import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { SqliteStore } from "../../dist/memory/sqlite-store.js";
import { FindingStore } from "../../dist/memory/finding-store.js";

const PROJECT = "atomic-finding-project";

function openFresh(prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  return { dir, dbPath: path.join(dir, "memory.sqlite") };
}

function finding(overrides = {}) {
  return {
    title: "sample finding",
    claim: "sample claim",
    trigger: "when called",
    category: "correctness",
    severity: "P2",
    featureKey: "feature",
    entityKey: "entity",
    anchors: [],
    evidence: [{ kind: "code", path: "src/a.ts", startLine: 1 }],
    round: 1,
    identity: {
      fingerprint: "fp-sample",
      featureKey: "feature",
      entityKey: "entity",
      category: "correctness",
      normalizedClaim: "sample claim",
      normalizedTrigger: "when called",
    },
    status: "confirmed",
    memoryMatches: [],
    ...overrides,
  };
}

// Child process for the cross-process test: open the shared DB, print "ready",
// wait for the parent's "go" line (the IPC barrier — no sleeps), then allocate
// and insert findings with their evidence.
const WRITER_SCRIPT = `
import { createInterface } from "node:readline";
const { SqliteStore } = await import(process.env.PIR_ATOMIC_STORE);
const { FindingStore } = await import(process.env.PIR_ATOMIC_FINDINGS);

const store = SqliteStore.open(process.env.PIR_ATOMIC_DB);
const findings = new FindingStore(store, process.env.PIR_ATOMIC_PROJECT);
const input = createInterface({ input: process.stdin });
process.stdout.write("ready\\n");
await new Promise((resolve) => input.once("line", resolve));

const count = Number(process.env.PIR_ATOMIC_COUNT);
try {
  for (let i = 0; i < count; i += 1) {
    findings.insert({
      title: "concurrent finding " + i,
      claim: "claim " + process.pid + " " + i,
      trigger: "trigger",
      category: "correctness",
      severity: "P2",
      featureKey: "feature",
      entityKey: "entity",
      anchors: [],
      evidence: [
        { kind: "code", path: "src/a.ts", startLine: i + 1 },
        { kind: "test", path: "tests/a.test.js", description: "covers it" },
      ],
      round: 1,
      identity: {
        fingerprint: "fp-" + process.pid + "-" + i,
        featureKey: "feature",
        entityKey: "entity",
        category: "correctness",
        normalizedClaim: "claim",
        normalizedTrigger: "trigger",
      },
      status: "confirmed",
      memoryMatches: [],
    }, "run-concurrent");
  }
  store.close();
  process.exit(0);
} catch (error) {
  process.stderr.write(String(error && error.stack ? error.stack : error) + "\\n");
  process.exit(1);
}
`;

function spawnWriter({ dbPath, count }) {
  return spawn(process.execPath, ["--input-type=module", "-e", WRITER_SCRIPT], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      PIR_ATOMIC_STORE: pathToFileURL(path.resolve("dist/memory/sqlite-store.js")).href,
      PIR_ATOMIC_FINDINGS: pathToFileURL(path.resolve("dist/memory/finding-store.js")).href,
      PIR_ATOMIC_DB: dbPath,
      PIR_ATOMIC_PROJECT: PROJECT,
      PIR_ATOMIC_COUNT: String(count),
    },
  });
}

function waitForReady(child) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.includes("\n")) resolve();
    });
    child.on("exit", (code, signal) => {
      reject(new Error(`writer exited before the barrier (code ${code}, signal ${signal}): ${stderr}`));
    });
  });
}

function waitForExit(child, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`writer did not finish within ${timeoutMs}ms: ${stderr}`));
    }, timeoutMs);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stderr });
    });
  });
}

test("finding insert rolls back the finding when an evidence row fails", () => {
  const { dir, dbPath } = openFresh("pir-finding-rollback-");
  const store = SqliteStore.open(dbPath);
  const findings = new FindingStore(store, PROJECT);
  try {
    // finding_evidence.kind is NOT NULL, so this evidence row fails after the
    // finding row has already been written inside the transaction.
    assert.throws(
      () => findings.insert(finding({ evidence: [{ kind: null, path: "src/a.ts" }] }), "run-1"),
      /NOT NULL|constraint/i,
    );
    assert.equal(findings.count(), 0);
    assert.equal(store.get("SELECT COUNT(*) AS n FROM finding_evidence").n, 0);
    // The failed insert consumed no display id and left the connection usable.
    assert.equal(findings.nextDisplayId(), "F-1");
    const inserted = findings.insert(finding(), "run-1");
    assert.equal(inserted.displayId, "F-1");
    assert.equal(findings.evidence(inserted.id).length, 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two connections on one DB allocate distinct sequential display ids", () => {
  const { dir, dbPath } = openFresh("pir-finding-two-conn-");
  const first = SqliteStore.open(dbPath);
  const second = SqliteStore.open(dbPath);
  const a = new FindingStore(first, PROJECT);
  const b = new FindingStore(second, PROJECT);
  try {
    const a1 = a.insert(finding(), "run-a");
    const b1 = b.insert(finding({ claim: "from the second connection" }), "run-b");
    const a2 = a.insert(finding(), "run-a");
    assert.deepEqual([a1.displayId, b1.displayId, a2.displayId], ["F-1", "F-2", "F-3"]);
    assert.equal(a.count(), 3);
    assert.equal(b.count(), 3);
    // Committed writes are visible across connections immediately.
    assert.equal(b.get(a1.id).displayId, "F-1");
    assert.equal(first.get("SELECT COUNT(*) AS n FROM finding_evidence").n, 3);
  } finally {
    first.close();
    second.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("concurrent processes on one DB create unique F-N rows with no torn evidence", async () => {
  const { dir, dbPath } = openFresh("pir-finding-concurrent-");
  // Create the schema before the children open: their opens then only read
  // the migration ledger until the barrier releases.
  const setup = SqliteStore.open(dbPath);
  setup.close();

  const perWriter = 4;
  const writers = [0, 1, 2].map(() => spawnWriter({ dbPath, count: perWriter }));
  try {
    await Promise.all(writers.map(waitForReady));
    // IPC barrier: release all writers at once instead of sleeping.
    for (const writer of writers) writer.stdin.write("go\n");
    const exits = await Promise.all(writers.map((writer) => waitForExit(writer)));
    for (const exit of exits) {
      assert.equal(exit.code, 0, `writer failed: ${exit.stderr}`);
      assert.equal(exit.signal, null);
    }

    const store = SqliteStore.open(dbPath);
    try {
      const expected = writers.length * perWriter;
      const rows = store.all(
        "SELECT id, display_id FROM findings WHERE project_id = ? ORDER BY CAST(substr(display_id, 3) AS INTEGER)",
        PROJECT,
      );
      assert.equal(rows.length, expected);
      // Every allocation saw the previous writer's committed row, so ids are
      // unique and contiguous — no two processes claimed the same F-N.
      assert.deepEqual(
        rows.map((row) => row.display_id),
        Array.from({ length: expected }, (_, i) => `F-${i + 1}`),
      );

      const evidence = store.get("SELECT COUNT(*) AS n FROM finding_evidence");
      assert.equal(evidence.n, expected * 2);
      const torn = store.all(
        "SELECT f.id, COUNT(e.id) AS n FROM findings f LEFT JOIN finding_evidence e ON e.finding_id = f.id GROUP BY f.id HAVING n <> 2",
      );
      assert.deepEqual(torn, []);
      const orphans = store.get(
        "SELECT COUNT(*) AS n FROM finding_evidence e LEFT JOIN findings f ON f.id = e.finding_id WHERE f.id IS NULL",
      );
      assert.equal(orphans.n, 0);
    } finally {
      store.close();
    }
  } finally {
    for (const writer of writers) {
      if (writer.exitCode === null && writer.signalCode === null) writer.kill("SIGKILL");
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
