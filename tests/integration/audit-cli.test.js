import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createTempGitRepo } from "../fixtures/helpers.js";
import { executePirCommand, UsageError, parseArgs } from "../../dist/cli/executor.js";

test("parseArgs collects repeated --path/--skip values in order", () => {
  const parsed = parseArgs(["audit", "--path", "src/a", "--path=src/b", "--skip", "*.gen.ts", "--skip", "dist"]);
  assert.deepEqual(parsed.multi.get("--path"), ["src/a", "src/b"]);
  assert.deepEqual(parsed.multi.get("--skip"), ["*.gen.ts", "dist"]);
  // Single-slot map keeps the last value for compatibility.
  assert.equal(parsed.flags.get("--path"), "src/b");
  assert.equal(parsed.positional[0], "audit");
});

test("pir audit rejects find-only flags as usage errors before any context", async () => {
  const repo = createTempGitRepo("pir-audit-cli-");
  try {
    // executePirCommand resolves the working directory from --cwd (there is no
    // opts.cwd), so every call pins the temp repo explicitly.
    await assert.rejects(
      executePirCommand(["audit", "--cwd", repo.dir, "--base", "HEAD^"]),
      (error) => error instanceof UsageError && /no comparison base/.test(error.message),
    );
    await assert.rejects(
      executePirCommand(["audit", "--cwd", repo.dir, "--uncommitted"]),
      (error) => error instanceof UsageError && /find only/.test(error.message),
    );
    await assert.rejects(
      executePirCommand(["audit", "--cwd", repo.dir, "--max-rounds", "3"]),
      (error) => error instanceof UsageError && /no global round limit/.test(error.message),
    );
    await assert.rejects(
      executePirCommand(["audit", "--cwd", repo.dir, "--branch", "main"]),
      (error) => error instanceof UsageError && /--head/.test(error.message),
    );
  } finally {
    repo.cleanup();
  }
});

test("pir audit with no reviewable scope fails as a usage error, exit 2 semantics", async () => {
  const repo = createTempGitRepo("pir-audit-cli-scope-");
  try {
    // Only binary entries selected: nothing reviewable.
    repo.write("assets/logo.png", "binary by extension\n");
    repo.commit("binary");
    await assert.rejects(
      executePirCommand(["audit", "--json", "--no-sync-index", "--cwd", repo.dir], { dbPath: path.join(repo.dir, "memory.sqlite") }),
      (error) => error instanceof UsageError && /none are reviewable text/.test(error.message),
    );
    // --path that matches nothing at all is an explicit scope miss.
    await assert.rejects(
      executePirCommand(["audit", "--json", "--no-sync-index", "--cwd", repo.dir, "--path", "does/not/exist"], { dbPath: path.join(repo.dir, "memory.sqlite") }),
      (error) => error instanceof UsageError && /scope is empty/.test(error.message),
    );
  } finally {
    repo.cleanup();
  }
});
