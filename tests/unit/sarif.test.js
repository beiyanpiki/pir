import { test } from "node:test";
import assert from "node:assert/strict";
import { buildIdentity } from "../../dist/findings/identity.js";
import {
  SARIF_FINGERPRINT_KEY,
  SARIF_SCHEMA,
  SARIF_VERSION,
  renderSarif,
  sarifLevel,
  sarifLog,
  sarifRuleId,
  sarifUri,
} from "../../dist/app/sarif.js";

/**
 * Roadmap S6 / ADR 0020: the SARIF 2.1.0 document `--format sarif` emits.
 * Model-free and offline: the builder is a pure function of the reported
 * findings plus the run's completion flag, and `assertValidSarif` checks the
 * subset of the schema this output actually uses (required fields, level and
 * rule-id vocabulary, location regions, fingerprints, invocation shape).
 */

function view(overrides = {}) {
  return {
    id: "row-1",
    displayId: "F-1",
    title: "unchecked error",
    claim: "The handler ignores the returned error.",
    trigger: "Any call where the error is non-nil.",
    category: "correctness",
    severity: "P1",
    status: "confirmed",
    featureKey: null,
    entityKey: null,
    anchors: [{ path: "src/a.ts", startLine: 12, endLine: 14 }],
    evidence: [],
    memoryMatches: [],
    verifierRationale: "confirmed against the call site",
    rejectionGround: null,
    confidence: 0.9,
    round: 1,
    createdAt: 1_700_000_000_000,
    lineCorrected: false,
    ...overrides,
  };
}

function input(overrides = {}) {
  return {
    command: "find",
    version: "0.0.0-test",
    findings: [view()],
    incomplete: false,
    stoppedBecause: "review complete",
    runId: "run-1",
    ...overrides,
  };
}

function assertLocation(location) {
  const uri = location.physicalLocation?.artifactLocation?.uri;
  assert.equal(typeof uri, "string");
  assert.ok(uri.length > 0);
  assert.equal(uri.startsWith("/"), false, "repository-relative URI, never absolute");
  assert.equal(uri.includes("\\"), false, "POSIX separators only");
  const region = location.physicalLocation.region;
  assert.ok(Number.isInteger(region?.startLine) && region.startLine >= 1, "startLine >= 1");
  if (region.endLine !== undefined) {
    assert.ok(Number.isInteger(region.endLine) && region.endLine >= region.startLine);
  }
}

/** The SARIF 2.1.0 subset this output uses: required fields and vocabularies. */
function assertValidSarif(log) {
  assert.equal(log.version, SARIF_VERSION);
  assert.equal(log.$schema, SARIF_SCHEMA);
  assert.ok(Array.isArray(log.runs) && log.runs.length === 1);
  const [run] = log.runs;
  const driver = run.tool?.driver;
  assert.equal(driver?.name, "pir");
  assert.equal(typeof driver.informationUri, "string");
  assert.equal(typeof driver.version, "string");
  const rules = driver.rules ?? [];
  assert.ok(Array.isArray(rules));
  const ruleIds = new Set();
  for (const rule of rules) {
    assert.match(rule.id, /^[a-z0-9._-]+$/);
    assert.equal(ruleIds.has(rule.id), false, "rule ids are unique");
    ruleIds.add(rule.id);
    assert.equal(typeof rule.shortDescription?.text, "string");
  }
  assert.ok(Array.isArray(run.invocations) && run.invocations.length === 1);
  const [invocation] = run.invocations;
  assert.equal(typeof invocation.executionSuccessful, "boolean");
  for (const note of invocation.toolExecutionNotifications ?? []) {
    assert.ok(["note", "warning", "error"].includes(note.level));
    assert.equal(typeof note.message?.text, "string");
  }
  assert.ok(Array.isArray(run.results));
  for (const result of run.results) {
    assert.ok(ruleIds.has(result.ruleId), `result ruleId ${result.ruleId} is declared`);
    assert.ok(["note", "warning", "error"].includes(result.level));
    assert.equal(typeof result.message?.text, "string");
    assert.ok(result.message.text.length > 0);
    for (const location of result.locations ?? []) assertLocation(location);
    const relatedIds = new Set();
    for (const location of result.relatedLocations ?? []) {
      assert.ok(Number.isInteger(location.id) && location.id >= 1);
      assert.equal(relatedIds.has(location.id), false, "related location ids are unique");
      relatedIds.add(location.id);
      assertLocation(location);
    }
    const fingerprint = result.partialFingerprints?.[SARIF_FINGERPRINT_KEY];
    assert.match(fingerprint ?? "", /^[0-9a-f]{64}$/);
  }
  // Round-trip through JSON: the document must be JSON-serializable as is.
  assert.deepEqual(JSON.parse(JSON.stringify(log)), log);
}

test("severity maps to the SARIF level vocabulary", () => {
  assert.equal(sarifLevel("P0"), "error");
  assert.equal(sarifLevel("P1"), "error");
  assert.equal(sarifLevel("P2"), "warning");
  assert.equal(sarifLevel("P3"), "note");
  assert.equal(sarifLevel("unknown"), "warning");
});

test("category is the rule id: lowercased, sanitized, deduplicated and sorted", () => {
  assert.equal(sarifRuleId("Correctness"), "correctness");
  assert.equal(sarifRuleId("  Security / Secrets!  "), "security-secrets");
  assert.equal(sarifRuleId(""), "other");
  assert.equal(sarifRuleId(null), "other");
  const log = sarifLog(input({
    findings: [
      view({ category: "Security", displayId: "F-1" }),
      view({ category: "correctness", displayId: "F-2" }),
      view({ category: "Security / Secrets!", displayId: "F-3" }),
      view({ category: "", displayId: "F-4" }),
    ],
  }));
  const ids = log.runs[0].tool.driver.rules.map((rule) => rule.id);
  assert.deepEqual(ids, ["correctness", "other", "security", "security-secrets"]);
  assert.deepEqual(log.runs[0].results.map((result) => result.ruleId), [
    "security", "correctness", "security-secrets", "other",
  ]);
});

test("one finding becomes one result carrying its canonical identity", () => {
  const finding = view();
  const log = sarifLog(input({ findings: [finding] }));
  const [result] = log.runs[0].results;
  const identity = buildIdentity({
    category: finding.category,
    claim: finding.claim,
    trigger: finding.trigger,
  });
  assert.equal(result.ruleId, "correctness");
  assert.equal(result.level, "error");
  assert.equal(result.message.text, finding.claim);
  assert.deepEqual(result.locations, [{
    physicalLocation: {
      artifactLocation: { uri: "src/a.ts" },
      region: { startLine: 12, endLine: 14 },
    },
  }]);
  assert.equal(result.partialFingerprints[SARIF_FINGERPRINT_KEY], identity.fingerprint);
  assert.deepEqual(result.properties, {
    displayId: "F-1",
    severity: "P1",
    status: "confirmed",
    category: "correctness",
    confidence: 0.9,
  });
  assertValidSarif(log);
});

test("multiple anchors: the primary location plus relatedLocations with unique ids", () => {
  const finding = view({
    anchors: [
      { path: "src/a.ts", startLine: 3 },
      { path: "src/b.ts", startLine: 7, endLine: 9 },
      { path: "src/c.ts", startLine: 0 },
    ],
  });
  const [result] = sarifLog(input({ findings: [finding] })).runs[0].results;
  assert.deepEqual(result.locations, [{
    physicalLocation: { artifactLocation: { uri: "src/a.ts" }, region: { startLine: 3 } },
  }]);
  assert.deepEqual(result.relatedLocations, [{
    id: 1,
    physicalLocation: { artifactLocation: { uri: "src/b.ts" }, region: { startLine: 7, endLine: 9 } },
  }]);
});

test("only reported statuses become results: rejections and suppressions are not alerts", () => {
  const log = sarifLog(input({
    findings: [
      view({ displayId: "F-1", status: "confirmed" }),
      view({ displayId: "F-2", status: "uncertain", severity: "P3", category: "style" }),
      view({ displayId: "F-3", status: "rejected", severity: "P1" }),
      view({ displayId: "F-4", status: "expected", severity: "P0" }),
      view({ displayId: "F-5", status: "false_positive" }),
      view({ displayId: "F-6", status: "accepted_risk" }),
      view({ displayId: "F-7", status: "wont_fix" }),
    ],
  }));
  assert.deepEqual(log.runs[0].results.map((result) => result.properties.displayId), ["F-1", "F-2"]);
  // Rules come from the reported set too: a category seen only on a dismissed
  // row does not enter the driver's rule list.
  assert.deepEqual(log.runs[0].tool.driver.rules.map((rule) => rule.id), ["correctness", "style"]);
  assertValidSarif(log);
});

test("a run whose every finding was dismissed still yields a valid empty log", () => {
  const log = sarifLog(input({
    findings: [view({ status: "rejected" }), view({ displayId: "F-2", status: "wont_fix" })],
  }));
  assert.deepEqual(log.runs[0].results, []);
  assert.equal("rules" in log.runs[0].tool.driver, false);
  assertValidSarif(log);
});

test("a finding without usable anchors omits locations instead of inventing one", () => {
  const [result] = sarifLog(input({ findings: [view({ anchors: [] })] })).runs[0].results;
  assert.equal("locations" in result, false);
  assert.equal("relatedLocations" in result, false);
});

test("no findings yields a valid log with empty results and no empty rules array", () => {
  const log = sarifLog(input({ findings: [] }));
  assert.deepEqual(log.runs[0].results, []);
  assert.equal("rules" in log.runs[0].tool.driver, false);
  assertValidSarif(log);
});

test("an incomplete run is represented in the invocation, not in the results", () => {
  const log = sarifLog(input({ incomplete: true, stoppedBecause: "max findings reached (10)" }));
  const [invocation] = log.runs[0].invocations;
  assert.equal(invocation.executionSuccessful, false);
  assert.deepEqual(invocation.toolExecutionNotifications, [{
    level: "warning",
    message: { text: "max findings reached (10)" },
  }]);
  assert.deepEqual(invocation.properties, { command: "find", runId: "run-1" });
  assert.deepEqual(log.runs[0].results[0].properties.status, "confirmed");
  assertValidSarif(log);
});

test("a complete run with a stop reason records a note and stays successful", () => {
  const log = sarifLog(input({ stoppedBecause: "review complete" }));
  const [invocation] = log.runs[0].invocations;
  assert.equal(invocation.executionSuccessful, true);
  assert.deepEqual(invocation.toolExecutionNotifications, [{
    level: "note",
    message: { text: "review complete" },
  }]);
  const silent = sarifLog(input({ stoppedBecause: "  " }));
  assert.equal("toolExecutionNotifications" in silent.runs[0].invocations[0], false);
});

test("an audit run carries its coverage on the invocation", () => {
  const log = sarifLog(input({
    command: "audit",
    coverage: { filesTotal: 10, filesReviewed: 9, batchesTotal: 3, batchesCompleted: 3 },
  }));
  assert.deepEqual(log.runs[0].invocations[0].properties, {
    command: "audit",
    runId: "run-1",
    coverage: { filesTotal: 10, filesReviewed: 9, batchesTotal: 3, batchesCompleted: 3 },
  });
  assert.equal(log.runs[0].invocations[0].executionSuccessful, true);
});

test("URIs are percent-encoded per segment and never absolute", () => {
  assert.equal(sarifUri("src/a.ts"), "src/a.ts");
  assert.equal(sarifUri("dir with space/ünïcode#.ts"), "dir%20with%20space/%C3%BCn%C3%AFcode%23.ts");
  const [result] = sarifLog(input({
    findings: [view({ anchors: [{ path: "dir with space/a.ts", startLine: 1 }] })],
  })).runs[0].results;
  assert.equal(result.locations[0].physicalLocation.artifactLocation.uri, "dir%20with%20space/a.ts");
});

test("rendering is deterministic, newline-terminated and lossless", () => {
  const log = sarifLog(input());
  assert.equal(renderSarif(input()), renderSarif(input()));
  assert.equal(renderSarif(input()).endsWith("\n"), true);
  assert.deepEqual(JSON.parse(renderSarif(input())), log);
  assertValidSarif(log);
});
