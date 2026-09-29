import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Memory } from "../../dist/memory/index.js";
import { MEMORY_SCHEMA_VERSION, applySnapshot, exportSnapshot, mergeSnapshots } from "../../dist/memory/sync.js";
import { createTempGitRepo } from "../fixtures/helpers.js";

function tempDir(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

/** Two memory DBs over the same repo: the "local" and "remote" replica. */
async function openReplicas(repo) {
  const local = await Memory.open(repo.dir, { dbPath: path.join(tempDir("pir-sync-local-"), "memory.sqlite") });
  const remote = await Memory.open(repo.dir, { dbPath: path.join(tempDir("pir-sync-remote-"), "memory.sqlite") });
  return { local, remote };
}

function seedFeature(memory, overrides = {}) {
  return memory.features.upsert({
    key: overrides.key ?? "payment-retry",
    name: overrides.name ?? "Payment Retry",
    summary: overrides.summary ?? "retries failed payments",
    responsibilities: [],
    invariants: [],
    entryPoints: [],
    dependencies: [],
    relatedFeatureKeys: [],
    source: overrides.source ?? "agent_summary",
    confidence: overrides.confidence ?? 0.6,
    createdAtCommit: null,
    validatedAtCommit: null,
    stale: false,
  });
}

function seedIssue(memory, overrides = {}) {
  return memory.issues.insert({
    featureKey: overrides.featureKey ?? "payment-retry",
    entityKey: overrides.entityKey ?? null,
    fingerprint: overrides.fingerprint ?? "fp-1",
    category: "correctness",
    claim: overrides.claim ?? "quota claim",
    trigger: "t",
    decision: overrides.decision ?? "expected",
    priority: null,
    rationale: "user said intentional",
    scope: overrides.scope ?? "feature",
    source: overrides.source ?? "user_explicit",
    createdAtCommit: null,
    validUntilCommit: null,
    stale: false,
  });
}

/** Make every prior write on a replica look old (deterministic LWW tests). */
function backdateWrites(memory, ts = 1000) {
  memory.store.run("UPDATE memory_versions SET created_at = ?", ts);
}

test("merge is symmetric and both replicas converge", async () => {
  const repo = createTempGitRepo("pir-sync-conv-");
  const { local, remote } = await openReplicas(repo);
  try {
    seedFeature(local, { summary: "local summary" });
    seedIssue(local);
    seedFeature(remote, { summary: "remote rewrote it", confidence: 0.7 });
    seedFeature(remote, { key: "auth", name: "Auth" });

    const snapLocal = exportSnapshot(local.store, local.identity.projectId);
    const snapRemote = exportSnapshot(remote.store, remote.identity.projectId);

    const ab = mergeSnapshots(snapLocal, snapRemote);
    const ba = mergeSnapshots(snapRemote, snapLocal);
    assert.deepEqual(ab.merged, ba.merged, "merge(a,b) must equal merge(b,a)");

    applySnapshot(local.store, local.identity.projectId, ab.merged);
    applySnapshot(remote.store, remote.identity.projectId, ab.merged);

    const afterLocal = exportSnapshot(local.store, local.identity.projectId);
    const afterRemote = exportSnapshot(remote.store, remote.identity.projectId);
    delete afterLocal.exportedAt;
    delete afterRemote.exportedAt;
    assert.deepEqual(afterLocal.tables, afterRemote.tables, "replicas must hold identical rows");

    // Union semantics: each side gained what only the other had.
    assert.equal(afterLocal.tables.features.filter((f) => f.key === "auth").length, 1);
    assert.equal(afterRemote.tables.issue_memories.length, 1);
    // One surviving row per natural key, not one per replica.
    assert.equal(afterLocal.tables.features.filter((f) => f.key === "payment-retry").length, 1);
  } finally {
    local.close();
    remote.close();
    repo.cleanup();
  }
});

test("user knowledge beats a newer agent write on the same record", async () => {
  const repo = createTempGitRepo("pir-sync-user-");
  const { local, remote } = await openReplicas(repo);
  try {
    seedFeature(local, { key: "auth", source: "user_explicit", summary: "user version" });
    backdateWrites(local); // the user write is OLDER — it must still win
    seedFeature(remote, { key: "auth", source: "agent_summary", summary: "agent version" });

    const { merged, stats } = mergeSnapshots(
      exportSnapshot(local.store, local.identity.projectId),
      exportSnapshot(remote.store, remote.identity.projectId),
    );
    const auth = merged.tables.features.find((f) => f.key === "auth");
    assert.equal(auth.summary, "user version");
    assert.equal(auth.source, "user_explicit");
    assert.equal(stats.tables.features.conflicts.localWon, 1);
  } finally {
    local.close();
    remote.close();
    repo.cleanup();
  }
});

test("same-source conflict: the newer write wins", async () => {
  const repo = createTempGitRepo("pir-sync-lww-");
  const { local, remote } = await openReplicas(repo);
  try {
    seedFeature(local, { key: "pay", source: "user_explicit", summary: "older" });
    backdateWrites(local);
    seedFeature(remote, { key: "pay", source: "user_explicit", summary: "newer" });

    const { merged } = mergeSnapshots(
      exportSnapshot(local.store, local.identity.projectId),
      exportSnapshot(remote.store, remote.identity.projectId),
    );
    assert.equal(merged.tables.features.find((f) => f.key === "pay").summary, "newer");
  } finally {
    local.close();
    remote.close();
    repo.cleanup();
  }
});

test("merged writeTimes keep the table-name contract and re-merge correctly", async () => {
  const repo = createTempGitRepo("pir-sync-writetimes-");
  const { local, remote } = await openReplicas(repo);
  try {
    seedFeature(local, { key: "pay", source: "user_explicit", summary: "v1" });
    backdateWrites(local, 1000);
    seedFeature(remote, { key: "pay", source: "user_explicit", summary: "v2" });
    backdateWrites(remote, 2000);

    const snapLocal = exportSnapshot(local.store, local.identity.projectId);
    const snapRemote = exportSnapshot(remote.store, remote.identity.projectId);
    const { merged } = mergeSnapshots(snapLocal, snapRemote);

    // Keys are TABLE names (the exportSnapshot/timeOf namespace), never the
    // memory-type names, and per-id times are the union of both sides.
    assert.deepEqual(Object.keys(merged.writeTimes).sort(), [
      "code_entities",
      "features",
      "finding_resolutions",
      "issue_memories",
      "project_memories",
    ]);
    const localId = snapLocal.tables.features.find((f) => f.key === "pay").id;
    const remoteId = snapRemote.tables.features.find((f) => f.key === "pay").id;
    assert.equal(merged.writeTimes.features[localId], 1000);
    assert.equal(merged.writeTimes.features[remoteId], 2000);

    // A merged snapshot is itself a valid merge input: against a third replica
    // holding an older-timestamped rewrite of the same key, the timestamps
    // carried inside `merged` must keep LWW working.
    const third = structuredClone(snapLocal);
    third.tables.features[0].summary = "v3";
    third.writeTimes.features[localId] = 1500;
    const { merged: chained } = mergeSnapshots(merged, third);
    assert.equal(chained.tables.features.find((f) => f.key === "pay").summary, "v2");
  } finally {
    local.close();
    remote.close();
    repo.cleanup();
  }
});

test("features with per-replica ids collapse to one id; feature_entities unions and remaps", async () => {
  const repo = createTempGitRepo("pir-sync-links-");
  const { local, remote } = await openReplicas(repo);
  try {
    for (const memory of [local, remote]) {
      seedFeature(memory, { key: "pay" });
      memory.entities.upsert({
        symbolKey: "PaymentService.retry",
        qualifiedName: "PaymentService.retry",
        kind: "method",
        path: "src/pay.ts",
        signature: null,
        responsibilities: [],
        invariants: [],
        notes: [],
        featureKeys: ["pay"],
        source: "agent_summary",
        signatureHash: null,
        bodyHash: "abc",
        lastSeenCommit: null,
        stale: false,
      });
    }

    const snapLocal = exportSnapshot(local.store, local.identity.projectId);
    const snapRemote = exportSnapshot(remote.store, remote.identity.projectId);
    assert.notEqual(snapLocal.tables.features[0].id, snapRemote.tables.features[0].id, "replicas mint their own uuids");

    const { merged } = mergeSnapshots(snapLocal, snapRemote);
    assert.equal(merged.tables.features.filter((f) => f.key === "pay").length, 1);
    assert.equal(merged.tables.code_entities.length, 1);
    assert.equal(merged.tables.feature_entities.length, 1, "both sides' links collapse onto the surviving ids");
    const [pair] = merged.tables.feature_entities;
    assert.equal(pair.feature_id, merged.tables.features[0].id);
    assert.equal(pair.entity_id, merged.tables.code_entities[0].id);

    applySnapshot(local.store, local.identity.projectId, merged);
    const pairs = local.store.all("SELECT * FROM feature_entities");
    assert.equal(pairs.length, 1);
  } finally {
    local.close();
    remote.close();
    repo.cleanup();
  }
});

test("a verified resolution outranks its unverified copy", async () => {
  const repo = createTempGitRepo("pir-sync-res-");
  const { local } = await openReplicas(repo);
  try {
    const inserted = local.resolutions.insert({
      findingId: "f-1",
      fingerprint: "fp-9",
      featureKey: null,
      entityKey: null,
      category: "correctness",
      originalClaim: "c",
      originalTrigger: "t",
      resolution: "fixed",
      explanation: "",
      beforeCommit: null,
      afterCommit: null,
      beforeCodeHash: null,
      afterCodeHash: null,
      fixCommit: null,
      fixDiffHash: null,
      verified: false,
    });
    local.resolutions.markVerified(inserted.id, null, null);

    const snapLocal = exportSnapshot(local.store, local.identity.projectId);
    // The other replica holds the same row before verification.
    const snapRemote = structuredClone(snapLocal);
    snapRemote.tables.finding_resolutions[0].verified = 0;

    const { merged } = mergeSnapshots(snapLocal, snapRemote);
    assert.equal(merged.tables.finding_resolutions[0].verified, 1);
  } finally {
    local.close();
    repo.cleanup();
  }
});

test("staleness flips propagate through the version log", async () => {
  const repo = createTempGitRepo("pir-sync-stale-");
  const { local, remote } = await openReplicas(repo);
  try {
    const issue = seedIssue(local);
    applySnapshot(remote.store, remote.identity.projectId, exportSnapshot(local.store, local.identity.projectId));
    backdateWrites(remote); // the replica synced a while ago

    local.issues.markStale(issue.id, true); // fresh write, versioned
    const { merged } = mergeSnapshots(
      exportSnapshot(local.store, local.identity.projectId),
      exportSnapshot(remote.store, remote.identity.projectId),
    );
    const row = merged.tables.issue_memories.find((m) => m.id === issue.id);
    assert.equal(row.stale, 1, "the fresh staleness flip wins over the stale copy");
  } finally {
    local.close();
    remote.close();
    repo.cleanup();
  }
});

test("applySnapshot is idempotent: unchanged rows cost nothing", async () => {
  const repo = createTempGitRepo("pir-sync-idem-");
  const { local, remote } = await openReplicas(repo);
  try {
    seedFeature(local);
    const { merged } = mergeSnapshots(
      exportSnapshot(local.store, local.identity.projectId),
      exportSnapshot(remote.store, remote.identity.projectId),
    );
    const first = applySnapshot(remote.store, remote.identity.projectId, merged);
    assert.equal(first.features, 1);
    const second = applySnapshot(remote.store, remote.identity.projectId, merged);
    assert.equal(second.features, 0, "re-applying an already-applied snapshot writes nothing");
    const syncVersions = remote.store.all("SELECT * FROM memory_versions WHERE reason = 'sync'");
    assert.equal(syncVersions.length, 1, "no duplicate version records");
  } finally {
    local.close();
    remote.close();
    repo.cleanup();
  }
});

test("guards: project and schema mismatches are loud", async () => {
  const repo = createTempGitRepo("pir-sync-guard-");
  const { local, remote } = await openReplicas(repo);
  try {
    seedFeature(local);
    const snap = exportSnapshot(local.store, local.identity.projectId);

    assert.throws(() => mergeSnapshots(snap, { ...snap, projectId: "0".repeat(64) }), /project mismatch/);
    const foreign = structuredClone(snap);
    foreign.projectId = "0".repeat(64);
    assert.throws(
      () => applySnapshot(remote.store, remote.identity.projectId, foreign),
      /belongs to project/,
    );
    const newer = structuredClone(snap);
    newer.schemaVersion = MEMORY_SCHEMA_VERSION + 1;
    assert.throws(() => applySnapshot(remote.store, remote.identity.projectId, newer), /schema version/);
  } finally {
    local.close();
    remote.close();
    repo.cleanup();
  }
});
