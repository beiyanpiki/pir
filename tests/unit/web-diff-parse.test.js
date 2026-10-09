import { test } from "node:test";
import assert from "node:assert/strict";
// Type-stripped import: diff-parse.ts is the pure (React-free) parser for
// get_change tool results, kept out of diff-view.tsx so this suite can drive
// the exact response formats the tool emits (see src/tools/review-tools.ts).
import { parseDiff } from "../../web/src/components/session/diff-parse.ts";

// get_change response shapes, condensed from real reviewer transcripts.

const LISTING = [
  'merge-base aaa -> head bbb (569 changed lines, 4 files)',
  'requested base: aaa',
  '## "web/src/App.tsx" [modified] (+17/-61); hunks: 2',
  'hunkIndex: 0; @@ -1,5 +1,4 @@; raw diff lines: 5',
  'get_change: {"path":"web/src/App.tsx","hunkIndex":0,"offset":0,"limit":120}',
  ' import { useMemo } from "react";',
  '-import { Message } from "@/components/ai-elements/message";',
  ' import { fmtClock } from "../../format";',
  '+import { ToolRow } from "./blocks";',
  'hunkIndex: 1; @@ -10,7 +9,7 @@ import type {; raw diff lines: 8',
  'get_change: {"path":"web/src/App.tsx","hunkIndex":1,"offset":0,"limit":120}',
  '   ToolResultMessage,',
  '-import { RawBlock } from "./blocks";',
  '+import { ToolRow } from "./blocks";',
  ' ',
  'entries: 2; returned: 2; offset: 0; truncated: false',
  'continuation: null',
].join("\n");

const OVERVIEW_NO_BODIES = [
  'merge-base aaa -> head bbb (569 changed lines, 4 files)',
  'requested base: aaa',
  '## "web/src/App.tsx" [modified] (+17/-61); hunks: 6',
  'get_change: {"path":"web/src/App.tsx"}',
  '## "web/src/layout/Sidebar.tsx" [modified] (+128/-32); hunks: 3',
  'get_change: {"path":"web/src/layout/Sidebar.tsx"}',
  'entries: 4; returned: 4; offset: 0; truncated: true',
  'continuation: null',
  'Hunk bodies omitted in overview; use the get_change requests above, then follow continuation for both -removed and +added lines.',
].join("\n");

const OVERVIEW_WITH_BODIES = [
  'merge-base aaa -> head bbb (30 changed lines, 1 file)',
  '## "lib.ts" [modified] (+3/-1); hunks: 2',
  'get_change: {"path":"lib.ts"}',
  'hunkIndex: 0; @@ -1,3 +1,3 @@',
  ' context',
  '-removed',
  '+added',
  'hunkIndex: 1; @@ -10,3 +10,4 @@',
  ' tail-context',
  '+tail-added',
  'continuation: null',
].join("\n");

const SINGLE_HUNK = [
  'merge-base aaa -> head bbb (30 changed lines, 1 file)',
  '## "lib.ts" [added] (+3/-0); hunks: 1',
  'hunkIndex: 0; @@ -0,0 +1,3 @@',
  'raw diff lines: 3; offset: 0; charOffset: 0',
  '+one',
  '+two',
  '+three',
  'truncated: false; continuation: null',
  'nextHunk: null',
].join("\n");

test("parseDiff: hunk listing keeps body lines past the interleaved get_change hint", () => {
  const files = parseDiff(LISTING);
  assert.equal(files.length, 1);
  const [file] = files;
  assert.equal(file.path, "web/src/App.tsx");
  assert.equal(file.status, "modified");
  assert.equal(file.additions, 17);
  assert.equal(file.deletions, 61);
  assert.equal(file.hunks.length, 2, "both hunk headers become hunks");

  const [first, second] = file.hunks;
  assert.deepEqual(
    first.lines.map((line) => [line.kind, line.text]),
    [
      ["context", 'import { useMemo } from "react";'],
      ["delete", 'import { Message } from "@/components/ai-elements/message";'],
      ["context", 'import { fmtClock } from "../../format";'],
      ["add", 'import { ToolRow } from "./blocks";'],
    ],
    "body lines survive the get_change: suggestion between header and body",
  );
  assert.equal(first.lines[1].oldLine, 2, "removed lines carry old-side numbers");
  assert.equal(first.lines[3].newLine, 3, "added lines carry new-side numbers");
  assert.deepEqual(
    second.lines.map((line) => line.kind),
    ["context", "delete", "add", "context"],
  );
});

test("parseDiff: overview without bodies keeps its files as a zero-hunk list", () => {
  const files = parseDiff(OVERVIEW_NO_BODIES);
  assert.equal(files.length, 2, "files are not dropped when no hunks were inlined");
  assert.deepEqual(
    files.map((file) => [file.path, file.hunks.length]),
    [
      ["web/src/App.tsx", 0],
      ["web/src/layout/Sidebar.tsx", 0],
    ],
  );
});

test("parseDiff: overview with inlined bodies splits hunks per hunkIndex", () => {
  const files = parseDiff(OVERVIEW_WITH_BODIES);
  assert.equal(files.length, 1);
  assert.equal(files[0].hunks.length, 2);
  assert.deepEqual(
    files[0].hunks[0].lines.map((line) => line.kind),
    ["context", "delete", "add"],
  );
  assert.deepEqual(
    files[0].hunks[1].lines.map((line) => line.kind),
    ["context", "add"],
  );
});

test("parseDiff: single-hunk pages parse as before", () => {
  const files = parseDiff(SINGLE_HUNK);
  assert.equal(files.length, 1);
  assert.equal(files[0].status, "added");
  assert.equal(files[0].hunks.length, 1);
  assert.deepEqual(
    files[0].hunks[0].lines.map((line) => [line.kind, line.newLine]),
    [
      ["add", 1],
      ["add", 2],
      ["add", 3],
    ],
  );
});

test("parseDiff: unparsed output yields nothing (raw fallback in the view)", () => {
  assert.deepEqual(parseDiff("no diff structure at all"), []);
});

test("parseDiff: a standalone @@ header without file context synthesizes a file", () => {
  const files = parseDiff("@@ -1,2 +1,2 @@\n keep\n-gone\n+new\n tail");
  assert.equal(files.length, 1);
  assert.equal(files[0].path, "change");
  assert.equal(files[0].hunks.length, 1);
  assert.deepEqual(
    files[0].hunks[0].lines.map((line) => line.kind),
    ["context", "delete", "add", "context"],
  );
});
