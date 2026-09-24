import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createTempGitRepo } from "../fixtures/helpers.js";

/**
 * Load the compiled extension factory with a mock ExtensionAPI — the same
 * interface pi provides — and verify command registration and end-to-end
 * handler wiring without a running pi instance.
 */
async function loadExtension() {
  const extension = await import("../../dist/extension/index.js");
  const commands = new Map();
  const events = [];
  const pi = {
    registerCommand: (name, options) => commands.set(name, options),
    on: (event, handler) => {
      events.push(event);
      return () => {};
    },
  };
  extension.default(pi);
  return { commands, events };
}

function makeCtx(repoDir) {
  const notifications = [];
  return {
    notifications,
    cwd: repoDir,
    ui: {
      notify: (message, type) => notifications.push({ message, type }),
      setStatus: () => {},
    },
  };
}

test("extension factory registers the four /review-* commands", async () => {
  const { commands, events } = await loadExtension();
  assert.deepEqual(
    [...commands.keys()].sort(),
    ["review-feedback", "review-find", "review-memory", "review-remember"],
  );
  assert.ok(commands.get("review-feedback").description.length > 0);
  assert.ok(events.includes("session_shutdown"));
});

test("/review-memory status renders project state through the shared app layer", async () => {
  const repo = createTempGitRepo("pir-ext-");
  try {
    const { commands } = await loadExtension();
    const ctx = makeCtx(repo.dir);
    await commands.get("review-memory").handler("status", ctx);
    assert.equal(ctx.notifications.length, 1);
    assert.match(ctx.notifications[0].message, /project /);
    assert.match(ctx.notifications[0].message, /codegraph/);
  } finally {
    repo.cleanup();
  }
});

test("/review-remember + /review-feedback handlers round-trip into memory", async (t) => {
  const repo = createTempGitRepo("pir-ext2-");
  const dbPath = path.join(repo.dir, "m.sqlite");
  process.env.PIR_MEMORY_DB = dbPath;
  t.after(() => delete process.env.PIR_MEMORY_DB);
  try {
    const { commands } = await loadExtension();

    const rememberCtx = makeCtx(repo.dir);
    await commands
      .get("review-remember")
      .handler('project invariant "All financial writes must be idempotent"', rememberCtx);
    assert.match(rememberCtx.notifications[0].message, /remembered \(project\)/);

    const { Memory } = await import("../../dist/memory/index.js");
    const { buildIdentity } = await import("../../dist/findings/identity.js");
    const memory = await Memory.open(repo.dir, { dbPath: path.join(repo.dir, "m.sqlite") });
    const identity = buildIdentity({
      featureKey: null,
      entityKey: "PaymentService.retry",
      category: "correctness",
      claim: "quota claim",
      trigger: "gateway throws",
    });
    const row = memory.findings.insert(
      {
        title: "t",
        claim: "quota claim",
        trigger: "gateway throws",
        category: "correctness",
        severity: "P1",
        entityKey: "PaymentService.retry",
        anchors: [],
        evidence: [],
        round: 1,
        identity,
        status: "confirmed",
        memoryMatches: [],
      },
      "run-1",
    );
    memory.close();

    const feedbackCtx = makeCtx(repo.dir);
    await commands
      .get("review-feedback")
      .handler(`F-1 expected "retry_count intentionally counts attempts"`, feedbackCtx);
    assert.match(feedbackCtx.notifications[0].message, /confirmed -> expected/);
    assert.match(feedbackCtx.notifications[0].message, /issue memory recorded/);
  } finally {
    repo.cleanup();
  }
});

test("/review-feedback usage errors notify instead of throwing", async () => {
  const repo = createTempGitRepo("pir-ext3-");
  try {
    const { commands } = await loadExtension();
    const ctx = makeCtx(repo.dir);
    await commands.get("review-feedback").handler("", ctx);
    assert.match(ctx.notifications[0].message, /usage:/);
    assert.equal(ctx.notifications[0].type, "warning");
  } finally {
    repo.cleanup();
  }
});
