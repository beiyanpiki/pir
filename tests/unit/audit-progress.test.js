import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Memory } from "../../dist/memory/index.js";
import { createTempGitRepo } from "../fixtures/helpers.js";

function openMemory(repo) {
  const dbPath = `${repo.dir}/.pir/memory.sqlite`;
  return Memory.open(repo.dir, { dbPath });
}

/**
 * #38 durable progress: the audit ledger and the run heartbeat must be
 * observable while a run is in flight, not only after finishRun.
 */
test("audit progress: beginRun records the target and starts the heartbeat", async () => {
  const repo = createTempGitRepo("pir-progress-");
  const memory = await openMemory(repo);
  try {
    const run = memory.findings.createRun({ base: null, head: "a".repeat(40), mode: "audit" });
    const row = memory.store.get("SELECT target, status, updated_at FROM review_runs WHERE id = ?", run.id);
    assert.equal(row.status, "running");
    assert.equal(row.updated_at !== null, true);

    memory.audit.beginRun(run.id, {
      commit: "a".repeat(40), treeId: "t".repeat(40), scopeVersion: 1, plannerVersion: 1,
      scope: { includePaths: [], skipGlobs: [] },
    });
    const target = JSON.parse(memory.store.get("SELECT target FROM review_runs WHERE id = ?", run.id).target);
    assert.equal(target.commit, "a".repeat(40));
    assert.deepEqual(target.scope, { includePaths: [], skipGlobs: [] });
  } finally {
    memory.close();
    repo.cleanup();
  }
});

test("audit progress: upsertProgress writes unit + owned-file rows and advances updated_at", async () => {
  const repo = createTempGitRepo("pir-progress-");
  const memory = await openMemory(repo);
  try {
    const run = memory.findings.createRun({ base: null, head: "a".repeat(40), mode: "audit" });
    const before = memory.store.get("SELECT updated_at FROM review_runs WHERE id = ?", run.id).updated_at;

    memory.audit.upsertProgress(run.id, {
      units: [{ unitId: "u-001", state: "reviewed", files: 2, attempts: 1 }],
      files: [
        { path: "src/a.ts", blobId: "b1", state: "reviewed", rangesTotal: 1, rangesReviewed: 1 },
        { path: "src/b.ts", blobId: "b2", state: "partial", reason: "1/2 owning units reviewed", rangesTotal: 2, rangesReviewed: 1 },
      ],
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    memory.audit.upsertProgress(run.id, {
      units: [{ unitId: "u-002", state: "in-progress", reason: "reviewer requested another pass", files: 1, attempts: 2 }],
      files: [{ path: "src/b.ts", blobId: "b2", state: "partial", reason: "1/2 owning units reviewed", rangesTotal: 2, rangesReviewed: 1 }],
    });

    const units = memory.audit.units(run.id);
    assert.equal(units.length, 2);
    const u1 = units.find((unit) => unit.unitId === "u-001");
    assert.equal(u1.state, "reviewed");
    assert.equal(u1.files, 2);
    const u2 = units.find((unit) => unit.unitId === "u-002");
    assert.equal(u2.state, "in-progress");
    assert.equal(u2.reason, "reviewer requested another pass");

    const coverage = memory.audit.fileCoverage(run.id);
    assert.equal(coverage.length, 2);
    const bRow = coverage.find((row) => row.path === "src/b.ts");
    assert.equal(bRow.state, "partial");
    assert.equal(bRow.reason, "1/2 owning units reviewed");

    // The heartbeat advanced with the last flush — the "is it alive" signal.
    const after = memory.store.get("SELECT updated_at FROM review_runs WHERE id = ?", run.id).updated_at;
    assert.ok(after > before, `updated_at must advance (${after} > ${before})`);
  } finally {
    memory.close();
    repo.cleanup();
  }
});

test("audit progress: upsertProgress updates (not duplicates) the same unit", async () => {
  const repo = createTempGitRepo("pir-progress-");
  const memory = await openMemory(repo);
  try {
    const run = memory.findings.createRun({ base: null, head: "a".repeat(40), mode: "audit" });
    memory.audit.upsertProgress(run.id, {
      units: [{ unitId: "u-001", state: "in-progress", files: 1, attempts: 1 }],
      files: [{ path: "src/a.ts", blobId: "b1", state: "unreviewed", rangesTotal: 1, rangesReviewed: 0 }],
    });
    memory.audit.upsertProgress(run.id, {
      units: [{ unitId: "u-001", state: "blocked", reason: "no pinned reads", files: 1, attempts: 2 }],
      files: [{ path: "src/a.ts", blobId: "b1", state: "blocked", reason: "owning unit blocked", rangesTotal: 1, rangesReviewed: 0 }],
    });
    const units = memory.audit.units(run.id);
    assert.equal(units.length, 1);
    assert.equal(units[0].state, "blocked");
    assert.equal(units[0].attempts, 2);
    assert.equal(memory.audit.fileCoverage(run.id).length, 1);
  } finally {
    memory.close();
    repo.cleanup();
  }
});

test("audit progress: touchRun is the generic heartbeat (find rounds use it)", async () => {
  const repo = createTempGitRepo("pir-progress-");
  const memory = await openMemory(repo);
  try {
    const run = memory.findings.createRun({ base: "b".repeat(40), head: "a".repeat(40) });
    const before = memory.store.get("SELECT updated_at FROM review_runs WHERE id = ?", run.id).updated_at;
    await new Promise((resolve) => setTimeout(resolve, 5));
    memory.findings.touchRun(run.id);
    const after = memory.store.get("SELECT updated_at FROM review_runs WHERE id = ?", run.id).updated_at;
    assert.ok(after > before, "touchRun must advance updated_at");

    memory.findings.finishRun(run.id, { rounds: 1, candidates: 0, confirmed: 0, rejected: 0, uncertain: 0, status: "completed" });
    const done = memory.store.get("SELECT status, finished_at, updated_at FROM review_runs WHERE id = ?", run.id);
    assert.equal(done.status, "completed");
    assert.ok(done.updated_at >= after, "finishRun keeps the heartbeat current");
  } finally {
    memory.close();
    repo.cleanup();
  }
});

test("migration v6: an existing (pre-updated_at) db upgrades in place", async () => {
  const repo = createTempGitRepo("pir-progress-");
  const dbPath = `${repo.dir}/.pir/memory.sqlite`;
  const memory = await Memory.open(repo.dir, { dbPath });
  const run = memory.findings.createRun({ base: null, head: "a".repeat(40), mode: "audit" });
  const projectId = memory.identity.projectId;
  memory.close();

  // Simulate a v5 db: drop the column data, recreate the table without it.
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec("BEGIN");
  db.exec(`CREATE TABLE review_runs_v5 (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'change', base TEXT, head TEXT NOT NULL, target TEXT, started_at INTEGER NOT NULL, finished_at INTEGER, status TEXT NOT NULL DEFAULT 'running', rounds INTEGER NOT NULL DEFAULT 0, candidates INTEGER NOT NULL DEFAULT 0, confirmed INTEGER NOT NULL DEFAULT 0, rejected INTEGER NOT NULL DEFAULT 0, uncertain INTEGER NOT NULL DEFAULT 0, notes TEXT)`);
  db.exec(`INSERT INTO review_runs_v5 SELECT id, project_id, mode, base, head, target, started_at, finished_at, status, rounds, candidates, confirmed, rejected, uncertain, notes FROM review_runs`);
  db.exec("DROP TABLE review_runs");
  db.exec("ALTER TABLE review_runs_v5 RENAME TO review_runs");
  // Also strip the later findings column: a genuine pre-v6 db has no
  // confidence column, so replaying v6+ must not collide with it (Q4 v7).
  db.exec("ALTER TABLE findings DROP COLUMN confidence");
  db.exec("DELETE FROM _migrations WHERE version >= 6");
  db.exec("COMMIT");
  db.close();

  // Reopening runs the migrations: v6 adds updated_at and backfills nothing
  // (NULL = "never heartbeated"), existing rows survive.
  const upgraded = await Memory.open(repo.dir, { dbPath });
  try {
    const columns = upgraded.store.all("PRAGMA table_info(review_runs)").map((row) => row.name);
    assert.ok(columns.includes("updated_at"), `updated_at column missing: ${columns.join(",")}`);
    const survived = upgraded.store.get("SELECT id FROM review_runs WHERE id = ?", run.id);
    assert.equal(survived !== undefined, true);
    const fresh = upgraded.findings.createRun({ base: null, head: "c".repeat(40), mode: "audit" });
    const row = upgraded.store.get("SELECT updated_at FROM review_runs WHERE id = ?", fresh.id);
    assert.equal(row.updated_at !== null, true);
    assert.equal(upgraded.identity.projectId, projectId);
  } finally {
    upgraded.close();
    repo.cleanup();
  }
});

test("audit progress: mid-run upserts keep the main db file current for snapshot readers", async () => {
  // The WAL staleness trap from #38: with only finishRun writes, copying
  // memory.sqlite mid-run yields a stale snapshot. A passive checkpoint
  // after each flush folds committed frames back into the main file.
  const repo = createTempGitRepo("pir-progress-");
  const memory = await openMemory(repo);
  try {
    const run = memory.findings.createRun({ base: null, head: "a".repeat(40), mode: "audit" });
    memory.audit.upsertProgress(run.id, {
      units: [{ unitId: "u-001", state: "reviewed", files: 1, attempts: 1 }],
      files: [{ path: "src/a.ts", blobId: "b1", state: "reviewed", rangesTotal: 1, rangesReviewed: 1 }],
    });
    // Read the MAIN file only (no -wal companion) the way an operator
    // copying the db mid-run would.
    const snapshot = readFileSync(`${repo.dir}/.pir/memory.sqlite`);
    const text = Buffer.from(snapshot).toString("latin1");
    assert.ok(text.includes("u-001"), "unit rows must be visible in the main db file right after the flush");
  } finally {
    memory.close();
    repo.cleanup();
  }
});
