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
const AUDIT_RUN_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

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
  store.run(
    `INSERT INTO review_runs (id, project_id, mode, base, head, target, started_at, finished_at, status, rounds, candidates, confirmed, rejected, uncertain, notes, updated_at)
     VALUES (?, ?, 'audit', NULL, ?, ?, ?, ?, 'incomplete', 1, 1, 0, 0, 1, 'budget reached', ?)`,
    AUDIT_RUN_ID, PROJECT_ID, "a".repeat(40), JSON.stringify({ commit: "a".repeat(40), scope: { includePaths: [], skipGlobs: [] } }), Date.now() - 5000, Date.now(), Date.now(),
  );
  store.run("INSERT INTO audit_work_units (run_id, unit_id, state, attempts, files, reason, updated_at) VALUES (?, 'unit-1', 'reviewed', 1, 1, NULL, ?)", AUDIT_RUN_ID, Date.now());
  store.run("INSERT INTO audit_file_coverage (run_id, path, blob_id, state, reason, ranges_total, ranges_reviewed, updated_at) VALUES (?, 'src/a.ts', 'blob', 'reviewed', NULL, 1, 1, ?)", AUDIT_RUN_ID, Date.now());
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
    verifierModel: "prov/verifier", runVerdict: "incorrect", changeCoverage: { hunksTotal: 2, hunksCovered: 1, filesTotal: 1, filesCovered: 0, files: [{ path: "src/loop.ts", covered: 1, total: 2 }] },
  }));
  mkdirSync(path.join(projectDir, "transcripts", AUDIT_RUN_ID), { recursive: true });
  writeFileSync(path.join(projectDir, "transcripts", AUDIT_RUN_ID, "run.json"), JSON.stringify({
    schemaVersion: 1, runId: AUDIT_RUN_ID, projectId: PROJECT_ID, mode: "audit", status: "incomplete", base: null, head: "a".repeat(40), model: "prov/m", verifierModel: null, startedAt: 1, finishedAt: 2,
    stoppedBecause: "budget reached", incomplete: true, runVerdict: "needs-review", maxFindings: 10, rounds: [], plugins: [], sessions: [], durationMs: 100, estimatedTokens: 0,
    coverage: { filesTotal: 1, filesNotSelected: 0, filesExcluded: 0, filesInScope: 1, filesReviewed: 1, filesPartial: 0, filesUnreviewed: 0, filesBlocked: 0, filesFailed: 0, batchesTotal: 1, batchesCompleted: 1, batchesBlocked: 0, batchesFailed: 0 },
    units: [{ id: "unit-1", module: "src", state: "reviewed", files: 1, attempts: 1 }],
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

  // Malformed percent-escapes must answer 400, never escape the request
  // listener (an unhandled throw there kills the whole serve process, and
  // the static branch runs BEFORE any token check — F-17 regression).
  for (const malformed of ["/%", "/%zz", "/assets/%E0%A4%A"]) {
    const response = await fetch(`${base}${malformed}`);
    assert.equal(response.status, 400, `${malformed} answers 400`);
    assert.equal((await response.json()).error, "malformed request path");
  }
  const afterMalformed = await fetch(`${base}/api/overview`, { headers: { authorization: `Bearer ${WEB_TOKEN}` } });
  assert.equal(afterMalformed.status, 200, "server stays alive after malformed paths");
});

test("web ui: the retired /next prefix is no longer special-cased", async (t) => {
  const { base } = await withWebServer(t);

  // The legacy app is gone, so /next is an ordinary SPA route: the shell is
  // served and the client router renders not-found. No redirect, and no
  // Location header that could be turned into an open redirect.
  for (const path of ["/next", "/next/projects/abc", "/next//attacker.example", "/next/\\attacker.example?x=1"]) {
    const response = await fetch(`${base}${path}`, { redirect: "manual" });
    assert.equal(response.status, 200, `${path} serves the shell`);
    assert.equal(response.headers.get("location"), null, `${path} does not redirect`);
    assert.match(await response.text(), /pir web fixture/);
  }
});

test("web ui: runs, run detail and transcripts are served read-only", async (t) => {
  const { base, root } = await withWebServer(t);
  const auth = { authorization: `Bearer ${WEB_TOKEN}` };

  const runs = await fetch(`${base}/api/projects/${PROJECT_ID}/runs`, { headers: auth });
  assert.equal(runs.status, 200);
  const runsBody = await runs.json();
  assert.equal(runsBody.total, 2);
  assert.ok(runsBody.runs.some((run) => run.runId === RUN_ID));
  assert.equal(runsBody.runs.find((run) => run.runId === RUN_ID).model, "prov/m");
  assert.equal(runsBody.runs[0].transcriptsAvailable, true);

  const detail = await fetch(`${base}/api/runs/${PROJECT_ID}/${RUN_ID}`, { headers: auth });
  assert.equal(detail.status, 200);
  const detailBody = await detail.json();
  assert.equal(detailBody.manifest.plugins[0].name, "typescript");
  assert.equal(detailBody.sessions[0].file, "reviewer-r1.json");
  // Findings are summary rows in the detail; heavy fields load per row.
  assert.equal(detailBody.findings.total, 1);
  assert.equal(detailBody.findings.items[0].displayId, "F-1");
  assert.equal(detailBody.findings.items[0].evidenceCount, 1);
  assert.equal(detailBody.findings.items[0].claim, undefined);

  const changeCoverage = await fetch(`${base}/api/runs/${PROJECT_ID}/${RUN_ID}/coverage`, { headers: auth });
  assert.equal(changeCoverage.status, 200);
  const changeView = await changeCoverage.json();
  assert.equal(changeView.mode, "change");
  assert.equal(changeView.summary.hunksCovered, 1);
  assert.equal(changeView.files[0].path, "src/loop.ts");
  const auditCoverage = await fetch(`${base}/api/runs/${PROJECT_ID}/${AUDIT_RUN_ID}/coverage`, { headers: auth });
  assert.equal(auditCoverage.status, 200);
  const auditView = await auditCoverage.json();
  assert.equal(auditView.mode, "audit");
  assert.equal(auditView.summary.batchesCompleted, 1);
  assert.equal(auditView.units[0].id, "unit-1");
  assert.equal(auditView.files[0].path, "src/a.ts");
  assert.equal(auditView.target.commit, "a".repeat(40));

  const findingDetail = await fetch(`${base}/api/runs/${PROJECT_ID}/${RUN_ID}/findings/f1`, { headers: auth });
  assert.equal(findingDetail.status, 200);
  const finding = await findingDetail.json();
  assert.equal(finding.displayId, "F-1");
  assert.equal(finding.evidence[0].path, "src/loop.ts");
  assert.equal(finding.verifierRationale, "checked the bound");

  const transcript = await fetch(`${base}/api/runs/${PROJECT_ID}/${RUN_ID}/transcript/reviewer-r1.json`, { headers: auth });
  assert.equal(transcript.status, 200);
  const transcriptBody = await transcript.json();
  assert.equal(transcriptBody.role, "code reviewer");

  const missingTranscript = await fetch(`${base}/api/runs/${PROJECT_ID}/${RUN_ID}/transcript/missing.json`, { headers: auth });
  assert.equal(missingTranscript.status, 404);
  writeFileSync(path.join(root, PROJECT_ID, "transcripts", RUN_ID, "broken.json"), "{corrupt");
  const brokenTranscript = await fetch(`${base}/api/runs/${PROJECT_ID}/${RUN_ID}/transcript/broken.json`, { headers: auth });
  assert.equal(brokenTranscript.status, 500, "corrupt transcripts are server errors, not missing files");

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

test("web ui: run lists still serve archives written before the mode column", async (t) => {
  const { base, root } = await withWebServer(t);
  const auth = { authorization: `Bearer ${WEB_TOKEN}` };
  const store = SqliteStore.open(path.join(root, PROJECT_ID, "memory.sqlite"));
  // Pre-v5 archives have no review_runs.mode column and were never migrated.
  store.run("ALTER TABLE review_runs DROP COLUMN mode");
  store.close();
  const list = async (suffix) => {
    const response = await fetch(`${base}/api/projects/${PROJECT_ID}/runs${suffix}`, { headers: auth });
    return { status: response.status, body: await response.json() };
  };
  const all = await list("");
  assert.equal(all.status, 200);
  const total = all.body.total;
  assert.ok(total === 1 || total === 2, `fixture has one or two runs (got ${total})`);
  assert.ok(all.body.runs.every((run) => run.mode === "change"));
  const change = await list("?mode=change");
  assert.equal(change.status, 200);
  assert.equal(change.body.total, total);
  const audit = await list("?mode=audit");
  assert.equal(audit.status, 200, "an audit filter on a pre-v5 archive is empty, not a 404");
  assert.equal(audit.body.total, 0);
});

test("web ui: project search, memory, feedback and fingerprint comparison stay read-only", async (t) => {
  const { base, root } = await withWebServer(t);
  const auth = { authorization: `Bearer ${WEB_TOKEN}` };
  const store = SqliteStore.open(path.join(root, PROJECT_ID, "memory.sqlite"));
  store.run(`INSERT INTO findings (id, project_id, run_id, display_id, fingerprint, title, claim, trigger, category, severity, status, anchors, memory_matches, round, created_at, updated_at)
    VALUES ('f2', ?, ?, 'F-99', 'fp', 'Same issue later', 'The loop overruns by one.', 'diff', 'logic', 'P2', 'uncertain', '[]', '[]', 1, ?, ?)`, PROJECT_ID, AUDIT_RUN_ID, Date.now() + 1000, Date.now() + 1000);
  store.run(`INSERT INTO issue_memories (id, project_id, fingerprint, claim, decision, rationale, scope, valid_until_commit, stale)
    VALUES ('i1', ?, 'fp', 'Known loop bound', 'expected', 'Owner accepted this bound', 'project', 'deadbeef', 1)`, PROJECT_ID);
  store.run(`INSERT INTO finding_resolutions (id, finding_id, fingerprint, original_claim, resolution, created_at)
    VALUES ('res1', 'f1', 'fp', 'Loop bound', 'fixed', 1)`);
  store.run(`INSERT INTO feedback_events (ts, finding_id, action, decision, note) VALUES (1, 'f1', 'feedback', 'expected', 'Accepted by owner')`);
  store.close();
  const get = async (suffix) => { const response = await fetch(`${base}/api/projects/${PROJECT_ID}/${suffix}`, { headers: auth }); assert.equal(response.status, 200, suffix); return response.json(); };
  const runs = await get('runs?q=prov%2Fm&limit=1&offset=1');
  assert.equal(runs.total, 2); assert.equal(runs.runs.length, 1);
  assert.equal((await get('runs?q=budget&mode=audit')).total, 1);
  assert.equal((await get('runs?q=' + encodeURIComponent('definitely-no-match-' + Date.now()))).total, 0);
  const findings = await get('findings?q=loop&status=uncertain&severity=P2&limit=1');
  assert.equal(findings.total, 1); assert.equal(findings.findings[0].fingerprint, 'fp'); assert.equal(findings.findings[0].runId, AUDIT_RUN_ID);
  assert.equal((await get('findings?limit=1&offset=1')).findings.length, 1);
  assert.equal((await get('findings?limit=nan&offset=-3')).findings.length, 2);
  const memory = await get('memory?q=Known');
  assert.equal(memory.total, 1); assert.equal(memory.items[0].stale, true);
  assert.equal(memory.items[0].validUntilCommit, 'deadbeef');
  assert.equal(memory.items[0].relatedFinding.displayId, 'F-99');
  assert.equal((await get('memory')).resolutions[0].relatedFinding.displayId, 'F-1');
  const feedback = await get('feedback?q=Accepted&limit=1');
  assert.equal(feedback.total, 1); assert.equal(feedback.events[0].decision, 'expected');
  const compare = await get(`run-compare?leftRunId=${RUN_ID}&rightRunId=${AUDIT_RUN_ID}`);
  assert.deepEqual(compare.summary, { added: 0, removed: 0, changed: 1, unchanged: 0 });
  assert.equal(compare.changed[0].before.displayId, 'F-1'); assert.equal(compare.changed[0].after.displayId, 'F-99');
  assert.equal(compare.rightRun.stoppedBecause, 'budget reached');
  for (const endpoint of ['findings', 'memory', 'feedback', `run-compare?leftRunId=${RUN_ID}&rightRunId=${AUDIT_RUN_ID}`]) {
    assert.equal((await fetch(`${base}/api/projects/${PROJECT_ID}/${endpoint}`)).status, 401);
    assert.equal((await fetch(`${base}/api/projects/${PROJECT_ID}/${endpoint}`, { method: 'POST', headers: auth })).status, 405);
  }
  assert.equal((await fetch(`${base}/api/projects/${'b'.repeat(64)}/memory`, { headers: auth })).status, 404);
});
