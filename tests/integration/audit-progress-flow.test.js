import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createTempGitRepo } from "../fixtures/helpers.js";
import { createAppContext } from "../../dist/app/context.js";
import { auditIssues } from "../../dist/core/supervisor.js";

/**
 * #38 durable-progress flow: while an audit is mid-run, its ledger and
 * heartbeat are already queryable — the "is it alive / how far along"
 * questions must never wait for finishRun.
 */
async function fixture() {
  const repo = createTempGitRepo("pir-audit-live-");
  repo.write("src/a/util.ts", "export const id = (x) => x;\n");
  repo.write("src/b/calc.ts", "export const add = (a, b) => a + b;\n");
  repo.commit("code");
  const ctx = await createAppContext(repo.dir, { noSyncIndex: true, dbPath: path.join(repo.dir, "memory.sqlite") });
  return { repo, ctx, cleanup() { ctx.memory.close(); repo.cleanup(); } };
}

function ownedFromPrompt(prompt) {
  return [...prompt.matchAll(/^- (\S+) \((?:from line \d+ to end|lines \d+-\d+)\)/gm)].map((match) => match[1]);
}

function factory(reviewer) {
  return {
    async createSession(config) {
      return {
        async prompt(text) {
          const tools = (name) => config.tools.find((tool) => tool.name === name);
          await reviewer(tools, text, config);
        },
        getLastAssistantText: () => "done",
        getLastAssistantError: () => undefined,
        dispose() {},
      };
    },
  };
}

test("audit: ledger rows and heartbeat are visible while the run is in flight", async () => {
  const f = await fixture();
  let reviewerSessions = 0;
  let midRun = null;
  const sessions = factory(async (tools, prompt) => {
    reviewerSessions += 1;
    if (reviewerSessions === 2) {
      // Mid-run observation (after unit 1 settled, during unit 2's session)
      // through a SEPARATE read-only connection, the way a second pir
      // request (or an operator) would look.
      const { SqliteStore } = await import("../../dist/memory/sqlite-store.js");
      const reader = SqliteStore.open(path.join(f.repo.dir, "memory.sqlite"), { readOnly: true });
      try {
        midRun = {
          units: reader.all("SELECT unit_id, state FROM audit_work_units"),
          coverage: reader.all("SELECT path, state FROM audit_file_coverage"),
          run: reader.get("SELECT status, target, updated_at FROM review_runs WHERE status = 'running'"),
        };
      } finally {
        reader.close();
      }
    }
    const owned = ownedFromPrompt(prompt);
    for (const file of owned) await tools("read_code").execute({ path: file });
    await tools("finish_round").execute({ summary: "covered", nextFocus: [], needsMoreRounds: false });
  });

  const out = await auditIssues({
    ...f.ctx,
    factory: sessions,
    options: { maxVerificationsPerRound: 1 },
  });
  try {
    assert.equal(out.coverage.batchesCompleted, 2);
    assert.ok(midRun, "the reviewer ran and observed mid-run state");
    // Target recorded at start (beginRun), not only at finishRun.
    assert.ok(midRun.run, "a running row exists mid-audit");
    assert.match(midRun.run.target, /"commit":"/);
    assert.ok(midRun.run.updated_at !== null, "heartbeat column is live");
    // The first unit settled before the second session started: its row was
    // flushed per-unit, not held until finishRun.
    assert.ok(
      midRun.units.length >= 1 && midRun.units.every((unit) => ["reviewed", "in-progress", "blocked", "failed"].includes(unit.state)),
      `mid-run unit rows: ${JSON.stringify(midRun.units)}`,
    );
    // Owned files of the finished unit are already accounted for.
    assert.ok(midRun.coverage.length >= 1, `mid-run coverage rows: ${JSON.stringify(midRun.coverage)}`);

    // Final state is authoritative and complete.
    const units = f.ctx.memory.audit.units(out.runId);
    assert.equal(units.length, 2);
    assert.ok(units.every((unit) => unit.state === "reviewed"));
    const run = f.ctx.memory.store.get("SELECT status, updated_at FROM review_runs WHERE id = ?", out.runId);
    assert.equal(run.status, "completed");
    assert.ok(run.updated_at !== null);
  } finally {
    f.cleanup();
  }
});

test("audit: a failed run leaves its ledger behind for the post-mortem", async () => {
  const f = await fixture();
  let reviewerSessions = 0;
  const okReviewer = factory(async (tools, prompt) => {
    const owned = ownedFromPrompt(prompt);
    for (const file of owned) await tools("read_code").execute({ path: file });
    await tools("finish_round").execute({ summary: "covered", nextFocus: [], needsMoreRounds: false });
  });
  const failing = {
    // Unit 1 completes; unit 2's reviewer session cannot even start (the
    // provider is down). The run fails — but its ledger (target + the
    // settled unit) must survive for the post-mortem.
    createSession: (config) => {
      if (config.systemRole !== "code reviewer") {
        return {
          async prompt() {
            throw new Error("unreachable");
          },
          getLastAssistantText: () => "done",
          getLastAssistantError: () => undefined,
          dispose() {},
        };
      }
      reviewerSessions += 1;
      if (reviewerSessions === 2) return Promise.reject(new Error("model endpoint exploded"));
      return okReviewer.createSession(config);
    },
  };
  await assert.rejects(
    auditIssues({ ...f.ctx, factory: failing }),
    /model endpoint exploded/,
  );
  try {
    const rows = f.ctx.memory.store.all(
      "SELECT id, status, notes, target FROM review_runs WHERE mode = 'audit'",
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "failed");
    assert.match(rows[0].notes, /model endpoint exploded/);
    assert.match(rows[0].target, /"commit":"/, "failed runs keep their audit target");
    const units = f.ctx.memory.store.all("SELECT unit_id, state FROM audit_work_units");
    assert.ok(units.length >= 1, "failed runs persist their unit ledger");
    assert.ok(units.some((unit) => unit.state === "reviewed"), `unit 1 settled before the crash: ${JSON.stringify(units)}`);
  } finally {
    f.cleanup();
  }
});
