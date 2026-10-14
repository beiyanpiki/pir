import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Memory } from "../../dist/memory/index.js";
import { computeProjectIdentity } from "../../dist/memory/identity.js";
import { buildIdentity } from "../../dist/findings/identity.js";
import { compareRuns, listProjectFindings, listRuns } from "../../dist/server/web-store.js";
import { createTempGitRepo } from "../fixtures/helpers.js";

// Web-store read contracts: legacy archives (the web tier opens
// memory.sqlite read-only and never migrates) still answer, and the runs
// list pages in SQL instead of mapping the project's whole run history per
// request.

async function seedProject(stateRoot, heads) {
  const repo = createTempGitRepo("pir-webstore-");
  const projectId = (await computeProjectIdentity(repo.dir)).projectId;
  const projectDir = path.join(stateRoot, projectId);
  mkdirSync(projectDir, { recursive: true });
  const memory = await Memory.open(repo.dir, { dbPath: path.join(projectDir, "memory.sqlite") });
  const insertFinding = (run, tag) =>
    memory.findings.insert(
      {
        title: `finding ${tag}`,
        claim: `claim for ${tag}`,
        trigger: "when reviewed",
        category: "correctness",
        severity: "P2",
        featureKey: "web-store",
        entityKey: `Entity.${tag}`,
        anchors: [{ path: `src/${tag}.ts`, startLine: 5 }],
        evidence: [{ kind: "code", path: `src/${tag}.ts`, startLine: 5, excerpt: "const x = 1;" }],
        round: 1,
        identity: buildIdentity({
          featureKey: "web-store",
          entityKey: `Entity.${tag}`,
          category: "correctness",
          claim: `claim for ${tag}`,
          trigger: "when reviewed",
        }),
        status: "confirmed",
        memoryMatches: [],
      },
      run.id,
    );
  const runs = heads.map((head) => memory.findings.createRun({ base: null, head, mode: "change" }));
  return { repo, memory, projectId, projectDir, runs, insertFinding };
}

test("legacy archive without findings.confidence: project findings and run compare still answer", async () => {
  const stateRoot = mkdtempSync(path.join(tmpdir(), "pir-webstore-state-"));
  const { repo, memory, projectId, runs, insertFinding } = await seedProject(stateRoot, ["a".repeat(40)]);
  insertFinding(runs[0], "legacy");
  memory.close();

  // Simulate a pre-v7 archive: the column v7 added is absent. The web tier
  // never migrates, so its reads must probe for the column, not assume it.
  const db = new DatabaseSync(path.join(stateRoot, projectId, "memory.sqlite"));
  db.exec("ALTER TABLE findings DROP COLUMN confidence");
  db.close();

  try {
    const listed = listProjectFindings(projectId, {}, stateRoot);
    assert.ok(listed, "listProjectFindings must answer on a pre-v7 archive");
    assert.equal(listed.total, 1);
    assert.equal(listed.findings.length, 1);
    assert.equal(listed.findings[0].confidence, null);

    const compared = compareRuns(projectId, runs[0].id, runs[0].id, stateRoot);
    assert.ok(compared, "compareRuns must answer on a pre-v7 archive");
    assert.equal(compared.summary.unchanged, 1);
    assert.equal(compared.summary.added, 0);
    assert.equal(compared.summary.removed, 0);
    assert.equal(compared.unchanged[0].before.confidence, null);
    assert.equal(compared.unchanged[0].after.confidence, null);
  } finally {
    rmSync(stateRoot, { recursive: true, force: true });
    repo.cleanup();
  }
});
