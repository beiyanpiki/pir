import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SCRIPT = path.resolve("docker/auth-seed.cjs");

function run(env) {
  return execFileAsync(process.execPath, [SCRIPT], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function authDir(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "pir-authseed-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("auth-seed merges an object PI_AUTH_JSON into auth.json", async (t) => {
  const dir = authDir(t);
  const target = path.join(dir, "auth.json");
  await run({ HOME: dir, PIR_ENTRY_AUTH_PATH: target, PI_AUTH_JSON: '{"deepseek":{"type":"api_key","key":"sk-1"}}' });
  const auth = JSON.parse(readFileSync(target, "utf8"));
  assert.deepEqual(auth, { deepseek: { type: "api_key", key: "sk-1" } });
});

test("auth-seed rejects a non-object PI_AUTH_JSON instead of writing garbage", async (t) => {
  const dir = authDir(t);
  const target = path.join(dir, "auth.json");
  for (const bad of ['"sk-plain-string"', '["array"]', "123"]) {
    await assert.rejects(
      run({ HOME: dir, PIR_ENTRY_AUTH_PATH: target, PI_AUTH_JSON: bad }),
      (err) => err.code === 1 && /PI_AUTH_JSON must be a JSON object/.test(err.stderr),
    );
  }
  // Refused input must not corrupt or create the store.
  assert.equal(existsSync(target), false, "no auth.json should be written on refusal");
});

test("auth-seed rejects invalid JSON with a clear message", async (t) => {
  const dir = authDir(t);
  const target = path.join(dir, "auth.json");
  await assert.rejects(
    run({ HOME: dir, PIR_ENTRY_AUTH_PATH: target, PI_AUTH_JSON: "{not json" }),
    (err) => err.code === 1 && /PI_AUTH_JSON is not valid JSON/.test(err.stderr),
  );
});

test("auth-seed merges PI_API_KEY__<provider> env and existing file contents", async (t) => {
  const dir = authDir(t);
  const target = path.join(dir, "auth.json");
  writeFileSync(target, JSON.stringify({ zai: { type: "api_key", key: "existing" } }));
  await run({
    HOME: dir,
    PIR_ENTRY_AUTH_PATH: target,
    PI_AUTH_JSON: '{"deepseek":{"type":"api_key","key":"sk-2"}}',
    PI_API_KEY__openai: "sk-3",
  });
  const auth = JSON.parse(readFileSync(target, "utf8"));
  assert.deepEqual(auth, {
    zai: { type: "api_key", key: "existing" },
    deepseek: { type: "api_key", key: "sk-2" },
    openai: { type: "api_key", key: "sk-3" },
  });
});

test("auth-seed rejects a non-object existing auth.json (bad /pi-config mount)", async (t) => {
  const dir = authDir(t);
  const target = path.join(dir, "auth.json");
  writeFileSync(target, '"just-a-string"\n');
  // Same treatment as a corrupt file: fail loudly instead of leaving the
  // bad store in place to resurface later as a model-auth error.
  await assert.rejects(
    run({ HOME: dir, PIR_ENTRY_AUTH_PATH: target }),
    (err) => err.code === 1 && /is not a JSON object/.test(err.stderr),
  );
  assert.equal(readFileSync(target, "utf8"), '"just-a-string"\n');
});
