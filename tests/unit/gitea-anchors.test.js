import { test } from "node:test";
import assert from "node:assert/strict";

const { parseUnifiedDiff } = await import("../../dist/changes/diff.js");
const { mapFindingsToInlineComments } = await import("../../dist/gitea/anchors.js");

/**
 * Anchor mapping against a real parsed patch: one added file, one modified
 * file with two hunks (added line + deep-context anchor), a rename with a
 * new path, and a deletion. Every case below asserts the reviewdog-style
 * rule: inline only when an anchor lands inside a hunk's new-side span.
 */

const PATCH = `diff --git a/src/added.ts b/src/added.ts
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/src/added.ts
@@ -0,0 +1,4 @@
+export function one(): number {
+  return 1;
+}
+// end
diff --git a/src/modified.ts b/src/modified.ts
index 1111111..2222222 100644
--- a/src/modified.ts
+++ b/src/modified.ts
@@ -2,7 +2,7 @@
 context two
-deleted old three
+added new three
 context four
 context five
 context six
 context seven
 context eight
@@ -20,4 +20,5 @@
 context twenty
 context twenty one
+brand new twenty two
 context twenty three
 context twenty four
diff --git a/src/old-name.ts b/src/renamed.ts
similarity index 90%
rename from src/old-name.ts
rename to src/renamed.ts
index 3333333..4444444 100644
--- a/src/old-name.ts
+++ b/src/renamed.ts
@@ -1,4 +1,4 @@
-context one
+context one changed
 rest two
 rest three
 rest four
diff --git a/src/gone.ts b/src/gone.ts
deleted file mode 100644
index 5555555..0000000
--- a/src/gone.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-line one
-line two
-line three
`;

function view(id, anchors) {
  return {
    id: `row-${id}`,
    displayId: id,
    fingerprint: `fp-${id}`,
    title: `t-${id}`,
    claim: `c-${id}`,
    trigger: "diff",
    category: "correctness",
    severity: "P2",
    status: "confirmed",
    anchors,
    evidence: [],
    memoryMatches: [],
    verifierRationale: null,
    round: 1,
    createdAt: 1,
  };
}

function mapOne(finding) {
  return mapFindingsToInlineComments([finding], parseUnifiedDiff(PATCH).files);
}

test("anchor on an added line of an added file maps inline", () => {
  const { inline, demoted } = mapOne(view("F-1", [{ path: "src/added.ts", startLine: 2 }]));
  assert.equal(inline.length, 1);
  assert.equal(inline[0].path, "src/added.ts");
  assert.equal(inline[0].new_position, 2);
  assert.equal(inline[0].finding.displayId, "F-1");
  assert.deepEqual(demoted, []);
});

test("anchor on a context line inside a hunk's new-side span maps inline (not just added lines)", () => {
  // Hunk 1 of src/modified.ts spans new lines [2, 9); line 5 is context.
  const { inline, demoted } = mapOne(view("F-2", [{ path: "src/modified.ts", startLine: 5 }]));
  assert.equal(inline.length, 1);
  assert.equal(inline[0].path, "src/modified.ts");
  assert.equal(inline[0].new_position, 5);
  assert.deepEqual(demoted, []);
});

test("anchor on the added line of the second hunk maps inline", () => {
  // Hunk 2 spans new lines [20, 25); +brand new sits on new line 22.
  const { inline } = mapOne(view("F-3", [{ path: "src/modified.ts", startLine: 22 }]));
  assert.equal(inline.length, 1);
  assert.equal(inline[0].new_position, 22);
});

test("anchor outside every hunk span is demoted (between-hunk gap)", () => {
  // Line 10 is new-side file content but not covered by hunk [2,9) or [20,25).
  const { inline, demoted } = mapOne(view("F-4", [{ path: "src/modified.ts", startLine: 10 }]));
  assert.deepEqual(inline, []);
  assert.deepEqual(demoted.map((f) => f.displayId), ["F-4"]);
});

test("anchor into a deleted file is demoted — there is no new side to comment on", () => {
  const { inline, demoted } = mapOne(view("F-5", [{ path: "src/gone.ts", startLine: 1 }]));
  assert.deepEqual(inline, []);
  assert.deepEqual(demoted.map((f) => f.displayId), ["F-5"]);
});

test("renamed file matches only under its new path; the old path is a mismatch", () => {
  const renamed = mapOne(view("F-6", [{ path: "src/renamed.ts", startLine: 1 }]));
  assert.equal(renamed.inline.length, 1);
  assert.equal(renamed.inline[0].path, "src/renamed.ts");
  assert.equal(renamed.inline[0].new_position, 1);

  const oldPath = mapOne(view("F-7", [{ path: "src/old-name.ts", startLine: 1 }]));
  assert.deepEqual(oldPath.inline, []);
  assert.deepEqual(oldPath.demoted.map((f) => f.displayId), ["F-7"]);
});

test("unknown path is demoted", () => {
  const { inline, demoted } = mapOne(view("F-8", [{ path: "src/nope.ts", startLine: 1 }]));
  assert.deepEqual(inline, []);
  assert.deepEqual(demoted.map((f) => f.displayId), ["F-8"]);
});

test("a multi-anchor finding uses the FIRST mappable anchor in order", () => {
  const finding = view("F-9", [
    { path: "src/gone.ts", startLine: 2 }, // deleted file — unmappable
    { path: "src/nope.ts", startLine: 1 }, // no such file — unmappable
    { path: "src/modified.ts", startLine: 3 }, // added line of hunk 1 — wins
    { path: "src/added.ts", startLine: 1 }, // also mappable, but later
  ]);
  const { inline, demoted } = mapOne(finding);
  assert.equal(inline.length, 1);
  assert.equal(inline[0].path, "src/modified.ts");
  assert.equal(inline[0].new_position, 3);
  assert.deepEqual(demoted, []);
});

test("a finding with no anchors at all is demoted, and ordering inline-then-demoted is stable", () => {
  const files = parseUnifiedDiff(PATCH).files;
  const findings = [
    view("F-10", []),
    view("F-11", [{ path: "src/added.ts", startLine: 4 }]),
    view("F-12", [{ path: "src/modified.ts", startLine: 99 }]),
    view("F-13", [{ path: "src/renamed.ts", startLine: 2 }]),
  ];
  const { inline, demoted } = mapFindingsToInlineComments(findings, files);
  assert.deepEqual(inline.map((c) => [c.finding.displayId, c.path, c.new_position]), [
    ["F-11", "src/added.ts", 4],
    ["F-13", "src/renamed.ts", 2],
  ]);
  assert.deepEqual(demoted.map((f) => f.displayId), ["F-10", "F-12"]);
});

test("an empty diff demotes everything (fresh branch, binary-only change)", () => {
  const { inline, demoted } = mapFindingsToInlineComments(
    [view("F-14", [{ path: "src/added.ts", startLine: 1 }])],
    [],
  );
  assert.deepEqual(inline, []);
  assert.deepEqual(demoted.map((f) => f.displayId), ["F-14"]);
});
