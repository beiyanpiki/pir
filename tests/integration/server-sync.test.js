import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import process from "node:process";
import { startServer } from "../../dist/server/server.js";
import { SqliteStore } from "../../dist/memory/sqlite-store.js";
import { FeaturesRepo } from "../../dist/memory/feature-memory.js";
import { computeProjectIdentity } from "../../dist/memory/identity.js";
import { applySnapshot, exportSnapshot } from "../../dist/memory/sync.js";
import { createTempGitRepo } from "../fixtures/helpers.js";

const execFileAsync = promisify(execFile);
const CLI = path.resolve("dist/cli/cli.js");
const TOKEN = "test-token-123";

async function makeCerts(dir) {
  await execFileAsync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=pir-test",
    "-keyout", path.join(dir, "key.pem"),
    "-out", path.join(dir, "cert.pem"),
  ]);
  return { cert: path.join(dir, "cert.pem"), key: path.join(dir, "key.pem") };
}

/** Server plus an isolated PIR_STATE_ROOT so the server DB is a temp dir. */
async function withSyncServer(t) {
  const workspace = createTempGitRepo("pir-syncsrv-ws-");
  const certDir = mkdtempSync(path.join(tmpdir(), "pir-syncsrv-certs-"));
  const stateRoot = mkdtempSync(path.join(tmpdir(), "pir-syncsrv-state-"));
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  const certs = await makeCerts(certDir);
  const handle = await startServer({
    host: "127.0.0.1",
    port: 0,
    token: TOKEN,
    workspace: workspace.dir,
    tls: { cert: readFileSync(certs.cert, "utf8"), key: readFileSync(certs.key, "utf8") },
  });
  process.env.PIR_STATE_ROOT = stateRoot;
  const port = handle.url.split(":").pop();
  const base = `https://127.0.0.1:${port}`;
  t.after(() => {
    handle.close();
    delete process.env.PIR_STATE_ROOT;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "1";
    rmSync(certDir, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
    workspace.cleanup();
  });
  return { base, stateRoot };
}

function seedServerFeature(stateRoot, projectId, key, summary) {
  const store = SqliteStore.open(path.join(stateRoot, projectId, "memory.sqlite"));
  try {
    new FeaturesRepo(store, projectId).upsert({
      key,
      name: key,
      summary,
      responsibilities: [],
      invariants: [],
      entryPoints: [],
      dependencies: [],
      relatedFeatureKeys: [],
      source: "agent_summary",
      confidence: 0.5,
      createdAtCommit: null,
      validatedAtCommit: null,
      stale: false,
    });
  } finally {
    store.close();
  }
}

test("/v1/memory/sync: pushes the client snapshot into the server DB and returns the merge", async (t) => {
  const { base, stateRoot } = await withSyncServer(t);
  const repo = createTempGitRepo("pir-syncsrc-");
  t.after(() => repo.cleanup());

  const { Memory } = await import("../../dist/memory/index.js");
  const { exportSnapshot: exportLocal } = await import("../../dist/memory/sync.js");
  const identity = await computeProjectIdentity(repo.dir);
  const clientDb = path.join(mkdtempSync(path.join(tmpdir(), "pir-synccli-")), "memory.sqlite");
  const memory = await Memory.open(repo.dir, { dbPath: clientDb });
  t.after(() => {
    memory.close();
    rmSync(path.dirname(clientDb), { recursive: true, force: true });
  });
  memory.features.upsert({
    key: "payment-retry",
    name: "Payment Retry",
    summary: "retries failed payments",
    responsibilities: [],
    invariants: [],
    entryPoints: [],
    dependencies: [],
    relatedFeatureKeys: [],
    source: "user_explicit",
    confidence: 1,
    createdAtCommit: null,
    validatedAtCommit: null,
    stale: false,
  });
  const snapshot = exportLocal(memory.store, identity.projectId);

  const response = await fetch(`${base}/v1/memory/sync`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      projectId: identity.projectId,
      remoteUrl: identity.remote,
      normalizedRemote: identity.normalizedRemote,
      rootCommit: identity.rootCommit,
      snapshot,
    }),
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.merged.tables.features.length, 1);
  assert.equal(payload.stats.tables.features.localOnly, 1);

  const serverDbPath = path.join(stateRoot, identity.projectId, "memory.sqlite");
  assert.ok(existsSync(serverDbPath), "server persists the project's memory db");
  const server = SqliteStore.open(serverDbPath);
  try {
    const rows = server.all("SELECT key FROM features WHERE project_id = ?", identity.projectId);
    assert.deepEqual(rows.map((r) => r.key), ["payment-retry"]);
  } finally {
    server.close();
  }
});

test("/v1/memory/sync: requires the bearer token", async (t) => {
  const { base } = await withSyncServer(t);
  const response = await fetch(`${base}/v1/memory/sync`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(response.status, 401);
});

test("/v1/memory/sync: rejects an identity that does not hash to the claimed projectId", async (t) => {
  const { base } = await withSyncServer(t);
  const repo = createTempGitRepo("pir-syncbad-");
  t.after(() => repo.cleanup());
  const identity = await computeProjectIdentity(repo.dir);

  const response = await fetch(`${base}/v1/memory/sync`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      projectId: "0".repeat(64),
      remoteUrl: identity.remote,
      normalizedRemote: identity.normalizedRemote,
      rootCommit: identity.rootCommit,
      snapshot: { schemaVersion: 2, projectId: "0".repeat(64), exportedAt: 0, tables: {}, writeTimes: {} },
    }),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /does not match the shipped identity/);
});

test("/v1/memory/sync: dryRun computes the merge without writing the server DB", async (t) => {
  const { base, stateRoot } = await withSyncServer(t);
  const repo = createTempGitRepo("pir-syncdry-");
  t.after(() => repo.cleanup());
  const identity = await computeProjectIdentity(repo.dir);

  const empty = {
    schemaVersion: 2,
    projectId: identity.projectId,
    exportedAt: Date.now(),
    tables: {
      projects: [],
      project_memories: [],
      features: [
        {
          id: "dry-run-feature", project_id: identity.projectId, key: "ghost", name: "ghost",
          summary: "", responsibilities: "[]", invariants: "[]", entry_points: "[]",
          dependencies: "[]", related_feature_keys: "[]", source: "agent_summary",
          confidence: 0.5, created_at_commit: null, validated_at_commit: null, stale: 0,
        },
      ],
      code_entities: [], feature_entities: [], issue_memories: [], finding_resolutions: [],
    },
    writeTimes: {},
  };
  const response = await fetch(`${base}/v1/memory/sync`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      projectId: identity.projectId,
      remoteUrl: identity.remote,
      normalizedRemote: identity.normalizedRemote,
      rootCommit: identity.rootCommit,
      snapshot: empty,
      dryRun: true,
    }),
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.merged.tables.features.length, 1);
  assert.equal(existsSync(path.join(stateRoot, identity.projectId, "memory.sqlite")), false, "dry-run writes nothing");
});

test("/v1/memory/sync: a second sync pulls server-only rows back to the client", async (t) => {
  const { base, stateRoot } = await withSyncServer(t);
  const repo = createTempGitRepo("pir-syncpull-");
  t.after(() => repo.cleanup());
  const identity = await computeProjectIdentity(repo.dir);

  // Server has a feature the client has never seen.
  seedServerFeature(stateRoot, identity.projectId, "server-only", "summarized on the server");
  // The client starts with an empty (but valid) snapshot.
  const emptySnapshot = {
    schemaVersion: 2,
    projectId: identity.projectId,
    exportedAt: Date.now(),
    tables: {
      projects: [], project_memories: [], features: [], code_entities: [],
      feature_entities: [], issue_memories: [], finding_resolutions: [],
    },
    writeTimes: {},
  };

  const response = await fetch(`${base}/v1/memory/sync`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      projectId: identity.projectId,
      remoteUrl: identity.remote,
      normalizedRemote: identity.normalizedRemote,
      rootCommit: identity.rootCommit,
      snapshot: emptySnapshot,
    }),
  });
  assert.equal(response.status, 200);
  const { merged } = await response.json();
  assert.equal(merged.tables.features.filter((f) => f.key === "server-only").length, 1);

  // What the client service does with the response: apply it locally.
  const clientDb = path.join(mkdtempSync(path.join(tmpdir(), "pir-syncpull-cli-")), "memory.sqlite");
  const client = SqliteStore.open(clientDb);
  try {
    client.run(
      `INSERT INTO projects (id, remote, normalized_remote, root_commit, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (id) DO NOTHING`,
      identity.projectId, identity.remote, identity.normalizedRemote, identity.rootCommit, Date.now(),
    );
    applySnapshot(client, identity.projectId, merged);
    const keys = client.all("SELECT key FROM features WHERE project_id = ?", identity.projectId).map((r) => r.key);
    assert.deepEqual(keys, ["server-only"]);
  } finally {
    client.close();
    rmSync(path.dirname(clientDb), { recursive: true, force: true });
  }
});

test("/v1/exec refuses to run memory sync server-side", async (t) => {
  const { base } = await withSyncServer(t);
  const response = await fetch(`${base}/v1/exec`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ argv: ["memory", "sync", "--json"] }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.code, 2, JSON.stringify(body));
  assert.ok(body.log.some((l) => l.includes("client-side command")));
});

test("CLI: pir memory sync runs locally in remote mode and merges both ways", async (t) => {
  const { base, stateRoot } = await withSyncServer(t);
  const repo = createTempGitRepo("pir-synccli-");
  const clientState = mkdtempSync(path.join(tmpdir(), "pir-synccli-state-"));
  const configDir = mkdtempSync(path.join(tmpdir(), "pir-synccli-cfg-"));
  t.after(() => {
    repo.cleanup();
    rmSync(clientState, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  });

  const baseEnv = {
    ...process.env,
    PIR_CONFIG_DIR: configDir,
    PIR_NO_WIZARD: "1",
    PIR_STATE_ROOT: clientState, // the client's own centralized state
  };
  const identity = await computeProjectIdentity(repo.dir);

  // Seed the client db locally (local mode: no PIR_SERVER_URL in env).
  const rememberEnv = { ...baseEnv };
  delete rememberEnv.PIR_SERVER_URL;
  await execFileAsync(
    process.execPath,
    [CLI, "remember", "feature", "payment-retry", "invariant", "--text", "retries are idempotent", "--cwd", repo.dir, "--json"],
    { env: rememberEnv, encoding: "utf8" },
  );

  // Seed a server-only feature behind the server's back.
  seedServerFeature(stateRoot, identity.projectId, "server-only", "summarized on the server");

  // Remote mode via env: cli.ts must keep memory sync local (no forwarding).
  const syncEnv = { ...baseEnv, PIR_SERVER_URL: base, PIR_SERVER_TOKEN: TOKEN };
  const { stdout } = await execFileAsync(
    process.execPath,
    [CLI, "memory", "sync", "--insecure", "--cwd", repo.dir, "--json"],
    { env: syncEnv, encoding: "utf8" },
  );
  const envelopeBody = JSON.parse(stdout);
  assert.equal(envelopeBody.command, "memory.sync");
  assert.ok(envelopeBody.data.stats.tables.features.remoteOnly >= 1, "server-only rows are pulled");
  assert.ok(envelopeBody.data.stats.tables.features.localOnly >= 1, "client rows are pushed");

  // The client db converged: it now holds the server-only feature.
  const client = SqliteStore.open(path.join(clientState, identity.projectId, "memory.sqlite"));
  try {
    const keys = client.all("SELECT key FROM features WHERE project_id = ?", identity.projectId).map((r) => r.key).sort();
    assert.deepEqual(keys, ["payment-retry", "server-only"]);
    const issue = client.get("SELECT COUNT(*) AS n FROM issue_memories WHERE project_id = ?", identity.projectId);
    assert.equal(issue.n, 0, "remember wrote a feature invariant, not an issue memory");
  } finally {
    client.close();
  }

  // And the server db holds the client's user knowledge.
  const server = SqliteStore.open(path.join(stateRoot, identity.projectId, "memory.sqlite"));
  try {
    const feature = server.get(
      "SELECT source FROM features WHERE project_id = ? AND key = ?",
      identity.projectId,
      "payment-retry",
    );
    assert.equal(feature.source, "user_explicit");
  } finally {
    server.close();
  }
});
