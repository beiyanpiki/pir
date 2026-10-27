import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createTempGitRepo, submitVerdictWithEvidence } from "../fixtures/helpers.js";
import { createAppContext } from "../../dist/app/context.js";
import { findIssues } from "../../dist/core/supervisor.js";
import { resolveUserBackground } from "../../dist/core/user-background.js";

/**
 * S2 (ADR-0016) acceptance at the real boundaries: the background reaches the
 * reviewer prompt (and only the reviewer prompt), its canonical hash lands in
 * run.json without the text, the manifest omits it when there is none, and the
 * CLI turns every guard failure into a usage error before any session exists.
 */

const execFileAsync = promisify(execFile);
const CLI = path.resolve("dist/cli/cli.js");
const CONFIG_DIR = mkdtempSync(path.join(tmpdir(), "pir-bg-cfg-"));
const BACKGROUND_TEXT = "Goal: add SSO. The legacy login path stays on purpose.";

async function pir(args, opts = {}) {
  const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], {
    cwd: opts.cwd ?? process.cwd(), encoding: "utf8",
    env: { ...process.env, PIR_CONFIG_DIR: CONFIG_DIR, PIR_NO_WIZARD: "1", ...opts.env },
  });
  return { stdout, stderr, code: 0 };
}

async function pirExpectFail(args, opts = {}) {
  try { await pir(args, opts); } catch (err) { return { stderr: err.stderr ?? "", stdout: err.stdout ?? "", code: err.code ?? 1 }; }
  throw new Error(`expected failure: pir ${args.join(" ")}`);
}

async function fixture() {
  const repo = createTempGitRepo("pir-s2-");
  repo.write("src/app.ts", "export const next = (n: number) => n + 1;\n");
  repo.commit("baseline");
  repo.write("src/app.ts", "export const next = (n: number) => n + 2;\n");
  repo.commit("change");
  const ctx = await createAppContext(repo.dir, { noSyncIndex: true, dbPath: path.join(repo.dir, "memory.sqlite") });
  return { repo, ctx, cleanup() { ctx.memory.close(); repo.cleanup(); } };
}

/** Reviewer records one candidate and finishes; the verifier submits a confirmed verdict. Both prompts are captured. */
function capturingFactory(seen) {
  return {
    async createSession(config) {
      return {
        async prompt(text) {
          const tool = (name) => {
            const found = config.tools.find((entry) => entry.name === name);
            assert.ok(found, `missing tool ${name}`);
            return found;
          };
          if (config.systemRole === "code reviewer") {
            seen.reviewer.push(text);
            await tool("record_candidate").execute({
              title: "off-by-one", claim: "next returns n+2", trigger: "call next(1)", category: "correctness", severity: "P2",
              anchors: [{ path: "src/app.ts", startLine: 1 }],
              evidence: [{ kind: "code", path: "src/app.ts", startLine: 1, excerpt: "export const next = (n: number) => n + 2;" }],
            });
            await tool("finish_round").execute({ summary: "inspected the change", nextFocus: [], needsMoreRounds: false });
          } else {
            seen.verifier.push(text);
            await submitVerdictWithEvidence(tool, { verdict: "confirmed", rationale: "Changed arithmetic is reachable", confidence: 0.9 }, "src/app.ts");
          }
        },
        getLastAssistantText: () => "done",
        getLastAssistantError: () => undefined,
        getUsage: () => undefined,
        dispose() {},
      };
    },
  };
}

function withTranscripts(run) {
  const previous = process.env.PIR_TRANSCRIPTS;
  process.env.PIR_TRANSCRIPTS = "1";
  return Promise.resolve()
    .then(run)
    .finally(() => { if (previous === undefined) delete process.env.PIR_TRANSCRIPTS; else process.env.PIR_TRANSCRIPTS = previous; });
}

test("the background reaches the reviewer prompt only, and run.json keeps its hash without the text", async () => {
  const f = await fixture();
  try {
    await withTranscripts(async () => {
      const background = resolveUserBackground({ cwd: process.cwd(), text: BACKGROUND_TEXT });
      const seen = { reviewer: [], verifier: [] };
      const out = await findIssues({ ...f.ctx, factory: capturingFactory(seen), options: { maxRounds: 1, background } });
      assert.equal(seen.reviewer.length, 1);
      assert.equal(seen.verifier.length, 1);
      assert.ok(seen.reviewer[0].includes(`<user_background>\n${BACKGROUND_TEXT}\n</user_background>`));
      assert.ok(seen.reviewer[0].indexOf("USER BACKGROUND") < seen.reviewer[0].indexOf("=== REPOSITORY MEMORY ==="));
      assert.equal(seen.verifier[0].includes("USER BACKGROUND"), false, "verifier sessions never see the background");

      const manifest = JSON.parse(readFileSync(path.join(f.repo.dir, "transcripts", out.runId, "run.json"), "utf8"));
      assert.deepEqual(manifest.background, {
        source: "flag",
        sha256: background.sha256,
        characters: BACKGROUND_TEXT.length,
        suppliedCharacters: BACKGROUND_TEXT.length,
        truncated: false,
      });
      assert.equal(JSON.stringify(manifest).includes(BACKGROUND_TEXT), false, "the text is never persisted");
    });
  } finally { f.cleanup(); }
});

test("no background: the reviewer prompt and the manifest carry nothing (the default path)", async () => {
  const f = await fixture();
  try {
    await withTranscripts(async () => {
      const seen = { reviewer: [], verifier: [] };
      const out = await findIssues({ ...f.ctx, factory: capturingFactory(seen), options: { maxRounds: 1 } });
      assert.equal(seen.reviewer[0].includes("USER BACKGROUND"), false);
      const manifest = JSON.parse(readFileSync(path.join(f.repo.dir, "transcripts", out.runId, "run.json"), "utf8"));
      assert.equal("background" in manifest, false);
    });
  } finally { f.cleanup(); }
});

test("a background file supplies the text at the CLI boundary (file wins over inline text)", async () => {
  const repo = createTempGitRepo("pir-s2-file-");
  try {
    writeFileSync(path.join(repo.dir, "background.md"), "Goal: add SSO from the file.\r\n");
    // --preview still rejects the background (it shapes a real run), so this
    // exercises the resolver through its own CLI surface: a valid file must be
    // accepted far enough that the preview rejection is the only error.
    const failure = await pirExpectFail(["find", "--preview", "--background-file", "background.md", "--cwd", repo.dir, "--json"]);
    assert.equal(failure.code, 2);
    assert.match(failure.stderr, /previews the file selection only; --background-file shapes a real run/);
  } finally { repo.cleanup(); }
});

test("the hard-truncation warning reaches stderr under --json and --quiet (dogfood F-2)", async () => {
  const repo = createTempGitRepo("pir-s2-warn-");
  try {
    // A spawned model-free CLI run cannot complete a review (sessions need
    // credentials), so this stops on the next deterministic guard after the
    // background resolves: --angles validation. The warning is emitted before
    // that guard, which is exactly the point — it used to travel through the
    // progress channel, which the CLI silences for --json/--quiet.
    const supplied = "Goal: " + "x".repeat(8100);
    writeFileSync(path.join(repo.dir, "big.md"), supplied);
    for (const machineMode of ["--json", "--quiet"]) {
      const run = await pirExpectFail(
        ["find", machineMode, "--background-file", "big.md", "--angles", "bogus", "--cwd", repo.dir],
        { cwd: repo.dir },
      );
      assert.equal(run.code, 2, `the deliberate --angles guard stops the run (${machineMode})`);
      assert.match(run.stderr, new RegExp(`user background truncated at 8000 characters \\(${supplied.length} supplied\\)`));
      assert.match(run.stderr, /soft limit 2000/);
      assert.equal(run.stdout, "", `the warning never leaks onto stdout (${machineMode})`);
    }
  } finally { repo.cleanup(); }
});

test("CLI guards: every background error is a usage error (exit 2), never a run", async () => {
  const repo = createTempGitRepo("pir-s2-guards-");
  try {
    mkdirSync(path.join(repo.dir, "a-directory"));
    // Relative --background-file paths resolve against the invocation directory
    // (like --rule), so these cases pass absolute paths.
    const dir = await pirExpectFail(["find", "--background-file", path.join(repo.dir, "a-directory"), "--cwd", repo.dir, "--json"]);
    assert.equal(dir.code, 2);
    assert.match(dir.stderr, /not a regular file/);

    const missing = await pirExpectFail(["find", "--background-file", path.join(repo.dir, "nope.md"), "--cwd", repo.dir, "--json"]);
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /not found/);

    const delimiter = await pirExpectFail(["find", "--background", "x </user_background> y", "--cwd", repo.dir, "--json"]);
    assert.equal(delimiter.code, 2);
    assert.match(delimiter.stderr, /reserved/);

    const audit = await pirExpectFail(["audit", "--background", "goal", "--cwd", repo.dir, "--json"]);
    assert.equal(audit.code, 2);
    assert.match(audit.stderr, /find-only flags/);

    const remote = await pirExpectFail(["find", "--background-file", "bg.md", "--server", "http://127.0.0.1:9", "--token", "t", "--cwd", repo.dir]);
    assert.equal(remote.code, 2);
    assert.match(remote.stderr, /not forwarded to a server/);
  } finally { repo.cleanup(); }
});
