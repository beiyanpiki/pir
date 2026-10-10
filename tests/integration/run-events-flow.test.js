import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { findIssues } from "../../dist/core/supervisor.js";
import { createAppContext } from "../../dist/app/context.js";
import { onRunEvent } from "../../dist/observability/run-events.js";
import { LiveRegistry } from "../../dist/server/live-registry.js";
import { buildIdentity } from "../../dist/findings/identity.js";
import { createTempGitRepo, submitVerdictWithEvidence } from "../fixtures/helpers.js";

/**
 * End-to-end observability flow: a scripted findIssues run (no model) must
 * emit the full run-event sequence into the bus, buffer in a LiveRegistry,
 * and persist the run.json manifest next to its transcripts.
 */

class FakeSessionFactory {
  constructor({ reviewerScript, verifierScript }) {
    this.reviewerScript = reviewerScript;
    this.verifierScript = verifierScript;
  }
  async createSession(config) {
    const factory = this;
    return {
      config,
      async prompt() {
        const tool = (name) => config.tools.find((candidate) => candidate.name === name);
        if (config.systemRole === "code reviewer") await factory.reviewerScript(tool);
        else await factory.verifierScript(tool);
        if (config.transcriptFile) {
          writeFileSync(config.transcriptFile, JSON.stringify({
            role: config.systemRole, model: "fake/model", startedAt: "2026-01-01T00:00:00Z",
            endedAt: "2026-01-01T00:00:01Z", prompt: "p", messages: [],
          }));
        }
      },
      getLastAssistantText: () => "fake",
      getLastAssistantError: () => undefined,
      getUsage: () => ({ inputTokens: 5, outputTokens: 7, totalTokens: 12, cost: 0.001, durationMs: 10 }),
      dispose() {},
    };
  }
}

function setupRepo() {
  const repo = createTempGitRepo();
  repo.write("src/pay.ts", "export function retry(): void {}\n");
  repo.commit("init");
  repo.write("src/pay.ts", "export function retry(): void { consumeQuota(); }\n");
  repo.commit("introduce bug");
  return repo;
}

async function reviewerRecordsCandidate(tool) {
  await tool("record_candidate").execute({
    title: "retry quota consumed without remote attempt",
    claim: "quota vanishes", trigger: "gateway exception before charge",
    category: "correctness", severity: "P1",
    featureKey: "payment-retry", entityKey: "PaymentService.retry",
    anchors: [{ path: "src/pay.ts", startLine: 1 }],
    evidence: [{ kind: "code", path: "src/pay.ts", startLine: 1, excerpt: "consumeQuota()" }],
  });
  await tool("finish_round").execute({ summary: "checked", nextFocus: [], needsMoreRounds: false });
}

async function verifierConfirms(tool) {
  await submitVerdictWithEvidence(tool, { verdict: "confirmed", rationale: "reproduced", confidence: 0.9 });
}

test("findIssues emits the run-event sequence, feeds a LiveRegistry and writes run.json", async () => {
  const savedEnv = process.env.PIR_TRANSCRIPTS;
  process.env.PIR_TRANSCRIPTS = "1";
  const repo = setupRepo();
  const events = [];
  const unsubscribe = onRunEvent((event) => events.push(event));
  const registry = new LiveRegistry();
  const root = mkdtempSync(path.join(tmpdir(), "pir-run-events-"));
  try {
    const ctx = await createAppContext(repo.dir, { noSyncIndex: true, dbPath: path.join(repo.dir, "m.sqlite") });
    const outcome = await findIssues({
      repoRoot: repo.dir,
      memory: ctx.memory,
      codeMap: ctx.codeMap,
      factory: new FakeSessionFactory({ reviewerScript: reviewerRecordsCandidate, verifierScript: verifierConfirms }),
      options: { model: "fake/model" },
    });
    // Q4: confidence rides the verdict onto the persisted finding, the split
    // defaults off, and the deterministic verdict is on the outcome.
    assert.equal(outcome.findings[0].confidence, 0.9);
    assert.deepEqual(outcome.lowConfidenceFindings, []);
    assert.equal(outcome.minConfidence, 0);
    assert.equal(outcome.runVerdict, "incorrect");

    // ---- bus sequence -----------------------------------------------------
    const kinds = events.map((event) => event.kind);
    const start = kinds.indexOf("run-start");
    assert.ok(start >= 0, "run-start emitted");
    assert.equal(events[start].mode, "change");
    assert.equal(events[start].model, "fake/model");
    assert.equal(events[start].projectId, ctx.memory.identity.projectId);
    assert.ok(kinds.includes("session-start") && kinds.includes("session-end"), "session lifecycle emitted");
    const phases = events.filter((event) => event.kind === "progress").map((event) => event.phase);
    assert.ok(phases.includes("round-start"), "round-start progress emitted");
    assert.ok(phases.includes("round-end"), "round-end progress emitted");
    const roundEnd = events.find((event) => event.kind === "progress" && event.phase === "round-end");
    assert.ok(roundEnd.roundInfo, "round-end carries the round record");
    const runEnd = events.find((event) => event.kind === "run-end");
    assert.equal(runEnd.status, "completed");
    assert.equal(runEnd.counts.confirmed, 1);
    assert.equal(runEnd.findings[0].severity, "P1");

    const sessionStarts = events.filter((event) => event.kind === "session-start");
    assert.equal(sessionStarts.length, 2, "reviewer + verifier session");
    assert.equal(sessionStarts[0].sessionKind, "reviewer");
    assert.ok(sessionStarts[0].prompt.length > 100, "rendered prompt rides the session-start event");
    assert.equal(sessionStarts[0].round, 1);
    assert.equal(sessionStarts[1].sessionKind, "verifier");
    assert.equal(sessionStarts[1].displayId, "F-101", "verifier session tagged with the candidate display id (round 1, candidate 01)");

    // Monotonic sequence numbers keep SSE consumers order-stable.
    for (let index = 1; index < events.length; index += 1) {
      assert.ok(events[index].seq > events[index - 1].seq, `seq increases at ${index}`);
    }

    // ---- live registry ----------------------------------------------------
    const active = registry.activeRuns();
    assert.equal(active.length, 0, "run retired from active after run-end");
    const snapshot = registry.snapshot(outcome.runId);
    assert.ok(snapshot, "ended run stays bufferable inside the grace window");
    assert.equal(snapshot.end.status, "completed");
    assert.equal(snapshot.sessions.length, 2);
    assert.ok(snapshot.sessions.every((session) => session.endedAt !== null));

    // ---- run.json manifest ------------------------------------------------
    const manifestPath = path.join(path.dirname(path.join(repo.dir, "m.sqlite")), "transcripts", outcome.runId, "run.json");
    assert.ok(existsSync(manifestPath), "manifest written next to transcripts");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.runId, outcome.runId);
    assert.equal(manifest.status, "completed");
    assert.equal(manifest.model, "fake/model");
    // Q4: the deterministic verdict lands on the manifest — one confirmed P1 ⇒ incorrect.
    assert.equal(manifest.runVerdict, "incorrect");
    // Q5: no separate verifier model requested — verifiers used the reviewer model.
    assert.equal(manifest.verifierModel, null);
    assert.equal(manifest.sessions.length, 2);
    assert.deepEqual(
      manifest.sessions.map((session) => session.sessionKind).sort(),
      ["reviewer", "verifier"],
    );
    assert.ok(manifest.files.some((file) => file.path === "src/pay.ts"), "reviewed file list persisted");
    assert.equal(manifest.usage.totalTokens, outcome.usage.totalTokens);
  } finally {
    unsubscribe();
    registry.dispose();
    process.env.PIR_TRANSCRIPTS = savedEnv;
    repo.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});
