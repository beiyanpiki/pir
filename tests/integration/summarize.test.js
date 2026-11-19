import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createTempGitRepo } from "../fixtures/helpers.js";
import { createAppContext } from "../../dist/app/context.js";
import { emptyRangeSummary, runSummarize } from "../../dist/app/summarize.js";
import { renderSummarizeResultText } from "../../dist/app/output.js";
import { executePirCommand, UsageError } from "../../dist/cli/executor.js";

const execFileAsync = promisify(execFile);
const CLI = path.resolve("dist/cli/cli.js");

/**
 * `pir summarize`: the change set is built exactly like find's (merge-base
 * diff + change-mode filter) and ONE summarizer session returns the walkthrough
 * through submit_summary. Scripted sessions here implement the factory
 * interface and execute the real terminal tool, the review-loop pattern.
 */

function seedRepo() {
  const repo = createTempGitRepo("pir-summarize-");
  repo.write("src/pay.ts", "export function retry(): void {}\n");
  repo.commit("baseline");
  repo.write("src/pay.ts", "export function retry(): void { consumeQuota(); }\n");
  repo.write("docs/pay.md", "# Pay\nQuota is consumed per retry.\n");
  // Secret path: metadata stays visible, the diff body never reaches a model.
  repo.write(".env", "API_TOKEN=SUPER_SECRET_VALUE\n");
  repo.commit("change");
  return repo;
}

const SCRIPTED_SUMMARY = "## What changed\nThe retry helper now consumes quota on every attempt.";

/** Scripted summarizer session: records its config/prompt and submits through the real tool. */
function summarizerFactory(onPrompt) {
  const sessions = [];
  return {
    sessions,
    async createSession(config) {
      sessions.push(config);
      return {
        async prompt(text) {
          onPrompt?.(text, config);
          const submit = config.tools.find((tool) => tool.name === "submit_summary");
          assert.ok(submit, "summarizer session must expose submit_summary");
          const result = await submit.execute({
            summary: SCRIPTED_SUMMARY,
            riskAreas: ["quota accounting on retries"],
          });
          assert.ok(!result.text.startsWith("ERROR"), result.text);
        },
        getLastAssistantText: () => "done",
        getLastAssistantError: () => undefined,
        dispose() {},
      };
    },
  };
}

test("runSummarize walks the find-shaped change set through one scripted session", async () => {
  const repo = seedRepo();
  const prompts = [];
  const factory = summarizerFactory((text, config) => prompts.push({ text, config }));
  const ctx = await createAppContext(repo.dir, {
    noSyncIndex: true,
    dbPath: path.join(repo.dir, "memory.sqlite"),
    factory,
  });
  try {
    const result = await runSummarize(ctx, { model: "provider/model" });
    // Stats over the whole change set: the filtered .env keeps its metadata.
    assert.deepEqual(result.stats, { files: 3, insertions: 4, deletions: 1 });
    assert.match(result.base, /^[0-9a-f]{40}$/);
    assert.match(result.head, /^[0-9a-f]{40}$/);
    assert.equal(result.summary, SCRIPTED_SUMMARY);
    assert.deepEqual(result.riskAreas, ["quota accounting on retries"]);
    // Exactly one session, configured like a reviewer session plus submit_summary.
    assert.equal(factory.sessions.length, 1);
    const config = factory.sessions[0];
    assert.equal(config.systemRole, "change summarizer");
    assert.equal(config.model, "provider/model");
    assert.deepEqual(config.builtinTools, ["read", "grep", "find", "ls"]);
    const names = config.tools.map((tool) => tool.name);
    for (const name of ["get_change", "read_code", "search_text", "find_symbol", "find_callers", "find_callees", "find_references", "submit_summary"]) {
      assert.ok(names.includes(name), `missing tool ${name}`);
    }
    for (const reviewOnly of ["record_candidate", "finish_round", "submit_verdict"]) {
      assert.ok(!names.includes(reviewOnly), `review-only tool ${reviewOnly} leaked into the summarizer`);
    }
    // The prompt carries stats, the per-file map and the diff body.
    const prompt = prompts[0].text;
    assert.match(prompt, /3 files, \+4\/-1 changed lines/);
    assert.match(prompt, /- src\/pay\.ts \(modified, \+1\/-1\)/);
    assert.match(prompt, /- docs\/pay\.md \(added, \+2\/-0\)/);
    assert.match(prompt, /- \.env \(added, \+1\/-0\) — excluded: secret path/);
    assert.match(prompt, /consumeQuota\(\)/);
    assert.match(prompt, /NOT a review/i);
    assert.match(prompt, /submit_summary/);
    // The secret body is never rendered, not even as an example.
    assert.doesNotMatch(prompt, /SUPER_SECRET_VALUE/);
  } finally {
    ctx.memory.close();
    repo.cleanup();
  }
});

test("an empty range is a valid zero-change summary and never creates a session", async () => {
  const repo = seedRepo();
  let created = 0;
  const factory = {
    async createSession() {
      created += 1;
      throw new Error("no session is expected for an empty range");
    },
  };
  const ctx = await createAppContext(repo.dir, {
    noSyncIndex: true,
    dbPath: path.join(repo.dir, "memory.sqlite"),
    factory,
  });
  try {
    const result = await runSummarize(ctx, { base: "HEAD", head: "HEAD" });
    assert.deepEqual(result.stats, { files: 0, insertions: 0, deletions: 0 });
    assert.equal(result.summary, emptyRangeSummary());
    assert.deepEqual(result.riskAreas, []);
    assert.equal(created, 0);
  } finally {
    ctx.memory.close();
    repo.cleanup();
  }
});

test("summarize --json on an empty range prints the envelope contract on stdout", async () => {
  const repo = seedRepo();
  const dbPath = path.join(repo.dir, "memory.sqlite");
  try {
    const result = await executePirCommand(
      ["summarize", "--json", "--base", "HEAD", "--head", "HEAD", "--no-sync-index", "--cwd", repo.dir],
      { dbPath },
    );
    assert.equal(result.code, 0);
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.schemaVersion, 1);
    assert.equal(parsed.command, "summarize");
    assert.equal(parsed.project.cwd, repo.dir);
    assert.match(parsed.project.id, /./);
    assert.match(parsed.project.head, /^[0-9a-f]{40}$/);
    assert.deepEqual(Object.keys(parsed.data).sort(), ["base", "head", "riskAreas", "stats", "summary"]);
    assert.deepEqual(parsed.data.stats, { files: 0, insertions: 0, deletions: 0 });
    assert.equal(parsed.data.summary, emptyRangeSummary());
    assert.deepEqual(parsed.data.riskAreas, []);
  } finally {
    repo.cleanup();
  }
});

test("text mode prints a range/stats header then the markdown walkthrough", async () => {
  const repo = seedRepo();
  const dbPath = path.join(repo.dir, "memory.sqlite");
  try {
    // Executor text lane on the empty range: header line plus canned summary.
    const result = await executePirCommand(
      ["summarize", "--base", "HEAD", "--head", "HEAD", "--no-sync-index", "--cwd", repo.dir],
      { dbPath },
    );
    assert.equal(result.code, 0);
    assert.match(result.output, /^summary of [0-9a-f]{40}\.\.[0-9a-f]{40}: 0 files, \+0\/-0\n\nNo changed files in this range — there is nothing to walk through\.\n$/);
    // With content, the markdown summary passes through unchanged after the header.
    const rendered = renderSummarizeResultText({
      base: "b",
      head: "h",
      stats: { files: 2, insertions: 3, deletions: 1 },
      summary: SCRIPTED_SUMMARY,
    });
    assert.equal(
      rendered,
      `summary of b..h: 2 files, +3/-1\n\n${SCRIPTED_SUMMARY}`,
    );
  } finally {
    repo.cleanup();
  }
});

test("summarize rejects find/audit run-shaping flags as usage errors (exit 2)", async () => {
  const repo = seedRepo();
  const dbPath = path.join(repo.dir, "memory.sqlite");
  try {
    for (const bad of [["--max-rounds", "2"], ["--fail-on", "P1"], ["--format", "sarif"]]) {
      await assert.rejects(
        executePirCommand(["summarize", ...bad, "--cwd", repo.dir], { dbPath }),
        (error) => error instanceof UsageError && error.message.includes(bad[0]),
      );
    }
    // The built CLI maps the same rejection to exit code 2.
    const { stderr, code } = await execFileAsync(process.execPath, [CLI, "summarize", "--fail-on", "P1", "--cwd", repo.dir], {
      encoding: "utf8",
      env: { ...process.env, PIR_CONFIG_DIR: path.join(repo.dir, "cfg"), PIR_NO_WIZARD: "1" },
    }).catch((error) => error);
    assert.equal(code, 2);
    assert.match(stderr, /--fail-on/);
  } finally {
    repo.cleanup();
  }
});
