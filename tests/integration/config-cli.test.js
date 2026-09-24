import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import process from "node:process";
import { startServer } from "../../dist/server/server.js";
import { createTempGitRepo } from "../fixtures/helpers.js";

const execFileAsync = promisify(execFile);
const CLI = path.resolve("dist/cli/cli.js");
const TOKEN = "cfg-test-token";

const CONFIG_DIR = mkdtempSync(path.join(tmpdir(), "pir-cfgcli-"));

function configPath() {
  return path.join(CONFIG_DIR, "config.json");
}

function writeConfig(config) {
  writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`);
}

async function pir(args, opts = {}) {
  const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], {
    cwd: opts.cwd ?? process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      PIR_CONFIG_DIR: CONFIG_DIR,
      // Default to wizard-free so individual tests can opt into the hint case.
      PIR_NO_WIZARD: opts.wizardEnv === false ? undefined : "1",
      ...opts.env,
    },
  });
  return { stdout, stderr, code: 0 };
}

async function pirExpectFail(args, opts = {}) {
  try {
    await pir(args, opts);
  } catch (err) {
    return { stderr: err.stderr ?? "", stdout: err.stdout ?? "", code: err.code ?? 1 };
  }
  throw new Error(`expected failure: pir ${args.join(" ")}`);
}

/** Plain-HTTP pir serve on an ephemeral port over a temp repo workspace. */
async function withHttpServer(t) {
  const repo = createTempGitRepo("pir-cfg-server-");
  const handle = await startServer({
    host: "127.0.0.1",
    port: 0,
    token: TOKEN,
    workspace: repo.dir,
    tls: null,
  });
  t.after(() => {
    handle.close();
    repo.cleanup();
  });
  return { base: handle.url, repo };
}

test("pir config show/set/reset lifecycle", async () => {
  rmSync(configPath(), { force: true });

  const empty = await pir(["config", "show", "--json"]);
  assert.equal(JSON.parse(empty.stdout).data.config, null);

  await pir(["config", "set", "server.url", "https://pir.example.com:8790/"]);
  await pir(["config", "set", "server.token", "secret-token-abcdef"]);
  await pir(["config", "set", "mode", "remote"]);

  const shown = await pir(["config", "show"]);
  assert.match(shown.stdout, /mode:\s+remote/);
  assert.match(shown.stdout, /server:\s+https:\/\/pir\.example\.com:8790/);
  assert.match(shown.stdout, /token:\s+secr…cdef/); // never the full token
  assert.ok(!shown.stdout.includes("secret-token-abcdef"));

  // --json keeps the real token (machine mode, user's own machine).
  const json = await pir(["config", "show", "--json"]);
  assert.equal(JSON.parse(json.stdout).data.config.server.token, "secret-token-abcdef");

  const badMode = await pirExpectFail(["config", "set", "mode", "bogus"]);
  assert.equal(badMode.code, 2);

  const reset = await pir(["config", "reset"]);
  assert.match(reset.stdout, /removed/);
  assert.equal(existsSync(configPath()), false);
});

test("pir config set mode remote without a server URL exits 2", async () => {
  rmSync(configPath(), { force: true });
  const fail = await pirExpectFail(["config", "set", "mode", "remote"]);
  assert.equal(fail.code, 2);
  assert.match(fail.stderr, /server\.url/);
});

test("remote config forwards commands; version/config/skill stay client-side", async (t) => {
  const { base, repo } = await withHttpServer(t);
  writeConfig({
    schemaVersion: 1,
    mode: "remote",
    server: { url: base, token: TOKEN },
  });

  // memory status goes through /v1/exec on the server's workspace repo.
  const relayed = await pir(["memory", "status", "--json", "--cwd", repo.dir]);
  const parsed = JSON.parse(relayed.stdout);
  assert.equal(parsed.command, "memory.status");
  assert.ok(parsed.data.projectId);

  // version is client-side: plain text, no server round-trip shape.
  const version = await pir(["version"]);
  assert.match(version.stdout.trim(), /^pir \d+\.\d+\.\d+$/);

  // config is client-side: reads THIS process's PIR_CONFIG_DIR, not a server's.
  const config = await pir(["config", "show", "--json"]);
  assert.equal(JSON.parse(config.stdout).data.config.server.url, base);

  // A wrong token in the config still reaches the server and fails loudly.
  writeConfig({ schemaVersion: 1, mode: "remote", server: { url: base, token: "wrong" } });
  const rejected = await pirExpectFail(["memory", "status", "--cwd", repo.dir]);
  assert.equal(rejected.code, 3);
  assert.match(rejected.stderr, /rejected|--token|401|403/);

  // --local forces in-process execution despite the remote config.
  const local = await pir(["--local", "memory", "status", "--json", "--cwd", repo.dir]);
  assert.equal(JSON.parse(local.stdout).command, "memory.status");
});

test("first run without a TTY prints a config hint on stderr and still works locally", async () => {
  rmSync(configPath(), { force: true });
  const repo = createTempGitRepo("pir-cfg-hint-");
  try {
    const run = await pir(["memory", "status", "--json", "--cwd", repo.dir], { wizardEnv: false });
    assert.equal(JSON.parse(run.stdout).command, "memory.status");
    assert.match(run.stderr, /no config at/);
    assert.match(run.stderr, /pir config/);
  } finally {
    repo.cleanup();
  }
});

test("pir skill: path resolves the shipped file; install copies it", async () => {
  const target = mkdtempSync(path.join(tmpdir(), "pir-skill-"));
  try {
    const shown = await pir(["skill", "path"]);
    assert.ok(existsSync(shown.stdout.trim()), "SKILL.md exists at the reported path");

    await pir(["skill", "install", "--dir", target]);
    const installed = path.join(target, "pir", "SKILL.md");
    assert.ok(existsSync(installed));
    assert.match(readFileSync(installed, "utf8"), /^name: pir$/m);

    const printed = await pir(["skill", "print"]);
    assert.match(printed.stdout, /# pir — verified code review/);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test("server refuses client-side commands over /v1/exec", async (t) => {
  const { base } = await withHttpServer(t);
  for (const argv of [["config", "show"], ["skill", "path"]]) {
    const response = await fetch(`${base}/v1/exec`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ argv }),
    });
    const body = await response.json();
    assert.equal(body.code, 2, `${argv.join(" ")} must be refused server-side`);
  }
});
