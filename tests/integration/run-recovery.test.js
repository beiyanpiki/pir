import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import process from "node:process";
import { createServer } from "node:http";
import { startServer } from "../../dist/server/server.js";
import { SqliteStore } from "../../dist/memory/sqlite-store.js";

const execFileAsync = promisify(execFile);
const CLI = path.resolve("dist/cli/cli.js");
const WEB_TOKEN = "web-token-456";
const EXEC_TOKEN = "exec-token-123";
const PROJECT_ID = "a".repeat(64);
const RUN_ID = "11111111-2222-3333-4444-555555555555";
const LIVE_RUN_ID = "99999999-8888-7777-6666-555555555555";

/**
 * #48/#49/#50/#52: recovering a finished (or in-flight) run from just a URL.
 * The client-side commands talk to the server's read-only web tier, so every
 * CLI invocation here runs from a scratch directory that is NOT a repository
 * — the posture of a user pasting a link from the web UI.
 */

function seedFinding(store, id, displayId, status, title, createdAt) {
  store.run(
    `INSERT INTO findings (id, project_id, run_id, display_id, fingerprint, title, claim, trigger, category, severity, status, feature_key, entity_key, anchors, memory_matches, verifier_rationale, round, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'fp', ?, 'The loop overruns by one.', 'diff', 'logic', 'P1', ?, NULL, NULL, '[]', '[]', 'checked the bound', 1, ?, ?)`,
    id, PROJECT_ID, RUN_ID, displayId, title, status, createdAt, createdAt,
  );
  store.run(
    `INSERT INTO finding_evidence (id, finding_id, kind, path, start_line, end_line, excerpt, description, created_at)
     VALUES (?, ?, 'code', 'src/loop.ts', 10, 12, 'for (let i = 0; i <= n; i++)', 'bound', ?)`,
    `e-${id}`, id, createdAt,
  );
}

function buildStateFixture(root) {
  const projectDir = path.join(root, PROJECT_ID);
  const store = SqliteStore.open(path.join(projectDir, "memory.sqlite"));
  store.run(
    "INSERT INTO projects (id, remote, normalized_remote, root_commit, created_at) VALUES (?, ?, ?, ?, ?)",
    PROJECT_ID, "https://github.com/example/widget.git", "github.com/example/widget", "f".repeat(40), Date.now(),
  );
  // A finished change-mode run with three findings.
  store.run(
    `INSERT INTO review_runs (id, project_id, mode, base, head, started_at, finished_at, status, rounds, candidates, confirmed, rejected, uncertain, notes)
     VALUES (?, ?, 'change', ?, ?, ?, ?, 'completed', 1, 3, 2, 1, 0, 'reviewer signaled completion; 0 pending')`,
    RUN_ID, PROJECT_ID, "b".repeat(40), "h".repeat(40), Date.now() - 60_000, Date.now() - 30_000,
  );
  const t = Date.now() - 30_000;
  seedFinding(store, "f1", "F-1", "confirmed", "Off-by-one", t);
  seedFinding(store, "f2", "F-2", "confirmed", "Missing null check", t + 1);
  seedFinding(store, "f3", "F-3", "rejected", "Style nit", t + 2);
  // A live audit run: finished_at null — the export-snapshot case.
  store.run(
    `INSERT INTO review_runs (id, project_id, mode, base, head, started_at, finished_at, status, rounds, candidates, confirmed, rejected, uncertain, notes)
     VALUES (?, ?, 'audit', NULL, ?, ?, NULL, 'running', 1, 0, 0, 0, 0, NULL)`,
    LIVE_RUN_ID, PROJECT_ID, "h".repeat(40), Date.now() - 600_000,
  );
  store.run(
    `INSERT INTO findings (id, project_id, run_id, display_id, fingerprint, title, claim, trigger, category, severity, status, feature_key, entity_key, anchors, memory_matches, verifier_rationale, round, created_at, updated_at)
     VALUES ('lf1', ?, ?, 'F-100', 'fp', 'Partial finding', 'So far.', 'tree', 'logic', 'P2', 'uncertain', NULL, NULL, '[]', '[]', NULL, 1, ?, ?)`,
    PROJECT_ID, LIVE_RUN_ID, Date.now(), Date.now(),
  );
  store.close();

  const transcriptDir = path.join(projectDir, "transcripts", RUN_ID);
  mkdirSync(transcriptDir, { recursive: true });
  writeFileSync(path.join(transcriptDir, "run.json"), JSON.stringify({
    schemaVersion: 1, runId: RUN_ID, projectId: PROJECT_ID, mode: "change", status: "completed",
    base: "b".repeat(40), head: "h".repeat(40), model: "prov/m", startedAt: 1, finishedAt: 2,
    stoppedBecause: "reviewer signaled completion", incomplete: false, maxFindings: 10,
    rounds: [], plugins: [], sessions: [],
    usage: { totalTokens: 10, cost: 0.01 }, durationMs: 1234, estimatedTokens: 0,
    coverage: {
      filesTotal: 10, filesNotSelected: 2, filesExcluded: 1, filesInScope: 7, filesReviewed: 5,
      filesPartial: 1, filesUnreviewed: 1, filesBlocked: 0, filesFailed: 0,
      batchesTotal: 2, batchesCompleted: 2, batchesBlocked: 0, batchesFailed: 0,
    },
  }));
}

async function withWebServer(t, { webToken = WEB_TOKEN } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "pir-run-recovery-"));
  buildStateFixture(root);
  const handle = await startServer({
    host: "127.0.0.1",
    port: 0,
    token: EXEC_TOKEN,
    workspace: root,
    tls: null,
    ...(webToken !== null ? { webUi: { token: webToken, stateRoot: root, webRoot: path.join(root, "web-missing") } } : {}),
  });
  t.after(() => {
    handle.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { base: handle.url, root };
}

/** Scratch cwd + isolated config dir: not a repo, no wizard, no defaults noise. */
function scratchEnv(t, extra = {}) {
  const cwd = mkdtempSync(path.join(tmpdir(), "pir-scratch-cwd-"));
  const configDir = mkdtempSync(path.join(tmpdir(), "pir-scratch-config-"));
  t.after(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  });
  return {
    cwd,
    env: {
      ...process.env,
      PIR_NO_WIZARD: "1",
      PIR_CONFIG_DIR: configDir,
      ...extra,
    },
  };
}

async function pir(args, { cwd, env }) {
  return execFileAsync(process.execPath, [CLI, ...args], { cwd, env, encoding: "utf8" });
}

const RUN_URL = (base) => `${base}/runs/${PROJECT_ID}/${RUN_ID}`;
const VIEWER = ["--viewer-token", WEB_TOKEN];

// ---------------------------------------------------------------------------
// pir runs status (#48)
// ---------------------------------------------------------------------------

test("runs: status by URL works outside any repository, json + text", async (t) => {
  const { base } = await withWebServer(t);
  const { cwd, env } = scratchEnv(t);

  const { stdout } = await pir(["runs", "status", RUN_URL(base), "--json", ...VIEWER], { cwd, env });
  const envelope = JSON.parse(stdout);
  assert.equal(envelope.command, "runs.status");
  assert.equal(envelope.data.run.runId, RUN_ID);
  assert.equal(envelope.data.run.status, "completed");
  assert.equal(envelope.data.run.head, "h".repeat(40));
  assert.equal(envelope.data.stopReason, "reviewer signaled completion");
  assert.equal(envelope.data.findingsTotal, 3);
  assert.equal(envelope.data.confirmed, 2);
  assert.deepEqual(
    ["filesInScope", "filesReviewed", "filesUnreviewed"].map((k) => envelope.data.coverage?.[k]),
    [7, 5, 1],
    "coverage summary comes from the run manifest",
  );
  assert.equal(envelope.data.url, RUN_URL(base));

  const text = await pir(["runs", "status", RUN_URL(base), ...VIEWER], { cwd, env });
  assert.match(text.stdout, new RegExp(`run ${RUN_ID} \\(change\\) — completed`));
  assert.match(text.stdout, /5\/7 reviewed/);
  assert.match(text.stdout, /stopped: +reviewer signaled completion/);

  // The flag trio addresses the same run.
  const flags = await pir(["runs", "status", "--server", base, "--project", PROJECT_ID, "--run", RUN_ID, "--json", ...VIEWER], { cwd, env });
  assert.equal(JSON.parse(flags.stdout).data.run.runId, RUN_ID);
});

test("runs: error matrix — unknown run vs no web tier vs missing viewer token", async (t) => {
  const { cwd, env } = scratchEnv(t);
  const { base } = await withWebServer(t);

  const unknown = await pir(["runs", "status", `${base}/runs/${PROJECT_ID}/deadbeef`, ...VIEWER], { cwd, env }).catch((e) => e);
  assert.equal(unknown.code, 3);
  assert.match(unknown.stderr, /unknown run/i);

  // No token offered (config dir is empty, so no origin binding): 401 with
  // the viewer-credential hint, not the execution-token hint.
  const unauth = await pir(["runs", "status", RUN_URL(base)], { cwd, env }).catch((e) => e);
  assert.equal(unauth.code, 3);
  assert.match(unauth.stderr, /viewer token/);
  assert.doesNotMatch(unauth.stderr, /check --token\b/);

  // A server without --web answers the endpoints-listing 404.
  const bare = await startServer({ host: "127.0.0.1", port: 0, token: EXEC_TOKEN, workspace: tmpdir(), tls: null });
  t.after(() => bare.close());
  const noWeb = await pir(["runs", "status", `${bare.url}/runs/${PROJECT_ID}/${RUN_ID}`], { cwd, env }).catch((e) => e);
  assert.equal(noWeb.code, 3);
  assert.match(noWeb.stderr, /serve --web/);

  // Usage: neither URL nor trio.
  const usage = await pir(["runs", "status"], { cwd, env }).catch((e) => e);
  assert.equal(usage.code, 2);
});

test("runs: works with a corrupt config.json — the URL carries the server", async (t) => {
  const { base } = await withWebServer(t);
  const { cwd, env } = scratchEnv(t);
  writeFileSync(path.join(env.PIR_CONFIG_DIR, "config.json"), "{ this is not json");
  const { stdout, stderr } = await pir(["runs", "status", RUN_URL(base), "--json", ...VIEWER], { cwd, env });
  assert.match(stderr, /not valid JSON.*continuing/);
  assert.equal(JSON.parse(stdout).data.run.runId, RUN_ID);
});

test("findings --run: skips the first-run wizard on an unconfigured interactive machine (dogfood F-55)", async (t) => {
  const { base } = await withWebServer(t);
  // The wizard's exact trigger conditions: no config, stdin+stdout on a
  // TTY, and none of --json/--no-wizard/PIR_NO_WIZARD. The wrapper forces
  // isTTY before importing the CLI so the child believes it is interactive
  // while stdio stay pipes the test can read — without the webRoute
  // exemption the wizard prompts and hangs on the closed stdin pipe.
  const cwd = mkdtempSync(path.join(tmpdir(), "pir-tty-cwd-"));
  const configDir = mkdtempSync(path.join(tmpdir(), "pir-tty-config-"));
  const runner = path.join(cwd, "tty-runner.mjs");
  writeFileSync(runner, [
    "process.argv = [process.argv[0], 'pir', ...process.argv.slice(2)];",
    "process.stdin.isTTY = true;",
    "process.stdout.isTTY = true;",
    `await import(${JSON.stringify(pathToFileURL(CLI).href)});`,
    "",
  ].join("\n"));
  t.after(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  });
  const env = { ...process.env, PIR_CONFIG_DIR: configDir };
  delete env.PIR_NO_WIZARD;

  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [runner, "findings", "list", "--run", RUN_URL(base), ...VIEWER],
    { cwd, env, encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL" },
  );
  assert.match(stdout, /"displayId": "F-1"/);
  // The command ran instead of the wizard: no prompts, no config written,
  // and no misleading local-defaults hint (the URL carries the server).
  assert.doesNotMatch(stdout, /first-run setup/);
  assert.doesNotMatch(stderr, /first-run setup|locally or \[2\]/);
  assert.doesNotMatch(stderr, /no config at/);
  assert.equal(existsSync(path.join(configDir, "config.json")), false);
});

// ---------------------------------------------------------------------------
// pir findings list|show --run (#48)
// ---------------------------------------------------------------------------

test("findings --run: list pagination metadata and show by display id", async (t) => {
  const { base } = await withWebServer(t);
  const { cwd, env } = scratchEnv(t);

  const list = await pir(["findings", "list", "--run", RUN_URL(base), "--json", ...VIEWER], { cwd, env });
  const page = JSON.parse(list.stdout);
  assert.equal(page.command, "findings.list");
  assert.equal(page.data.total, 3);
  assert.equal(page.data.returned, 3);
  assert.equal(page.data.hasMore, false);
  assert.equal(page.data.nextOffset, null);
  assert.deepEqual(page.data.findings.map((f) => f.displayId).sort(), ["F-1", "F-2", "F-3"]);

  const partial = await pir(["findings", "list", "--run", RUN_URL(base), "--limit", "2", "--json", ...VIEWER], { cwd, env });
  const p2 = JSON.parse(partial.stdout).data;
  assert.equal(p2.returned, 2);
  assert.equal(p2.hasMore, true);
  assert.equal(p2.nextOffset, 2);

  // show resolves the display id users actually have (F-2), not the row uuid.
  const show = await pir(["findings", "show", "F-2", "--run", RUN_URL(base), "--json", ...VIEWER], { cwd, env });
  const detail = JSON.parse(show.stdout);
  assert.equal(detail.command, "findings.show");
  assert.equal(detail.data.displayId, "F-2");
  assert.equal(detail.data.claim, "The loop overruns by one.");
  assert.equal(detail.data.evidence.length, 1);
  assert.equal(detail.data.evidence[0].path, "src/loop.ts");

  const missing = await pir(["findings", "show", "F-99", "--run", RUN_URL(base), ...VIEWER], { cwd, env }).catch((e) => e);
  assert.equal(missing.code, 3);
  assert.match(missing.stderr, /finding not found in this run/);

  // The web tier has no status filter; the flag must fail loudly, not lie
  // (dogfood F-40).
  const statusFlag = await pir(["findings", "list", "--run", RUN_URL(base), "--status", "confirmed", ...VIEWER], { cwd, env }).catch((e) => e);
  assert.equal(statusFlag.code, 2);
  assert.match(statusFlag.stderr, /--status with --run/);
});

// ---------------------------------------------------------------------------
// pir findings export --run (#49)
// ---------------------------------------------------------------------------

test("export: complete run — file output, provenance, status filter, checkpoint cleanup", async (t) => {
  const { base } = await withWebServer(t);
  const { cwd, env } = scratchEnv(t);
  const output = path.join(cwd, "out", "findings.json");

  const { stdout, stderr } = await pir(["findings", "export", "--run", RUN_URL(base), "--output", output, ...VIEWER], { cwd, env });
  assert.equal(stdout, "", "the export goes to the file, stdout stays clean");
  assert.match(stderr, /wrote .*findings\.json \(3 findings, complete: true\)/);
  assert.equal(existsSync(output), true);
  assert.equal(existsSync(`${output}.checkpoint.json`), false, "checkpoint removed on success");
  assert.equal(existsSync(`${output}.tmp`), false, "no tmp residue — the rename is atomic");

  const envelope = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(envelope.command, "findings.export");
  assert.equal(envelope.data.provenance.origin, base);
  assert.equal(envelope.data.provenance.projectId, PROJECT_ID);
  assert.equal(envelope.data.provenance.runId, RUN_ID);
  assert.equal(envelope.data.provenance.head, "h".repeat(40));
  assert.equal(envelope.data.provenance.complete, true);
  assert.equal(envelope.data.total, 3);
  assert.equal(envelope.data.returned, 3);
  assert.equal(new Set(envelope.data.findings.map((f) => f.id)).size, 3, "ids unique");
  assert.ok(envelope.data.findings[0].claim, "full detail records, not summaries");

  const filtered = await pir(
    ["findings", "export", "--run", RUN_URL(base), "--status", "rejected", "--output", `${output}.rejected.json`, ...VIEWER],
    { cwd, env },
  );
  const rejected = JSON.parse(readFileSync(`${output}.rejected.json`, "utf8"));
  assert.equal(rejected.data.total, 1);
  assert.equal(rejected.data.findings[0].displayId, "F-3");
  assert.deepEqual(rejected.data.filters, { status: "rejected" });

  // No --output: the envelope goes to stdout.
  const toStdout = await pir(["findings", "export", "--run", RUN_URL(base), ...VIEWER], { cwd, env });
  assert.equal(JSON.parse(toStdout.stdout).data.returned, 3);

  // Without --run it is a usage error (client-side, before any server call).
  const usage = await pir(["findings", "export"], { cwd, env }).catch((e) => e);
  assert.equal(usage.code, 2);
  assert.match(usage.stderr, /requires --run/);
});

test("export: a live run exports the current snapshot as complete:false", async (t) => {
  const { base } = await withWebServer(t);
  const { cwd, env } = scratchEnv(t);
  const { stdout } = await pir(["findings", "export", "--run", `${base}/runs/${PROJECT_ID}/${LIVE_RUN_ID}`, ...VIEWER], { cwd, env });
  const envelope = JSON.parse(stdout);
  assert.equal(envelope.data.provenance.complete, false);
  assert.equal(typeof envelope.data.provenance.snapshotAt, "string");
  assert.equal(envelope.data.findings.length, 1);
});

// ---------------------------------------------------------------------------
// export retry/resume against an instrumented stub (#49)
// ---------------------------------------------------------------------------

function stubSummary(id, displayId, status) {
  return { id, displayId, title: `t-${id}`, category: "logic", severity: "P1", status, round: 1, createdAt: 1, evidenceCount: 1 };
}

/**
 * An /api stub with a request log and a mutable "f1 failure" switch: enough
 * machinery to observe retries, checkpoint writes and resume behavior
 * without a real serve process.
 */
async function withExportStub(t, { failF1 = "always" } = {}) {
  const state = { f1Hits: 0, f1FailuresLeft: failF1 === "once" ? 1 : failF1 === "never" ? 0 : Number.POSITIVE_INFINITY, requests: [] };
  const summaries = [stubSummary("f1", "F-1", "confirmed"), stubSummary("f2", "F-2", "confirmed"), stubSummary("f3", "F-3", "rejected")];
  const detail = (id) => ({ id, displayId: `F-${id.slice(1)}`, title: `t-${id}`, claim: "c", trigger: "diff", category: "logic", severity: "P1", status: id === "f3" ? "rejected" : "confirmed", anchors: [], evidence: [{ kind: "code", path: "a.ts" }], memoryMatches: [], verifierRationale: null, round: 1, createdAt: 1 });
  const stub = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://local");
    state.requests.push(`${req.method} ${url.pathname}${url.search}`);
    const send = (code, payload) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    if (url.pathname === `/api/runs/${PROJECT_ID}/${RUN_ID}`) {
      send(200, { run: { runId: RUN_ID, mode: "change", base: null, head: "h".repeat(40), startedAt: 1, finishedAt: 2, status: "completed", rounds: 1, candidates: 3, confirmed: 2, rejected: 1, uncertain: 0, notes: null, model: null, durationMs: 1, totalTokens: null, cost: null }, findings: { items: [], total: 3 }, manifest: null, sessions: [], transcriptsAvailable: false });
      return;
    }
    if (url.pathname === `/api/runs/${PROJECT_ID}/${RUN_ID}/findings`) {
      const offset = Number(url.searchParams.get("offset") ?? 0);
      send(200, { findings: offset === 0 ? summaries : [], total: 3 });
      return;
    }
    const detailMatch = /^\/api\/runs\/[^/]+\/[^/]+\/findings\/(f\d+)$/.exec(url.pathname);
    if (detailMatch) {
      const id = detailMatch[1];
      if (id === "f1") {
        state.f1Hits += 1;
        if (state.f1FailuresLeft >= state.f1Hits) {
          send(500, { error: "stub: transient" });
          return;
        }
      }
      send(200, detail(id));
      return;
    }
    send(404, { error: "unknown api endpoint" });
  });
  await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
  t.after((done) => stub.close(done));
  return { base: `http://127.0.0.1:${stub.address().port}`, state, heal: () => { state.f1FailuresLeft = 0; } };
}

test("export: a transient 500 is retried, not fatal", async (t) => {
  const { base, state } = await withExportStub(t, { failF1: "once" });
  const { cwd, env } = scratchEnv(t);
  const output = path.join(cwd, "findings.json");
  const { stdout } = await pir(["findings", "export", "--run", `${base}/runs/${PROJECT_ID}/${RUN_ID}`, "--output", output], { cwd, env });
  assert.equal(stdout, "");
  assert.equal(state.f1Hits, 2, "exactly one retry after the 500");
  const envelope = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(envelope.data.returned, 3);
  assert.equal(existsSync(`${output}.checkpoint.json`), false);
});

test("export: exhausted retries keep no output, write a checkpoint, and a rerun resumes", async (t) => {
  const { base, state, heal } = await withExportStub(t, { failF1: "always" });
  const { cwd, env } = scratchEnv(t);
  const output = path.join(cwd, "findings.json");

  const failed = await pir(["findings", "export", "--run", `${base}/runs/${PROJECT_ID}/${RUN_ID}`, "--output", output], { cwd, env }).catch((e) => e);
  assert.equal(failed.code, 3);
  assert.match(failed.stderr, /could not be fetched after 3 retries: F-1/);
  assert.equal(existsSync(output), false, "no complete-looking file after a failed export");
  assert.equal(existsSync(`${output}.checkpoint.json`), true, "the partial fetch is kept for resume");
  const checkpoint = JSON.parse(readFileSync(`${output}.checkpoint.json`, "utf8"));
  assert.deepEqual(checkpoint.findings.map((f) => f.id).sort(), ["f2", "f3"]);
  const attemptsBefore = state.f1Hits;

  // The stub heals; the rerun reuses the checkpoint and fetches only f1.
  heal();
  const healed = await pir(["findings", "export", "--run", `${base}/runs/${PROJECT_ID}/${RUN_ID}`, "--output", output], { cwd, env });
  assert.match(healed.stderr, /resuming: 2 findings already fetched/);
  assert.equal(state.f1Hits, attemptsBefore + 1, "only f1 was re-requested");
  const envelope = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(envelope.data.returned, 3);
  assert.equal(existsSync(`${output}.checkpoint.json`), false, "success clears the checkpoint");
});

// ---------------------------------------------------------------------------
// dogfood findings from the PR2 self-review
// ---------------------------------------------------------------------------

test("web commands: a 2xx non-JSON body classifies instead of crashing (dogfood F-42)", async (t) => {
  const stub = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html>a proxy ate the api</html>");
  });
  await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
  t.after((done) => stub.close(done));
  const { cwd, env } = scratchEnv(t);
  const failed = await pir(["runs", "status", `http://127.0.0.1:${stub.address().port}/runs/${PROJECT_ID}/${RUN_ID}`], { cwd, env }).catch((e) => e);
  assert.equal(failed.code, 3);
  assert.match(failed.stderr, /was not pir JSON/);
  assert.doesNotMatch(failed.stderr, /Cannot read propert/);
});

test("export: duplicate rows across live-run pages collapse instead of failing (dogfood F-43)", async (t) => {
  // A stub whose offset paging hands f1 back twice — the live-run signature
  // of rows inserting ahead of the cursor.
  const detail = (id) => ({ id, displayId: `F-${id.slice(1)}`, title: `t-${id}`, claim: "c", trigger: "diff", category: "logic", severity: "P1", status: "confirmed", anchors: [], evidence: [], memoryMatches: [], verifierRationale: null, round: 1, createdAt: 1 });
  const pages = new Map([
    [0, [stubSummary("f1", "F-1", "confirmed"), stubSummary("f2", "F-2", "confirmed")]],
    [2, [stubSummary("f1", "F-1", "confirmed"), stubSummary("f3", "F-3", "confirmed")]],
  ]);
  const stub = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://local");
    const send = (code, payload) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    if (url.pathname === `/api/runs/${PROJECT_ID}/${RUN_ID}`) {
      send(200, { run: { runId: RUN_ID, mode: "audit", base: null, head: "h".repeat(40), startedAt: 1, finishedAt: null, status: "running", rounds: 1, candidates: 3, confirmed: 2, rejected: 1, uncertain: 0, notes: null, model: null, durationMs: null, totalTokens: null, cost: null }, findings: { items: [], total: 3 }, manifest: null, sessions: [], transcriptsAvailable: false });
      return;
    }
    if (url.pathname === `/api/runs/${PROJECT_ID}/${RUN_ID}/findings`) {
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const items = pages.get(offset) ?? [];
      send(200, { findings: items, total: 3 });
      return;
    }
    const detailMatch = /^\/api\/runs\/[^/]+\/[^/]+\/findings\/(f\d+)$/.exec(url.pathname);
    if (detailMatch) {
      send(200, detail(detailMatch[1]));
      return;
    }
    send(404, { error: "unknown api endpoint" });
  });
  await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
  t.after((done) => stub.close(done));
  const { cwd, env } = scratchEnv(t);

  const { stdout } = await pir(["findings", "export", "--run", `http://127.0.0.1:${stub.address().port}/runs/${PROJECT_ID}/${RUN_ID}`], { cwd, env });
  const envelope = JSON.parse(stdout);
  const ids = envelope.data.findings.map((f) => f.id);
  assert.equal(ids.length, 3, "the duplicated row collapsed");
  assert.equal(new Set(ids).size, 3);
  assert.equal(envelope.data.provenance.complete, false, "live run exports a snapshot");
});

test("export: the checkpoint persists periodically, not only at exhaustion (dogfood F-44)", async (t) => {
  // 25 findings; the stub hangs on the 21st detail request. Once 20 details
  // have landed, the periodic write must already have produced a checkpoint
  // while the export is still in flight — no interruption needed to observe.
  const detailsServed = { n: 0 };
  const gate = { release: null };
  const stub = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://local");
    const send = (code, payload) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    if (url.pathname === `/api/runs/${PROJECT_ID}/${RUN_ID}`) {
      send(200, { run: { runId: RUN_ID, mode: "change", base: null, head: "h".repeat(40), startedAt: 1, finishedAt: 2, status: "completed", rounds: 1, candidates: 25, confirmed: 25, rejected: 0, uncertain: 0, notes: null, model: null, durationMs: 1, totalTokens: null, cost: null }, findings: { items: [], total: 25 }, manifest: null, sessions: [], transcriptsAvailable: false });
      return;
    }
    if (url.pathname === `/api/runs/${PROJECT_ID}/${RUN_ID}/findings`) {
      const offset = Number(url.searchParams.get("offset") ?? 0);
      if (offset === 0) send(200, { findings: Array.from({ length: 25 }, (_, i) => stubSummary(`f${i + 1}`, `F-${i + 1}`, "confirmed")), total: 25 });
      else send(200, { findings: [], total: 25 });
      return;
    }
    const detailMatch = /^\/api\/runs\/[^/]+\/[^/]+\/findings\/(f\d+)$/.exec(url.pathname);
    if (detailMatch) {
      detailsServed.n += 1;
      if (detailsServed.n === 21) {
        // Hold the 21st request open; the test observes the checkpoint and
        // then releases (or the process is killed on test end).
        gate.promise.then(() => send(200, { id: detailMatch[1], displayId: detailMatch[1], anchors: [], evidence: [] }));
        return;
      }
      send(200, { id: detailMatch[1], displayId: `F-${detailMatch[1].slice(1)}`, title: "t", claim: "c", trigger: "diff", category: "logic", severity: "P1", status: "confirmed", anchors: [], evidence: [], memoryMatches: [], verifierRationale: null, round: 1, createdAt: 1 });
      return;
    }
    send(404, { error: "unknown api endpoint" });
  });
  gate.promise = new Promise((resolve) => { gate.release = resolve; });
  await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
  t.after((done) => {
    gate.release();
    stub.closeAllConnections?.();
    stub.close(done);
  });
  const { cwd, env } = scratchEnv(t);
  const output = path.join(cwd, "many.json");

  const child = execFile(process.execPath, [CLI, "findings", "export", "--run", `http://127.0.0.1:${stub.address().port}/runs/${PROJECT_ID}/${RUN_ID}`, "--output", output], { cwd, env, encoding: "utf8" }, () => {});
  const deadline = Date.now() + 15000;
  while ((!existsSync(`${output}.checkpoint.json`) || detailsServed.n < 21) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(existsSync(`${output}.checkpoint.json`), "checkpoint written mid-flight (periodic persistence)");
  const checkpoint = JSON.parse(readFileSync(`${output}.checkpoint.json`, "utf8"));
  assert.ok(checkpoint.findings.length >= 20, `at least the first 20 details persisted, got ${checkpoint.findings.length}`);
  assert.equal(existsSync(output), false, "final output not written yet — the export is genuinely in flight");
  gate.release();
  await new Promise((resolve) => { child.on("close", resolve); });
});

test("export: a live-run checkpoint is discarded after the run settles (dogfood F-47)", async (t) => {
  const { base, state } = await withExportStub(t, { failF1: "never" });
  const { cwd, env } = scratchEnv(t);
  const output = path.join(cwd, "phase.json");

  // A checkpoint captured while the run was live (complete:false), holding
  // all three details — then the run settles (the stub always reports a
  // finished run, standing in for "it finished between the two attempts").
  mkdirSync(path.dirname(output), { recursive: true });
  const staleDetail = (id) => ({ id, displayId: `F-${id.slice(1)}`, stale: true });
  writeFileSync(`${output}.checkpoint.json`, JSON.stringify({
    schemaVersion: 1, origin: base, projectId: PROJECT_ID, runId: RUN_ID,
    fetchedAt: new Date().toISOString(), complete: false,
    findings: [staleDetail("f1"), staleDetail("f2"), staleDetail("f3")],
  }));

  const { stderr } = await pir(["findings", "export", "--run", `${base}/runs/${PROJECT_ID}/${RUN_ID}`, "--output", output], { cwd, env });
  assert.match(stderr, /live and it has since settled — refetching everything/);
  const envelope = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(envelope.data.findings.every((f) => f.stale !== true), true, "no stale detail rows survive");
  assert.equal(envelope.data.provenance.complete, true);

  // A checkpoint from a different origin is equally unusable.
  rmSync(output);
  writeFileSync(`${output}.checkpoint.json`, JSON.stringify({
    schemaVersion: 1, origin: "http://elsewhere:1", projectId: PROJECT_ID, runId: RUN_ID,
    fetchedAt: new Date().toISOString(), complete: true, findings: [staleDetail("f1")],
  }));
  const rerun = await pir(["findings", "export", "--run", `${base}/runs/${PROJECT_ID}/${RUN_ID}`, "--output", output], { cwd, env });
  assert.match(rerun.stderr, /different run\/origin — refetching everything/);
  void state;
});

test("export: stdout mode fails without promising a checkpoint (dogfood F-48)", async (t) => {
  const { base } = await withExportStub(t, { failF1: "always" });
  const { cwd, env } = scratchEnv(t);
  const failed = await pir(["findings", "export", "--run", `${base}/runs/${PROJECT_ID}/${RUN_ID}`], { cwd, env }).catch((e) => e);
  assert.equal(failed.code, 3);
  assert.match(failed.stderr, /could not be fetched after 3 retries: F-1/);
  assert.match(failed.stderr, /no checkpoint without --output/);
  assert.doesNotMatch(failed.stderr, /rerun to resume from the checkpoint/);
});

// ---------------------------------------------------------------------------
// viewer credentials over the wire (#50)
// ---------------------------------------------------------------------------

test("viewer credentials (#50): config token reaches its own origin, never a foreign one", async (t) => {
  const { base } = await withWebServer(t);
  const { cwd, env } = scratchEnv(t);
  // config: local mode + the server's url + viewerToken (set like a user would).
  writeFileSync(
    path.join(env.PIR_CONFIG_DIR, "config.json"),
    JSON.stringify({ schemaVersion: 1, mode: "local", server: { url: base, viewerToken: WEB_TOKEN } }),
  );

  // Same origin: the config viewer token is sent, no flag needed.
  const viaConfig = await pir(["runs", "status", RUN_URL(base), "--json"], { cwd, env });
  assert.equal(JSON.parse(viaConfig.stdout).data.run.runId, RUN_ID);

  // Foreign origin: a stub that demands auth and records what was offered.
  const seen = [];
  const stub = createServer((req, res) => {
    seen.push(req.headers.authorization ?? "(none)");
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "missing or invalid bearer token" }));
  });
  await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
  t.after((done) => stub.close(done));
  const foreign = `http://127.0.0.1:${stub.address().port}`;

  const refused = await pir(["runs", "status", `${foreign}/runs/${PROJECT_ID}/${RUN_ID}`], { cwd, env }).catch((e) => e);
  assert.equal(refused.code, 3);
  assert.match(refused.stderr, /viewer token/);
  assert.deepEqual(seen, ["(none)"], "the configured token must never be sent to another origin");
  assert.match(refused.stderr, /not the configured server/);

  // The explicit flag travels to any origin the user names.
  const flagged = await pir(["runs", "status", `${foreign}/runs/${PROJECT_ID}/${RUN_ID}`, "--viewer-token", WEB_TOKEN], { cwd, env }).catch((e) => e);
  assert.equal(flagged.code, 3);
  assert.deepEqual(seen, ["(none)", `Bearer ${WEB_TOKEN}`]);
});

test("viewer credentials (#50): PIR_VIEWER_TOKEN pairs with PIR_SERVER_URL", async (t) => {
  const { base } = await withWebServer(t);
  const { cwd, env } = scratchEnv(t, { PIR_SERVER_URL: base, PIR_VIEWER_TOKEN: WEB_TOKEN });
  const { stdout } = await pir(["findings", "list", "--run", RUN_URL(base), "--json"], { cwd, env });
  assert.equal(JSON.parse(stdout).data.total, 3);
});

// ---------------------------------------------------------------------------
// receipts (#52) end to end
// ---------------------------------------------------------------------------

/** /v1 stub: accepts an async find, then serves the completed job with a
 * find-shaped result envelope carrying data.run.id + project.id. */
async function withJobStub(t) {
  const seen = [];
  const jobId = "j0b1d234-5678-4aaa-bbbb-ccccdddd0000";
  const runId = "run-from-envelope-1";
  const resultOutput = JSON.stringify({
    schemaVersion: 1,
    command: "find",
    project: { id: PROJECT_ID },
    data: { run: { id: runId, head: "h".repeat(40), findings: [] } },
  });
  const stub = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://local");
      seen.push({ method: req.method, path: url.pathname, auth: req.headers.authorization ?? "(none)", body: body || null });
      const send = (code, payload) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (url.pathname === "/v1/review" && req.method === "POST") {
        send(202, { jobId, status: "queued" });
        return;
      }
      if (url.pathname === `/v1/jobs/${jobId}`) {
        send(200, {
          job: {
            jobId, command: "find", argv: ["find", "--json"], status: "completed",
            createdAt: 1, startedAt: 1, finishedAt: 2, logTotal: 0, log: [],
            result: { code: 0, output: `${resultOutput}\n`, log: [], truncated: false },
            error: null, clientGone: false,
          },
        });
        return;
      }
      if (url.pathname === "/v1/jobs") {
        send(200, { jobs: [] });
        return;
      }
      send(404, { error: "not found", endpoints: ["GET /health"] });
    });
  });
  await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
  t.after((done) => stub.close(done));
  return { base: `http://127.0.0.1:${stub.address().port}`, seen, jobId, runId };
}

test("receipts (#52): async submission writes a receipt; the settled run id lands in it", async (t) => {
  const { base, jobId, runId } = await withJobStub(t);
  const repo = mkdtempSync(path.join(tmpdir(), "pir-receipt-repo-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  // A minimal repo so createBundle has something to pack.
  execFileSync("git", ["init", "--quiet"], { cwd: repo });
  writeFileSync(path.join(repo, "a.txt"), "hello\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--quiet", "-m", "one"], { cwd: repo });

  const { cwd, env } = scratchEnv(t);
  const { stderr } = await pir(
    ["--server", base, "--token", EXEC_TOKEN, "find", "--json", "--cwd", repo],
    { cwd, env },
  );
  assert.match(stderr, /receipt saved/);

  const listed = await pir(["receipts", "list", "--json"], { cwd, env });
  const receipts = JSON.parse(listed.stdout).data.receipts;
  assert.equal(receipts.length, 1);
  const receipt = receipts[0];
  assert.equal(receipt.jobId, jobId);
  assert.equal(receipt.kind, "find");
  assert.equal(receipt.origin, base);
  assert.equal(receipt.runId, runId, "run id updated from the result envelope");
  assert.equal(receipt.projectId, PROJECT_ID);
  assert.ok(!JSON.stringify(receipt).includes(EXEC_TOKEN), "no execution token in the receipt");

  // show prints the recovery commands, including the run URL.
  const shown = await pir(["receipts", "show", jobId.slice(0, 8)], { cwd, env });
  assert.match(shown.stdout, /runs status/);
  assert.match(shown.stdout, new RegExp(`${base}/runs/${PROJECT_ID}/${runId}`));
  assert.match(shown.stdout, /findings export --run/);

  // The receipt file is owner-only.
  const receiptsDir = path.join(env.PIR_CONFIG_DIR, "receipts");
  const name = readdirSync(receiptsDir)[0];
  assert.equal(statSync(path.join(receiptsDir, name)).mode & 0o777, 0o600);

  // jobs 404 on a restarted registry points at the receipt (recovery #52).
  const unknown = await pir(["jobs", "status", jobId.slice(0, 8), "--server", base, "--token", EXEC_TOKEN], { cwd, env }).catch((e) => e);
  assert.equal(unknown.code, 3);
  assert.match(unknown.stderr, /unknown job/);
  assert.match(unknown.stderr, /local receipt/);
  assert.match(unknown.stderr, /runs status/);
});

test("--detach (#53): submit, print the envelope, never poll", async (t) => {
  const { base, seen, jobId } = await withJobStub(t);
  const repo = mkdtempSync(path.join(tmpdir(), "pir-detach-repo-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet"], { cwd: repo });
  writeFileSync(path.join(repo, "a.txt"), "hello\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--quiet", "-m", "one"], { cwd: repo });

  const { cwd, env } = scratchEnv(t);
  // find is sync by default; --detach must imply the async lane (202).
  const { stdout, stderr } = await pir(
    ["--server", base, "--token", EXEC_TOKEN, "find", "--detach", "--json", "--cwd", repo],
    { cwd, env },
  );
  const envelope = JSON.parse(stdout);
  assert.equal(envelope.schemaVersion, 1);
  assert.equal(envelope.command, "find.detach");
  assert.equal(envelope.data.jobId, jobId);
  assert.equal(envelope.data.origin, base);
  // The project id is computed locally (same formula as the server) — a
  // 64-hex identity, not something echoed from the server we never polled.
  assert.match(envelope.data.projectId, /^[0-9a-f]{64}$/);
  assert.equal(envelope.data.projectId, envelope.project.id);
  assert.equal(envelope.data.mode, "async");
  assert.equal(envelope.data.runId, null, "run id is unknown until pickup");
  assert.ok(envelope.data.followUp.some((c) => c === `pir jobs wait ${jobId}`));
  assert.ok(envelope.data.followUp.some((c) => c.startsWith("pir receipts show")));

  // Detach means detach: exactly one request left the machine and the job
  // registry was never polled.
  assert.equal(seen.filter((r) => r.path === "/v1/review" && r.method === "POST").length, 1);
  assert.equal(seen.filter((r) => r.path.startsWith("/v1/jobs")).length, 0);

  // The receipt exists and still names runId null — nothing followed the job.
  assert.match(stderr, /receipt saved/);
  const listed = await pir(["receipts", "list", "--json"], { cwd, env });
  const receipts = JSON.parse(listed.stdout).data.receipts;
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].jobId, jobId);
  assert.equal(receipts[0].runId, null);

  // Text mode keeps stdout human: full job id and the follow-up commands.
  const repo2 = mkdtempSync(path.join(tmpdir(), "pir-detach-repo2-"));
  t.after(() => rmSync(repo2, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet"], { cwd: repo2 });
  writeFileSync(path.join(repo2, "a.txt"), "hello\n");
  execFileSync("git", ["add", "."], { cwd: repo2 });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--quiet", "-m", "one"], { cwd: repo2 });
  const text = await pir(["--server", base, "--token", EXEC_TOKEN, "find", "--detach", "--cwd", repo2], { cwd, env });
  assert.match(text.stdout, new RegExp(`submitted find as job ${jobId}`));
  assert.match(text.stdout, /pir jobs wait/);
});

test("--detach (#53): rejected for non-review commands and in local mode", async (t) => {
  const { base, seen } = await withJobStub(t);
  const { cwd, env } = scratchEnv(t);
  // models forwards through /v1/exec — detach has nothing to detach there.
  const wrongCommand = await pir(["models", "--ids", "--detach", "--server", base], { cwd, env }).then(
    () => assert.fail("expected exit 2"),
    (err) => err,
  );
  assert.equal(wrongCommand.code, 2);
  assert.match(wrongCommand.stderr, /--detach applies to/);
  // Local execution cannot detach either (executor-side validation, #53).
  const repo = mkdtempSync(path.join(tmpdir(), "pir-detach-local-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet"], { cwd: repo });
  writeFileSync(path.join(repo, "a.txt"), "hello\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--quiet", "-m", "one"], { cwd: repo });
  const local = await pir(["find", "--detach", "--local", "--cwd", repo], { cwd, env }).then(
    () => assert.fail("expected exit 2"),
    (err) => err,
  );
  assert.equal(local.code, 2);
  assert.match(local.stderr, /--detach submits to a remote server/);
  assert.equal(seen.length, 0, "validation failures never reach the network");
});
