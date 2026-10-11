import { test } from "node:test";
import assert from "node:assert/strict";
import { ChangeCoverage } from "../../dist/core/change-coverage.js";
import { parseUnifiedDiff } from "../../dist/changes/diff.js";

const PATCH = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@ first
 keep1
+added
 keep3
 keep4
@@ -10,2 +12,2 @@ second
-removed
+replaced
diff --git a/gone.ts b/gone.ts
deleted file mode 100644
index 3333333..0000000
--- a/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-gone1
-gone2
diff --git a/old.ts b/renamed.ts
similarity index 100%
rename from old.ts
rename to renamed.ts
diff --git a/old2.ts b/new2.ts
similarity index 90%
rename from old2.ts
rename to new2.ts
@@ -1,2 +1,3 @@ rename-edit
 ctx
+new line
 ctx2
`;

function coverage(patch = PATCH) {
  return new ChangeCoverage({ files: parseUnifiedDiff(patch).files });
}

test("counts: hunks across files; hunk-less entries (pure rename, binary) excluded", () => {
  // src/a.ts: 2 hunks; gone.ts: 1 deleted-side hunk; new2.ts: 1 hunk.
  // renamed.ts (similarity 100%, no hunks) has nothing observable.
  assert.deepEqual(coverage().counts(), { hunksTotal: 4, hunksCovered: 0, filesTotal: 3, filesCovered: 0 });
});

test("read windows: exact hit and EOF-null open range", () => {
  const c = coverage();
  c.recordRead("src/a.ts", { startLine: 1, endLine: 4 });
  c.recordRead("src/a.ts", { startLine: 12, endLine: null });
  assert.deepEqual(c.counts(), { hunksTotal: 4, hunksCovered: 2, filesTotal: 3, filesCovered: 1 });
});

test("boundary: a read ending on the hunk's last line covers it; gaps stay uncovered", () => {
  const c = coverage();
  c.recordRead("src/a.ts", { startLine: 4, endLine: 11 });
  const counts = c.counts();
  assert.equal(counts.hunksCovered, 1);
  // single-line hunk boundary: read of exactly the hunk's line covers it
  const single = coverage(`diff --git a/s.ts b/s.ts
index 1111111..2222222 100644
--- a/s.ts
+++ b/s.ts
@@ -7,1 +7,2 @@ one-liner
 keep
+added`);
  single.recordRead("s.ts", { startLine: 8, endLine: 8 });
  assert.equal(single.counts().hunksCovered, 1);
  single.recordRead("s.ts", { startLine: 9, endLine: 20 });
  assert.equal(single.counts().hunksCovered, 1);
});

test("degenerate windows (end before start) cover nothing", () => {
  const c = coverage();
  c.recordRead("src/a.ts", { startLine: 5, endLine: 4 });
  assert.equal(c.counts().hunksCovered, 0);
});

test("recordHunk covers paged hunks including deleted-side ones; unknown entries ignored", () => {
  const c = coverage();
  c.recordHunk("gone.ts", 0);
  c.recordHunk("src/a.ts", 0);
  c.recordHunk("src/a.ts", 9);
  c.recordHunk("nope.ts", 0);
  assert.equal(c.counts().hunksCovered, 2);
  // deleted files have no head-side interval: a head read cannot cover their hunks
  c.recordRead("gone.ts", { startLine: 1, endLine: 5 });
  assert.equal(c.counts().hunksCovered, 2);
});

test("renames are accounted under the new path only", () => {
  const c = coverage();
  c.recordRead("old2.ts", { startLine: 1, endLine: 5 });
  assert.equal(c.counts().hunksCovered, 0);
  c.recordRead("new2.ts", { startLine: 2, endLine: 2 });
  assert.equal(c.counts().hunksCovered, 1);
  c.recordHunk("renamed.ts", 0);
  assert.equal(c.counts().hunksCovered, 1);
});

test("files detail is capped at 200 while counts cover every file", () => {
  let patch = "";
  for (let i = 0; i < 250; i++) {
    patch += `diff --git a/f${i}.ts b/f${i}.ts
index 1111111..2222222 100644
--- a/f${i}.ts
+++ b/f${i}.ts
@@ -1,1 +1,2 @@ f${i}
 ctx
+added
`;
  }
  const summary = coverage(patch).summary();
  assert.equal(summary.filesTotal, 250);
  assert.equal(summary.hunksTotal, 250);
  assert.equal(summary.files.length, 200);
});

test("unreadHunks enumerates uncovered hunks in file order up to the limit (C1 stage 2)", () => {
  const c = coverage();
  c.recordHunk("gone.ts", 0);
  c.recordRead("src/a.ts", { startLine: 1, endLine: 4 });
  assert.deepEqual(c.unreadHunks(10), [
    { path: "src/a.ts", hunkIndex: 1 },
    { path: "new2.ts", hunkIndex: 0 },
  ]);
  assert.deepEqual(c.unreadHunks(1), [{ path: "src/a.ts", hunkIndex: 1 }]);
  assert.deepEqual(c.unreadHunks(0), []);
});
