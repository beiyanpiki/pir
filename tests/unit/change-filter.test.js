import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempGitRepo } from "../fixtures/helpers.js";
import {
  BINARY_EXTENSIONS,
  DEFAULT_SKIP_PATTERNS,
  FILTER_VERSION,
  MAX_AUDIT_FILE_BYTES,
  MAX_DIFF_FILE_BYTES,
  applyChangeFilter,
  classifyEntry,
  diffBodyBytes,
  normalizeIncludePath,
  selectChangeFile,
  selectChangeFile as select,
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

// ---------------------------------------------------------------------------
// the four gates (ADR 0004)
// ---------------------------------------------------------------------------

const HEADER = "@@ -1,1 +1,1 @@";

/** A changed file with one small text hunk, overridable per case. */
function file(path, over = {}) {
  return {
    path,
    status: "modified",
    hunks: [{ newStart: 1, newLineCount: 1, oldStart: 1, oldLineCount: 1, header: HEADER, lines: ["+const a = 1;"] }],
    additions: 1,
    deletions: 0,
    ...over,
  };
}

test("B1 gate 1 (binary): extension policy, on both sides of a rename, before everything else", () => {
  assert.deepEqual(select(file("assets/logo.png")), {
    path: "assets/logo.png", selected: false, gate: "binary",
    reason: "binary file (diff bodies are not machine-reviewable text)",
  });
  assert.equal(select(file("src/A.PNG")).gate, "binary");
  // A source file renamed away from a binary name still has binary content.
  assert.equal(select(file("src/notes.txt", { oldPath: "assets/logo.png" })).gate, "binary");
  assert.equal(select(file("src/app.ts")).selected, true);
});

test("B1 gate 2 (secret): dotenv/.ssh/credential paths are excluded and .env examples are exempt", () => {
  for (const path of [
    ".env", "config/.env", "config/.env.production", ".ssh/id_rsa", ".ssh/config",
    "id_rsa", "keys/id_ed25519", ".netrc", "sub/.npmrc", ".pypirc", ".dockercfg",
  ]) {
    const decision = select(file(path));
    assert.equal(decision.gate, "secret", `${path} must be excluded as a secret path`);
    assert.match(decision.reason, /never sent to a model/);
  }
  // A checked-in example is not a secret.
  for (const path of [".env.example", ".env.sample", "config/.env.template"]) {
    assert.equal(select(file(path)).selected, true, `${path} must stay reviewable`);
  }
  // Renaming a secret away does not launder it: the old side changed too.
  assert.equal(select(file("config/example.txt", { oldPath: ".env" })).gate, "secret");
});

test("B1 gate 3 (skip patterns): explicit --skip first, then the versioned default policy", () => {
  const skipped = select(file("src/api.gen.ts"), { skipGlobs: ["*.gen.ts"] });
  assert.equal(skipped.gate, "skip-pattern");
  assert.equal(skipped.reason, "--skip *.gen.ts");
  const policy = select(file("dist/bundle.js"));
  assert.equal(policy.gate, "skip-pattern");
  assert.equal(policy.reason, "default policy: build output");
  assert.equal(select(file("package-lock.json")).reason, "default policy: lockfile");
  assert.equal(select(file("src/app.ts")).selected, true);
});

test("B1 gate 4 (oversized diff): bytes of the pageable diff body, cap boundary exact", () => {
  const atCap = file("src/exact.ts", { hunks: [{ newStart: 1, newLineCount: 1, oldStart: 1, oldLineCount: 1, header: HEADER, lines: ["x".repeat(MAX_DIFF_FILE_BYTES - HEADER.length - 2)] }] });
  assert.equal(diffBodyBytes(atCap), MAX_DIFF_FILE_BYTES);
  assert.equal(select(atCap).selected, true, "exactly at the cap is still reviewable");
  const overCap = file("src/big.ts", { hunks: [{ newStart: 1, newLineCount: 1, oldStart: 1, oldLineCount: 1, header: HEADER, lines: ["x".repeat(MAX_DIFF_FILE_BYTES)] }] });
  const decision = select(overCap);
  assert.equal(decision.gate, "oversized-diff");
  assert.match(decision.reason, new RegExp(`oversized file diff \\(\\d+ bytes > ${MAX_DIFF_FILE_BYTES}\\)`));
  // Multi-byte content is measured in bytes, not UTF-16 code units.
  const multibyte = file("src/i18n.ts", { hunks: [{ newStart: 1, newLineCount: 1, oldStart: 1, oldLineCount: 1, header: HEADER, lines: ["+\u4e2d".repeat(MAX_DIFF_FILE_BYTES / 3 + 1)] }] });
  assert.ok(diffBodyBytes(multibyte) > MAX_DIFF_FILE_BYTES);
});

test("B1 include bypass: include rescues skip patterns and oversized diffs, never binary or secret", () => {
  // Bypass: an explicit include overrides the default policy and the size cap.
  assert.equal(select(file("dist/bundle.js"), { includePaths: ["dist/bundle.js"] }).selected, true);
  assert.equal(select(file("dist"), { includePaths: ["dist"] }).selected, true, "dir prefixes include a subtree");
  const big = file("src/big.ts", { hunks: [{ newStart: 1, newLineCount: 1, oldStart: 1, oldLineCount: 1, header: HEADER, lines: ["x".repeat(MAX_DIFF_FILE_BYTES)] }] });
  assert.equal(select(big, { includePaths: ["src"] }).selected, true);
  // No bypass: the non-overridable gates still win.
  assert.equal(select(file("assets/logo.png"), { includePaths: ["assets/logo.png"] }).gate, "binary");
  const secret = select(file(".env"), { includePaths: [".env"] });
  assert.equal(secret.gate, "secret");
  assert.match(secret.reason, /never sent to a model/);
  // Include is also a scope: a file outside it is not selected.
  const outside = select(file("src/app.ts"), { includePaths: ["docs"] });
  assert.equal(outside.gate, "not-included");
  assert.equal(outside.reason, "outside the include scope");
  // Either side of a rename satisfies the include.
  assert.equal(select(file("src/new.ts", { oldPath: "src/old.ts" }), { includePaths: ["src/old.ts"] }).selected, true);
});

test("applyChangeFilter: metadata and churn stay, hunks go, clean change sets pass through", () => {
  const changeSet = {
    repoRoot: "/repo", base: "base", head: "head", mergeBase: "merge",
    files: [
      file("src/app.ts", { additions: 4, deletions: 2, language: "ts" }),
      file(".env", { additions: 3, deletions: 1, language: "" }),
      file("dist/bundle.js", { additions: 9, deletions: 0, language: "js" }),
    ],
    patch: "raw merge-base..head patch",
    churn: 19,
  };
  const filtered = applyChangeFilter(changeSet);
  const env = filtered.files.find((f) => f.path === ".env");
  assert.equal(env.excluded, true);
  assert.match(env.excludedReason, /secret path \(dotenv file\); never sent to a model/);
  assert.deepEqual(env.hunks, [], "the diff body must not be reachable");
  assert.equal(env.additions, 3);
  assert.equal(env.deletions, 1);
  const generated = filtered.files.find((f) => f.path === "dist/bundle.js");
  assert.equal(generated.excluded, true);
  assert.equal(generated.excludedReason, "default policy: build output");
  assert.equal(filtered.files.find((f) => f.path === "src/app.ts").excluded, undefined);
  assert.equal(filtered.files.find((f) => f.path === "src/app.ts").hunks.length, 1);
  // Churn stays the change-set total: filtered files are visible, not deleted.
  assert.equal(filtered.churn, 19);
  assert.equal(filtered.patch, "raw merge-base..head patch");
  // Nothing excluded -> identical object, i.e. zero behavioral change.
  const clean = { ...changeSet, files: [file("src/app.ts")] };
  assert.equal(applyChangeFilter(clean), clean);
});
