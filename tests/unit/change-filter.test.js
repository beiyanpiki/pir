import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempGitRepo } from "../fixtures/helpers.js";
import {
  BINARY_EXTENSIONS,
  DEFAULT_SKIP_PATTERNS,
  FILTER_VERSION,
  MAX_AUDIT_FILE_BYTES,
  classifyEntry,
  normalizeIncludePath,
} from "../../dist/changes/filter.js";
import { buildRepoSnapshot } from "../../dist/changes/snapshot.js";

/**
 * B1: the shared filter module. These pin the contract the real run and both
 * previews (`audit --dry-run`, `find --preview`) call — the tables, the
 * classifier and the include normalization.
 */

test("B1 filter policy: one versioned module owns the shared tables", () => {
  assert.equal(FILTER_VERSION, 1);
  assert.equal(MAX_AUDIT_FILE_BYTES, 1_000_000);
  assert.ok(DEFAULT_SKIP_PATTERNS.length >= 15);
  for (const rule of DEFAULT_SKIP_PATTERNS) {
    assert.equal(typeof rule.glob, "string");
    assert.ok(rule.glob.length > 0);
    assert.ok(rule.reason.length > 0, `missing reason for ${rule.glob}`);
  }
  for (const extension of ["png", "pdf", "zip", "wasm", "woff2", "parquet"]) {
    assert.ok(BINARY_EXTENSIONS.has(extension), `${extension} must stay binary`);
  }
});

test("classifyEntry: symlink, submodule, binary extension and the size boundary", () => {
  const entry = (over = {}) => ({ path: "src/a.ts", type: "blob", mode: "100644", size: 10, ...over });
  assert.equal(classifyEntry(entry()), "text");
  assert.equal(classifyEntry(entry({ mode: "120000" })), "symlink");
  assert.equal(classifyEntry(entry({ type: "commit", mode: "160000", size: null })), "submodule");
  assert.equal(classifyEntry(entry({ path: "assets/logo.PNG" })), "binary-extension");
  // Exactly at the cap is still reviewable; one byte over is not.
  assert.equal(classifyEntry(entry({ size: MAX_AUDIT_FILE_BYTES })), "text");
  assert.equal(classifyEntry(entry({ size: MAX_AUDIT_FILE_BYTES + 1 })), "oversized");
});

test("normalizeIncludePath: literal file/dir prefixes only", () => {
  assert.equal(normalizeIncludePath("./"), ".");
  assert.equal(normalizeIncludePath("."), ".");
  assert.equal(normalizeIncludePath("src/./a"), "src/a");
  assert.equal(normalizeIncludePath("src/a/"), "src/a");
  for (const bad of ["../etc", "src/../etc", "src/*.ts", "src/[a].ts", "a\\b", "src/\u0000a", ""]) {
    assert.throws(() => normalizeIncludePath(bad), /invalid --path/, `${JSON.stringify(bad)} must be rejected`);
  }
});

test("B1: audit selection is unchanged — include narrows, then skip and the default policy apply", async () => {
  const repo = createTempGitRepo("pir-filter-audit-");
  try {
    repo.write("src/app.ts", "const a = 1;\n");
    repo.write("node_modules/dep/index.js", "const dep = 1;\n");
    repo.write("dist/gen.js", "const gen = 1;\n");
    repo.write("config/.env", "TOKEN=super-secret\n");
    repo.commit("all");
    // Audit's include scope is a narrowing filter, not a bypass: the same
    // behavior as before the policy tables moved into the shared module.
    const snap = await buildRepoSnapshot(repo.dir, "HEAD", {
      includePaths: ["node_modules", "dist", "config/.env"],
      skipGlobs: [],
    });
    const byPath = new Map(snap.entries.map((entry) => [entry.path, entry]));
    assert.equal(byPath.get("src/app.ts").selection, "not-selected");
    assert.equal(byPath.get("node_modules/dep/index.js").selection, "excluded");
    assert.match(byPath.get("node_modules/dep/index.js").exclusionReason, /default policy: vendored dependencies/);
    assert.equal(byPath.get("dist/gen.js").selection, "excluded");
    assert.match(byPath.get("dist/gen.js").exclusionReason, /default policy: build output/);
    // Audit keeps no secret gate (change mode adds it) — untouched by B1.
    assert.equal(byPath.get("config/.env").selection, "selected");
    assert.equal(snap.scopeVersion, FILTER_VERSION);
  } finally {
    repo.cleanup();
  }
});
