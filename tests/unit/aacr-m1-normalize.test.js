import { test } from "node:test";
import assert from "assert/strict";

import {
  DEFAULT_VIEWS, REPORTED_STATUSES, VIEWS, findingText, normalizeFilePath, normalizeFindings, safeId, toUpstreamResult,
} from "../eval/aacr/m1/normalize-aacr.js";

const finding = (over = {}) => ({
  displayId: "F-1",
  status: "confirmed",
  title: "Race in retry",
  claim: "Two flushes can update the counter",
  trigger: "concurrent flush",
  anchors: [{ path: "src/retry.ts", startLine: 10, endLine: 14 }],
  ...over,
});

const envelope = (findings, extra = {}) => ({ data: { findings, ...extra } });

test("views are exported and reported is the uncertain=keep policy", () => {
  assert.deepEqual(VIEWS, ["reported", "confirmedOnly"]);
  assert.deepEqual(DEFAULT_VIEWS, VIEWS);
  assert.deepEqual([...REPORTED_STATUSES], ["confirmed", "uncertain"]);
});

test("anchorless findings are dropped and counted, never mapped", () => {
  const rows = [
    finding(),
    finding({ displayId: "F-2", status: "uncertain", anchors: [] }),
    finding({ displayId: "F-3", anchors: [{ path: "", startLine: 3 }] }),
    finding({ displayId: "F-4", anchors: [{ path: "src/noline.ts" }] }),
    finding({ displayId: "F-5", status: "rejected", anchors: [{ path: "src/rejected.ts", startLine: 1 }] }),
    finding({ displayId: "F-6", status: "candidate", anchors: [{ path: "src/candidate.ts", startLine: 1 }] }),
  ];
  const normalized = normalizeFindings(envelope(rows));
  assert.equal(normalized.reported.length, 1);
  assert.equal(normalized.confirmedOnly.length, 1);
  // total = status-eligible rows (confirmed + uncertain); rejected/candidate
  // are outside the reported population and are not "dropped".
  assert.deepEqual(normalized.dropped, { anchorless: 3, total: 4 });
  assert.equal(normalized.reported[0].path, "src/retry.ts");
});

test("anchor selection uses the first anchor that carries a path", () => {
  const normalized = normalizeFindings(envelope([
    finding({ anchors: [{ path: "" }, { path: "./src/second.ts", startLine: 7 }] }),
  ]));
  assert.equal(normalized.reported.length, 1);
  assert.equal(normalized.reported[0].path, "src/second.ts");
  assert.equal(normalized.reported[0].start_line, 7);
  assert.equal(normalized.reported[0].end_line, 7, "missing end line closes the range at start");
});

test("line normalization: end missing, invalid or before start closes at start", () => {
  for (const anchor of [
    { path: "a.ts", startLine: 5 },
    { path: "a.ts", startLine: 5, endLine: 4 },
    { path: "a.ts", startLine: 5, endLine: 5.5 },
    { path: "a.ts", startLine: 5, endLine: "9" },
  ]) {
    const normalized = normalizeFindings(envelope([finding({ anchors: [anchor] })]));
    assert.equal(normalized.reported[0].start_line, 5);
    assert.equal(normalized.reported[0].end_line, 5);
  }
});

test("text combines title, claim and trigger deterministically with one blank line", () => {
  const row = finding({
    title: "  Race\n in   retry ",
    claim: "Two\r\nflushes\tupdate the counter",
    trigger: " concurrent\n\nflush ",
  });
  assert.equal(findingText(row), "Race in retry\n\nTwo flushes update the counter\n\nconcurrent flush");
  // Missing parts disappear without leaving extra blank lines.
  assert.equal(findingText({ title: "Only title" }), "Only title");
  assert.equal(findingText({ claim: "Only claim", trigger: "" }), "Only claim");
  assert.equal(findingText({}), "");
  const normalized = normalizeFindings(envelope([row]));
  assert.equal(normalized.reported[0].text, findingText(row));
  assert.equal(/\n{3,}/.test(normalized.reported[0].text), false);
});

test("confirmedOnly is the strict subset and keeps a stable order", () => {
  const normalized = normalizeFindings(envelope([
    finding({ displayId: "F-1", status: "uncertain", anchors: [{ path: "a.ts", startLine: 1 }] }),
    finding({ displayId: "F-2", status: "confirmed", anchors: [{ path: "b.ts", startLine: 2 }] }),
  ]));
  assert.deepEqual(normalized.reported.map((c) => c.path), ["a.ts", "b.ts"]);
  assert.deepEqual(normalized.confirmedOnly.map((c) => c.path), ["b.ts"]);
});

test("toUpstreamResult emits the OCR-shaped result file per view", () => {
  const normalized = normalizeFindings(envelope([
    finding(),
    finding({ displayId: "F-2", status: "uncertain", anchors: [{ path: "src/other.ts", startLine: 1, endLine: 2 }] }),
  ], { usage: { inputTokens: 120, outputTokens: 30, cacheReadTokens: 7 }, durationMs: 2500 }));

  const reported = toUpstreamResult(normalized, { view: "reported" });
  assert.deepEqual(reported.review.comments.map((c) => c.path), ["src/retry.ts", "src/other.ts"]);
  assert.deepEqual(reported.review.comments[0], {
    content: "Race in retry\n\nTwo flushes can update the counter\n\nconcurrent flush",
    path: "src/retry.ts",
    start_line: 10,
    end_line: 14,
  });
  assert.equal(reported.duration_seconds, 2.5);
  assert.deepEqual(reported.review.summary, { input_tokens: 120, output_tokens: 30 });
  assert.equal(reported.token_usage.input_tokens, 120);
  assert.equal(reported.token_usage.output_tokens, 30);
  assert.equal(reported.token_usage.cache_read_input_tokens, 7);

  const confirmed = toUpstreamResult(normalized, { view: "confirmedOnly" });
  assert.deepEqual(confirmed.review.comments.map((c) => c.path), ["src/retry.ts"]);
});

test("toUpstreamResult fails closed on an unknown view and missing input", () => {
  const normalized = normalizeFindings(envelope([]));
  assert.throws(() => toUpstreamResult(normalized, { view: "everything" }), /unknown view/);
  assert.throws(() => toUpstreamResult(normalized), /unknown view/);
  assert.throws(() => toUpstreamResult(null, { view: "reported" }), /normalized must be an object/);
});

test("toUpstreamResult tolerates a run without usage or duration", () => {
  const normalized = normalizeFindings(envelope([finding()]));
  const result = toUpstreamResult(normalized, { view: "reported" });
  assert.equal(result.duration_seconds, 0);
  assert.deepEqual(result.review.summary, { input_tokens: 0, output_tokens: 0 });
  assert.deepEqual(result.token_usage, { input_tokens: 0, output_tokens: 0 });
});

test("normalizeFindings rejects a missing findings array", () => {
  assert.throws(() => normalizeFindings({ data: {} }), /findings must be an array/);
  assert.throws(() => normalizeFindings(null), /findings must be an array/);
});

test("normalizeFilePath matches the upstream path shape", () => {
  assert.equal(normalizeFilePath("src/app.ts"), "src/app.ts");
  assert.equal(normalizeFilePath("./src/app.ts"), "src/app.ts");
  assert.equal(normalizeFilePath(".\\src\\app.ts"), "src/app.ts");
  assert.equal(normalizeFilePath("  src/app.ts  "), "src/app.ts");
  assert.equal(normalizeFilePath(undefined), "");
  assert.equal(normalizeFilePath(7), "");
});

test("safeId mirrors upstream config.safe_id exactly (only / is rewritten)", () => {
  assert.equal(safeId("FreeCAD/FreeCAD@a050e42"), "FreeCAD__FreeCAD@a050e42");
  assert.equal(safeId("FreeCAD__FreeCAD@a050e42"), "FreeCAD__FreeCAD@a050e42");
  assert.equal(safeId("owner/repo.js@bbbbbbb"), "owner__repo.js@bbbbbbb");
});
