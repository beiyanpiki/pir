import { test } from "node:test";
import assert from "assert/strict";

import { normalizeTask, normalizeFilePath } from "../eval/reviewbench/normalize.js";

function manifestEntry(extra = {}) {
  return {
    repo: "https://github.com/example/repo",
    pr_number: 42,
    base: "b".repeat(40),
    head: "a".repeat(40),
    nwo: "example/repo",
    ...extra,
  };
}

function findingRow(extra = {}) {
  return {
    displayId: "F-1",
    status: "confirmed",
    title: "Mutex not held",
    claim: "The cache is updated without holding the mutex.",
    trigger: "cache write in handler",
    anchors: [{ path: "src/cache.ts", startLine: 10, endLine: 12 }],
    ...extra,
  };
}

function outcome(findings, extra = {}) {
  return { data: { findings, usage: { totalTokens: 1200 }, durationMs: 34000, ...extra } };
}

test("normalizeTask emits the judging-input contract field by field", () => {
  const { reported } = normalizeTask({
    manifestEntry: manifestEntry(),
    outcome: outcome([findingRow()]),
  });
  assert.deepEqual(Object.keys(reported).sort(), ["agent", "findings", "pr", "usage"]);
  assert.deepEqual(reported.pr, {
    repo: "https://github.com/example/repo",
    pr_number: 42,
    base: "b".repeat(40),
    head: "a".repeat(40),
  });
  assert.equal(reported.agent, "pir");
  assert.deepEqual(reported.usage, { total_tokens: 1200, time_in_ms: 34000 });
  assert.equal(reported.findings.length, 1);
  const finding = reported.findings[0];
  assert.deepEqual(Object.keys(finding).sort(), ["end_line", "file", "message", "producer", "start_line"]);
  assert.equal(finding.producer, "pir");
  assert.equal(finding.file, "src/cache.ts");
  assert.equal(finding.start_line, 10);
  assert.equal(finding.end_line, 12);
  assert.equal(finding.message, "Mutex not held — The cache is updated without holding the mutex. Trigger: cache write in handler");
});

test("reported includes uncertain; confirmedOnly keeps confirmed only", () => {
  const rows = [
    findingRow({ displayId: "F-1" }),
    findingRow({ displayId: "F-2", status: "uncertain", anchors: [{ path: "src/other.ts", startLine: 3 }] }),
  ];
  const { reported, confirmedOnly } = normalizeTask({ manifestEntry: manifestEntry(), outcome: outcome(rows) });
  assert.deepEqual(reported.findings.map((f) => f.file), ["src/cache.ts", "src/other.ts"]);
  assert.deepEqual(confirmedOnly.findings.map((f) => f.file), ["src/cache.ts"]);
  // confirmedOnly shares the same pr/agent/usage envelope.
  assert.deepEqual(confirmedOnly.pr, reported.pr);
  assert.deepEqual(confirmedOnly.usage, reported.usage);
});

test("non-reported statuses never reach either variant", () => {
  const rows = ["candidate", "rejected", "false_positive", "expected", "accepted_risk", "wont_fix", "fixed"].map(
    (status, index) => findingRow({ displayId: `F-${index}`, status, anchors: [{ path: `f${index}.ts`, startLine: 1 }] }),
  );
  const { reported, confirmedOnly, dropped } = normalizeTask({ manifestEntry: manifestEntry(), outcome: outcome(rows) });
  assert.deepEqual(reported.findings, []);
  assert.deepEqual(confirmedOnly.findings, []);
  assert.deepEqual(dropped, []);
});

test("end_line falls back to start_line when missing or inverted", () => {
  const rows = [
    findingRow({ anchors: [{ path: "a.ts", startLine: 7 }] }),
    findingRow({ anchors: [{ path: "b.ts", startLine: 7, endLine: 3 }] }),
  ];
  const { reported } = normalizeTask({ manifestEntry: manifestEntry(), outcome: outcome(rows) });
  assert.deepEqual(reported.findings.map((f) => [f.start_line, f.end_line]), [[7, 7], [7, 7]]);
});

test("paths are normalized to forward slashes without a leading ./", () => {
  const rows = [
    findingRow({ anchors: [{ path: ".\\src\\deep\\file.ts", startLine: 1 }] }),
    findingRow({ anchors: [{ path: "././src/top.ts", startLine: 1 }] }),
  ];
  const { reported } = normalizeTask({ manifestEntry: manifestEntry(), outcome: outcome(rows) });
  assert.deepEqual(reported.findings.map((f) => f.file), ["src/deep/file.ts", "src/top.ts"]);
  assert.equal(normalizeFilePath("  src/x.ts  "), "src/x.ts");
});

test("reported rows without a usable anchor are dropped with a counted, identifiable warning", () => {
  const rows = [
    findingRow({ displayId: "F-9", anchors: [] }),
    findingRow({ displayId: "F-10", anchors: [{ path: "ok.ts", startLine: 2 }] }),
    findingRow({ displayId: "F-11", anchors: [{ path: "", startLine: 2 }] }),
    findingRow({ displayId: "F-12", anchors: [{ path: "x.ts", startLine: 1.5 }] }),
    findingRow({ displayId: "F-13", anchors: [{ path: "x.ts", startLine: 0 }] }),
  ];
  const { reported, confirmedOnly, dropped } = normalizeTask({ manifestEntry: manifestEntry(), outcome: outcome(rows) });
  assert.deepEqual(reported.findings.map((f) => f.file), ["ok.ts"]);
  assert.deepEqual(confirmedOnly.findings.map((f) => f.file), ["ok.ts"]);
  assert.deepEqual(dropped.map((d) => d.displayId), ["F-9", "F-11", "F-12", "F-13"]);
  for (const d of dropped) assert.equal(typeof d.reason, "string");
});

test("usage fields are omitted when not measurably present", () => {
  const noUsage = normalizeTask({
    manifestEntry: manifestEntry(),
    outcome: { data: { findings: [], usage: null, durationMs: null } },
  });
  assert.equal("usage" in noUsage.reported, false);
  assert.equal("usage" in noUsage.confirmedOnly, false);

  const onlyDuration = normalizeTask({
    manifestEntry: manifestEntry(),
    outcome: { data: { findings: [], usage: { totalTokens: null }, durationMs: 5 } },
  });
  assert.deepEqual(onlyDuration.reported.usage, { time_in_ms: 5 });

  const negativeTokens = normalizeTask({
    manifestEntry: manifestEntry(),
    outcome: { data: { findings: [], usage: { totalTokens: -1 }, durationMs: 5 } },
  });
  assert.deepEqual(negativeTokens.reported.usage, { time_in_ms: 5 });
});

test("message tolerates missing title or claim without breaking the shape", () => {
  const rows = [
    findingRow({ title: "", anchors: [{ path: "a.ts", startLine: 1 }] }),
    findingRow({ claim: "", anchors: [{ path: "b.ts", startLine: 1 }] }),
  ];
  const { reported } = normalizeTask({ manifestEntry: manifestEntry(), outcome: outcome(rows) });
  assert.equal(reported.findings[0].message, "The cache is updated without holding the mutex. Trigger: cache write in handler");
  assert.equal(reported.findings[1].message, "Mutex not held Trigger: cache write in handler");
});

test("non-array findings is a contract violation, not an empty review", () => {
  assert.throws(() => normalizeTask({ manifestEntry: manifestEntry(), outcome: { data: {} } }), TypeError);
  assert.throws(() => normalizeTask({ manifestEntry: manifestEntry(), outcome: { data: { findings: null } } }), TypeError);
});
