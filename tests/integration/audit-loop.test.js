import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createTempGitRepo, submitVerdictWithEvidence } from "../fixtures/helpers.js";
import { createAppContext } from "../../dist/app/context.js";
import { auditIssues, AuditScopeError } from "../../dist/core/supervisor.js";

async function fixture() {
  const repo = createTempGitRepo("pir-audit-");
  repo.write("src/a/util.ts", "export const id = (x) => x;\n");
  repo.write("src/b/calc.ts", "export const add = (a, b) => a + b;\n");
  repo.commit("code");
  const ctx = await createAppContext(repo.dir, { noSyncIndex: true, dbPath: path.join(repo.dir, "memory.sqlite") });
  return { repo, ctx, cleanup() { ctx.memory.close(); repo.cleanup(); } };
}

/**
 * Fake session factory mirroring the review-loop harness. The reviewer parses
 * its OWNED SCOPE from the audit prompt and must pin-read every owned file —
 * the same contract the supervisor enforces for coverage.
 */
function factory(reviewer, verifier, measured = false) {
  const sessions = [];
  const prompts = [];
  return {
    sessions,
    prompts,
    async createSession(config) {
      sessions.push(config);
      return {
        async prompt(text) {
          prompts.push({ role: config.systemRole, text });
          const tools = (name) => {
            const found = config.tools.find((tool) => tool.name === name);
            assert.ok(found, `missing tool ${name}`);
            return found;
          };
          await (config.systemRole === "code reviewer" ? reviewer : verifier)(tools, text, config);
        },
        getLastAssistantText: () => "done",
        getLastAssistantError: () => undefined,
        ...(measured ? { getUsage: () => ({ inputTokens: 10, outputTokens: 2, totalTokens: 12 }) } : {}),
        dispose() {},
      };
    },
  };
}

function ownedFromPrompt(prompt) {
  return [...prompt.matchAll(/^- (\S+) \((?:from line \d+ to end|lines \d+-\d+)\)/gm)].map((match) => match[1]);
}

test("audit: full sweep reviews every unit, confirms snapshot defects, persists coverage", async () => {
  const f = await fixture();
  let reviewerSessions = 0;
  const sessions = factory(async (tools, prompt, config) => {
    reviewerSessions += 1;
    // Audit capability contract: no diff tool, snapshot inventory instead.
    assert.ok(!config.tools.some((tool) => tool.name === "get_change"), "audit reviewer must not see get_change");
    assert.ok(config.tools.some((tool) => tool.name === "list_snapshot_files"));
    assert.match(prompt, /no change attribution/i);
    const owned = ownedFromPrompt(prompt);
    assert.ok(owned.length >= 1);
    for (const file of owned) {
      const read = await tools("read_code").execute({ path: file });
      assert.ok(!read.text.startsWith("ERROR"), read.text);
    }
    await tools("record_candidate").execute({
      title: `Defect in ${owned[0]}`,
      claim: `Snapshot defect reachable in ${owned[0]}`,
      trigger: "normal operation",
      category: "correctness", severity: "P1",
      anchors: [{ path: owned[0], startLine: 1 }],
      evidence: [{ kind: "code", path: owned[0], startLine: 1, excerpt: "export const" }],
    });
    await tools("finish_round").execute({ summary: `covered ${owned.join(", ")}`, nextFocus: [], needsMoreRounds: false });
  }, async (tools, prompt) => {
    assert.ok(!/introduced by this change/.test(prompt), "audit verifier prompt must not demand attribution");
    assert.match(prompt, /Do NOT evaluate change attribution/i);
    await submitVerdictWithEvidence(tools, { verdict: "confirmed", rationale: "reachable at the pinned snapshot" }, "src/a/util.ts");
  });
  try {
    const out = await auditIssues({ ...f.ctx, factory: sessions });
    assert.equal(reviewerSessions, 2, "one session per module unit");
    assert.equal(out.incomplete, false);
    assert.equal(out.stoppedBecause, "audit discovery complete");
    assert.equal(out.coverage.filesTotal, 2);
    assert.equal(out.coverage.filesReviewed, 2);
    assert.equal(out.coverage.filesInScope, 2);
    assert.equal(out.coverage.batchesTotal, 2);
    assert.equal(out.coverage.batchesCompleted, 2);
    assert.equal(out.findings.length, 2);
    assert.ok(out.findings.every((row) => row.status === "confirmed"));
    assert.equal(out.pendingCandidates, 0);

    // Run + coverage persisted with honest audit semantics (mode, null base).
    const run = f.ctx.memory.store.get("SELECT mode, base, status FROM review_runs WHERE id = ?", out.runId);
    assert.equal(run.mode, "audit");
    assert.equal(run.base, null);
    assert.equal(run.status, "completed");
    const units = f.ctx.memory.audit.units(out.runId);
    assert.equal(units.length, 2);
    assert.ok(units.every((unit) => unit.state === "reviewed"));
    const files = f.ctx.memory.audit.fileCoverage(out.runId);
    assert.equal(files.length, 2);
    assert.ok(files.every((file) => file.state === "reviewed"));
    // Checkpoint flow: candidates were persisted once and updated in place.
    const count = f.ctx.memory.store.get("SELECT COUNT(*) AS n FROM findings").n;
    assert.equal(count, 2);
  } finally { f.cleanup(); }
});

test("audit: finishing a unit without pinned reads is rejected and retried, then blocked if repeated", async () => {
  const f = await fixture();
  let calls = 0;
  const sessions = factory(async (tools, prompt) => {
    calls += 1;
    const owned = ownedFromPrompt(prompt);
    if (calls === 1) {
      // Declares completion without reading anything: invalid claim.
      await tools("finish_round").execute({ summary: "done", nextFocus: [], needsMoreRounds: false });
      return;
    }
    if (calls === 2) {
      assert.match(prompt, /WITHOUT pinned reads/, "retry prompt names the unread files");
    }
    for (const file of owned) await tools("read_code").execute({ path: file });
    await tools("finish_round").execute({ summary: "covered", nextFocus: [], needsMoreRounds: false });
  }, async (tools) => {
    await submitVerdictWithEvidence(tools, { verdict: "rejected", rationale: "counter-evidence at snapshot" }, "src/a/util.ts");
  });
  try {
    const out = await auditIssues({ ...f.ctx, factory: sessions });
    const retried = out.units[0];
    assert.equal(retried.attempts, 2);
    assert.equal(retried.state, "reviewed");
    assert.equal(out.incomplete, false);
    assert.equal(out.coverage.filesReviewed, 2);
    assert.equal(out.findings.length, 0, "rejected findings are reported as rows but not confirmed");
  } finally { f.cleanup(); }
});

test("audit: token budget stop leaves the rest of the scope honestly unreviewed", async () => {
  const f = await fixture();
  const sessions = factory(async (tools, prompt) => {
    const owned = ownedFromPrompt(prompt);
    for (const file of owned) await tools("read_code").execute({ path: file });
    await tools("finish_round").execute({ summary: "covered", nextFocus: [], needsMoreRounds: false });
  }, async (tools) => {
    await submitVerdictWithEvidence(tools, { verdict: "confirmed", rationale: "reachable at snapshot" }, "src/a/util.ts");
  });
  try {
    const out = await auditIssues({ ...f.ctx, factory: sessions, options: { maxTokens: 1 } });
    assert.equal(out.incomplete, true);
    assert.match(out.stoppedBecause, /token budget exhausted/);
    assert.equal(out.coverage.filesReviewed, 1);
    assert.equal(out.coverage.filesUnreviewed, 1);
    assert.ok(out.incompleteReasons.some((reason) => /unreviewed/.test(reason)));
    const run = f.ctx.memory.store.get("SELECT mode, status FROM review_runs WHERE id = ?", out.runId);
    assert.equal(run.status, "incomplete");
  } finally { f.cleanup(); }
});

test("audit: an empty or fully non-text scope fails explicitly, never reports a clean sweep", async () => {
  const repo = createTempGitRepo("pir-audit-empty-");
  try {
    const ctx = await createAppContext(repo.dir, { noSyncIndex: true, dbPath: path.join(repo.dir, "memory.sqlite") });
    try {
      // Only the empty init commit exists: nothing selected.
      await assert.rejects(auditIssues({ ...ctx, factory: factory(async () => {}, async () => {}) }), AuditScopeError);
      repo.write("assets/logo.png", "binary by extension\n");
      repo.commit("binary only");
      // Selected but nothing reviewable as text.
      await assert.rejects(
        auditIssues({ ...ctx, factory: factory(async () => {}, async () => {}), options: { includePaths: ["assets"] } }),
        AuditScopeError,
      );
    } finally {
      ctx.memory.close();
    }
  } finally {
    repo.cleanup();
  }
});

test("audit: prior accepted-risk suppression still requires the verifier's material revalidation", async () => {
  const f = await fixture();
  const seenPrompts = [];
  const sessions = factory(async (tools, prompt) => {
    const owned = ownedFromPrompt(prompt);
    for (const file of owned) await tools("read_code").execute({ path: file });
    await tools("record_candidate").execute({
      title: "Divide by zero", claim: "Snapshot defect: division by zero in calc",
      trigger: "zero input", category: "correctness", severity: "P1",
      entityKey: "calc.add",
      anchors: [{ path: "src/b/calc.ts", startLine: 1 }],
      evidence: [{ kind: "code", path: "src/b/calc.ts", startLine: 1, excerpt: "a + b" }],
    });
    await tools("finish_round").execute({ summary: "covered", nextFocus: [], needsMoreRounds: false });
  }, async (tools, prompt, config) => {
    seenPrompts.push(prompt);
    await submitVerdictWithEvidence(tools, {
      verdict: "confirmed", rationale: "technically real at the snapshot",
      decisionAssessments: [{ memoryId: prompt.match(/"memoryId":"([^"]+)"/)?.[1] ?? "m1", stillApplies: false, rationale: "callers changed" }],
    }, "src/a/util.ts");
  });
  try {
    // Seed a trusted accepted-risk decision for this exact fingerprint.
    const { applyFeedback } = await import("../../dist/memory/feedback.js");
    const { buildIdentity } = await import("../../dist/findings/identity.js");
    const identity = buildIdentity({ entityKey: "calc.add", category: "correctness", claim: "Snapshot defect: division by zero in calc", trigger: "zero input" });
    const run = f.ctx.memory.findings.createRun({ base: "0".repeat(40), head: "0".repeat(40) });
    const row = f.ctx.memory.findings.insert({
      title: "Divide by zero", claim: "Snapshot defect: division by zero in calc", trigger: "zero input",
      category: "correctness", severity: "P1", entityKey: "calc.add", round: 1, identity,
      anchors: [{ path: "src/b/calc.ts", startLine: 1 }], evidence: [], status: "confirmed", memoryMatches: [],
    }, run.id);
    await applyFeedback(f.ctx.memory, { findingId: row.displayId, decision: "accepted-risk", note: "risk accepted", commit: "0".repeat(40) });

    const out = await auditIssues({ ...f.ctx, factory: sessions });
    const calc = out.findings.find((finding) => finding.entityKey === "calc.add");
    assert.ok(calc, "calc finding present");
    // The verifier said stillApplies=false: the accepted risk does NOT suppress.
    assert.equal(calc.status, "confirmed");
  } finally { f.cleanup(); }
});
