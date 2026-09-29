import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import path from "node:path";
import { Memory } from "../../dist/memory/index.js";
import { buildMemoryPack, matchIssueHistory, MEMORY_PACK_PREAMBLE } from "../../dist/memory/retrieval.js";
import { classifyFreshness, hashFilesAtCommit } from "../../dist/memory/freshness.js";
import { refreshMemory } from "../../dist/memory/bootstrap.js";
import { createTempGitRepo } from "../fixtures/helpers.js";

async function setup(t) {
  const repo = createTempGitRepo();
  const memory = await Memory.open(repo.dir, { dbPath: path.join(repo.dir, ".memory.sqlite") });
  t.after(() => { memory.close(); repo.cleanup(); });
  return { repo, memory };
}

function project(memory, overrides = {}) {
  return memory.projectMemory.upsert({ architectureSummary: "API to service", responsibilities: [], invariants: ["financial writes stay idempotent"], conventions: [], riskAreas: [], featureKeys: [], source: "agent_summary", createdAtCommit: "old", validatedAtCommit: "old", stale: false, ...overrides });
}

function feature(memory, overrides = {}) {
  return memory.features.upsert({ key: "payments", name: "Payments", summary: "payment orchestration", responsibilities: [], invariants: ["one charge per attempt"], entryPoints: [], dependencies: [], relatedFeatureKeys: [], source: "agent_summary", confidence: 0.6, createdAtCommit: "old", validatedAtCommit: "old", stale: false, ...overrides });
}

function entity(memory, overrides = {}) {
  return memory.entities.upsert({ symbolKey: "Pay.retry", qualifiedName: "Pay.retry", kind: "method", path: "src/pay.ts", signature: null, responsibilities: ["coordinate attempts"], invariants: ["quota only counts attempts"], notes: [], featureKeys: ["payments"], source: "agent_summary", signatureHash: null, bodyHash: "stored", lastSeenCommit: "old", stale: false, ...overrides });
}

function issue(memory, overrides = {}) {
  return memory.issues.insert({ featureKey: "payments", entityKey: "Pay.retry", fingerprint: null, category: "correctness", claim: "retry quota consumed without remote attempt", trigger: "gateway exception", decision: "expected", priority: null, rationale: "SECRET-DECISION", scope: "symbol", source: "user_explicit", anchorPaths: ["src/pay.ts"], createdAtCommit: "old", validUntilCommit: null, stale: false, ...overrides });
}

function resolution(memory, overrides = {}) {
  return memory.resolutions.insert({ findingId: "fixture-finding", fingerprint: "fixture-fingerprint", featureKey: null, entityKey: "Pay.retry", category: "correctness", originalClaim: "entity-only quota regression", originalTrigger: "retry", resolution: "fixed", explanation: "fixed", beforeCommit: "before", afterCommit: "after", beforeCodeHash: null, afterCodeHash: null, fixCommit: "after", fixDiffHash: null, verified: true, ...overrides });
}

const input = { changedPaths: ["src/pay.ts"], entityKeys: [], featureKeys: [], headCommit: "reviewed-head" };

test("pack compresses oversized project memory without losing changed contracts or fixes", async (t) => {
  const { memory } = await setup(t);
  project(memory, { architectureSummary: "architecture detail ".repeat(2000), invariants: ["financial writes stay idempotent", "long contract ".repeat(1000)] });
  feature(memory);
  entity(memory, { notes: ["implementation detail ".repeat(1000)] });
  feature(memory, { key: "unrelated", name: "UNRELATED-FEATURE" });
  entity(memory, { symbolKey: "Other", qualifiedName: "UNRELATED-ENTITY", path: "src/other.ts", featureKeys: ["unrelated"] });
  issue(memory);
  resolution(memory);
  resolution(memory, { originalClaim: "feature-only regression", entityKey: null, featureKey: "payments" });
  resolution(memory, { originalClaim: "UNVERIFIED-FIX", verified: false });
  resolution(memory, { originalClaim: "NOT-A-FIX", resolution: "accepted_risk" });
  const pack = buildMemoryPack(memory, input, 900);
  assert.equal(pack.truncated, true);
  assert.ok(pack.approxTokens <= 900);
  for (const text of [MEMORY_PACK_PREAMBLE, "financial writes stay idempotent", "quota only counts attempts", "one charge per attempt", "entity-only quota regression", "feature-only regression"]) assert.ok(pack.text.includes(text), text);
  for (const text of ["UNRELATED-FEATURE", "UNRELATED-ENTITY", "SECRET-DECISION", "UNVERIFIED-FIX", "NOT-A-FIX"]) assert.ok(!pack.text.includes(text), text);
  assert.ok(pack.sections[0].startsWith("PROJECT"));
  assert.ok(pack.sections[1].startsWith("ENTITY: Pay.retry"));
});

test("pack honors strict approximate budget including preamble separators and omission marker", async (t) => {
  const { memory } = await setup(t);
  project(memory, { architectureSummary: "very long project ".repeat(3000) });
  entity(memory);
  feature(memory);
  resolution(memory);
  for (const budget of [0, 1, 20, 49, 50, 60, 75, 100, 150, 250, 500, 900, 4000, 10000, 100.5]) {
    const pack = buildMemoryPack(memory, input, budget);
    assert.equal(pack.approxTokens, Math.ceil(pack.text.length / 4));
    assert.ok(pack.approxTokens <= budget, `budget ${budget}, actual ${pack.approxTokens}`);
    if (pack.text) assert.ok(pack.text.startsWith(MEMORY_PACK_PREAMBLE));
    for (const section of pack.sections) assert.ok(pack.text.includes(section));
  }
});

test("entity-only explicit regression lookup works without a feature record and deduplicates fixes", async (t) => {
  const { memory } = await setup(t);
  resolution(memory);
  const explicit = buildMemoryPack(memory, { ...input, changedPaths: [], entityKeys: ["Pay.retry"] });
  assert.match(explicit.text, /entity-only quota regression/);
  entity(memory);
  resolution(memory, { originalClaim: "shared regression", featureKey: "payments" });
  const pack = buildMemoryPack(memory, input);
  assert.equal(pack.text.split("shared regression").length - 1, 1);
});

test("pack prioritizes directly changed entities over merely supplied keys deterministically", async (t) => {
  const { memory } = await setup(t);
  entity(memory);
  entity(memory, { symbolKey: "A.other", qualifiedName: "A.other", path: "src/other.ts", featureKeys: [] });
  const pack = buildMemoryPack(memory, { ...input, entityKeys: ["A.other", "Pay.retry"] });
  assert.ok(pack.text.indexOf("ENTITY: Pay.retry") < pack.text.indexOf("ENTITY: A.other"));
  assert.equal(pack.text, buildMemoryPack(memory, { ...input, entityKeys: ["Pay.retry", "A.other"] }).text);
});

test("pack annotations compare stored metadata with actual reviewed head without assuming freshness", async (t) => {
  const { memory } = await setup(t);
  project(memory, { validatedAtCommit: "reviewed-head" });
  feature(memory, { validatedAtCommit: null });
  entity(memory);
  const pack = buildMemoryPack(memory, input);
  assert.match(pack.text, /Reviewed head: reviewed-head/);
  assert.match(pack.sections[0], /validated at reviewed head/);
  assert.match(pack.sections[1], /possibly stale: changed path/);
  assert.match(pack.sections[2], /stored unknown/);
  const differentHead = buildMemoryPack(memory, { ...input, changedPaths: [], entityKeys: ["Pay.retry"], headCommit: "different-head" });
  assert.match(differentHead.sections[0], /freshness unknown/);
  entity(memory, { lastSeenCommit: "reviewed-head", stale: true });
  assert.match(buildMemoryPack(memory, input).sections[1], /possibly stale/);
  entity(memory, { lastSeenCommit: "reviewed-head" });
  assert.match(buildMemoryPack(memory, input).sections[1], /seen at reviewed head.*contracts still require validation/);
});

test("history ranks fingerprint entity feature project fuzzy independently of commit spelling", async (t) => {
  const { memory } = await setup(t);
  const fuzzy = issue(memory, { scope: "exact", fingerprint: "other", createdAtCommit: "zzzz" });
  const projectIssue = issue(memory, { scope: "project", entityKey: null, featureKey: null, createdAtCommit: "zzzz" });
  const featureIssue = issue(memory, { scope: "feature", createdAtCommit: "mmmm" });
  const entityIssue = issue(memory, { createdAtCommit: "aaaa" });
  const exact = issue(memory, { scope: "exact", fingerprint: "exact", category: "security", claim: "fingerprint remains authoritative" });
  const query = { fingerprint: "exact", claim: "retry quota consumed without remote attempt", entityKey: "Pay.retry", featureKey: "payments", category: "correctness" };
  const expected = [exact, entityIssue, featureIssue, projectIssue, fuzzy].map((entry) => entry.id);
  assert.deepEqual(matchIssueHistory(memory, query).map((entry) => entry.id), expected);
  assert.deepEqual(matchIssueHistory(memory, query).map((entry) => entry.id), expected);
});

test("scoped history honors categories declared scopes and relevant claims", async (t) => {
  const { memory } = await setup(t);
  const relevant = issue(memory);
  issue(memory, { category: "security" });
  issue(memory, { claim: "month end ledger export loses currency precision" });
  issue(memory, { entityKey: "Other.fn" });
  issue(memory, { featureKey: "shipping" });
  issue(memory, { stale: true });
  const exactOnly = issue(memory, { scope: "exact", fingerprint: "different" });
  assert.ok(!memory.issues.matchingScope({ entityKey: "Pay.retry", category: "correctness" }).some((entry) => entry.id === exactOnly.id));
  memory.issues.markStale(exactOnly.id, true);
  const query = { entityKey: "Pay.retry", featureKey: "payments", category: " Correctness ", claim: "retry quota consumed without remote attempt" };
  assert.deepEqual(matchIssueHistory(memory, query).map((entry) => entry.id), [relevant.id]);
  assert.deepEqual(matchIssueHistory(memory, { ...query, claim: "session cookie missing secure flag" }), []);
  assert.deepEqual(matchIssueHistory(memory, {}), []);
});

test("claim-only fallback preserves category drift but unrelated claims never return recent history", async (t) => {
  const { memory } = await setup(t);
  const relevant = issue(memory);
  issue(memory, { scope: "project", entityKey: null, featureKey: null, claim: "ledger export loses precision" });
  assert.deepEqual(matchIssueHistory(memory, { claim: relevant.claim, category: "regression" }).map((entry) => entry.id), [relevant.id]);
  assert.deepEqual(matchIssueHistory(memory, { claim: "database backup corrupts archives" }), []);
  assert.equal(matchIssueHistory(memory, { entityKey: "missing", claim: relevant.claim }).length, 0);
});

test("matcher never promotes agent summaries to trusted suppression evidence", async (t) => {
  const { memory } = await setup(t);
  const summary = issue(memory, { source: "agent_summary" });
  const matches = matchIssueHistory(memory, { entityKey: "Pay.retry", claim: summary.claim });
  assert.equal(matches.length, 1);
  assert.deepEqual(memory.issues.suppressionEvidence(matches), []);
});

test("missing hashes cannot prove freshness and partial hash maps do not imply deletion", async (t) => {
  const { memory } = await setup(t);
  for (const [storedHash, currentHash] of [[null, null], [null, "a"], ["a", null]]) {
    assert.equal(classifyFreshness({ storedHash, currentHash, fileExists: true }), "stale");
  }
  assert.equal(classifyFreshness({ storedHash: "a", currentHash: "a", fileExists: true }), "fresh");
  assert.equal(classifyFreshness({ storedHash: "a", currentHash: null, fileExists: false }), "invalid");
  entity(memory);
  assert.equal(memory.entities.markStaleWhereHashMismatch("head", new Map()), 0);
  assert.equal(memory.entities.get("Pay.retry").stale, false);
  assert.equal(memory.entities.markStaleWhereHashMismatch("head", new Map(), ["src/pay.ts"]), 1);
  assert.equal(memory.entities.get("Pay.retry").stale, true);
});

test("refresh marks deleted files stale without invoking a model or touching unchanged entities", async (t) => {
  const { memory, repo } = await setup(t);
  repo.write("src/pay.ts", "export const pay = 1;");
  repo.write("src/keep.ts", "export const keep = 1;");
  const before = repo.commit("fixture files", ["src/pay.ts", "src/keep.ts"]);
  const hashes = await hashFilesAtCommit(repo.dir, before, ["src/pay.ts", "src/keep.ts"]);
  entity(memory, { lastSeenCommit: before, bodyHash: hashes.get("src/pay.ts") });
  entity(memory, { symbolKey: "Keep", qualifiedName: "Keep", path: "src/keep.ts", lastSeenCommit: before, bodyHash: hashes.get("src/keep.ts"), featureKeys: [] });
  memory.setLastIndexedCommit(before);
  rmSync(path.join(repo.dir, "src/pay.ts"));
  const after = repo.commit("delete fixture", ["src/pay.ts"]);
  const result = await refreshMemory({ repoRoot: repo.dir, memory, factory: { createSession() { throw new Error("deleted-only refresh must not invoke a model"); } } });
  assert.deepEqual(result.changedFiles, ["src/pay.ts"]);
  assert.equal(result.staleMarked, 1);
  assert.equal(result.entitiesRefreshed, 0);
  assert.equal(result.headCommit, after);
  assert.equal(memory.entities.get("Pay.retry").stale, true);
  assert.equal(memory.entities.get("Keep").stale, false);
  assert.equal(memory.getLastIndexedCommit(), after);
});
