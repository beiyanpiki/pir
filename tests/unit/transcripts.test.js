import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runTranscriptDir, transcriptsEnabled, writeTranscript } from "../../dist/agents/transcripts.js";

function withEnv(env, fn) {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    return fn();
  } finally {
    for (const key of Object.keys(env)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test("transcriptsEnabled: only 1/true opt in", () => {
  return withEnv({ PIR_TRANSCRIPTS: undefined }, () => {
    delete process.env.PIR_TRANSCRIPTS;
    assert.equal(transcriptsEnabled(), false);
    for (const [raw, expected] of [
      ["1", true],
      ["true", true],
      ["0", false],
      ["yes", false],
      ["", false],
    ]) {
      process.env.PIR_TRANSCRIPTS = raw;
      assert.equal(transcriptsEnabled(), expected, `PIR_TRANSCRIPTS=${raw}`);
    }
  });
});

test("runTranscriptDir sits next to the run's effective memory db", () => {
  const root = mkdtempSync(path.join(tmpdir(), "pir-transcripts-"));
  try {
    // Server mode: db forced under PIR_STATE_ROOT/<projectId> -> transcripts
    // beside it, never inside the throwaway worktree.
    const serverDir = runTranscriptDir(path.join(root, "proj-1", "memory.sqlite"), "run-9");
    assert.equal(serverDir, path.join(root, "proj-1", "transcripts", "run-9"));
    assert.ok(existsSync(serverDir), "directory is created");

    // Docker-exec mode: db under <repo>/.pir -> transcripts beside it.
    const inProject = runTranscriptDir(path.join(root, "repo", ".pir", "memory.sqlite"), "run-9");
    assert.equal(inProject, path.join(root, "repo", ".pir", "transcripts", "run-9"));

    // The image bakes PIR_STATE_IN_PROJECT=1 for docker-exec and the serve
    // process inherits it; the db the run uses wins regardless.
    const leaked = withEnv({ PIR_STATE_IN_PROJECT: "1", PIR_STATE_ROOT: path.join(root, "state") }, () =>
      runTranscriptDir(path.join(root, "state", "proj-2", "memory.sqlite"), "run-9"),
    );
    assert.equal(leaked, path.join(root, "state", "proj-2", "transcripts", "run-9"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writeTranscript keeps legacy payloads unchanged and preserves optional usage metadata", () => {
  const root = mkdtempSync(path.join(tmpdir(), "pir-transcript-metadata-"));
  try {
    const file = path.join(root, "t.json");
    const legacy = {
      role: "code reviewer", model: "offline/model",
      startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T00:00:01.000Z",
      prompt: "review only", messages: [{ role: "user", content: "review only" }],
    };
    writeTranscript(file, legacy);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), legacy);
    const enriched = {
      ...legacy,
      capture: "session-messages", sessionStartedAt: "2025-12-31T23:59:59.000Z",
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 20, cacheWriteTokens: 2, totalTokens: 37, cost: 0.25, durationMs: 2000, toolCalls: 3, repeatedToolCalls: 1 },
      usageAvailable: true,
      effectiveConfig: {
        model: "offline/model", thinkingLevel: "off", builtinTools: ["read"], customTools: ["finish_round"],
        systemPrompt: "read-only-review-v1", resources: "isolated", settings: "in-memory", toolExecution: "sequential",
      },
    };
    writeTranscript(file, enriched);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), enriched);
    writeTranscript(file, { ...legacy, usage: undefined, effectiveConfig: undefined });
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), legacy);
    writeTranscript(file, { ...legacy, usageAvailable: false });
    assert.equal(JSON.parse(readFileSync(file, "utf8")).usageAvailable, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("writeTranscript is JSON-safe and never throws", () => {
  const root = mkdtempSync(path.join(tmpdir(), "pir-transcript-write-"));
  try {
    const file = path.join(root, "t.json");
    const messy = {
      role: "code reviewer",
      fn: () => "never",
      big: 10n ** 20n,
      nested: { ok: true, arr: [1, "two", null] },
    };
    writeTranscript(file, messy);
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(parsed.role, "code reviewer");
    assert.equal(parsed.fn, undefined);
    assert.equal(parsed.big, "100000000000000000000");
    assert.deepEqual(parsed.nested, { ok: true, arr: [1, "two", null] });

    // A failing dump must not propagate (reviews must not die on transcripts).
    writeTranscript(path.join(root, "no-such-dir", "t.json"), { ok: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
