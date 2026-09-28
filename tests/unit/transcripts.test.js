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

test("runTranscriptDir mirrors the memory state-dir resolution", () => {
  const root = mkdtempSync(path.join(tmpdir(), "pir-transcripts-"));
  try {
    // Server mode: <PIR_STATE_ROOT>/<projectId>/transcripts/<runId>
    const serverDir = withEnv({ PIR_STATE_ROOT: root }, () =>
      runTranscriptDir("/repo", "proj-1", "run-9"),
    );
    assert.equal(serverDir, path.join(root, "proj-1", "transcripts", "run-9"));
    assert.ok(existsSync(serverDir), "directory is created");

    // Docker-exec mode: <repo>/.pir/transcripts/<runId>
    const inProject = withEnv({ PIR_STATE_IN_PROJECT: "1" }, () =>
      runTranscriptDir(path.join(root, "repo"), "proj-1", "run-9"),
    );
    assert.equal(inProject, path.join(root, "repo", ".pir", "transcripts", "run-9"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
