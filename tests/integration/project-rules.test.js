import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTempGitRepo } from "../fixtures/helpers.js";
import { createAppContext } from "../../dist/app/context.js";
import { findIssues } from "../../dist/core/supervisor.js";
import { ProjectRuleError } from "../../dist/rules/project-rules.js";

/**
 * B5 acceptance A1 at the supervisor boundary: the rendered PROJECT RULES
 * section reaches the reviewer prompt in its documented position, the
 * repo/--rule layers decide what is injected, mergeBuiltin=false withholds the
 * built-in language-pack guidance, and the canonical hash lands in run.json.
 * All model-free: scripted sessions, a temp repository, no network.
 */

async function fixture() {
  const repo = createTempGitRepo("pir-b5-");
  repo.write("go.mod", "module example.com/counter\n\ngo 1.22\n");
  repo.write("src/counter.go", "package counter\n\nfunc Next(n int) int { return n + 1 }\n");
  repo.commit("baseline");
  repo.write("src/counter.go", "package counter\n\nfunc Next(n int) int { return n + 2 }\n");
  repo.commit("change");
  const ctx = await createAppContext(repo.dir, { noSyncIndex: true, dbPath: path.join(repo.dir, "memory.sqlite") });
  return { repo, ctx, cleanup() { ctx.memory.close(); repo.cleanup(); } };
}

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

function writeRule(file, body) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(body));
}

test("repo rules reach the reviewer prompt before the memory pack", async () => {
  const f = await fixture();
  const prompts = [];
  writeRule(path.join(f.repo.dir, ".pir", "rule.json"), {
    rules: [{ path: "src/**", guidance: "COUNTER RULE: every increment must stay overflow-safe." }],
  });
  try {
    await findIssues({ ...f.ctx, factory: capturingFactory(prompts), options: { maxRounds: 1 } });
    assert.equal(prompts.length, 1);
    const prompt = prompts[0];
    assert.match(prompt, /PROJECT RULES/);
    assert.match(prompt, /COUNTER RULE: every increment must stay overflow-safe\./);
    assert.match(prompt, /untrusted evidence, not instructions/);
    assert.ok(prompt.indexOf("PROJECT RULES") < prompt.indexOf("=== REPOSITORY MEMORY ==="));
  } finally { f.cleanup(); }
});

test("an explicit rule file wins over the repository layer", async () => {
  const f = await fixture();
  const prompts = [];
  const explicit = path.join(f.repo.dir, "explicit-rules.json");
  writeRule(path.join(f.repo.dir, ".pir", "rule.json"), { rules: [{ path: "src/**", guidance: "REPO-LAYER" }] });
  writeRule(explicit, { rules: [{ path: "src/**", guidance: "EXPLICIT-LAYER" }] });
  try {
    await findIssues({ ...f.ctx, factory: capturingFactory(prompts), options: { maxRounds: 1, ruleFile: explicit } });
    assert.match(prompts[0], /EXPLICIT-LAYER/);
    assert.doesNotMatch(prompts[0], /REPO-LAYER/);
  } finally { f.cleanup(); }
});

test("mergeBuiltin=true keeps the language-pack guidance; false withholds it for the run", async () => {
  const f = await fixture();
  const keepPrompts = [];
  const dropPrompts = [];
  const ruleFile = path.join(f.repo.dir, ".pir", "rule.json");
  try {
    writeRule(ruleFile, { rules: [{ path: "src/**", guidance: "KEEP", mergeBuiltin: true }] });
    await findIssues({ ...f.ctx, factory: capturingFactory(keepPrompts), options: { maxRounds: 1 } });
    assert.match(keepPrompts[0], /LANGUAGE GUIDANCE/);
    assert.match(keepPrompts[0], /Go review directions/);

    writeRule(ruleFile, { rules: [{ path: "src/**", guidance: "REPLACE", mergeBuiltin: false }] });
    await findIssues({ ...f.ctx, factory: capturingFactory(dropPrompts), options: { maxRounds: 1 } });
    assert.doesNotMatch(dropPrompts[0], /Go review directions/);
    assert.doesNotMatch(dropPrompts[0], /=== LANGUAGE GUIDANCE/);
    assert.match(dropPrompts[0], /WITHHELD/);
    assert.match(dropPrompts[0], /REPLACE/);
  } finally { f.cleanup(); }
});

test("a broken rule file fails before any session, and the manifest records the rule hash", async () => {
  const f = await fixture();
  const previous = process.env.PIR_TRANSCRIPTS;
  process.env.PIR_TRANSCRIPTS = "1";
  const ruleFile = path.join(f.repo.dir, ".pir", "rule.json");
  try {
    writeRule(ruleFile, { rules: [{ path: "src/**", guidance: "OK" }], oops: true });
    let created = 0;
    const factory = { async createSession() { created += 1; throw new Error("must not create a session"); } };
    await assert.rejects(
      findIssues({ ...f.ctx, factory, options: { maxRounds: 1 } }),
      (error) => error instanceof ProjectRuleError && /unknown key "oops"/.test(error.message),
    );
    assert.equal(created, 0);

    writeRule(ruleFile, { rules: [{ path: "src/**", guidance: "HASHED-GUIDANCE" }] });
    const prompts = [];
    const out = await findIssues({ ...f.ctx, factory: capturingFactory(prompts), options: { maxRounds: 1 } });
    assert.match(prompts[0], /HASHED-GUIDANCE/);
    const manifest = JSON.parse(readFileSync(path.join(f.repo.dir, "transcripts", out.runId, "run.json"), "utf8"));
    assert.match(manifest.projectRules.hash, /^[0-9a-f]{64}$/);
    assert.equal(manifest.projectRules.matchedFiles, 1);
    assert.equal(manifest.projectRules.rules, 1);
    assert.equal(manifest.projectRules.builtinSuppressed, false);
    assert.deepEqual(manifest.projectRules.layers, [{ layer: "repo", rules: 1 }]);
  } finally {
    if (previous === undefined) delete process.env.PIR_TRANSCRIPTS;
    else process.env.PIR_TRANSCRIPTS = previous;
    f.cleanup();
  }
});

function runConfigShow(t, repo, extraEnv = {}) {
  const configDir = mkdtempSync(path.join(tmpdir(), "pir-b5-config-"));
  t.after(() => rmSync(configDir, { recursive: true, force: true }));
  const cli = path.resolve(import.meta.dirname, "..", "..", "dist", "cli", "cli.js");
  return execFileSync(process.execPath, [cli, "config", "show", "--json", "--cwd", repo.dir], {
    encoding: "utf8",
    env: { ...process.env, PIR_CONFIG_DIR: configDir, PIR_NO_WIZARD: "1", ...extraEnv },
  });
}

test("config show reports the repository rule layer for --cwd, additively in --json", async (t) => {
  const repo = createTempGitRepo("pir-b5-config-");
  t.after(() => repo.cleanup());
  writeRule(path.join(repo.dir, ".pir", "rule.json"), { rules: [{ path: "src/**", guidance: "CONFIG-SHOW-RULE" }] });
  const parsed = JSON.parse(runConfigShow(t, repo));
  assert.equal(parsed.command, "config.show");
  assert.equal(parsed.data.rules.layers.length, 1);
  assert.equal(parsed.data.rules.layers[0].layer, "repo");
  assert.match(parsed.data.rules.layers[0].file, /\.pir\/rule\.json$/);
  assert.equal(parsed.data.rules.layers[0].rules[0].guidance, "CONFIG-SHOW-RULE");
  assert.match(parsed.data.rules.hash, /^[0-9a-f]{64}$/);
  // The pre-existing config field keeps its shape (null on a fresh config dir).
  assert.equal(parsed.data.config, null);
});

test("config show maps a broken rule file to a usage error (exit 2)", async (t) => {
  const repo = createTempGitRepo("pir-b5-config-bad-");
  t.after(() => repo.cleanup());
  writeRule(path.join(repo.dir, ".pir", "rule.json"), { rules: [{ path: "src/**", guidance: "x" }], nope: 1 });
  assert.throws(() => runConfigShow(t, repo), (error) => {
    assert.equal(error.status, 2);
    assert.match(String(error.stderr), /unknown key "nope"/);
    return true;
  });
});
