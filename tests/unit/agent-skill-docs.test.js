import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Dogfood F-176: the pir-dogfood range recipes used to hardcode `--base origin/dev`,
 * so a PR against a declared target branch would review the wrong diff scope. The
 * range table must resolve the ref `work-with-pr` resolves (`$BASE_REF`); a literal
 * `origin/dev` is allowed only on the line that names it as the default.
 */

const SKILL = path.resolve(import.meta.dirname, "..", "..", ".agents", "skills", "pir-dogfood", "SKILL.md");
const markdown = readFileSync(SKILL, "utf8");

function rangeTableRows(text) {
  const heading = "## Range selection";
  const start = text.indexOf(heading);
  assert.notEqual(start, -1, `the dogfood skill has a "${heading}" section`);
  const after = text.slice(start + heading.length);
  const next = after.search(/\n## /);
  const section = next === -1 ? after : after.slice(0, next);
  return section.split("\n").filter((line) => line.trimStart().startsWith("|"));
}

test("the range table resolves every diff base from the declared target branch", () => {
  const rows = rangeTableRows(markdown);
  assert.ok(rows.length >= 4, "the range table keeps its recipe rows");

  for (const row of rows) {
    if (!row.includes("origin/dev")) continue;
    assert.match(row, /default/i, `origin/dev is only allowed on a line that names the default: ${row}`);
  }

  const whole = rows.find((row) => row.includes("Whole branch"));
  assert.ok(whole, "the whole-branch recipe row exists");
  assert.match(whole, /--uncommitted --base "\$BASE_REF"/);
  assert.doesNotMatch(whole, /origin\/dev/);

  const committed = rows.find((row) => row.includes("Committed branch diff"));
  assert.ok(committed, "the committed-branch-diff recipe row exists");
  assert.match(committed, /--base "\$BASE_REF"/);
  assert.doesNotMatch(committed, /origin\/dev/);
});

test("origin/dev survives only where the skill states the default explicitly", () => {
  const mentions = markdown.split("\n").filter((line) => line.includes("origin/dev"));
  assert.ok(mentions.length > 0, "the default ref is stated somewhere");
  for (const line of mentions) {
    assert.match(line, /default/i, `a literal origin/dev outside the default statement: ${line}`);
  }
  const declared = mentions.find((line) => line.includes("$BASE_REF") && /default/i.test(line));
  assert.ok(declared, "one line states that $BASE_REF is origin/dev for the default target");
});
