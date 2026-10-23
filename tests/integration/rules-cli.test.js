import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createTempGitRepo } from "../fixtures/helpers.js";

/**
 * Track B S7 at the CLI boundary: `rules check <path>` answers which project
 * rule wins for one path from the same layered loader find uses, names the
 * layer and the matched glob, prints the rendered guidance, carries no host
 * path, and opens no review run, database or model session. Model-free.
 */

const execFileAsync = promisify(execFile);
const CLI = path.resolve("dist/cli/cli.js");

function sandbox(t) {
  const root = mkdtempSync(path.join(tmpdir(), "pir-rules-cli-"));
  const configDir = path.join(root, "config");
  const stateRoot = path.join(root, "state");
  const previous = {
    PIR_CONFIG_DIR: process.env.PIR_CONFIG_DIR,
    PIR_STATE_ROOT: process.env.PIR_STATE_ROOT,
    PIR_NO_WIZARD: process.env.PIR_NO_WIZARD,
  };
  process.env.PIR_CONFIG_DIR = configDir;
  process.env.PIR_STATE_ROOT = stateRoot;
  process.env.PIR_NO_WIZARD = "1";
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  return { root, configDir, stateRoot };
}

async function pir(args, opts = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], {
      encoding: "utf8",
      env: { ...process.env, ...opts.env },
      cwd: opts.cwd,
    });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", code: err.code ?? 1 };
  }
}

const rule = (glob, guidance, extra = {}) => ({ path: glob, guidance, ...extra });

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}

function writeRepoRule(repo, value) {
  writeJson(path.join(repo.dir, ".pir", "rule.json"), value);
}

/** A repo whose tracked-looking paths exist, so "exists: false" never muddies a case. */
function fixture(prefix) {
  const repo = createTempGitRepo(prefix);
  repo.write("src/a.ts", "export const a = 1;\n");
  repo.write("docs/x.md", "# docs\n");
  return repo;
}

test("prints the winning rule, layer, glob and guidance; byte-stable; no host paths", async (t) => {
  const { root, configDir } = sandbox(t);
  const repo = fixture("pir-s7-text-");
  const guidance = "SRC-RULE: keep increments overflow-safe.";
  try {
    writeRepoRule(repo, { rules: [rule("src/**", guidance)] });
    const first = await pir(["rules", "check", "src/a.ts", "--cwd", repo.dir]);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(first.stderr, "");
    const lines = first.stdout.trimEnd().split("\n");
    assert.deepEqual(lines.slice(0, 6), [
      "path: src/a.ts",
      'rule: "src/**"',
      "layer: repo (.pir/rule.json)",
      "mergeBuiltin: true",
      `guidance (inline, ${guidance.length} chars):`,
      guidance,
    ]);
    assert.equal(lines[6], "");
    assert.match(lines[7], /^rules hash: [0-9a-f]{64}$/);
    assert.equal(lines.length, 8);
    const second = await pir(["rules", "check", "src/a.ts", "--cwd", repo.dir]);
    assert.equal(second.stdout, first.stdout, "byte-stable output");
    for (const hostPath of [root, repo.dir, configDir, tmpdir()]) {
      assert.equal(first.stdout.includes(hostPath), false, `no host path (${hostPath}) in output`);
      assert.equal(first.stderr.includes(hostPath), false);
    }
  } finally { repo.cleanup(); }
});

test("--json carries the winner, the layer explanations and the rendered section", async (t) => {
  const { root } = sandbox(t);
  const repo = fixture("pir-s7-json-");
  try {
    writeRepoRule(repo, { rules: [rule("src/**", "SRC-RULE")] });
    const out = await pir(["rules", "check", "src/a.ts", "--cwd", repo.dir, "--json"]);
    assert.equal(out.code, 0, out.stderr);
    const parsed = JSON.parse(out.stdout);
    assert.equal(parsed.schemaVersion, 1);
    assert.equal(parsed.command, "rules.check");
    assert.equal(parsed.data.path, "src/a.ts");
    assert.equal(parsed.data.exists, true);
    assert.equal(parsed.data.matched, true);
    assert.match(parsed.data.rulesHash, /^[0-9a-f]{64}$/);
    assert.equal(parsed.data.winner.layer, "repo");
    assert.equal(parsed.data.winner.file, ".pir/rule.json");
    assert.equal(parsed.data.winner.rule, "src/**");
    assert.equal(parsed.data.winner.mergeBuiltin, true);
    assert.equal(parsed.data.winner.guidance, "SRC-RULE");
    assert.match(parsed.data.renderedSection, /PROJECT RULES/);
    assert.match(parsed.data.renderedSection, /RULE "src\/\*\*"/);
    assert.match(parsed.data.renderedSection, /SRC-RULE/);
    assert.equal(parsed.data.layers.length, 1);
    assert.deepEqual(parsed.data.layers[0], {
      layer: "repo",
      file: ".pir/rule.json",
      rules: 1,
      include: ["**"],
      exclude: [],
      includedBy: "**",
      excludedBy: null,
      rule: "src/**",
      won: true,
    });
    assert.equal(out.stdout.includes(root), false, "no host path in JSON output");
  } finally { repo.cleanup(); }
});

test("--rule is the flag layer and wins over repo and global", async (t) => {
  const { configDir } = sandbox(t);
  const repo = fixture("pir-s7-flag-");
  try {
    writeJson(path.join(configDir, "rule.json"), { rules: [rule("**", "GLOBAL")] });
    writeRepoRule(repo, { rules: [rule("**", "REPO")] });
    const flag = path.join(tmpdir(), `pir-s7-flag-${process.pid}.json`);
    writeJson(flag, { rules: [rule("**", "FLAG")] });
    try {
      const out = await pir(["rules", "check", "src/a.ts", "--cwd", repo.dir, "--rule", flag]);
      assert.equal(out.code, 0, out.stderr);
      assert.match(out.stdout, /^layer: flag \(--rule\)$/m);
      assert.match(out.stdout, /^FLAG$/m);
      assert.equal(out.stdout.includes(flag), false, "the --rule path itself is not echoed");
    } finally { rmSync(flag, { force: true }); }
  } finally { repo.cleanup(); }
});

test("repo layer wins over the global layer; the global layer answers where the repo has no rule", async (t) => {
  const { configDir } = sandbox(t);
  const repo = fixture("pir-s7-layers-");
  try {
    writeJson(path.join(configDir, "rule.json"), { rules: [rule("**", "GLOBAL")] });
    writeRepoRule(repo, { rules: [rule("src/**", "REPO-SRC")] });
    const repoWin = await pir(["rules", "check", "src/a.ts", "--cwd", repo.dir]);
    assert.match(repoWin.stdout, /^layer: repo \(\.pir\/rule\.json\)$/m);
    assert.match(repoWin.stdout, /^REPO-SRC$/m);
    const globalWin = await pir(["rules", "check", "docs/x.md", "--cwd", repo.dir]);
    assert.match(globalWin.stdout, /^layer: global \(~\/\.pir\/rule\.json\)$/m);
    assert.match(globalWin.stdout, /^GLOBAL$/m);
  } finally { repo.cleanup(); }
});

test("no match explains the layer gate: exclude wins, then include, then no rule", async (t) => {
  const { configDir } = sandbox(t);
  const repo = fixture("pir-s7-gates-");
  try {
    writeRepoRule(repo, {
      include: ["src/**"],
      exclude: ["src/generated/**"],
      rules: [rule("**", "SRC")],
    });
    const excluded = await pir(["rules", "check", "src/generated/x.ts", "--cwd", repo.dir]);
    assert.equal(excluded.code, 0, excluded.stderr);
    assert.match(excluded.stdout, /^rule: none$/m);
    assert.match(excluded.stdout, /repo \(\.pir\/rule\.json\): 1 rule, path excluded by exclude glob "src\/generated\/\*\*"/);
    const notIncluded = await pir(["rules", "check", "docs/x.md", "--cwd", repo.dir]);
    assert.match(notIncluded.stdout, /repo \(\.pir\/rule\.json\): 1 rule, path not included by any include glob/);
    writeRepoRule(repo, { rules: [rule("src/**", "SRC")] });
    const noRule = await pir(["rules", "check", "docs/x.md", "--cwd", repo.dir]);
    assert.match(noRule.stdout, /repo \(\.pir\/rule\.json\): 1 rule, path included, no rule matched/);
  } finally { repo.cleanup(); }
});

test("no rule files at all is reported as none loaded, with the hash", async (t) => {
  sandbox(t);
  const repo = fixture("pir-s7-none-");
  try {
    const out = await pir(["rules", "check", "src/a.ts", "--cwd", repo.dir]);
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, /^rule: none$/m);
    assert.match(out.stdout, /none loaded \(searched \.pir\/rule\.json and ~\/\.pir\/rule\.json; --rule is per invocation\)/);
    assert.match(out.stdout, /^rules hash: [0-9a-f]{64}$/m);
  } finally { repo.cleanup(); }
});

test("a path that does not exist is matched by string and flagged", async (t) => {
  sandbox(t);
  const repo = fixture("pir-s7-missing-");
  try {
    writeRepoRule(repo, { rules: [rule("src/**", "SRC")] });
    const out = await pir(["rules", "check", "src/not-created.ts", "--cwd", repo.dir]);
    assert.equal(out.code, 0, out.stderr);
    assert.equal(out.stdout.split("\n")[1], "note: path does not exist in this checkout; matched by path only");
    assert.match(out.stdout, /^rule: "src\/\*\*"$/m);
  } finally { repo.cleanup(); }
});

test("an absolute path inside the repository is accepted and reported relative", async (t) => {
  sandbox(t);
  const repo = fixture("pir-s7-abs-");
  try {
    writeRepoRule(repo, { rules: [rule("src/**", "SRC")] });
    const absolute = path.join(repo.dir, "src", "a.ts");
    const out = await pir(["rules", "check", absolute, "--cwd", repo.dir]);
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, /^path: src\/a\.ts$/m);
  } finally { repo.cleanup(); }
});

test("usage errors: subcommand, path, range flags and --repo are rejected (exit 2)", async (t) => {
  sandbox(t);
  const repo = fixture("pir-s7-usage-");
  try {
    writeRepoRule(repo, { rules: [rule("src/**", "SRC")] });
    const cases = [
      [["rules"], /requires a subcommand/],
      [["rules", "lint", "src/a.ts"], /unknown rules subcommand: lint/],
      [["rules", "check"], /requires a <path>/],
      [["rules", "check", "a", "b"], /takes one <path>/],
      [["rules", "check", "src/a.ts", "--cwd", repo.dir, "--repo", "x"], /--repo is not supported/],
      [["rules", "check", "src/a.ts", "--cwd", repo.dir, "--base", "HEAD~1"], /not a review range/],
      [["rules", "check", path.join(tmpdir(), "outside.ts"), "--cwd", repo.dir], /inside the repository/],
      [["rules", "check", "../escape.ts", "--cwd", repo.dir], /inside the repository/],
      [["rules", "check", "src/a.ts", "--cwd", repo.dir, "--rule", path.join(tmpdir(), "missing-rule.json")], /does not exist/],
    ];
    for (const [args, expected] of cases) {
      const out = await pir(args);
      assert.equal(out.code, 2, `expected exit 2 for: ${args.join(" ")} (got ${out.code})`);
      assert.match(out.stderr + out.stdout, expected);
    }
  } finally { repo.cleanup(); }
});

test("no run, no database, no model session: the command writes nothing and opens no project db", async (t) => {
  const { stateRoot } = sandbox(t);
  const repo = fixture("pir-s7-pure-");
  try {
    writeRepoRule(repo, { rules: [rule("src/**", "SRC")] });
    const out = await pir(["rules", "check", "src/a.ts", "--cwd", repo.dir, "--json"]);
    assert.equal(out.code, 0, out.stderr);
    assert.equal(existsSync(stateRoot), false, "no project state dir was created");
    assert.equal(existsSync(path.join(repo.dir, "memory.sqlite")), false, "no memory db in the repo");
    assert.equal(existsSync(path.join(repo.dir, "transcripts")), false, "no transcript dir");
    const entries = existsSync(repo.dir) ? readdirSync(repo.dir) : [];
    assert.deepEqual(entries.filter((name) => name.startsWith("memory.sqlite")), []);
  } finally { repo.cleanup(); }
});

test("rules check stays local in remote mode and never forwards", async (t) => {
  sandbox(t);
  const repo = fixture("pir-s7-remote-");
  try {
    writeRepoRule(repo, { rules: [rule("src/**", "SRC")] });
    const out = await pir(["rules", "check", "src/a.ts", "--cwd", repo.dir], {
      env: { PIR_MODE: "remote", PIR_SERVER_URL: "http://127.0.0.1:9" },
    });
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, /^SRC$/m);
    assert.equal(out.stderr, "", "no transport/wizard noise for a client-side command");
  } finally { repo.cleanup(); }
});

test("rules --help prints the command's own section", async (t) => {
  sandbox(t);
  const out = await pir(["rules", "--help"]);
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /Rules options/);
  assert.match(out.stdout, /check <path>/);
});

test("config show still reports the same layers and hash (A3)", async (t) => {
  sandbox(t);
  const repo = fixture("pir-s7-config-");
  try {
    writeRepoRule(repo, { rules: [rule("src/**", "SRC")] });
    const config = await pir(["config", "show", "--cwd", repo.dir, "--json"]);
    const check = await pir(["rules", "check", "src/a.ts", "--cwd", repo.dir, "--json"]);
    assert.equal(config.code, 0, config.stderr);
    const parsedConfig = JSON.parse(config.stdout);
    const parsedCheck = JSON.parse(check.stdout);
    assert.equal(parsedConfig.command, "config.show");
    assert.equal(parsedConfig.data.rules.layers[0].layer, "repo");
    assert.equal(parsedCheck.data.rulesHash, parsedConfig.data.rules.hash);
    // Running the check changes nothing config show reports.
    const after = await pir(["config", "show", "--cwd", repo.dir, "--json"]);
    assert.equal(after.stdout, config.stdout);
  } finally { repo.cleanup(); }
});
