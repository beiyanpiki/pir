import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Guard against the regression dogfood F-208 found: a stylesheet rewrite dropped
// shared .pir-* rules while the components still referenced them, so the sidebar,
// login page, finding drawer, diff view and markdown silently lost their styling.
//
// F-210: matching a bare token anywhere in the file is too weak — a compound
// ".wf-response .pir-markdown" rule would "define" pir-markdown while its base
// typography rule was gone. The checks below index real rule subjects instead.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const webSrc = path.join(root, "web/src");
const stylesheet = readFileSync(path.join(webSrc, "styles.css"), "utf8");

function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/** Every selector in the sheet, split on commas and stripped of whitespace. */
function ruleSubjects(css) {
  // Comments are removed first: a comma inside prose would otherwise be split
  // into a bogus selector (dogfood F-211).
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const subjects = [];
  for (const match of stripped.matchAll(/([^{}]+)\{/g)) {
    const block = match[1];
    if (block.includes(";") && !block.includes(",")) continue;
    for (const part of block.split(",")) {
      const selector = part.trim();
      if (selector && !selector.startsWith("@") && !selector.startsWith(":")) subjects.push(selector);
    }
  }
  return subjects;
}

const subjects = ruleSubjects(stylesheet);

/** The class is a compound of some rule subject (its own rule or a scoped one). */
function hasAnyRule(className) {
  const escaped = className.replace(/[.-]/g, "\\$&");
  const pattern = new RegExp("(^|[\\s>+~(])" + escaped + "(\\b|(?=[.:#[]))");
  return subjects.some((selector) => pattern.test(selector));
}

/** The class has a rule of its own (state/descendant allowed, another class not). */
function hasBaseRule(className) {
  return subjects.some((selector) => {
    if (selector === className) return true;
    if (!selector.startsWith(className)) return false;
    const next = selector.slice(className.length, className.length + 1);
    // ".cls.other" is a state/compound selector on top of another class, not a
    // base rule for .cls (dogfood F-212).
    return next === " " || next === ":" || next === "[";
  });
}

const tsxFiles = walk(webSrc).filter((file) => file.endsWith(".tsx"));
const used = new Map();
for (const file of tsxFiles) {
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(/className=(?:"([^"]*)"|\{([^}]*)\})/g)) {
    const value = match[1] ?? match[2] ?? "";
    for (const token of value.matchAll(/(?:^|[\s"'\`])((?:pir|wf)-[a-z0-9-]+)/g)) {
      const name = token[1];
      if (!used.has(name)) used.set(name, path.relative(root, file));
    }
  }
}

test("every pir-/wf- class used by a component has a stylesheet rule", () => {
  const missing = [...used.entries()].filter(([name]) => !hasAnyRule("." + name));
  assert.deepEqual(missing, [], "unstyled classes: " + missing.map(([name, file]) => name + " (" + file + ")").join(", "));
});

test("shared app-wide rules survive the workflow stylesheet", () => {
  // These selectors style pages and components outside the workflow tab; a
  // workflow-only edit must never drop them again, and a compound rule that
  // merely mentions them does not satisfy the requirement.
  for (const className of [
    ".pir-markdown",
    ".pir-code-block",
    ".pir-diff-file",
    ".pir-diff-line",
    ".pir-drawer-section",
    ".pir-anchor",
    ".pir-anchor-head",
    ".pir-empty-page",
    ".pir-login-wrap",
    ".pir-login-card",
    ".pir-login-brand",
    ".pir-sider-project",
  ]) {
    assert.ok(hasBaseRule(className), className + " has no base rule in web/src/styles.css");
  }
  // The diff gutter number only makes sense inside a diff line, so its rule is
  // legitimately scoped rather than a base rule.
  assert.ok(
    subjects.includes(".pir-diff-line .pir-line-no"),
    ".pir-diff-line .pir-line-no is missing from web/src/styles.css",
  );
});