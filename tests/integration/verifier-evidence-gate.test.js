import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { runVerifier } from "../../dist/agents/verifier.js";
import { buildIdentity } from "../../dist/findings/identity.js";
import { createTempGitRepo } from "../fixtures/helpers.js";

/**
 * Q3 evidence gate: submit_verdict is refused until the session has examined
 * evidence (a pinned read or a code-evidence call). The fake factory hands
 * the test the session's real tools so each script drives the same tool
 * objects the gate observes.
 */
function scriptedFactory(script) {
  const state = { tools: null, config: null };
  return {
    state,
    async createSession(config) {
      state.config = config;
      state.tools = (name) => {
        const found = config.tools.find((tool) => tool.name === name);
        assert.ok(found, `missing tool ${name}`);
        return found;
      };
      return {
        async prompt() {
          await script(state);
        },
        getLastAssistantText: () => "assistant text",
        getLastAssistantError: () => undefined,
        dispose() {},
      };
    },
  };
}

async function fixture() {
  const repo = createTempGitRepo("pir-evidence-gate-");
  repo.write("src/pay.ts", "export function retry(): void { consumeQuota(); }\n");
  const head = repo.commit("introduce bug");
  return {
    repo,
    head,
    ctx: {
      repoRoot: repo.dir,
      headCommit: head,
      changeSet: { baseCommit: head, headCommit: head, mergeBase: head, files: [], patch: "" },
      codeMap: { structuralQueries: false },
      memory: null,
    },
    cleanup() {
      repo.cleanup();
    },
  };
}

const candidate = {
  title: "retry quota consumed without remote attempt",
  claim: "retry quota is consumed without an actual remote gateway attempt",
  trigger: "gateway exception before charge",
  category: "correctness",
  severity: "P1",
  anchors: [{ path: "src/pay.ts", startLine: 1 }],
  identity: buildIdentity({ category: "correctness", claim: "retry quota is consumed without an actual remote gateway attempt", trigger: "gateway exception before charge" }),
};

test("evidence gate: immediate submit_verdict is a non-terminal error; a pinned read then admits it", async () => {
  const fx = await fixture();
  const factory = scriptedFactory(async ({ tools }) => {
    const rejected = await tools("submit_verdict").execute({
      verdict: "confirmed", rationale: "the name says it all", confidence: 0.9,
    });
    assert.match(rejected.text, /No evidence gathered in this session/);
    assert.equal(rejected.terminate, undefined, "the gate error is non-terminal: the session can recover");
    const read = await tools("read_code").execute({ path: "src/pay.ts" });
    assert.ok(!read.text.startsWith("ERROR"), read.text);
    const accepted = await tools("submit_verdict").execute({
      verdict: "confirmed", rationale: "src/pay.ts:1 consumes quota before the gateway call", confidence: 0.9,
    });
    assert.equal(accepted.terminate, true);
  });
  try {
    const result = await runVerifier({ factory, ctx: fx.ctx, candidate, priorDecisions: [] });
    assert.equal(result.verdict, "confirmed", "the recovered session's verdict lands");
  } finally {
    fx.cleanup();
  }
});

test("evidence gate: memory lookup alone never satisfies it — the error persists and the run degrades to uncertain", async () => {
  const fx = await fixture();
  const factory = scriptedFactory(async ({ tools }) => {
    const lookup = await tools("get_relevant_issue_memory").execute({ claim: candidate.claim });
    assert.ok(!lookup.text.startsWith("ERROR"), lookup.text);
    const rejected = await tools("submit_verdict").execute({
      verdict: "confirmed", rationale: "memory has context on this", confidence: 0.9,
    });
    assert.match(rejected.text, /No evidence gathered in this session/);
  });
  try {
    const result = await runVerifier({ factory, ctx: fx.ctx, candidate, priorDecisions: [] });
    assert.equal(result.verdict, "uncertain", "a session that never recovers degrades like a silent verifier");
    assert.equal(result.uncertaintyReason, "missing-verdict");
  } finally {
    fx.cleanup();
  }
});

test("evidence gate: a search alone gathers evidence but stage 2 still demands a cited pinned read", async () => {
  const fx = await fixture();
  const factory = scriptedFactory(async ({ tools }) => {
    const search = await tools("search_text").execute({ pattern: "consumeQuota", revision: "head" });
    assert.ok(!search.text.startsWith("ERROR"), search.text);
    const rejected = await tools("submit_verdict").execute({
      verdict: "rejected", rationale: "the searched call path contradicts the claim", confidence: 0.9,
    });
    assert.match(rejected.text, /No pinned read in this session/);
    const read = await tools("read_code").execute({ path: "src/pay.ts" });
    assert.ok(!read.text.startsWith("ERROR"), read.text);
    const accepted = await tools("submit_verdict").execute({
      verdict: "rejected", rationale: "the search at src/pay.ts:1 contradicts the claimed call path", confidence: 0.9,
    });
    assert.equal(accepted.terminate, true);
  });
  try {
    const result = await runVerifier({ factory, ctx: fx.ctx, candidate, priorDecisions: [] });
    assert.equal(result.verdict, "rejected");
  } finally {
    fx.cleanup();
  }
});

test("evidence gate: get_change counts as evidence in change mode; audit has no get_change but searches still count", async () => {
  const fx = await fixture();
  const changeFactory = scriptedFactory(async ({ tools }) => {
    const change = await tools("get_change").execute({});
    assert.ok(!change.text.startsWith("ERROR"), change.text);
    // Evidence alone is not acceptance: stage 2 wants a cited pinned read.
    const rejected = await tools("submit_verdict").execute({
      verdict: "confirmed", rationale: "the diff shows the quota charge moved ahead of the call", confidence: 0.9,
    });
    assert.match(rejected.text, /No pinned read in this session/);
    await tools("read_code").execute({ path: "src/pay.ts" });
    const accepted = await tools("submit_verdict").execute({
      verdict: "confirmed", rationale: "the diff shows the quota charge moved ahead of the call at src/pay.ts:1", confidence: 0.9,
    });
    assert.equal(accepted.terminate, true);
  });
  try {
    const changeResult = await runVerifier({ factory: changeFactory, ctx: fx.ctx, candidate, priorDecisions: [] });
    assert.equal(changeResult.verdict, "confirmed");
  } finally {
    fx.cleanup();
  }

  const auditFx = await fixture();
  const auditFactory = scriptedFactory(async ({ tools }) => {
    const search = await tools("search_text").execute({ pattern: "consumeQuota", revision: "head" });
    assert.ok(!search.text.startsWith("ERROR"), search.text);
    await tools("read_code").execute({ path: "src/pay.ts" });
    const accepted = await tools("submit_verdict").execute({
      verdict: "confirmed", rationale: "the snapshot reaches this failure at src/pay.ts:1", confidence: 0.9,
    });
    assert.equal(accepted.terminate, true);
  });
  try {
    const auditResult = await runVerifier({ factory: auditFactory, ctx: { ...auditFx.ctx, changeSet: undefined }, candidate, priorDecisions: [], audit: true });
    assert.equal(auditResult.verdict, "confirmed");
    assert.equal(auditFactory.state.config.tools.some((tool) => tool.name === "get_change"), false, "audit verifier sessions carry no get_change, so it cannot satisfy the gate there");
  } finally {
    auditFx.cleanup();
  }
});

test("evidence gate stage 2: a rationale citing an unread path is rejected until that path is read", async () => {
  const fx = await fixture();
  const factory = scriptedFactory(async ({ tools }) => {
    await tools("read_code").execute({ path: "src/pay.ts" });
    const rejected = await tools("submit_verdict").execute({
      verdict: "confirmed", rationale: "the failure is obvious in src/other/never-read.ts:3", confidence: 0.9,
    });
    assert.match(rejected.text, /cites no pinned-read path/);
    const otherRead = await tools("read_code").execute({ path: "src/other/never-read.ts" });
    assert.match(otherRead.text, /file not found at this snapshot/, "fixture has no such file; a failed read must not satisfy the gate either");
    const accepted = await tools("submit_verdict").execute({
      verdict: "confirmed", rationale: "quota is charged at src/pay.ts:1 before the gateway call", confidence: 0.9,
    });
    assert.equal(accepted.terminate, true);
  });
  try {
    const result = await runVerifier({ factory, ctx: fx.ctx, candidate, priorDecisions: [] });
    assert.equal(result.verdict, "confirmed");
  } finally {
    fx.cleanup();
  }
});

test("evidence gate stage 2: path tokens without line numbers and quoted citations both match", async () => {
  const fx = await fixture();
  const factory = scriptedFactory(async ({ tools }) => {
    await tools("read_code").execute({ path: "src/pay.ts" });
    const accepted = await tools("submit_verdict").execute({
      verdict: "rejected", rationale: '`src/pay.ts` shows the guard fires first; no defect', confidence: 0.9,
    });
    assert.equal(accepted.terminate, true, "a bare backticked path with no :line still counts as a citation");
  });
  try {
    const result = await runVerifier({ factory, ctx: fx.ctx, candidate, priorDecisions: [] });
    assert.equal(result.verdict, "rejected");
  } finally {
    fx.cleanup();
  }
});

test("evidence gate: a session that gathers nothing and never submits stays missing-verdict", async () => {
  const fx = await fixture();
  const factory = scriptedFactory(async () => {});
  try {
    const result = await runVerifier({ factory, ctx: fx.ctx, candidate, priorDecisions: [] });
    assert.equal(result.verdict, "uncertain");
    assert.equal(result.uncertaintyReason, "missing-verdict");
  } finally {
    fx.cleanup();
  }
});
