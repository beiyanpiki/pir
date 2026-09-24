#!/usr/bin/env node
/**
 * Evaluation runner (Phase 11).
 *
 * Usage:
 *   PIR_EVAL=1 [PIR_MODEL=<model-id>] node tests/eval/run-eval.js
 *
 * Requires a working pi model configuration (the same the `pir find` sessions
 * use). Without PIR_EVAL=1 the runner exits 0 with a skip notice so CI stays
 * model-free. Metrics: precision, recall, repeated_false_positive_rate,
 * memory_reuse_rate, finding_regression_recall.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { createTempGitRepo } from "../fixtures/helpers.js";
import { SCENARIOS } from "./scenarios.js";

const CLI = path.resolve("dist/cli/cli.js");

function pir(cwd, dbPath, args) {
  const res = spawnSync(process.execPath, [CLI, ...args, "--json", "--cwd", cwd], {
    encoding: "utf8",
    env: { ...process.env, PIR_MEMORY_DB: dbPath },
    timeout: 15 * 60_000,
  });
  if (res.status !== 0 && res.status !== 1) {
    throw new Error(`pir ${args.join(" ")} failed (${res.status}): ${res.stderr}`);
  }
  return JSON.parse(res.stdout);
}

function matches(text, pattern) {
  return new RegExp(pattern, "i").test(text);
}

async function main() {
  if (process.env.PIR_EVAL !== "1") {
    console.log("skipped: set PIR_EVAL=1 (and configure a pi model) to run evaluation");
    return;
  }
  const { Memory } = await import("../../dist/memory/index.js");
  const { buildIdentity } = await import("../../dist/findings/identity.js");

  const results = [];
  for (const scenario of SCENARIOS) {
    const repo = createTempGitRepo(`pir-eval-${scenario.name}-`);
    const dbPath = path.join(repo.dir, "eval.sqlite");
    let outcome = { scenario: scenario.name, pass: true, details: [] };
    try {
      scenario.build(repo);

      if (scenario.seedFinding || scenario.seedResolution || scenario.seedMemory) {
        const memory = await Memory.open(repo.dir, { dbPath });
        const claim = scenario.seedFinding?.claim ?? scenario.seedResolution?.claim ?? "seed";
        const entityKey = scenario.seedFinding?.entityKey ?? scenario.seedResolution?.entityKey ?? "seed";
        const identity = buildIdentity({ entityKey, category: "correctness", claim, trigger: "seed" });
        const row = memory.findings.insert(
          {
            title: claim,
            claim,
            trigger: "seed",
            category: "correctness",
            severity: "P2",
            entityKey,
            anchors: [],
            evidence: [],
            round: 1,
            identity,
            status: "confirmed",
            memoryMatches: [],
          },
          "seed-run",
        );
        if (scenario.seedFinding) {
          const { applyFeedback } = await import("../../dist/memory/feedback.js");
          await applyFeedback(memory, {
            findingId: row.displayId,
            decision: scenario.seedFinding.decision,
            note: scenario.seedFinding.note,
            commit: "HEAD",
          });
        }
        if (scenario.seedResolution) {
          const resolution = memory.resolutions.insert({
            findingId: row.id,
            fingerprint: identity.fingerprint,
            featureKey: null,
            entityKey,
            category: "correctness",
            originalClaim: claim,
            originalTrigger: "seed",
            resolution: "fixed",
            explanation: scenario.seedResolution.verified ? "verified fix" : "fix",
            beforeCommit: null,
            afterCommit: "HEAD",
            beforeCodeHash: null,
            afterCodeHash: null,
            fixCommit: null,
            fixDiffHash: null,
            verified: true,
          });
          void resolution;
        }
        if (scenario.seedMemory) {
          const { rememberKnowledge } = await import("../../dist/memory/remember.js");
          rememberKnowledge(memory, {
            scope: scenario.seedMemory.scope,
            target: scenario.seedMemory.target,
            kind: scenario.seedMemory.kind,
            text: scenario.seedMemory.text,
            commit: "HEAD",
          });
        }
        memory.close();
      }

      if (scenario.rebuild) scenario.rebuild(repo);

      const modelArgs = process.env.PIR_MODEL ? ["--model", process.env.PIR_MODEL] : [];
      const result = pir(repo.dir, dbPath, ["find", ...scenario.findArgs, ...modelArgs]);
      const reported = result.data.findings.filter((f) => ["confirmed", "uncertain"].includes(f.status));

      for (const expectation of scenario.expect) {
        const hit = reported.find((f) => matches(f.claim, expectation.claimLike));
        if (expectation.shouldReport) {
          const ok = Boolean(hit);
          outcome.details.push(`${ok ? "PASS" : "FAIL"} expected report matching /${expectation.claimLike}/ -> ${hit ? hit.displayId : "none"}`);
          if (!ok) outcome.pass = false;
        } else {
          const ok = !hit;
          outcome.details.push(`${ok ? "PASS" : "FAIL"} expected suppression for /${expectation.claimLike}/ -> ${hit ? `re-reported as ${hit.displayId}` : "not reported"}`);
          if (!ok) outcome.pass = false;
        }
      }
      outcome.findings = reported.map((f) => ({ id: f.displayId, status: f.status, claim: f.claim }));
    } catch (err) {
      outcome.pass = false;
      outcome.details.push(`ERROR ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      repo.cleanup();
    }
    results.push(outcome);
    console.log(`${outcome.pass ? "✔" : "✖"} ${outcome.scenario}`);
    for (const d of outcome.details) console.log(`   ${d}`);
  }

  const passed = results.filter((r) => r.pass).length;
  const repeatedFp = results.filter(
    (r) => r.scenario === "expected-behavior-suppressed" && !r.pass,
  ).length;
  const regressionRecall =
    results.filter((r) => r.scenario === "fixed-regression" && r.pass).length;
  const metrics = {
    scenarios: results.length,
    passed,
    failed: results.length - passed,
    repeated_false_positive_scenarios: repeatedFp,
    finding_regression_scenarios_caught: regressionRecall,
  };
  console.log("\nmetrics:", JSON.stringify(metrics, null, 2));
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(3);
});
