import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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

test("same-fingerprint decisions from two replicas collapse to one side's rows", async () => {
  const repo = createTempGitRepo("pir-sync-twins-");
  const { local, remote } = await openReplicas(repo);
  try {
    const fromLocal = seedIssue(local, { claim: "twin from local", decision: "expected" });
    const fromRemote = seedIssue(remote, { claim: "twin from remote", decision: "wont_fix" });
    backdateWrites(local, 1000); // local decided first; the newer write wins

    const snapLocal = exportSnapshot(local.store, local.identity.projectId);
    const snapRemote = exportSnapshot(remote.store, remote.identity.projectId);
    const ab = mergeSnapshots(snapLocal, snapRemote);
    const twins = ab.merged.tables.issue_memories.filter((m) => m.fingerprint === "fp-1");
    assert.equal(twins.length, 1, "one row per fingerprint after merge, not one per replica");
    assert.equal(twins[0].id, fromRemote.id, "the newer replica's row survives");
    assert.deepEqual(ab.merged, mergeSnapshots(snapRemote, snapLocal).merged, "group winner is order-independent");

    // Applying the merge must DELETE the losing twin, not upsert beside it.
    applySnapshot(local.store, local.identity.projectId, ab.merged);
    applySnapshot(remote.store, remote.identity.projectId, ab.merged);
    for (const memory of [local, remote]) {
      const ids = memory.store
        .all("SELECT id FROM issue_memories WHERE fingerprint = 'fp-1'")
        .map((r) => r.id)
        .sort();
      assert.deepEqual(ids, [fromRemote.id]);
    }
    assert.equal(local.issues.byFingerprint("fp-1").length, 1, "retrieval sees one live decision");
  } finally {
    local.close();
    remote.close();
    repo.cleanup();
  }
});

test("a verified fix history outranks a newer unverified twin", async () => {
  const repo = createTempGitRepo("pir-sync-verified-");
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
    backdateWrites(local, 1000); // the verification is OLDER — it must still win

    // The other replica recorded the same fix later and never verified it.
    const snapLocal = exportSnapshot(local.store, local.identity.projectId);
    const snapRemote = structuredClone(snapLocal);
    const twinId = randomUUID();
    snapRemote.tables.finding_resolutions[0].id = twinId;
    snapRemote.tables.finding_resolutions[0].verified = 0;
    snapRemote.writeTimes.finding_resolutions = { [twinId]: Date.now() };

    const { merged } = mergeSnapshots(snapLocal, snapRemote);
    const rows = merged.tables.finding_resolutions.filter((r) => r.fingerprint === "fp-9");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, inserted.id);
    assert.equal(rows[0].verified, 1, "verified beats newer-unverified regardless of time");
  } finally {
    local.close();
    repo.cleanup();
  }
});

test("issue memories without a fingerprint still union by id", async () => {
  const repo = createTempGitRepo("pir-sync-nofp-");
  const { local, remote } = await openReplicas(repo);
  try {
    // seedIssue's fingerprint override cannot express null (?? falls back), so
    // insert the fingerprint-less rows directly.
    const insertUnkeyed = (memory, claim) =>
      memory.issues.insert({
        featureKey: null,
        entityKey: null,
        fingerprint: null,
        category: "correctness",
        claim,
        trigger: "t",
        decision: "expected",
        priority: null,
        rationale: "scoped note",
        scope: "project",
        source: "user_explicit",
        anchorPaths: [],
        createdAtCommit: null,
        validUntilCommit: null,
        stale: false,
      });
    insertUnkeyed(local, "scope note A");
    insertUnkeyed(remote, "scope note B");

    const { merged } = mergeSnapshots(
      exportSnapshot(local.store, local.identity.projectId),
      exportSnapshot(remote.store, remote.identity.projectId),
    );
    assert.equal(merged.tables.issue_memories.length, 2, "no natural key — rows coexist");

    applySnapshot(remote.store, remote.identity.projectId, merged);
    const unkeyed = remote.store.all("SELECT claim FROM issue_memories WHERE fingerprint IS NULL");
    assert.deepEqual(unkeyed.map((r) => r.claim).sort(), ["scope note A", "scope note B"]);
  } finally {
    local.close();
    remote.close();
    repo.cleanup();
  }
});

test("projects.last_indexed_commit survives a merge only when both replicas agree", async () => {
  const repo = createTempGitRepo("pir-sync-lic-");
  const { local, remote } = await openReplicas(repo);
  try {
    const setIndexed = (memory, commit) =>
      memory.store.run("UPDATE projects SET last_indexed_commit = ? WHERE id = ?", commit, memory.identity.projectId);
    const merge = () =>
      mergeSnapshots(
        exportSnapshot(local.store, local.identity.projectId),
        exportSnapshot(remote.store, remote.identity.projectId),
      ).merged;

    // Divergent pointers: neither SHA is provably an ancestor on the other
    // machine — the merged pointer must not guess.
    setIndexed(local, "a".repeat(40));
    setIndexed(remote, "b".repeat(40));
    assert.equal(merge().tables.projects[0].last_indexed_commit, null);

    // One-sided pointer: adopting it could point at a foreign commit — drop it.
    setIndexed(remote, null);
    assert.equal(merge().tables.projects[0].last_indexed_commit, null);

    // Agreement: the pointer is meaningful on both sides — keep it.
    setIndexed(remote, "a".repeat(40));
    assert.equal(merge().tables.projects[0].last_indexed_commit, "a".repeat(40));
  } finally {
    local.close();
    remote.close();
    repo.cleanup();
  }
});

test("feature_entities stats report real deltas, not raw counts", async () => {
  const repo = createTempGitRepo("pir-sync-festats-");
  const { local, remote } = await openReplicas(repo);
  try {
    const seedLink = (memory, suffix) => {
      seedFeature(memory, { key: `feat-${suffix}` });
      memory.entities.upsert({
        symbolKey: `Svc.${suffix}`,
        qualifiedName: `Svc.${suffix}`,
        kind: "method",
        path: "src/x.ts",
        signature: null,
        responsibilities: [],
        invariants: [],
        notes: [],
        featureKeys: [`feat-${suffix}`],
        source: "agent_summary",
        signatureHash: null,
        bodyHash: `hash-${suffix}`,
        lastSeenCommit: null,
        stale: false,
      });
    };
    seedLink(local, "shared");
    seedLink(remote, "shared");
    seedLink(local, "only-local");

    const { stats } = mergeSnapshots(
      exportSnapshot(local.store, local.identity.projectId),
      exportSnapshot(remote.store, remote.identity.projectId),
    );
    assert.equal(stats.tables.feature_entities.localOnly, 1);
    assert.equal(stats.tables.feature_entities.remoteOnly, 0);
    assert.equal(stats.tables.feature_entities.bothIdentical, 1);
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

test("agent_fields travels with the projects/features/entities rows through sync", async () => {
  const repo = createTempGitRepo();
  const { local, remote } = await openReplicas(repo);
  try {
    local.features.upsert({
      key: "payment-retry",
      name: "Payment Retry",
      summary: "retries failed payments",
      responsibilities: ["user resp"],
      invariants: ["agent inv"],
      agentGenerated: { invariants: ["agent inv"] },
      entryPoints: [],
      dependencies: [],
      relatedFeatureKeys: [],
      source: "agent_summary",
      confidence: 0.6,
      createdAtCommit: null,
      validatedAtCommit: null,
      stale: false,
    });
    const snapshot = exportSnapshot(local.store, local.identity.projectId);
    assert.equal(snapshot.schemaVersion, MEMORY_SCHEMA_VERSION);
    assert.ok(snapshot.tables.features[0].agent_fields.includes("agent inv"), "snapshot carries the generated-set column");
    applySnapshot(remote.store, remote.identity.projectId, mergeSnapshots(
      exportSnapshot(remote.store, remote.identity.projectId),
      snapshot,
    ).merged);
    const replica = remote.features.get("payment-retry");
    assert.deepEqual(replica.invariants, ["agent inv"]);
    assert.deepEqual(replica.agentGenerated.invariants, ["agent inv"], "receiving replica can keep replacing generated entries after sync");
  } finally {
    local.close();
    remote.close();
    repo.cleanup();
  }
});
