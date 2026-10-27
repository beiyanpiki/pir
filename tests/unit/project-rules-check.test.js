import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  applyProjectRules,
  checkProjectRules,
  loadProjectRules,
  matchProjectRule,
} from "../../dist/rules/project-rules.js";

/**
 * Rule introspection: the rules-check query shares the reviewer prompt's matcher, so
 * the debug answer and the prompt cannot disagree. Model-free; no CLI.
 */

function tempDir(t, prefix = "pir-rules-check-") {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}

const rule = (glob, guidance, extra = {}) => ({ path: glob, guidance, ...extra });

test("checkProjectRules reports the winner and its layer index", (t) => {
  const repo = tempDir(t);
  const configDir = tempDir(t);
  writeJson(path.join(repo, ".pir", "rule.json"), {
    rules: [rule("docs/**", "DOCS"), rule("src/**", "SRC")],
  });
  const set = loadProjectRules({ repoRoot: repo, configDir });
  const check = checkProjectRules(set, "src/a.ts");
  assert.ok(check.match);
  assert.equal(check.match.layer.layer, "repo");
  assert.equal(check.match.ruleIndex, 1);
  assert.equal(check.match.rule.guidance, "SRC");
  assert.deepEqual(check.layers.map((l) => l.won), [true]);
  assert.deepEqual(check.layers[0].include, ["**"]);
  assert.equal(check.layers[0].includedBy, "**");
  assert.equal(check.layers[0].excludedBy, null);
  assert.equal(check.layers[0].rulePath, "src/**");
});

test("the first match wins: layers in priority order, rules in declaration order", (t) => {
  const repo = tempDir(t);
  const configDir = tempDir(t);
  const flag = path.join(tempDir(t), "flag.json");
  writeJson(flag, { rules: [rule("**", "FLAG-ANY")] });
  writeJson(path.join(repo, ".pir", "rule.json"), { rules: [rule("src/**", "REPO-SRC")] });
  writeJson(path.join(configDir, "rule.json"), { rules: [rule("**", "GLOBAL-ANY")] });
  const set = loadProjectRules({ repoRoot: repo, configDir, explicitPath: flag });
  const check = checkProjectRules(set, "src/a.ts");
  assert.equal(check.match.layer.layer, "flag");
  assert.deepEqual(check.layers.map((l) => l.won), [true, false, false]);
  // Layers after the winner still explain their own (unused) match.
  assert.equal(check.layers[1].rulePath, "src/**");
  assert.equal(check.layers[2].rulePath, "**");
});

test("exclude wins over include and is explained", (t) => {
  const repo = tempDir(t);
  const configDir = tempDir(t);
  writeJson(path.join(repo, ".pir", "rule.json"), {
    include: ["src/**"],
    exclude: ["src/generated/**"],
    rules: [rule("**", "SRC")],
  });
  const set = loadProjectRules({ repoRoot: repo, configDir });
  const check = checkProjectRules(set, "src/generated/x.ts");
  assert.equal(check.match, null);
  assert.equal(check.layers[0].includedBy, "src/**");
  assert.equal(check.layers[0].excludedBy, "src/generated/**");
  assert.equal(check.layers[0].rulePath, null);
});

test("a layer include gate is explained when nothing matches", (t) => {
  const repo = tempDir(t);
  const configDir = tempDir(t);
  writeJson(path.join(repo, ".pir", "rule.json"), { include: ["src/**"], rules: [rule("**", "SRC")] });
  const set = loadProjectRules({ repoRoot: repo, configDir });
  const check = checkProjectRules(set, "docs/x.md");
  assert.equal(check.match, null);
  assert.equal(check.layers[0].includedBy, null);
  assert.equal(check.layers[0].excludedBy, null);
  assert.equal(check.layers[0].rulePath, null);
});

test("no rule files: the check reports no layers and no match", (t) => {
  const set = loadProjectRules({ repoRoot: tempDir(t), configDir: tempDir(t) });
  const check = checkProjectRules(set, "src/a.ts");
  assert.equal(check.match, null);
  assert.deepEqual(check.layers, []);
});

test("matchProjectRule honors oldPath for a rename, new path still wins first", (t) => {
  const repo = tempDir(t);
  const configDir = tempDir(t);
  writeJson(path.join(repo, ".pir", "rule.json"), { rules: [rule("old/**", "OLD")] });
  const set = loadProjectRules({ repoRoot: repo, configDir });
  assert.equal(matchProjectRule(set, "new/a.ts", "old/a.ts").rule.guidance, "OLD");
  assert.equal(matchProjectRule(set, "new/a.ts"), null);
});

test("applyProjectRules and checkProjectRules agree on every path", (t) => {
  const repo = tempDir(t);
  const configDir = tempDir(t);
  writeJson(path.join(repo, ".pir", "rule.json"), {
    rules: [rule("src/**", "SRC"), rule("**", "ANY")],
  });
  const set = loadProjectRules({ repoRoot: repo, configDir });
  const paths = ["src/a.ts", "docs/x.md", "other/y.go"].map((p) => ({ path: p }));
  const applied = applyProjectRules(set, paths);
  for (const file of paths) {
    const check = checkProjectRules(set, file.path);
    const match = applied.matches.find((m) => m.path === file.path);
    assert.equal(check.match === null, match === undefined, file.path);
    if (match) {
      assert.equal(check.match.layer.layer, match.layer);
      assert.equal(check.match.rule.path, match.rulePath);
    }
  }
});
