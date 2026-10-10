import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { findIssues, auditIssues } from "../../dist/core/supervisor.js";
import { createAppContext } from "../../dist/app/context.js";
import { createTempGitRepo, submitVerdictWithEvidence } from "../fixtures/helpers.js";

/**
 * Model-free harness for the parallel verification drain: a scripted session
 * factory that tracks how many finding-verifier sessions are open at once
 * (peak concurrency), reports deterministic token usage, and lets tests gate
 * individual verifiers on deferreds so completion order is choreographed
 * independently of admission order.
 */
class DrainHarness {
  constructor({ reviewer, verifier, usage = false } = {}) {
    this.reviewerScript = reviewer;
    this.verifierScript = verifier;
    this.usage = usage;
    this.verifierSessions = 0;
    this.verifierActive = 0;
    this.verifierPeak = 0;
    this.reviewPrompts = [];
  }

  /**
   * Resolves once <n> finding-verifier sessions exist simultaneously. Polls
   * on a timer: a bare promise could leave the whole test process with no
   * I/O in flight and let the event loop drain while choreography is pending.
   */
  waitVerifierSessions(n) {
    return new Promise((resolve) => {
      const check = () => {
        if (this.verifierSessions >= n) resolve();
        else setTimeout(check, 1);
      };
      check();
    });
  }

  async createSession(config) {
    if (config.systemRole === "finding verifier") {
      this.verifierSessions += 1;
      this.verifierActive += 1;
      this.verifierPeak = Math.max(this.verifierPeak, this.verifierActive);
    }
    const harness = this;
    return {
      config,
      async prompt(text) {
        const tools = (name) => {
          const found = config.tools.find((t) => t.name === name);
          if (!found) throw new Error(`tool not found in fake session: ${name}`);
          return found;
        };
        if (config.systemRole === "code reviewer") {
          harness.reviewPrompts.push(text);
          await harness.reviewerScript(tools, text, config);
        } else if (config.systemRole === "finding verifier") {
          await harness.verifierScript(tools, text, config);
        } else {
          throw new Error(`unexpected session role: ${config.systemRole}`);
        }
      },
      getLastAssistantText: () => "fake assistant text",
      getLastAssistantError: () => undefined,
      ...(this.usage ? { getUsage: () => ({ inputTokens: 80, outputTokens: 20, totalTokens: 100 }) } : {}),
      dispose() {
        if (config.systemRole === "finding verifier") harness.verifierActive -= 1;
      },
    };
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** N distinct P1 candidates; same severity keeps pending order == record order. */
function candidates(count) {
  const names = "abcdefghijklmnopqrstuvwxyz".slice(0, count);
  return [...names].map((letter) => ({
    title: `issue-${letter}: quota consumed without remote attempt`,
    claim: `claim-${letter}: retry quota path ${letter} skips its gateway guard`,
    trigger: `gateway exception before charge (${letter})`,
    category: "correctness",
    severity: "P1",
    entityKey: `PaymentService.retry-${letter}`,
    featureKey: "payment-retry",
  }));
}

function reviewerRecording(candidatesList, { needsMoreRounds = false } = {}) {
  return async (tool) => {
    for (const candidate of candidatesList) {
      await tool("record_candidate").execute({
        title: candidate.title,
        claim: candidate.claim,
        trigger: candidate.trigger,
        category: candidate.category,
        severity: candidate.severity,
        featureKey: candidate.featureKey,
        entityKey: candidate.entityKey,
        anchors: [{ path: "src/pay.ts", startLine: 1 }],
        evidence: [{ kind: "code", path: "src/pay.ts", startLine: 1, excerpt: "consumeQuota()" }],
      });
    }
    await tool("finish_round").execute({
      summary: `${candidatesList.length} candidates`,
      nextFocus: [],
      needsMoreRounds,
    });
  };
}

function verifierConfirming(path = "src/pay.ts") {
  return async (tool) => {
    await submitVerdictWithEvidence(tool, {
      verdict: "confirmed",
      rationale: "traced the path in the test double",
      confidence: 0.9,
    }, path);
  };
}

async function findFixture() {
  const repo = createTempGitRepo("pir-parallel-drain-");
  repo.write("src/pay.ts", "export function retry(): void {}\n");
  repo.commit("init");
  repo.write("src/pay.ts", "export function retry(): void { consumeQuota(); }\n");
  repo.commit("introduce bug");
  const ctx = await createAppContext(repo.dir, { noSyncIndex: true, dbPath: path.join(repo.dir, "m.sqlite") });
  return {
    repo,
    ctx,
    run: (factory, options) =>
      findIssues({
        repoRoot: repo.dir,
        memory: ctx.memory,
        codeMap: ctx.codeMap,
        factory,
        options,
      }),
    cleanup() {
      ctx.memory.close();
      repo.cleanup();
    },
  };
}

function fingerprintRun(outcome) {
  return outcome.findings.map((row) => ({ fingerprint: row.fingerprint, status: row.status, displayId: row.displayId }));
}

test("parallel drain: C=4 peaks at 4 verifier sessions and lands results in admission order", async () => {
  const list = candidates(6);
  const gates = new Map(list.map((c) => [c.title, deferred()]));
  const fx = await findFixture();
  const factory = new DrainHarness({
    reviewer: reviewerRecording(list),
    verifier: async (tool, text) => {
      const candidate = list.find((c) => text.includes(c.title));
      await gates.get(candidate.title).promise;
      await submitVerdictWithEvidence(tool, { verdict: "confirmed", rationale: "traced it", confidence: 0.9 });
    },
  });
  try {
    const runPromise = fx.run(factory, { maxRounds: 1, verifyConcurrency: 4 });
    await factory.waitVerifierSessions(4);
    assert.equal(factory.verifierActive, 4, "four verifier sessions open at once");
    // Complete the first four in reverse admission order: the head candidate
    // finishes last, so landing order is only decided by the drain.
    for (const candidate of [...list].slice(0, 4).reverse()) gates.get(candidate.title).resolve();
    await factory.waitVerifierSessions(6);
    for (const candidate of [...list].slice(4).reverse()) gates.get(candidate.title).resolve();
    const outcome = await runPromise;
    assert.equal(factory.verifierPeak, 4, "peak concurrency stays at the configured 4");
    assert.equal(factory.verifierSessions, 6);
    assert.equal(outcome.findings.length, 6);
    // Admission (record) order, not completion order.
    assert.deepEqual(
      outcome.findings.map((row) => row.entityKey),
      list.map((c) => c.entityKey),
    );
  } finally {
    fx.cleanup();
  }
});

test("parallel drain: C=4 findings equal the serial run (fingerprint, status, displayId order)", async () => {
  const list = candidates(6);
  const serialFx = await findFixture();
  const parallelFx = await findFixture();
  try {
    const serial = await serialFx.run(
      new DrainHarness({ reviewer: reviewerRecording(list), verifier: verifierConfirming() }),
      { maxRounds: 1 },
    );
    const gates = new Map(list.map((c) => [c.title, deferred()]));
    const factory = new DrainHarness({
      reviewer: reviewerRecording(list),
      verifier: async (tool, text) => {
        const candidate = list.find((c) => text.includes(c.title));
        await gates.get(candidate.title).promise;
        await submitVerdictWithEvidence(tool, { verdict: "confirmed", rationale: "traced it", confidence: 0.9 });
      },
    });
    const runPromise = parallelFx.run(factory, { maxRounds: 1, verifyConcurrency: 4 });
    await factory.waitVerifierSessions(4);
    for (const candidate of [...list].slice(0, 4).reverse()) gates.get(candidate.title).resolve();
    await factory.waitVerifierSessions(6);
    for (const candidate of [...list].slice(4).reverse()) gates.get(candidate.title).resolve();
    const parallel = await runPromise;
    assert.deepEqual(fingerprintRun(parallel), fingerprintRun(serial));
  } finally {
    serialFx.cleanup();
    parallelFx.cleanup();
  }
});

test("parallel drain: maxVerificationsPerRound bounds admissions regardless of concurrency", async () => {
  const list = candidates(5);
  const fx = await findFixture();
  const factory = new DrainHarness({ reviewer: reviewerRecording(list), verifier: verifierConfirming() });
  try {
    const outcome = await fx.run(factory, { maxRounds: 1, maxVerificationsPerRound: 2, verifyConcurrency: 4 });
    assert.equal(factory.verifierSessions, 2, "only the admitted candidates reach a verifier");
    assert.equal(outcome.findings.length, 2);
    assert.equal(outcome.pendingCandidates, 3);
  } finally {
    fx.cleanup();
  }
});

test("parallel drain: in-flight candidates reserve maxFindings slots (no oversubscription)", async () => {
  const list = candidates(5);
  const fx = await findFixture();
  const factory = new DrainHarness({ reviewer: reviewerRecording(list), verifier: verifierConfirming() });
  try {
    // All verdicts confirm, so every admitted candidate would be reported:
    // the reservation must hold reported findings at exactly the cap.
    const outcome = await fx.run(factory, { maxRounds: 1, maxFindings: 2, verifyConcurrency: 4 });
    assert.equal(factory.verifierSessions, 2, "no admission beyond the reserved cap");
    assert.equal(outcome.findings.length, 2);
    assert.ok(outcome.findings.every((row) => row.status === "confirmed"));
    assert.equal(outcome.stoppedBecause, "max findings reached (2)");
  } finally {
    fx.cleanup();
  }
});

test("parallel drain: a rejected verdict frees its reserved slot for the next candidate", async () => {
  const list = candidates(5);
  const fx = await findFixture();
  const factory = new DrainHarness({
    reviewer: reviewerRecording(list),
    verifier: async (tool, text) => {
      const verdict = text.includes(list[0].title) ? "rejected" : "confirmed";
      await submitVerdictWithEvidence(tool, { verdict, rationale: "checked the code", confidence: 0.9 });
    },
  });
  try {
    const outcome = await fx.run(factory, { maxRounds: 1, maxFindings: 2, verifyConcurrency: 4 });
    // alpha rejected -> slot freed -> gamma admitted while beta is in flight;
    // beta+gamma confirm and fill the two report slots. delta/epsilon never run.
    assert.equal(factory.verifierSessions, 3);
    assert.equal(outcome.findings.filter((row) => row.status === "confirmed").length, 2);
    assert.equal(outcome.findings.filter((row) => row.status === "rejected").length, 1);
    assert.equal(outcome.stoppedBecause, "max findings reached (2)");
  } finally {
    fx.cleanup();
  }
});

test("parallel drain: token budget exhaustion stops dispatching; in-flight verifications still land", async () => {
  const list = candidates(5);
  const fx = await findFixture();
  // Deterministic without choreography: landings are in admission order, so
  // the n-th admission check always sees the same spend. Usage is 100 per
  // session (reviewer included): the 4th admission (delta) sees 100+200=300
  // and fits maxTokens=400, while the 5th (epsilon) always sees 100+300=400
  // and is refused — no gate for epsilon to sit on, so a slow completion of
  // delta before gamma can only shift session timing, never the outcome.
  const factory = new DrainHarness({
    reviewer: reviewerRecording(list),
    verifier: verifierConfirming(),
    usage: true,
  });
  try {
    const outcome = await fx.run(factory, { maxRounds: 5, maxTokens: 400, verifyConcurrency: 2 });
    assert.equal(factory.verifierSessions, 4, "budget-exhausted admission refuses the fifth");
    assert.equal(outcome.findings.length, 4, "the in-flight fourth verification lands");
    assert.equal(outcome.pendingCandidates, 1);
    assert.match(outcome.stoppedBecause, /token budget exhausted/);
  } finally {
    fx.cleanup();
  }
});

test("parallel drain: investigation feedback lands in admission order and keeps the 12-entry cap", async () => {
  const list = candidates(14);
  const fx = await findFixture();
  let reviewerRounds = 0;
  const factory = new DrainHarness({
    reviewer: async (tool) => {
      reviewerRounds += 1;
      if (reviewerRounds === 1) {
        await reviewerRecording(list, { needsMoreRounds: true })(tool);
        return;
      }
      await tool("finish_round").execute({ summary: "nothing more", nextFocus: [], needsMoreRounds: false });
    },
    verifier: async (tool, text) => {
      const candidate = list.find((c) => text.includes(c.title));
      await submitVerdictWithEvidence(tool, {
        verdict: "confirmed",
        rationale: "traced it",
        confidence: 0.9,
        codeFeedback: `feedback-${candidate.title.slice(6, 7)}: verify the refresh path`,
      });
    },
  });
  try {
    const outcome = await fx.run(factory, { maxRounds: 2, maxFindings: null, maxVerificationsPerRound: 14, verifyConcurrency: 4 });
    assert.equal(reviewerRounds, 2);
    assert.equal(outcome.findings.length, 14);
    // The round-2 reviewer prompt carries the feedback window: the last 12
    // entries in admission order; the first two fell out of the cap.
    const round2Prompt = factory.reviewPrompts[1];
    const feedbackJson = round2Prompt
      .split("CODE-ONLY INVESTIGATION FEEDBACK (leads to falsify, not findings to repeat)")[1]
      .split("\n")
      .find((line) => line.trim().startsWith("["));
    const feedback = JSON.parse(feedbackJson);
    assert.equal(feedback.length, 12);
    assert.match(feedback[0], /feedback-c:/);
    assert.match(feedback[1], /feedback-d:/);
    assert.match(feedback[11], /feedback-n:/);
    assert.ok(!round2Prompt.includes("feedback-a:"), "fell out of the 12-entry window");
    assert.ok(!round2Prompt.includes("feedback-b:"), "fell out of the 12-entry window");
  } finally {
    fx.cleanup();
  }
});

test("parallel drain: verifyConcurrency must be an integer within 1-8", async () => {
  const list = candidates(1);
  const fx = await findFixture();
  for (const bad of [0, -1, 1.5, 9, 100]) {
    await assert.rejects(
      fx.run(new DrainHarness({ reviewer: reviewerRecording(list), verifier: verifierConfirming() }), {
        maxRounds: 1,
        verifyConcurrency: bad,
      }),
      /verifyConcurrency/,
    );
  }
  const outcome = await fx.run(
    new DrainHarness({ reviewer: reviewerRecording(list), verifier: verifierConfirming() }),
    { maxRounds: 1, verifyConcurrency: 8 },
  );
  assert.equal(outcome.findings.length, 1, "boundary value 8 is accepted");
  fx.cleanup();
});

// ---------------------------------------------------------------------------
// The audit loop shares the same drain — the same guarantees must hold there.
// ---------------------------------------------------------------------------

async function auditFixture() {
  const repo = createTempGitRepo("pir-parallel-audit-");
  repo.write("src/a/util.ts", "export const id = (x) => x;\n");
  repo.write("src/b/calc.ts", "export const add = (a, b) => a + b;\n");
  repo.commit("code");
  const ctx = await createAppContext(repo.dir, { noSyncIndex: true, dbPath: path.join(repo.dir, "memory.sqlite") });
  return {
    repo,
    ctx,
    run: (factory, options) =>
      auditIssues({
        repoRoot: repo.dir,
        memory: ctx.memory,
        codeMap: ctx.codeMap,
        factory,
        options,
      }),
    cleanup() {
      ctx.memory.close();
      repo.cleanup();
    },
  };
}

function auditReviewerRecording(candidatesList) {
  return async (tools, prompt) => {
    const owned = [...prompt.matchAll(/^- (\S+) \((?:from line \d+ to end|lines \d+-\d+)\)/gm)].map((match) => match[1]);
    assert.ok(owned.length >= 1, "audit reviewer must own at least one file");
    for (const file of owned) {
      const read = await tools("read_code").execute({ path: file });
      assert.ok(!read.text.startsWith("ERROR"), read.text);
    }
    for (const candidate of candidatesList) {
      await tools("record_candidate").execute({
        title: candidate.title,
        claim: candidate.claim,
        trigger: candidate.trigger,
        category: candidate.category,
        severity: candidate.severity,
        featureKey: candidate.featureKey,
        entityKey: candidate.entityKey,
        anchors: [{ path: owned[0], startLine: 1 }],
        evidence: [{ kind: "code", path: owned[0], startLine: 1, excerpt: "export const" }],
      });
    }
    await tools("finish_round").execute({
      summary: `covered ${owned.join(", ")}`,
      nextFocus: [],
      needsMoreRounds: false,
    });
  };
}

test("parallel drain (audit): gated completions still land in admission order and match the serial run", async () => {
  const list = candidates(3);
  const serialFx = await auditFixture();
  const parallelFx = await auditFixture();
  try {
    const serial = await serialFx.run(
      new DrainHarness({ reviewer: auditReviewerRecording(list), verifier: verifierConfirming("src/a/util.ts") }),
      { verifyConcurrency: 1 },
    );
    const gates = new Map(list.map((c) => [c.title, deferred()]));
    const factory = new DrainHarness({
      reviewer: auditReviewerRecording(list),
      verifier: async (tool, text) => {
        const candidate = list.find((c) => text.includes(c.title));
        await gates.get(candidate.title).promise;
        await submitVerdictWithEvidence(tool, { verdict: "confirmed", rationale: "snapshot defect", confidence: 0.9 }, "src/a/util.ts");
      },
    });
    const runPromise = parallelFx.run(factory, { verifyConcurrency: 4 });
    await factory.waitVerifierSessions(3);
    for (const candidate of [...list].reverse()) gates.get(candidate.title).resolve();
    const parallel = await runPromise;
    assert.equal(factory.verifierPeak, 3);
    assert.deepEqual(fingerprintRun(parallel), fingerprintRun(serial));
    assert.equal(parallel.incomplete, false);
  } finally {
    serialFx.cleanup();
    parallelFx.cleanup();
  }
});

test("parallel drain (audit): maxFindings reservation holds under concurrency", async () => {
  const list = candidates(4);
  const fx = await auditFixture();
  const factory = new DrainHarness({ reviewer: auditReviewerRecording(list), verifier: verifierConfirming("src/a/util.ts") });
  try {
    const outcome = await fx.run(factory, { maxFindings: 2, verifyConcurrency: 4 });
    assert.equal(factory.verifierSessions, 2);
    assert.equal(outcome.findings.length, 2);
    assert.ok(outcome.findings.every((row) => row.status === "confirmed"));
  } finally {
    fx.cleanup();
  }
});
