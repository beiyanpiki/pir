import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createTempGitRepo } from "../fixtures/helpers.js";
import { createAppContext } from "../../dist/app/context.js";
import { CHANGED_FILES_LIMIT } from "../../dist/agents/prompts.js";
import { findIssues } from "../../dist/core/supervisor.js";

/**
 * ADR 0004 Part IV at the supervisor boundary: the reviewer prompt carries the
 * complete changed-file map (path, status, churn, exclusion reason), capped at
 * 60 entries with an explicit remainder line, and asks for per-file accounting
 * without making it a hard error. Prompt-only: no extra call, no new ask.
 */

/** A reviewer that records its prompt and finishes immediately (no findings). */
function capturingFactory(prompts) {
  return {
    async createSession(config) {
      return {
        async prompt(text) {
          prompts.push(text);
          const finish = config.tools.find((tool) => tool.name === "finish_round");
          assert.ok(finish, "finish_round tool is present");
          const result = await finish.execute({ summary: "inspected the change", nextFocus: [], needsMoreRounds: false });
          assert.ok(!result.text.startsWith("ERROR"), result.text);
        },
        getLastAssistantText: () => "done",
        getLastAssistantError: () => undefined,
        dispose() {},
      };
    },
  };
}

async function fixture(setup) {
  const repo = createTempGitRepo("pir-s3-");
  repo.write("README.md", "# fixture\n");
  repo.commit("baseline");
  setup(repo);
  repo.commit("change");
  const ctx = await createAppContext(repo.dir, { noSyncIndex: true, dbPath: path.join(repo.dir, "memory.sqlite") });
  return { repo, ctx, cleanup() { ctx.memory.close(); repo.cleanup(); } };
}

test("the changed-file map reaches the reviewer prompt with status, churn and exclusion reasons", async () => {
  const f = await fixture((repo) => {
    repo.write("src/app.ts", "export const next = (n: number) => n + 1;\n");
    repo.write(".env", "SUPER_SECRET_TOKEN=abc\n");
  });
  try {
    const prompts = [];
    await findIssues({ ...f.ctx, factory: capturingFactory(prompts), options: { maxRounds: 1 } });
    const prompt = prompts[0];
    assert.match(prompt, /CHANGED FILES \(all 2 files in this change; path, status, churn\)/);
    assert.match(prompt, /- src\/app\.ts \(added, \+1\/-0\)/);
    assert.match(prompt, /- \.env \(added, \+1\/-0\) — excluded: secret path \(dotenv file\); never sent to a model/);
    // The map is the change set, not the diff: the excluded file's body never
    // enters the prompt (the change-mode filter stays intact).
    assert.equal(prompt.includes("SUPER_SECRET_TOKEN"), false);
    // Placement: after the change line, before the process rules and the
    // evidence block.
    assert.ok(prompt.indexOf("Change: ") < prompt.indexOf("CHANGED FILES"));
    assert.ok(prompt.indexOf("CHANGED FILES") < prompt.indexOf("PROCESS"));
    assert.ok(prompt.indexOf("CHANGED FILES") < prompt.indexOf("=== REPOSITORY MEMORY ==="));
    // The accounting request is a request, not a hard error.
    assert.match(prompt, /ACCOUNT FOR EVERY CHANGED FILE/);
    assert.match(prompt, /stated reason in coverage/);
    assert.match(prompt, /This is not a hard error/);
  } finally { f.cleanup(); }
});

test("a large change is listed up to the cap and says how many files it left out", async () => {
  const total = CHANGED_FILES_LIMIT + 3;
  const f = await fixture((repo) => {
    for (let i = 0; i < total; i += 1) repo.write(`src/gen/file-${String(i).padStart(2, "0")}.ts`, `export const value = ${i};\n`);
  });
  try {
    const prompts = [];
    await findIssues({ ...f.ctx, factory: capturingFactory(prompts), options: { maxRounds: 1 } });
    const prompt = prompts[0];
    assert.match(prompt, new RegExp(`CHANGED FILES \\(all ${total} files in this change`));
    const listed = prompt.slice(prompt.indexOf("CHANGED FILES"), prompt.indexOf("ACCOUNT FOR EVERY CHANGED FILE"));
    assert.ok(listed.length > 0, "a CHANGED FILES section is rendered");
    assert.equal(listed.split("\n\n").filter((block) => block.startsWith("- ")).length, CHANGED_FILES_LIMIT);
    assert.ok(listed.includes(`... ${total - CHANGED_FILES_LIMIT} more changed files not listed`));
  } finally { f.cleanup(); }
});

test("an unchanged change set renders no section, so the prompt stays byte-identical", async () => {
  const f = await fixture((repo) => { repo.write("src/app.ts", "export const next = (n: number) => n + 1;\n"); });
  try {
    const prompts = [];
    const first = await findIssues({ ...f.ctx, factory: capturingFactory(prompts), options: { maxRounds: 1 } });
    assert.ok(prompts[0].includes("CHANGED FILES"));
    // Replaying the same prompt input without the list is the pre-change prompt.
    const { reviewerPrompt } = await import("../../dist/agents/prompts.js");
    const base = { base: "b", head: "h", round: 1, maxRounds: 2, maxFindings: 10, findingsRemaining: 10, focus: [], memoryPack: "", structuralQueries: false };
    assert.equal(reviewerPrompt({ ...base, changedFiles: [] }), reviewerPrompt(base));
    assert.equal(reviewerPrompt({ ...base, changedFiles: undefined }).includes("CHANGED FILES"), false);
    assert.equal(first.rounds.length >= 1, true);
  } finally { f.cleanup(); }
});
