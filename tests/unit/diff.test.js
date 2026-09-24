import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUnifiedDiff, addedLineNumbers } from "../../dist/changes/diff.js";

const SAMPLE = `diff --git a/src/pay.ts b/src/pay.ts
index 1111111..2222222 100644
--- a/src/pay.ts
+++ b/src/pay.ts
@@ -10,4 +10,6 @@ export function charge(amount: number) {
   const fee = computeFee(amount);
-  return amount;
+  // total includes the fee
+  return amount + fee;
 }
diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+export const X = 1;
+export const Y = 2;
diff --git a/src/old.ts b/src/old.ts
deleted file mode 100644
index 4444444..0000000
--- a/src/old.ts
+++ /dev/null
@@ -1,1 +0,0 @@
-export const Z = 3;
diff --git a/src/a.ts b/src/b.ts
similarity index 90%
rename from src/a.ts
rename to src/b.ts
index 5555555..6666666 100644
--- a/src/a.ts
+++ b/src/b.ts
@@ -2,3 +2,3 @@ const x = 1;
 const y = 2;
-const z = 3;
+const z = 4;
 const w = 5;
`;

test("parseUnifiedDiff handles modified/added/deleted/renamed files", () => {
  const { files } = parseUnifiedDiff(SAMPLE);
  assert.equal(files.length, 4);

  const modified = files[0];
  assert.equal(modified.path, "src/pay.ts");
  assert.equal(modified.status, "modified");
  assert.equal(modified.additions, 2);
  assert.equal(modified.deletions, 1);
  assert.equal(modified.hunks.length, 1);
  assert.equal(modified.hunks[0].newStart, 10);

  const added = files[1];
  assert.equal(added.path, "src/new.ts");
  assert.equal(added.status, "added");
  assert.equal(added.hunks[0].newStart, 1);

  const deleted = files[2];
  assert.equal(deleted.path, "src/old.ts");
  assert.equal(deleted.status, "deleted");

  const renamed = files[3];
  assert.equal(renamed.path, "src/b.ts");
  assert.equal(renamed.oldPath, "src/a.ts");
  assert.equal(renamed.status, "renamed");
});

test("addedLineNumbers returns head-side line numbers of added lines", () => {
  const { files } = parseUnifiedDiff(SAMPLE);
  assert.deepEqual(addedLineNumbers(files[0]), [11, 12]);
  assert.deepEqual(addedLineNumbers(files[1]), [1, 2]);
  assert.deepEqual(addedLineNumbers(files[2]), []);
});
