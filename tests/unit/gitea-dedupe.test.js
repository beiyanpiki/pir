import { test } from "node:test";
import assert from "node:assert/strict";

const { partitionNewFindings } = await import("../../dist/gitea/dedupe.js");
const { REPORTED_STATUSES } = await import("../../dist/app/output.js");

/**
 * Cross-run suppression: fingerprint match partitions this run's findings,
 * only reported statuses participate, and an empty posted list (first run
 * of a PR) posts everything.
 */

function view(id, fingerprint, status) {
  return {
    id: `row-${id}`,
    displayId: id,
    fingerprint,
    title: `t-${id}`,
    claim: `c-${id}`,
    trigger: "diff",
    category: "correctness",
    severity: "P2",
    status,
    anchors: [],
    evidence: [],
    memoryMatches: [],
    verifierRationale: null,
    round: 1,
    createdAt: 1,
  };
}

test("fingerprint matches move to unchanged; the rest post", () => {
  const findings = [
    view("F-1", "fp-a", "confirmed"),
    view("F-2", "fp-b", "uncertain"),
    view("F-3", "fp-c", "confirmed"),
  ];
  const { toPost, unchanged } = partitionNewFindings(findings, ["fp-b", "fp-c"]);
  assert.deepEqual(toPost.map((f) => f.displayId), ["F-1"]);
  assert.deepEqual(unchanged.map((f) => f.displayId), ["F-2", "F-3"]);
});

test("non-reported statuses never appear in either list", () => {
  assert.deepEqual([...REPORTED_STATUSES], ["confirmed", "uncertain"]);
  const findings = [
    view("F-1", "fp-a", "rejected"),
    view("F-2", "fp-b", "expected"),
    view("F-3", "fp-c", "false_positive"),
    view("F-4", "fp-d", "candidate"),
    view("F-5", "fp-e", "confirmed"),
  ];
  // Even a non-reported fingerprint listed in the posted set stays invisible.
  const { toPost, unchanged } = partitionNewFindings(findings, ["fp-a", "fp-b", "fp-c", "fp-d", "fp-e"]);
  assert.deepEqual(toPost.map((f) => f.displayId), []);
  assert.deepEqual(unchanged.map((f) => f.displayId), ["F-5"]);
});

test("empty posted list posts every reported finding (first run of a PR)", () => {
  const findings = [view("F-1", "fp-a", "confirmed"), view("F-2", "fp-b", "uncertain")];
  const { toPost, unchanged } = partitionNewFindings(findings, []);
  assert.deepEqual(toPost.map((f) => f.displayId), ["F-1", "F-2"]);
  assert.deepEqual(unchanged, []);
});

test("input order is preserved within each partition", () => {
  const findings = [
    view("F-1", "fp-a", "confirmed"),
    view("F-2", "fp-b", "confirmed"),
    view("F-3", "fp-a", "uncertain"),
  ];
  const { toPost, unchanged } = partitionNewFindings(findings, ["fp-a"]);
  assert.deepEqual(toPost.map((f) => f.displayId), ["F-2"]);
  assert.deepEqual(unchanged.map((f) => f.displayId), ["F-1", "F-3"]);
});
