import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer } from "../../dist/server/server.js";
import { SqliteStore } from "../../dist/memory/sqlite-store.js";
import { emitRunEventForTest } from "../../dist/observability/run-events.js";

const WEB_TOKEN = "web-token-456";
const PROJECT_ID = "a".repeat(64);
const RUN_ID = "11111111-2222-3333-4444-555555555555";

function buildStateFixture(root) {
  const projectDir = path.join(root, PROJECT_ID);
  mkdirSync(projectDir, { recursive: true });
  const store = SqliteStore.open(path.join(projectDir, "memory.sqlite"));
  store.run(
    "INSERT INTO projects (id, remote, normalized_remote, root_commit, created_at) VALUES (?, ?, ?, ?, ?)",
    PROJECT_ID, "https://github.com/example/widget.git", "github.com/example/widget", "f".repeat(40), Date.now(),
  );
  store.run(
    `INSERT INTO review_runs (id, project_id, mode, base, head, started_at, finished_at, status, rounds, candidates, confirmed, rejected, uncertain, notes)
     VALUES (?, ?, 'change', ?, ?, ?, ?, 'completed', 1, 2, 1, 1, 0, 'reviewer signaled completion; 0 pending')`,
    RUN_ID, PROJECT_ID, "b".repeat(40), "h".repeat(40), Date.now() - 60_000, Date.now(),
  );
  store.run(
    `INSERT INTO findings (id, project_id, run_id, display_id, fingerprint, title, claim, trigger, category, severity, status, feature_key, entity_key, anchors, memory_matches, verifier_rationale, round, created_at, updated_at)
     VALUES ('f1', ?, ?, 'F-1', 'fp', 'Off-by-one', 'The loop overruns by one.', 'diff', 'logic', 'P1', 'confirmed', NULL, NULL, '[]', '[]', 'checked the bound', 1, ?, ?)`,
    PROJECT_ID, RUN_ID, Date.now(), Date.now(),
  );
  store.run(
    `INSERT INTO finding_evidence (id, finding_id, kind, path, start_line, end_line, excerpt, description, created_at)
     VALUES ('e1', 'f1', 'code', 'src/loop.ts', 10, 12, 'for (let i = 0; i <= n; i++)', 'bound', ?)`,
    Date.now(),
  );
  store.close();

  const transcriptDir = path.join(projectDir, "transcripts", RUN_ID);
  mkdirSync(transcriptDir, { recursive: true });
  writeFileSync(path.join(transcriptDir, "reviewer-r1.json"), JSON.stringify({
    role: "code reviewer", model: "prov/m", startedAt: "2026-01-01T00:00:00Z", endedAt: "2026-01-01T00:01:00Z",
    prompt: "review this", messages: [{ role: "user", content: "review this" }], usage: { totalTokens: 10, cost: 0.01 },
  }));
  writeFileSync(path.join(transcriptDir, "run.json"), JSON.stringify({
    schemaVersion: 1, runId: RUN_ID, projectId: PROJECT_ID, mode: "change", status: "completed",
    base: "b".repeat(40), head: "h".repeat(40), model: "prov/m", startedAt: 1, finishedAt: 2,
    stoppedBecause: "reviewer signaled completion", incomplete: false, maxFindings: 10,
    rounds: [], plugins: [{ name: "typescript", version: "1.0.0", activation: "auto" }],
    sessions: [{ file: "reviewer-r1.json", sessionKind: "reviewer", round: 1 }],
    usage: { totalTokens: 10, cost: 0.01 }, durationMs: 1234, estimatedTokens: 0, files: [],
  }));
}

function buildWebFixture(root) {
  const webRoot = path.join(root, "web");
  mkdirSync(path.join(webRoot, "assets"), { recursive: true });
  writeFileSync(path.join(webRoot, "index.html"), "<!doctype html><title>pir web fixture</title><script src=\"/assets/app.js\"></script>");
  writeFileSync(path.join(webRoot, "assets", "app.js"), "console.log('fixture')");
  return webRoot;
}

async function withWebServer(t, { token = WEB_TOKEN } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "pir-web-ui-"));
  buildStateFixture(root);
  const webRoot = buildWebFixture(root);
  const handle = await startServer({
    host: "127.0.0.1",
    port: 0,
    workspace: root,
    tls: null,
    webUi: { ...(token ? { token } : {}), stateRoot: root, webRoot },
  });
  const base = handle.url;
  t.after(() => {
    handle.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { base, root };
}

test("web ui: disabled by default — classic JSON 404s are unchanged", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "pir-web-off-"));
  const handle = await startServer({ host: "127.0.0.1", port: 0, workspace: root, tls: null });
  t.after(() => {
    handle.close();
    rmSync(root, { recursive: true, force: true });
  });
  for (const pathname of ["/", "/api/overview", "/some/route"]) {
    const response = await fetch(`${handle.url}${pathname}`);
    assert.equal(response.status, 404, `${pathname} stays 404 without webUi`);
    const body = await response.json();
    assert.equal(body.error, "not found");
  }
});

test("web ui: bearer token gates the api, static shell stays public", async (t) => {
  const { base } = await withWebServer(t);

  const unauthenticated = await fetch(`${base}/api/overview`);
  assert.equal(unauthenticated.status, 401);
  const wrongToken = await fetch(`${base}/api/overview`, { headers: { authorization: "Bearer nope" } });
  assert.equal(wrongToken.status, 401);

  const overview = await fetch(`${base}/api/overview`, { headers: { authorization: `Bearer ${WEB_TOKEN}` } });
  assert.equal(overview.status, 200);
  const payload = await overview.json();
  assert.equal(payload.projects.length, 1);
  assert.equal(payload.projects[0].projectId, PROJECT_ID);
  assert.equal(payload.projects[0].remote, "github.com/example/widget");
  assert.ok(payload.projects[0].name.includes("widget"));

  // The SPA shell carries no data and needs no token.
  const index = await fetch(`${base}/`);
  assert.equal(index.status, 200);
  assert.match(index.headers.get("content-type"), /text\/html/);
  assert.match(await index.text(), /pir web fixture/);

  // SPA fallback: unknown extension-less routes serve the shell.
  const spaRoute = await fetch(`${base}/projects/${PROJECT_ID}/runs/${RUN_ID}`);
  assert.equal(spaRoute.status, 200);
  assert.match(await spaRoute.text(), /pir web fixture/);

  const asset = await fetch(`${base}/assets/app.js`);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get("content-type"), /text\/javascript/);

  // Path traversal out of the web root is refused.
  const traversal = await fetch(`${base}/..%2f..%2fpackage.json`);
  assert.notEqual(traversal.status, 200);
});

test("web ui: runs, run detail and transcripts are served read-only", async (t) => {
  const { base } = await withWebServer(t);
  const auth = { authorization: `Bearer ${WEB_TOKEN}` };

  const runs = await fetch(`${base}/api/projects/${PROJECT_ID}/runs`, { headers: auth });
  assert.equal(runs.status, 200);
  const runsBody = await runs.json();
  assert.equal(runsBody.total, 1);
  assert.equal(runsBody.runs[0].runId, RUN_ID);
  assert.equal(runsBody.runs[0].model, "prov/m");
  assert.equal(runsBody.runs[0].transcriptsAvailable, true);

  const detail = await fetch(`${base}/api/runs/${PROJECT_ID}/${RUN_ID}`, { headers: auth });
  assert.equal(detail.status, 200);
  const detailBody = await detail.json();
  assert.equal(detailBody.manifest.plugins[0].name, "typescript");
  assert.equal(detailBody.sessions[0].file, "reviewer-r1.json");
  assert.equal(detailBody.findings[0].displayId, "F-1");
  assert.equal(detailBody.findings[0].evidence[0].path, "src/loop.ts");

  const transcript = await fetch(`${base}/api/runs/${PROJECT_ID}/${RUN_ID}/transcript/reviewer-r1.json`, { headers: auth });
  assert.equal(transcript.status, 200);
  const transcriptBody = await transcript.json();
  assert.equal(transcriptBody.role, "code reviewer");

  // Transcript names are jailed to the run's directory.
  const escape = await fetch(`${base}/api/runs/${PROJECT_ID}/${RUN_ID}/transcript/${encodeURIComponent("../../memory.sqlite")}`, { headers: auth });
  assert.equal(escape.status, 404);
  const unknownRun = await fetch(`${base}/api/runs/${PROJECT_ID}/deadbeef`, { headers: auth });
  assert.equal(unknownRun.status, 404);
  const badProject = await fetch(`${base}/api/projects/not-a-project-id/runs`, { headers: auth });
  assert.equal(badProject.status, 404);

  // Read-only surface: mutating verbs are rejected outright.
  const post = await fetch(`${base}/api/overview`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: "{}" });
  assert.equal(post.status, 405);
  assert.equal((await post.json()).error, "the web endpoint is read-only");
});

test("web ui: sse streams live run events and rejects unknown runs", async (t) => {
  const { base } = await withWebServer(t);
  const auth = { authorization: `Bearer ${WEB_TOKEN}` };

  // Unknown run: the stream explains itself and closes.
  const stale = await fetch(`${base}/api/events?runId=${RUN_ID}`, { headers: auth });
  assert.equal(stale.status, 200);
  assert.match(stale.headers.get("content-type"), /text\/event-stream/);
  const staleText = await stale.text();
  assert.match(staleText, /"kind":"unavailable"/);

  // A live run in this process is buffered and replayed to late joiners.
  const runId = "live-run-1";
  const seq = { n: 0 };
  const bump = () => { seq.n += 1; return seq.n; };
  emitRunEventForTest({ kind: "run-start", runId, projectId: PROJECT_ID, seq: bump(), ts: Date.now(), mode: "change", base: null, head: "h", model: "prov/m" });
  emitRunEventForTest({ kind: "session-start", runId, projectId: PROJECT_ID, seq: bump(), ts: Date.now(), sessionId: "reviewer-1-x", sessionKind: "reviewer", role: "code reviewer", model: "prov/m", round: 1, prompt: "p" });
  emitRunEventForTest({ kind: "session-delta", runId, projectId: PROJECT_ID, seq: bump(), ts: Date.now(), sessionId: "reviewer-1-x", deltaType: "text", text: "streaming" });
  emitRunEventForTest({ kind: "session-end", runId, projectId: PROJECT_ID, seq: bump(), ts: Date.now(), sessionId: "reviewer-1-x" });

  const overview = await fetch(`${base}/api/overview`, { headers: auth });
  const overviewBody = await overview.json();
  assert.equal(overviewBody.active.length, 1);
  assert.equal(overviewBody.active[0].runId, runId);

  const detail = await fetch(`${base}/api/runs/${PROJECT_ID}/${runId}`, { headers: auth });
  // Unknown in sqlite -> 404 (the live snapshot only enriches known runs).
  assert.equal(detail.status, 404);

  const stream = await fetch(`${base}/api/events?runId=${runId}`, { headers: auth });
  // The stream stays open for future events; read until the ready marker,
  // then cancel — a browser EventSource/fetch consumer does the same.
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes('"kind":"ready"')) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  await reader.cancel();
  assert.match(text, /"kind":"run-start"/);
  assert.match(text, /"kind":"session-start"/);
  assert.match(text, /"kind":"session-delta"/);
  assert.match(text, /"kind":"session-end"/);
  assert.match(text, /"kind":"ready"/);

  // run-end retires the run from the active list.
  emitRunEventForTest({ kind: "run-end", runId, projectId: PROJECT_ID, seq: bump(), ts: Date.now(), status: "completed", stoppedBecause: "done", durationMs: 5, counts: { rounds: 1, candidates: 0, confirmed: 0, rejected: 0, uncertain: 0, pending: 0 }, findings: [] });
  const after = await fetch(`${base}/api/overview`, { headers: auth });
  const afterBody = await after.json();
  assert.equal(afterBody.active.length, 0);
});
