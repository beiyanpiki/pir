import { test } from "node:test";
import assert from "node:assert/strict";
import { renderFinding } from "../../dist/app/output.js";

/**
 * ADR-0005 / dogfood F-184: `lineCorrected` means "the excerpt match decided the
 * lines", not "the lines moved" — it is set for every uniquely located excerpt,
 * including drift 0. The human report must claim a correction only when the
 * located range differs from the model's own numbers.
 */

function finding(anchor) {
  return {
    id: "f-1",
    displayId: "F-101",
    title: "Rate applied too late",
    claim: "The running total ignores the per-item rate",
    trigger: "Calling computeTotal once",
    category: "correctness",
    severity: "P1",
    status: "confirmed",
    featureKey: null,
    entityKey: null,
    anchors: [anchor],
    evidence: [],
    memoryMatches: [],
    verifierRationale: null,
    rejectionGround: null,
    confidence: null,
    round: 1,
    createdAt: 0,
    lineCorrected: true,
  };
}

test("drift 0: an excerpt-confirmed anchor renders no correction claim", () => {
  const text = renderFinding(finding({
    path: "src/total.ts", startLine: 10, endLine: 12, excerpt: "return total * rate;",
    lineCorrected: true, originalStartLine: 10, originalEndLine: 12,
  }));
  assert.match(text, /^ {2}at: src\/total\.ts:10-12$/m);
  assert.doesNotMatch(text, /corrected/i);
});

test("drift +3: the annotation names the located range and the model's original one", () => {
  const text = renderFinding(finding({
    path: "src/total.ts", startLine: 13, endLine: 15, excerpt: "return total * rate;",
    lineCorrected: true, originalStartLine: 10, originalEndLine: 12,
  }));
  assert.match(text, /^ {2}at: src\/total\.ts:13-15 \(line corrected from 10-12\)$/m);
});

test("single-line anchors compare the same way: no claim at drift 0, a claim when the line moved", () => {
  const confirmed = renderFinding(finding({
    path: "src/total.ts", startLine: 16, excerpt: "  return total * rate;",
    lineCorrected: true, originalStartLine: 16,
  }));
  assert.match(confirmed, /^ {2}at: src\/total\.ts:16$/m);
  assert.doesNotMatch(confirmed, /corrected/i);

  const moved = renderFinding(finding({
    path: "src/total.ts", startLine: 16, excerpt: "  return total * rate;",
    lineCorrected: true, originalStartLine: 12,
  }));
  assert.match(moved, /^ {2}at: src\/total\.ts:16 \(line corrected from 12\)$/m);

  // An anchor without the flag never grows an annotation.
  const plain = renderFinding(finding({ path: "src/total.ts", startLine: 16 }));
  assert.match(plain, /^ {2}at: src\/total\.ts:16$/m);
  assert.doesNotMatch(plain, /corrected/i);
});
