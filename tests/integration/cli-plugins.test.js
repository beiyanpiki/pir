import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import process from "node:process";
import { createTempGitRepo } from "../fixtures/helpers.js";

const execFileAsync = promisify(execFile);
const CLI = path.resolve("dist/cli/cli.js");
const CONFIG_DIR = mkdtempSync(path.join(tmpdir(), "pir-plugins-cli-"));

async function pir(args, opts = {}) {
  const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], {
    cwd: opts.cwd ?? process.cwd(),
    encoding: "utf8",
    env: { ...process.env, PIR_CONFIG_DIR: CONFIG_DIR, PIR_NO_WIZARD: "1" },
  });
  return { stdout, stderr, code: 0 };
}

async function pirExpectFail(args, opts = {}) {
  try {
    return await pir(args, opts);
  } catch (err) {
    return { stderr: err.stderr ?? "", stdout: err.stdout ?? "", code: err.code ?? 1 };
  }
}

test("pir plugins list activates golang by go.mod at HEAD", async () => {
  const repo = createTempGitRepo("pir-plugins-go-");
  try {
    repo.write("go.mod", "module example.com/app\n\ngo 1.22\n");
    repo.write("main.go", "package main\n\nfunc main() {}\n");
    repo.commit("add go module");

    const json = await pir(["plugins", "list", "--json", "--cwd", repo.dir]);
    const parsed = JSON.parse(json.stdout);
    assert.equal(parsed.command, "plugins.list");
    assert.ok(parsed.data.head);
    const golang = parsed.data.packs.find((p) => p.name === "golang");
    assert.ok(golang, "golang pack listed");
    assert.equal(golang.active, true);
    assert.equal(golang.activation, "auto");
    assert.deepEqual(golang.markerFiles, ["go.mod"]);

    const text = await pir(["plugins", "list", "--cwd", repo.dir]);
    assert.match(text.stdout, /golang@\d+\.\d+\.\d+ \(Go\)/);
    assert.match(text.stdout, /\[active\]/);
  } finally {
    repo.cleanup();
  }
});

test("pir plugins list activates typescript by tsconfig.json at HEAD", async () => {
  const repo = createTempGitRepo("pir-plugins-ts-");
  try {
    repo.write("tsconfig.json", '{ "compilerOptions": { "strict": true } }\n');
    repo.write("index.ts", "export const x = 1;\n");
    repo.commit("add typescript project");

    const json = await pir(["plugins", "list", "--json", "--cwd", repo.dir]);
    const parsed = JSON.parse(json.stdout);
    const typescript = parsed.data.packs.find((p) => p.name === "typescript");
    assert.ok(typescript, "typescript pack listed");
    assert.equal(typescript.active, true);
    assert.equal(typescript.activation, "auto");
    assert.deepEqual(typescript.markerFiles, ["tsconfig.json"]);

    const golang = parsed.data.packs.find((p) => p.name === "golang");
    assert.equal(golang.active, false, "golang stays inactive in a TS-only repo");

    const text = await pir(["plugins", "list", "--cwd", repo.dir]);
    assert.match(text.stdout, /typescript@\d+\.\d+\.\d+ \(TypeScript\)/);
    assert.match(text.stdout, /\[active\]/);
  } finally {
    repo.cleanup();
  }
});

test("pir plugins list reports inactive packs in a non-Go repo", async () => {
  const repo = createTempGitRepo("pir-plugins-nongo-");
  try {
    repo.write("index.ts", "export const x = 1;\n");
    repo.commit("not a go repo");
    const json = await pir(["plugins", "list", "--json", "--cwd", repo.dir]);
    const parsed = JSON.parse(json.stdout);
    const golang = parsed.data.packs.find((p) => p.name === "golang");
    assert.equal(golang.active, false);
    assert.equal(golang.activation, null);
    const text = await pir(["plugins", "list", "--cwd", repo.dir]);
    assert.ok(!/\[active\]/.test(text.stdout), "no active marker in human output");
  } finally {
    repo.cleanup();
  }
});

test("unknown plugins subcommand and --plugins names are usage errors", async () => {
  const repo = createTempGitRepo("pir-plugins-usage-");
  try {
    repo.commit("plain");
    const badSub = await pirExpectFail(["plugins", "enable", "--cwd", repo.dir]);
    assert.equal(badSub.code, 2);
    assert.match(badSub.stderr, /unknown plugins subcommand: enable/);

    // Fails during flag parsing, before any model session is created.
    const badPack = await pirExpectFail(["find", "--plugins", "bogus", "--cwd", repo.dir]);
    assert.equal(badPack.code, 2);
    assert.match(badPack.stderr, /unknown --plugins pack\(s\): bogus/);
    assert.match(badPack.stderr, /available: golang/);

    const noValue = await pirExpectFail(["find", "--plugins"]);
    assert.equal(noValue.code, 2);
    assert.match(noValue.stderr, /missing value for --plugins/);

    const notRepo = await pirExpectFail(["plugins", "list", "--cwd", CONFIG_DIR]);
    assert.equal(notRepo.code, 2);
    assert.match(notRepo.stderr, /not a git repository/);
  } finally {
    repo.cleanup();
  }
});
