import { test } from "node:test";
import assert from "node:assert/strict";
import { symlinkSync } from "node:fs";
import path from "node:path";
import { createTempGitRepo } from "../fixtures/helpers.js";
import { buildRepoSnapshot, pathMatchesGlob } from "../../dist/changes/snapshot.js";

test("pathMatchesGlob: literal prefix, basename glob, ** and ? semantics", () => {
  assert.equal(pathMatchesGlob("dist/a.js", "dist"), true);
  assert.equal(pathMatchesGlob("dist/sub/a.js", "dist"), true);
  assert.equal(pathMatchesGlob("distx/a.js", "dist"), false);
  assert.equal(pathMatchesGlob("src/a/x.gen.ts", "*.gen.ts"), true);
  assert.equal(pathMatchesGlob("x.gen.ts", "*.gen.ts"), true);
  assert.equal(pathMatchesGlob("src/x.gen.js", "*.gen.ts"), false);
  assert.equal(pathMatchesGlob("a/b/c.ts", "a/**"), true);
  assert.equal(pathMatchesGlob("a/c.ts", "a/**"), true);
  assert.equal(pathMatchesGlob("x/a/c.ts", "a/**"), false);
  assert.equal(pathMatchesGlob("src/ab.ts", "src/a?.ts"), true);
  assert.equal(pathMatchesGlob("src/abc.ts", "src/a?.ts"), false);
});

test("snapshot enumerates the committed tree, not the dirty working tree", async () => {
  const repo = createTempGitRepo("pir-snap-");
  try {
    repo.write("src/a/util.ts", "export const id = (x: string) => x;\n");
    repo.write("src/b/calc.ts", "export const add = (a: number, b: number) => a + b;\n");
    repo.write("README.md", "# demo\n");
    repo.commit("code");
    // Dirty the tree AFTER committing: the snapshot must stay pinned.
    repo.write("src/a/util.ts", "export const id = (x: string) => 'dirty';\n");
    const snap = await buildRepoSnapshot(repo.dir, "HEAD", { includePaths: [], skipGlobs: [] });
    const paths = snap.entries.map((entry) => entry.path);
    assert.deepEqual(paths, ["README.md", "src/a/util.ts", "src/b/calc.ts"]);
    assert.ok(/^[0-9a-f]{40}$/.test(snap.commit));
    assert.ok(/^[0-9a-f]{40}$/.test(snap.treeId));
    assert.ok(snap.entries.every((entry) => entry.selection === "selected"));
  } finally {
    repo.cleanup();
  }
});

test("selection: include prefixes union, skip subtraction, default policy exclusion", async () => {
  const repo = createTempGitRepo("pir-snap-sel-");
  try {
    repo.write("src/a/util.ts", "const a = 1;\n");
    repo.write("src/a/util.gen.ts", "const g = 1;\n");
    repo.write("src/b/calc.ts", "const b = 2;\n");
    repo.write("docs/guide.md", "# guide\n");
    repo.write("node_modules/dep/index.js", "const d = 3;\n");
    repo.write("package-lock.json", "{}\n");
    repo.commit("all");
    const snap = await buildRepoSnapshot(repo.dir, "HEAD", {
      includePaths: ["src/a", "docs"],
      skipGlobs: ["*.gen.ts"],
    });
    const byPath = new Map(snap.entries.map((entry) => [entry.path, entry]));
    assert.equal(byPath.get("src/a/util.ts").selection, "selected");
    assert.equal(byPath.get("docs/guide.md").selection, "selected");
    assert.equal(byPath.get("src/b/calc.ts").selection, "not-selected");
    assert.equal(byPath.get("src/a/util.gen.ts").selection, "excluded");
    assert.match(byPath.get("src/a/util.gen.ts").exclusionReason, /--skip/);
    // Outside the selected prefixes: not-selected wins over any policy.
    assert.equal(byPath.get("node_modules/dep/index.js").selection, "not-selected");
    assert.equal(byPath.get("package-lock.json").selection, "not-selected");

    // Whole-tree scope: the default exclusion policy applies.
    const full = await buildRepoSnapshot(repo.dir, "HEAD", { includePaths: [], skipGlobs: [] });
    const fullByPath = new Map(full.entries.map((entry) => [entry.path, entry]));
    assert.equal(fullByPath.get("node_modules/dep/index.js").selection, "excluded");
    assert.match(fullByPath.get("node_modules/dep/index.js").exclusionReason, /default policy/);
    assert.equal(fullByPath.get("package-lock.json").selection, "excluded");
    assert.equal(fullByPath.get("src/b/calc.ts").selection, "selected");
  } finally {
    repo.cleanup();
  }
});

test("selected non-text entries are classified, never silently dropped", async () => {
  const repo = createTempGitRepo("pir-snap-bin-");
  try {
    repo.write("src/app.ts", "const a = 1;\n");
    repo.write("assets/logo.png", "not-really-png-but-extension-decides\n");
    symlinkSync("../src/app.ts", path.join(repo.dir, "src/link.ts"));
    repo.commit("mixed");
    const snap = await buildRepoSnapshot(repo.dir, "HEAD", { includePaths: [], skipGlobs: [] });
    const byPath = new Map(snap.entries.map((entry) => [entry.path, entry]));
    assert.equal(byPath.get("src/app.ts").classification, "text");
    assert.equal(byPath.get("assets/logo.png").classification, "binary-extension");
    assert.equal(byPath.get("assets/logo.png").selection, "selected");
    assert.equal(byPath.get("src/link.ts").classification, "symlink");
  } finally {
    repo.cleanup();
  }
});

test("root commit (no parent) is a valid snapshot target", async () => {
  const repo = createTempGitRepo("pir-snap-root-");
  try {
    repo.write("only.ts", "const only = 1;\n");
    const sha = repo.commit("root has code");
    const snap = await buildRepoSnapshot(repo.dir, sha, { includePaths: [], skipGlobs: [] });
    assert.equal(snap.commit, sha);
    assert.equal(snap.entries.length, 1);
  } finally {
    repo.cleanup();
  }
});
