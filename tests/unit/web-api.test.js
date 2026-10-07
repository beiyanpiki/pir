import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { Memory } from "../../dist/memory/index.js";
import { computeProjectIdentity } from "../../dist/memory/identity.js";
import { buildIdentity } from "../../dist/findings/identity.js";
import { startServer } from "../../dist/server/server.js";
import { emitRunEventForTest } from "../../dist/observability/run-events.js";
import { createTempGitRepo } from "../fixtures/helpers.js";

// Web-tier payload behavior for long runs: gzip negotiation, transcript
// ETag/304, findings summary/detail split, and the REST detail no longer
// embedding the SSE replay buffer (the two-download problem).

function requestJson(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path: pathname, headers }, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }),
        );
      })
      .on("error", reject);
  });
}

async function setupFixture() {
  const repo = createTempGitRepo("pir-webapi-");
  const stateRoot = mkdtempSync(path.join(tmpdir(), "pir-webapi-state-"));
  const webRoot = mkdtempSync(path.join(tmpdir(), "pir-webapi-web-"));
  const workspace = mkdtempSync(path.join(tmpdir(), "pir-webapi-ws-"));
  writeFileSync(path.join(webRoot, "index.html"), "<!doctype html><title>pir</title>");
  const bigJs = `console.log("${"x".repeat(4096)}");`;
  writeFileSync(path.join(webRoot, "app.js"), bigJs);

  const identity = await computeProjectIdentity(repo.dir);
  const projectDir = path.join(stateRoot, identity.projectId);
  mkdirSync(projectDir, { recursive: true });
  const memory = await Memory.open(repo.dir, { dbPath: path.join(projectDir, "memory.sqlite") });
  const run = memory.findings.createRun({ base: null, head: "a".repeat(40), mode: "change" });

  const seed = (title, severity, status) => {
    const findingIdentity = buildIdentity({
      featureKey: "web-perf",
      entityKey: `SessionTimeline.${title}`,
      category: "correctness",
      claim: `claim for ${title}`,
      trigger: "scrolling a long run",
    });
    return memory.findings.insert(
      {
        // Long enough to push the run-detail summary payload past the
        // compression threshold, like a real 100+ finding run.
        title: `${title}: ${"detail ".repeat(40)}`,
        claim: `claim for ${title}`,
        trigger: "scrolling a long run",
        category: "correctness",
        severity,
        featureKey: "web-perf",
        entityKey: `SessionTimeline.${title}`,
        anchors: [{ path: "web/src/x.tsx", startLine: 5 }],
        evidence: [{ kind: "code", path: "web/src/x.tsx", startLine: 5, excerpt: "const x = 1;" }],
        round: 1,
        identity: findingIdentity,
        status,
        memoryMatches: [],
      },
      run.id,
    );
  };
  const first = seed("summary regression", "P1", "confirmed");
  seed("slow render", "P2", "rejected");
  memory.findings.finishRun(run.id, {
    rounds: 1, candidates: 2, confirmed: 1, rejected: 1, uncertain: 0,
  });

  const transcriptsDir = path.join(projectDir, "transcripts", run.id);
  mkdirSync(transcriptsDir, { recursive: true });
  const transcript = {
    role: "code reviewer",
    model: "test-model",
    prompt: "review the diff",
    messages: [{ role: "user", content: "review the diff", timestamp: 1 }],
    padding: "y".repeat(4096), // push the body over the compression threshold
  };
  writeFileSync(path.join(transcriptsDir, "reviewer-r1.json"), JSON.stringify(transcript));
  memory.close();

  const handle = await startServer({
    host: "127.0.0.1",
    port: 0,
    workspace,
    tls: null,
    webUi: { stateRoot, webRoot },
  });
  const port = Number(new URL(handle.url).port);

  return {
    port,
    projectId: identity.projectId,
    runId: run.id,
    firstFindingId: first.id,
    cleanup: () => {
      handle.close();
      repo.cleanup();
      for (const dir of [stateRoot, webRoot, workspace]) rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("web api: gzip negotiation, ETag 304, findings split, no live events embed", async () => {
  const fixture = await setupFixture();
  try {
    const { port, projectId, runId, firstFindingId } = fixture;

    // --- gzip: large API bodies compress, small ones stay plain.
    const detailGz = await requestJson(port, `/api/runs/${projectId}/${runId}`, {
      "accept-encoding": "gzip",
    });
    assert.equal(detailGz.status, 200);
    assert.equal(detailGz.headers["content-encoding"], "gzip");
    const detail = JSON.parse(gunzipSync(detailGz.body).toString("utf8"));

    const overviewPlain = await requestJson(port, "/api/overview");
    assert.equal(overviewPlain.status, 200);
    assert.equal(overviewPlain.headers["content-encoding"], undefined, "small bodies skip gzip");

    const detailPlain = await requestJson(port, `/api/runs/${projectId}/${runId}`);
    assert.equal(detailPlain.headers["content-encoding"], undefined, "no accept-encoding means no gzip");
    assert.ok(detailPlain.body.length > detailGz.body.length, "gzip actually shrinks the payload");

    // --- run detail: summary rows only, heavy fields absent, no live events.
    assert.equal(detail.findings.total, 2);
    assert.equal(detail.findings.items.length, 2);
    for (const item of detail.findings.items) {
      assert.ok(item.id && item.displayId && item.severity && item.status, "summary carries row fields");
      assert.equal(item.claim, undefined, "claim is not in the summary");
      assert.equal(item.evidence, undefined, "evidence is not in the summary");
    }
    assert.equal(detail.live, undefined, "finished run has no live state");

    // --- findings list endpoint with pagination.
    const page = await requestJson(port, `/api/runs/${projectId}/${runId}/findings?limit=1&offset=1`);
    const pageBody = JSON.parse(page.body.toString("utf8"));
    assert.equal(page.status, 200);
    assert.equal(pageBody.total, 2);
    assert.equal(pageBody.findings.length, 1);

    // Non-numeric pagination degrades to "no pagination", never a 500.
    const badLimit = await requestJson(port, `/api/runs/${projectId}/${runId}/findings?limit=abc`);
    assert.equal(badLimit.status, 200);
    assert.equal(JSON.parse(badLimit.body.toString("utf8")).findings.length, 2);

    // --- finding detail endpoint carries the heavy fields.
    const detailRow = await requestJson(port, `/api/runs/${projectId}/${runId}/findings/${firstFindingId}`);
    const finding = JSON.parse(detailRow.body.toString("utf8"));
    assert.equal(detailRow.status, 200);
    assert.equal(finding.claim, "claim for summary regression");
    assert.equal(finding.evidence.length, 1);
    assert.equal(finding.evidence[0].excerpt, "const x = 1;");
    assert.ok(Array.isArray(finding.anchors));

    const missing = await requestJson(port, `/api/runs/${projectId}/${runId}/findings/no-such-finding`);
    assert.equal(missing.status, 404);

    // --- transcript: ETag + 304 revalidation.
    const transcriptUrl = `/api/runs/${projectId}/${runId}/transcript/reviewer-r1.json`;
    const first = await requestJson(port, transcriptUrl, { "accept-encoding": "gzip" });
    assert.equal(first.status, 200);
    assert.ok(first.headers.etag, "transcript carries an etag");
    assert.match(first.headers.etag, /-gz$/, "the gzip variant has its own validator");
    assert.equal(first.headers.vary, "Accept-Encoding", "negotiated responses declare Vary");
    assert.equal(first.headers["cache-control"], "no-cache");
    assert.equal(first.headers["content-encoding"], "gzip");
    assert.equal(JSON.parse(gunzipSync(first.body).toString("utf8")).role, "code reviewer");

    const revalidated = await requestJson(port, transcriptUrl, {
      "accept-encoding": "gzip",
      "if-none-match": first.headers.etag,
    });
    assert.equal(revalidated.status, 304);
    assert.equal(revalidated.body.length, 0, "304 answers without a body");

    // The identity variant has its own ETag; a gzip ETag does not 304 it.
    const identity = await requestJson(port, transcriptUrl);
    assert.equal(identity.headers["content-encoding"], undefined);
    assert.notEqual(identity.headers.etag, first.headers.etag);
    assert.equal(identity.headers.vary, "Accept-Encoding");
    const wrongVariant = await requestJson(port, transcriptUrl, {
      "if-none-match": first.headers.etag,
    });
    assert.equal(wrongVariant.status, 200, "a cross-variant validator revalidates fresh, not 304");

    // An explicit refusal (q=0) is honored — never serve gzip to it.
    const refused = await requestJson(port, transcriptUrl, { "accept-encoding": "gzip;q=0" });
    assert.equal(refused.status, 200);
    assert.equal(refused.headers["content-encoding"], undefined, "gzip;q=0 is a refusal, not consent");

    // Vary rides on plain (identity) negotiated responses too, so shared
    // caches key them by Accept-Encoding as well.
    const plainDetail = await requestJson(port, `/api/runs/${projectId}/${runId}`);
    assert.equal(plainDetail.headers.vary, "Accept-Encoding");

    // --- live runs: the REST detail keeps metadata but never the events.
    emitRunEventForTest({
      kind: "run-start", runId, projectId, seq: 1, ts: Date.now(),
      mode: "change", base: null, head: "a".repeat(40), model: null,
    });
    emitRunEventForTest({
      kind: "session-start", runId, projectId, seq: 2, ts: Date.now(),
      sessionId: "s1", sessionKind: "reviewer", role: "code reviewer", model: null, prompt: "go",
    });
    emitRunEventForTest({
      kind: "session-delta", runId, projectId, seq: 3, ts: Date.now(),
      sessionId: "s1", deltaType: "text", text: "streaming…",
    });
    const liveDetail = await requestJson(port, `/api/runs/${projectId}/${runId}`);
    const liveBody = JSON.parse(liveDetail.body.toString("utf8"));
    assert.ok(liveBody.live, "registry state is embedded for a live run");
    assert.equal(liveBody.live.events, undefined, "the replay buffer is NOT embedded");
    assert.equal(liveBody.live.sessions.length, 1, "session metadata is embedded");

    // --- static assets compress too.
    const js = await requestJson(port, "/app.js", { "accept-encoding": "gzip" });
    assert.equal(js.status, 200);
    assert.equal(js.headers["content-encoding"], "gzip");
    assert.equal(js.headers["content-type"], "text/javascript; charset=utf-8");
    assert.ok(gunzipSync(js.body).length > 4000, "the whole script came back");
  } finally {
    fixture.cleanup();
  }
});

test("web api: run detail 404s for unknown runs and malformed paths", async () => {
  const fixture = await setupFixture();
  try {
    const { port, projectId } = fixture;
    const unknownRun = await requestJson(port, `/api/runs/${projectId}/no-such-run`);
    assert.equal(unknownRun.status, 404);
    const badProject = await requestJson(port, "/api/runs/not-a-sha/run");
    assert.equal(badProject.status, 404);
    const traversal = await requestJson(
      port,
      `/api/runs/${projectId}/..%2f..%2fetc/transcript/passwd.json`,
    );
    assert.equal(traversal.status, 404, "path traversal cannot escape the transcripts dir");
  } finally {
    fixture.cleanup();
  }
});
