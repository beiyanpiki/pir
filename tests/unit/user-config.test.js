import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const {
  deleteUserConfig,
  loadUserConfig,
  maskSecret,
  resolveTransport,
  saveUserConfig,
  setConfigValue,
  UsageError,
} = await import("../../dist/cli/config.js");

function withTempConfig(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "pir-usercfg-"));
  const prev = process.env.PIR_CONFIG_DIR;
  process.env.PIR_CONFIG_DIR = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.PIR_CONFIG_DIR;
    else process.env.PIR_CONFIG_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

const CLEAN_ENV = {
  PIR_SERVER_URL: undefined,
  PIR_SERVER_TOKEN: undefined,
  PIR_INSECURE: undefined,
  PIR_MODE: undefined,
};
const env = (overrides = {}) => ({ ...CLEAN_ENV, ...overrides });

const REMOTE_CONFIG = {
  schemaVersion: 1,
  mode: "remote",
  server: { url: "https://pir.svc:8790", token: "config-token", insecure: true },
};

test("user config: absent -> null; save/load roundtrip with owner-only permissions", (t) => {
  withTempConfig(t);
  assert.equal(loadUserConfig(), null);

  const file = saveUserConfig(REMOTE_CONFIG);
  assert.equal(file, path.join(process.env.PIR_CONFIG_DIR, "config.json"));
  assert.equal((statSync(process.env.PIR_CONFIG_DIR).mode & 0o777), 0o700);
  assert.equal((statSync(file).mode & 0o777), 0o600);
  assert.deepEqual(loadUserConfig(), REMOTE_CONFIG);

  assert.equal(deleteUserConfig(), true);
  assert.equal(loadUserConfig(), null);
  assert.equal(deleteUserConfig(), false);
});

test("user config: malformed JSON and bad shapes are loud, not silent defaults", (t) => {
  const dir = withTempConfig(t);
  const file = path.join(dir, "config.json");

  writeFileSync(file, "{ not json");
  assert.throws(() => loadUserConfig(), /not valid JSON/);

  writeFileSync(file, JSON.stringify({ schemaVersion: 1, mode: "space" }));
  assert.throws(() => loadUserConfig(), /mode.*local.*remote/);

  writeFileSync(file, JSON.stringify({ schemaVersion: 1, mode: "remote" }));
  assert.throws(() => loadUserConfig(), /remote.*requires server\.url/);

  writeFileSync(file, JSON.stringify({ schemaVersion: 1, mode: "remote", server: { url: "ftp://x" } }));
  assert.throws(() => loadUserConfig(), /http\(s\)/);
});

test("resolveTransport precedence: flag > env > config file > local default", () => {
  // Nothing configured -> local.
  assert.deepEqual(resolveTransport({ argv: ["find"], env: env(), config: null }), { mode: "local" });
  assert.deepEqual(
    resolveTransport({ argv: ["find"], env: env(), config: { schemaVersion: 1, mode: "local" } }),
    { mode: "local" },
  );

  // --server flag wins over everything; = form works too.
  assert.deepEqual(resolveTransport({ argv: ["--server", "https://a:1", "find"], env: env(), config: REMOTE_CONFIG }), {
    mode: "remote",
    url: "https://a:1",
    token: "config-token",
    insecure: true,
  });
  assert.equal(resolveTransport({ argv: ["--server=https://b:2", "find"], env: env(), config: null }).url, "https://b:2");

  // --server and --local contradict.
  assert.throws(() => resolveTransport({ argv: ["--server", "https://a:1", "--local"], env: env(), config: null }), {
    constructor: UsageError,
  });

  // --local beats a remote config.
  assert.deepEqual(resolveTransport({ argv: ["--local", "find"], env: env(), config: REMOTE_CONFIG }), {
    mode: "local",
  });

  // PIR_SERVER_URL env beats the config file; trailing slash normalized.
  assert.deepEqual(resolveTransport({ argv: ["find"], env: env({ PIR_SERVER_URL: "https://env:8790/" }), config: REMOTE_CONFIG }).url, "https://env:8790");

  // Config file drives remote mode, with flag/env overrides for token+insecure.
  assert.deepEqual(resolveTransport({ argv: ["find"], env: env(), config: REMOTE_CONFIG }), {
    mode: "remote",
    url: "https://pir.svc:8790",
    token: "config-token",
    insecure: true,
  });
  assert.equal(
    resolveTransport({ argv: ["find", "--token", "flag-token"], env: env(), config: REMOTE_CONFIG }).token,
    "flag-token",
  );
  assert.equal(
    resolveTransport({ argv: ["find"], env: env({ PIR_SERVER_TOKEN: "env-token" }), config: REMOTE_CONFIG }).token,
    "env-token",
  );
  assert.equal(resolveTransport({ argv: ["find"], env: env(), config: { ...REMOTE_CONFIG, server: { url: "https://x" } } }).insecure, false);

  // PIR_MODE env beats the config in both directions.
  assert.deepEqual(resolveTransport({ argv: ["find"], env: env({ PIR_MODE: "local" }), config: REMOTE_CONFIG }), {
    mode: "local",
  });
  assert.equal(
    resolveTransport({ argv: ["find"], env: env({ PIR_MODE: "remote" }), config: REMOTE_CONFIG }).url,
    "https://pir.svc:8790",
  );

  // Remote without any resolvable URL is a usage error.
  assert.throws(() => resolveTransport({ argv: ["find"], env: env({ PIR_MODE: "remote" }), config: null }), /needs a server URL/);
});

test("setConfigValue: validates values, requires server.url before remote settings, clears with \"\"", () => {
  const local = { schemaVersion: 1, mode: "local" };

  assert.throws(() => setConfigValue(local, "mode", "remote"), /set server\.url before mode=remote/);
  assert.throws(() => setConfigValue(local, "mode", "bogus"), /local or remote/);

  const withUrl = setConfigValue(local, "server.url", "https://pir.svc:8790/");
  assert.equal(withUrl.server.url, "https://pir.svc:8790");
  assert.throws(() => setConfigValue(local, "server.url", "notaurl"), /not a valid URL/);
  assert.throws(() => setConfigValue(local, "server.url", "ftp://x"), /http\(s\)/);

  const withToken = setConfigValue(withUrl, "server.token", "t1");
  assert.equal(withToken.server.token, "t1");
  assert.equal(setConfigValue(withToken, "server.token", "").server.token, undefined);

  assert.equal(setConfigValue(withUrl, "server.insecure", "yes").server.insecure, true);
  assert.equal(setConfigValue(withUrl, "server.insecure", "0").server.insecure, false);
  assert.throws(() => setConfigValue(withUrl, "server.insecure", "maybe"), /true or false/);

  assert.equal(setConfigValue(local, "model", " anthropic/claude-opus-4 ").model, "anthropic/claude-opus-4");
  assert.equal(setConfigValue({ ...local, model: "x" }, "model", "").model, undefined);

  assert.throws(() => setConfigValue(local, "nope", "x"), /unknown config key/);
});

test("maskSecret keeps short secrets fully hidden", () => {
  assert.equal(maskSecret(undefined), "(none)");
  assert.equal(maskSecret("short"), "••••");
  assert.equal(maskSecret("secret-token-abcdef"), "secr…cdef");
});
