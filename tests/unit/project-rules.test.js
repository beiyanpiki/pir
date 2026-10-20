import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ProjectRuleError,
  applyProjectRules,
  canonicalizeGuidance,
  loadProjectRules,
  parseRuleFile,
  pirConfigDir,
} from "../../dist/rules/project-rules.js";
import { reviewerPrompt } from "../../dist/agents/prompts.js";

/**
 * B5 acceptance A1: layer precedence, first-match-wins, include/exclude,
 * guidance-file containment, merge semantics, canonical hash and byte-stable
 * rendering — all model-free.
 */

function tempDir(t, prefix = "pir-rules-") {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}

function layer(overrides = {}) {
  return { schemaVersion: 1, rules: [], ...overrides };
}

const rule = (glob, guidance, extra = {}) => ({ path: glob, guidance, ...extra });

function load(t, { repo, flag, global, ...rest } = {}) {
  const repoRoot = repo ?? tempDir(t);
  const configDir = global ?? tempDir(t);
  return loadProjectRules({
    repoRoot,
    configDir,
    ...(flag ? { explicitPath: flag } : {}),
    ...rest,
  });
}

test("three layers: flag > repo > global, first match wins per path", (t) => {
  const repo = tempDir(t);
  const global = tempDir(t);
  const flag = path.join(tempDir(t), "flag.json");
  writeJson(flag, layer({ rules: [rule("src/**", "FLAG-GUIDANCE")] }));
  writeJson(path.join(repo, ".pir", "rule.json"), layer({ rules: [rule("docs/**", "REPO-GUIDANCE")] }));
  writeJson(path.join(global, "rule.json"), layer({ rules: [rule("**", "GLOBAL-GUIDANCE")] }));
  const set = loadProjectRules({ repoRoot: repo, configDir: global, explicitPath: flag });
  const app = applyProjectRules(set, [{ path: "src/a.ts" }]);
  assert.match(app.section, /FLAG-GUIDANCE/);
  assert.doesNotMatch(app.section, new RegExp(flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "no absolute --rule path in the prompt");
  assert.doesNotMatch(app.section, /REPO-GUIDANCE|GLOBAL-GUIDANCE/);
  // A path the flag layer does not cover falls through to the repo layer, and
  // a path the repo layer does not cover to the global layer.
  const docs = applyProjectRules(set, [{ path: "docs/readme.md" }]);
  assert.match(docs.section, /REPO-GUIDANCE/);
  assert.doesNotMatch(docs.section, /GLOBAL-GUIDANCE|FLAG-GUIDANCE/);
  const other = applyProjectRules(set, [{ path: "LICENSE" }]);
  assert.match(other.section, /GLOBAL-GUIDANCE/);
  assert.equal(set.layers.map((entry) => entry.layer).join(","), "flag,repo,global");
});

test("within one layer, declaration order is priority", (t) => {
  const repo = tempDir(t);
  writeJson(path.join(repo, ".pir", "rule.json"), layer({ rules: [rule("src/**", "FIRST"), rule("src/*.ts", "SECOND")] }));
  const app = applyProjectRules(load(t, { repo }), [{ path: "src/a.ts" }]);
  assert.match(app.section, /FIRST/);
  assert.doesNotMatch(app.section, /SECOND/);
});

test("include/exclude are layer-local: exclude wins, a lower layer can cover the gap", (t) => {
  const repo = tempDir(t);
  const global = tempDir(t);
  writeJson(path.join(repo, ".pir", "rule.json"), layer({
    include: ["src/**"], exclude: ["**/*.test.ts"], rules: [rule("**", "REPO-RULE")],
  }));
  writeJson(path.join(global, "rule.json"), layer({ rules: [rule("**", "GLOBAL-RULE")] }));
  const set = loadProjectRules({ repoRoot: repo, configDir: global });
  assert.match(applyProjectRules(set, [{ path: "src/a.ts" }]).section, /REPO-RULE/);
  assert.match(applyProjectRules(set, [{ path: "src/a.test.ts" }]).section, /GLOBAL-RULE/);
  assert.match(applyProjectRules(set, [{ path: "docs/x.md" }]).section, /GLOBAL-RULE/);
});

test("excluded files are never matched; a rename matches through oldPath and reports the new path", (t) => {
  const repo = tempDir(t);
  writeJson(path.join(repo, ".pir", "rule.json"), layer({ rules: [rule("legacy/**", "LEGACY"), rule("src/**", "RULE")] }));
  const set = load(t, { repo });
  assert.equal(applyProjectRules(set, [{ path: "src/a.ts", excluded: true }]).section, "");
  const renamed = applyProjectRules(set, [{ path: "src/new.ts", oldPath: "legacy/old.ts" }]);
  assert.match(renamed.section, /LEGACY/);
  assert.match(renamed.section, /applies to: src\/new\.ts/);
});

test("an explicit --rule path must exist: a typo fails instead of silently disabling rules", (t) => {
  const repo = tempDir(t);
  assert.throws(
    () => loadProjectRules({ repoRoot: repo, configDir: tempDir(t), explicitPath: path.join(repo, "nope.json") }),
    /explicit rule file \(--rule\) does not exist/,
  );
});

test("no rule file: empty section, zero matches and a stable empty-set hash", (t) => {
  const empty = load(t);
  const app = applyProjectRules(empty, [{ path: "src/a.ts" }]);
  assert.equal(app.section, "");
  assert.equal(app.summary.matchedFiles, 0);
  assert.equal(app.summary.rules, 0);
  assert.equal(app.summary.builtinSuppressed, false);
  assert.match(empty.hash, /^[0-9a-f]{64}$/);
  assert.equal(empty.hash, load(t).hash, "hash of no rules is stable");
});

test("mergeBuiltin defaults to true; false marks the run's built-in guidance suppressed", (t) => {
  const repo = tempDir(t);
  writeJson(path.join(repo, ".pir", "rule.json"), layer({ rules: [rule("src/**", "KEEP-BOTH")] }));
  const kept = applyProjectRules(load(t, { repo }), [{ path: "src/a.ts" }]);
  assert.equal(kept.summary.builtinSuppressed, false);
  assert.match(kept.section, /mergeBuiltin=true/);

  writeJson(path.join(repo, ".pir", "rule.json"), layer({ rules: [rule("src/**", "REPLACE", { mergeBuiltin: false })] }));
  const replaced = applyProjectRules(load(t, { repo }), [{ path: "src/a.ts" }]);
  assert.equal(replaced.summary.builtinSuppressed, true);
  assert.match(replaced.section, /WITHHELD/);
  assert.match(replaced.section, /mergeBuiltin=false/);
});

test("guidance files are read as contained, allowlisted, size-capped input", (t) => {
  const repo = tempDir(t);
  mkdirSync(path.join(repo, "docs"), { recursive: true });
  writeFileSync(path.join(repo, "docs", "web.md"), "# Web rules\r\n\r\nNever mutate props.   \r\n");
  writeJson(path.join(repo, ".pir", "rule.json"), layer({
    rules: [{ path: "src/web/**", guidanceFile: "docs/web.md" }],
  }));
  const app = applyProjectRules(load(t, { repo }), [{ path: "src/web/app.ts" }]);
  assert.match(app.section, /# Web rules\n\nNever mutate props\./);
  assert.doesNotMatch(app.section, /\r/);
});

test("guidance file containment: absolute, .., symlink escape, bad extension, missing, oversized", (t) => {
  const repo = tempDir(t);
  const outside = tempDir(t);
  writeFileSync(path.join(outside, "outside.md"), "OUTSIDE");
  symlinkSync(path.join(outside, "outside.md"), path.join(repo, "escape.md"));
  mkdirSync(path.join(repo, "docs"), { recursive: true });
  writeFileSync(path.join(repo, "docs", "ok.md"), "OK");
  writeFileSync(path.join(repo, "docs", "rules.js"), "not markdown");
  writeFileSync(path.join(repo, "docs", "big.md"), "x".repeat(70_000));
  writeJson(path.join(repo, ".pir", "rule.json"), layer({ rules: [rule("**", "PLACEHOLDER")] }));
  const cases = [
    [path.join(repo, "docs", "ok.md"), /repo-relative/],
    ["../outside.md", /must not contain "\.\."/],
    ["escape.md", /resolves outside the repository root/],
    ["docs/rules.js", /unsupported extension/],
    ["docs/missing.md", /does not exist/],
    ["docs/big.md", /characters; the limit is/],
  ];
  for (const [guidanceFile, pattern] of cases) {
    const file = path.join(repo, ".pir", "rule.json");
    writeJson(file, layer({ rules: [{ path: "**", guidanceFile }] }));
    assert.throws(() => loadProjectRules({ repoRoot: repo, configDir: tempDir(t) }), pattern, guidanceFile);
  }
});

test("the repository rule file itself is contained: an outside symlink is fatal, an inside one is read", (t) => {
  const repo = tempDir(t);
  const outside = tempDir(t);
  writeJson(path.join(outside, "rules.json"), layer({ rules: [rule("**", "OUTSIDE")] }));
  mkdirSync(path.join(repo, ".pir"), { recursive: true });
  symlinkSync(path.join(outside, "rules.json"), path.join(repo, ".pir", "rule.json"));
  assert.throws(
    () => loadProjectRules({ repoRoot: repo, configDir: tempDir(t) }),
    /repository rule file resolves outside the repository root/,
  );

  mkdirSync(path.join(repo, "cfg"), { recursive: true });
  writeJson(path.join(repo, "cfg", "rules.json"), layer({ rules: [rule("**", "INSIDE")] }));
  rmSync(path.join(repo, ".pir", "rule.json"));
  symlinkSync(path.join(repo, "cfg", "rules.json"), path.join(repo, ".pir", "rule.json"));
  const app = applyProjectRules(loadProjectRules({ repoRoot: repo, configDir: tempDir(t) }), [{ path: "a.ts" }]);
  assert.match(app.section, /INSIDE/);
});

test("rule-file validation is strict: unknown keys, both/neither guidance, bad shapes", (t) => {
  const repo = tempDir(t);
  const file = path.join(repo, ".pir", "rule.json");
  const invalid = [
    [{ rules: [], extra: 1 }, /unknown key "extra"/],
    [{ rules: [{ path: "**", guidance: "x", nope: 1 }] }, /unknown key "nope"/],
    [{ rules: [{ path: "**" }] }, /exactly one of "guidance" or "guidanceFile"/],
    [{ rules: [{ path: "**", guidance: "x", guidanceFile: "docs/x.md" }] }, /exactly one of/],
    [{ rules: [{ path: "**", guidance: 7 }] }, /guidance must be a string/],
    [{ rules: [{ path: "**", guidance: "x", mergeBuiltin: "false" }] }, /mergeBuiltin must be a boolean/],
    [{ rules: [{ path: "/abs/**", guidance: "x" }] }, /repo-relative/],
    [{ rules: [{ path: "**", guidance: "x" }], include: "src/**" }, /"include" must be an array/],
    [{ rules: [], schemaVersion: 2 }, /schemaVersion.*must be 1/],
    [[], /expected a JSON object/],
  ];
  for (const [body, pattern] of invalid) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body));
    assert.throws(() => loadProjectRules({ repoRoot: repo, configDir: tempDir(t) }), pattern, JSON.stringify(body));
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, "{not json");
  assert.throws(() => loadProjectRules({ repoRoot: repo, configDir: tempDir(t) }), /not valid JSON/);
  // Too many rules.
  writeJson(file, layer({ rules: Array.from({ length: 65 }, (_, i) => rule(`src${i}/**`, `g${i}`)) }));
  assert.throws(() => loadProjectRules({ repoRoot: repo, configDir: tempDir(t) }), /65 rules exceed/);
  // Rule file over the byte cap.
  writeFileSync(file, JSON.stringify(layer({ rules: [rule("**", "x".repeat(300_000))] })));
  assert.throws(() => loadProjectRules({ repoRoot: repo, configDir: tempDir(t) }), /rule file is .* bytes; the limit/);
});

test("canonical hash: stable across checkout/line endings/whitespace, sensitive to semantics", (t) => {
  const one = tempDir(t);
  const two = tempDir(t);
  writeJson(path.join(one, ".pir", "rule.json"), layer({ rules: [rule("src/**", "Be careful.  \r\nNo shortcuts.")] }));
  writeJson(path.join(two, ".pir", "rule.json"), layer({ rules: [rule("src/**", "Be careful.\nNo shortcuts.")] }));
  const hashOne = loadProjectRules({ repoRoot: one, configDir: tempDir(t) }).hash;
  const hashTwo = loadProjectRules({ repoRoot: two, configDir: tempDir(t) }).hash;
  assert.equal(hashOne, hashTwo, "same rules in a different checkout hash identically");

  const variants = [
    layer({ rules: [rule("src/**", "Be careful.\nNo shortcuts.", { mergeBuiltin: false })] }),
    layer({ rules: [rule("src/**", "Different guidance.")] }),
    layer({ rules: [rule("src/**", "Be careful.\nNo shortcuts."), rule("docs/**", "Docs.")] }),
    layer({ include: ["src/**"], rules: [rule("src/**", "Be careful.\nNo shortcuts.")] }),
  ];
  for (const body of variants) {
    writeJson(path.join(two, ".pir", "rule.json"), body);
    assert.notEqual(loadProjectRules({ repoRoot: two, configDir: tempDir(t) }).hash, hashOne, JSON.stringify(body));
  }
});

test("rendering is byte-stable: groups sorted by glob, files sorted, repeatable", (t) => {
  const repo = tempDir(t);
  writeJson(path.join(repo, ".pir", "rule.json"), layer({
    rules: [rule("z/**", "Z-RULE"), rule("a/**", "A-RULE"), rule("m/**", "M-RULE")],
  }));
  const set = load(t, { repo });
  const app = applyProjectRules(set, [{ path: "z/two.ts" }, { path: "z/one.ts" }, { path: "a/b.ts" }, { path: "m/c.ts" }]);
  const a = app.section.indexOf('"a/**"');
  const m = app.section.indexOf('"m/**"');
  const z = app.section.indexOf('"z/**"');
  assert.ok(a !== -1 && a < m && m < z, "groups render in glob order");
  assert.match(app.section, /applies to: z\/one\.ts, z\/two\.ts/, "files are sorted");
  assert.equal(app.section, applyProjectRules(set, [{ path: "m/c.ts" }, { path: "a/b.ts" }, { path: "z/two.ts" }, { path: "z/one.ts" }]).section);
  assert.deepEqual(app.matches.map((match) => match.path), ["a/b.ts", "m/c.ts", "z/one.ts", "z/two.ts"]);
});

test("rendered section cap fails loudly instead of truncating", (t) => {
  const repo = tempDir(t);
  writeJson(path.join(repo, ".pir", "rule.json"), layer({
    rules: [1, 2, 3, 4].map((n) => rule(`src${n}/**`, "x".repeat(14_000))),
  }));
  const set = load(t, { repo });
  assert.throws(
    () => applyProjectRules(set, [1, 2, 3, 4].map((n) => ({ path: `src${n}/a.ts` }))),
    /rendered PROJECT RULES section is .* characters; the limit is 48000/,
  );
});

test("PROJECT RULES sits after the blacklist and before language guidance and the memory pack", () => {
  const base = { base: "b", head: "h", round: 1, maxRounds: 2, maxFindings: 10, findingsRemaining: 10, focus: [], memoryPack: "MEMORY-PACK", structuralQueries: false };
  const without = reviewerPrompt(base);
  assert.doesNotMatch(without, /PROJECT RULES/);
  const prompt = reviewerPrompt({ ...base, languageGuidance: "LANGUAGE-PACK", projectRules: "PROJECT RULES\nGUIDANCE-BLOCK" });
  const blacklist = prompt.indexOf("DO NOT REPORT");
  const project = prompt.indexOf("PROJECT RULES");
  const language = prompt.indexOf("LANGUAGE-PACK");
  const memory = prompt.indexOf("=== REPOSITORY MEMORY ===");
  assert.ok(blacklist !== -1 && blacklist < project, "project rules come after the process/blacklist block");
  assert.ok(project < language && language < memory, "project rules come before the pack and the memory pack");
  assert.match(prompt, /GUIDANCE-BLOCK/);
});

test("canonicalizeGuidance normalizes CRLF and trailing whitespace only", () => {
  assert.equal(canonicalizeGuidance("  a  \r\n\tb\t\r\n\r\n"), "a\n\tb");
  assert.equal(canonicalizeGuidance("a\n\nb"), "a\n\nb");
});

test("pirConfigDir honours PIR_CONFIG_DIR", (t) => {
  const previous = process.env.PIR_CONFIG_DIR;
  t.after(() => {
    if (previous === undefined) delete process.env.PIR_CONFIG_DIR;
    else process.env.PIR_CONFIG_DIR = previous;
  });
  process.env.PIR_CONFIG_DIR = "/tmp/pir-rules-config";
  assert.equal(pirConfigDir(), "/tmp/pir-rules-config");
});

test("parseRuleFile is exported for callers that already read the file", (t) => {
  const repo = tempDir(t);
  const parsed = parseRuleFile({
    text: JSON.stringify(layer({ include: ["src/**"], rules: [rule("src/**", "INLINE")] })),
    file: path.join(repo, ".pir", "rule.json"),
    layer: "repo",
    repoRoot: repo,
  });
  assert.equal(parsed.layer, "repo");
  assert.deepEqual(parsed.include, ["src/**"]);
  assert.equal(parsed.rules[0].guidanceSource, "inline");
  assert.equal(parsed.rules[0].mergeBuiltin, true);
  assert.ok(ProjectRuleError.prototype instanceof Error);
});
