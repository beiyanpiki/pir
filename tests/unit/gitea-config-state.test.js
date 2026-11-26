import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const {
  DEFAULT_GITEA_TRIGGER_POLICY,
  GiteaConfigError,
  loadGiteaConfig,
  resolveTriggerPolicy,
} = await import("../../dist/gitea/config.js");

const MINIMAL = {
  url: "https://gitea.example.com",
  token: "bot-token-0123456789",
  webhookSecret: "webhook-secret-0123456789",
};

function withTempDir(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "pir-gitea-cfg-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeGiteaJson(dir, config) {
  writeFileSync(path.join(dir, "gitea.json"), `${JSON.stringify(config, null, 2)}\n`);
}

/** For malformed-file cases that must hit the disk byte-for-byte, not via JSON.stringify. */
function writeRawGiteaJson(dir, raw) {
  writeFileSync(path.join(dir, "gitea.json"), raw);
}

test("gitea config: missing file is null (integration off), not an error", (t) => {
  const dir = withTempDir(t);
  assert.equal(loadGiteaConfig(dir), null);
});

test("gitea config: minimal file gets every default", (t) => {
  const dir = withTempDir(t);
  writeGiteaJson(dir, MINIMAL);
  const config = loadGiteaConfig(dir);
  assert.deepEqual(config.defaults, DEFAULT_GITEA_TRIGGER_POLICY);
  assert.equal(config.commentLanguage, "en");
  assert.equal(config.statusOnFindings, "success");
  assert.deepEqual(config.repos, {});
  assert.equal(config.url, "https://gitea.example.com");
});

test("gitea config: defaults merge over the built-in ones", (t) => {
  const dir = withTempDir(t);
  writeGiteaJson(dir, {
    ...MINIMAL,
    commentLanguage: "zh-CN",
    statusOnFindings: "failure",
    defaults: { baseBranches: ["main", "release/2.0"], maxFindings: 3, model: "zai-coding-cn/glm-5.3:max" },
  });
  const config = loadGiteaConfig(dir);
  assert.equal(config.commentLanguage, "zh-CN");
  assert.equal(config.statusOnFindings, "failure");
  assert.deepEqual(config.defaults, {
    ...DEFAULT_GITEA_TRIGGER_POLICY,
    baseBranches: ["main", "release/2.0"],
    maxFindings: 3,
    model: "zai-coding-cn/glm-5.3:max",
  });
});

test("gitea config: url must be http(s), trailing slash stripped", (t) => {
  const dir = withTempDir(t);
  writeGiteaJson(dir, { ...MINIMAL, url: "https://gitea.example.com/" });
  assert.equal(loadGiteaConfig(dir).url, "https://gitea.example.com");

  writeGiteaJson(dir, { ...MINIMAL, url: "ftp://gitea.example.com" });
  assert.throws(() => loadGiteaConfig(dir), /http\(s\)/);

  writeGiteaJson(dir, { ...MINIMAL, url: "not a url" });
  assert.throws(() => loadGiteaConfig(dir), GiteaConfigError);

  writeGiteaJson(dir, { ...MINIMAL, url: "" });
  assert.throws(() => loadGiteaConfig(dir), /url/);
});

test("gitea config: token and webhookSecret must be non-empty", (t) => {
  const dir = withTempDir(t);
  writeGiteaJson(dir, { ...MINIMAL, token: "" });
  assert.throws(() => loadGiteaConfig(dir), /token/);
  writeGiteaJson(dir, { ...MINIMAL, webhookSecret: "" });
  assert.throws(() => loadGiteaConfig(dir), /webhookSecret/);
  const { token: _drop, ...withoutToken } = MINIMAL;
  writeGiteaJson(dir, withoutToken);
  assert.throws(() => loadGiteaConfig(dir), /token/);
});

test("gitea config: unknown keys, bad shapes and bad values are loud", (t) => {
  const dir = withTempDir(t);
  const bad = (config, pattern) => {
    writeGiteaJson(dir, config);
    assert.throws(() => loadGiteaConfig(dir), pattern);
  };
  bad({ ...MINIMAL, webhook_secret: MINIMAL.webhookSecret }, /unknown key "webhook_secret"/);
  bad({ ...MINIMAL, commentLanguage: "fr" }, /commentLanguage/);
  bad({ ...MINIMAL, statusOnFindings: "error" }, /statusOnFindings/);
  bad({ ...MINIMAL, defaults: { skipLabel: ["x"] } }, /unknown key "skipLabel"/);
  bad({ ...MINIMAL, defaults: { maxFindings: 0 } }, /maxFindings/);
  bad({ ...MINIMAL, defaults: { maxFindings: "10" } }, /maxFindings/);
  bad({ ...MINIMAL, defaults: { model: 5 } }, /model/);
  bad({ ...MINIMAL, defaults: { baseBranches: "main" } }, /baseBranches/);
  bad({ ...MINIMAL, repos: ["owner/repo"] }, /repos/);
  bad({ ...MINIMAL, repos: { "owner/repo": { extra: true } } }, /unknown key "extra"/);
  writeRawGiteaJson(dir, "{ not json");
  assert.throws(() => loadGiteaConfig(dir), /not valid JSON/);
  writeGiteaJson(dir, [1, 2]);
  assert.throws(() => loadGiteaConfig(dir), /expected a JSON object/); // valid JSON, wrong shape
});

// ---------------------------------------------------------------------------
// PIR_GITEA_JSON env source
// ---------------------------------------------------------------------------

/** Set PIR_GITEA_JSON for one test; restored (or deleted) afterwards. */
function setGiteaJsonEnv(t, value) {
  const prev = process.env.PIR_GITEA_JSON;
  if (value === undefined) delete process.env.PIR_GITEA_JSON;
  else process.env.PIR_GITEA_JSON = value;
  t.after(() => {
    if (prev === undefined) delete process.env.PIR_GITEA_JSON;
    else process.env.PIR_GITEA_JSON = prev;
  });
}

test("gitea config: non-empty PIR_GITEA_JSON wins over the file and works with no file", (t) => {
  const dir = withTempDir(t);
  // A file with a DIFFERENT url proves the env value, not the file, was used.
  writeGiteaJson(dir, MINIMAL);
  setGiteaJsonEnv(t, JSON.stringify({ ...MINIMAL, url: "https://env-gitea.example.com/" }));
  let config = loadGiteaConfig(dir);
  assert.equal(config.url, "https://env-gitea.example.com");
  assert.deepEqual(config.defaults, DEFAULT_GITEA_TRIGGER_POLICY); // env goes through the same defaults
  // No file at all: the env alone enables the integration (docker case).
  rmSync(path.join(dir, "gitea.json"));
  config = loadGiteaConfig(dir);
  assert.equal(config.url, "https://env-gitea.example.com");
});

test("gitea config: invalid PIR_GITEA_JSON is a loud error naming the env, even with no file", (t) => {
  const dir = withTempDir(t); // deliberately no gitea.json — a broken env must not read as "off"
  setGiteaJsonEnv(t, "{ not json");
  assert.throws(() => loadGiteaConfig(dir), GiteaConfigError);
  assert.throws(() => loadGiteaConfig(dir), /\$PIR_GITEA_JSON is not valid JSON/);
  setGiteaJsonEnv(t, JSON.stringify({ ...MINIMAL, url: "ftp://gitea.example.com" }));
  assert.throws(() => loadGiteaConfig(dir), /\$PIR_GITEA_JSON: url/);
  setGiteaJsonEnv(t, JSON.stringify({ ...MINIMAL, webhook_secret: "x" }));
  assert.throws(() => loadGiteaConfig(dir), /unknown key "webhook_secret"/);
});

test("gitea config: unset, empty, or whitespace-only PIR_GITEA_JSON falls back to the file", (t) => {
  const dir = withTempDir(t);
  writeGiteaJson(dir, { ...MINIMAL, commentLanguage: "zh-CN" });
  for (const value of [undefined, "", "   "]) {
    setGiteaJsonEnv(t, value);
    assert.equal(loadGiteaConfig(dir).commentLanguage, "zh-CN", `env: ${JSON.stringify(value)}`);
  }
  setGiteaJsonEnv(t, undefined);
  assert.equal(loadGiteaConfig(dir).commentLanguage, "zh-CN");
  // And with neither source, the integration stays off.
  rmSync(path.join(dir, "gitea.json"));
  assert.equal(loadGiteaConfig(dir), null);
});

const POLICY_CONFIG = {
  ...MINIMAL,
  defaults: { baseBranches: ["main", "dev"], maxFindings: 5, model: "provider/default-model" },
  repos: {
    "owner/watched": { wipPrefixes: ["[NO-MERGE]"], skipLabels: [] },
    "owner/pinned-model": { model: null },
    "owner/everything": {
      baseBranches: ["release/2.0"],
      wipPrefixes: [],
      skipLabels: ["no-review"],
      maxFindings: 1,
      model: "provider/other-model",
    },
  },
};

test("gitea config: resolveTriggerPolicy — no repo entry keeps defaults verbatim", () => {
  const config = loadGiteaConfigFrom(POLICY_CONFIG);
  assert.deepEqual(resolveTriggerPolicy(config, "owner/unknown"), {
    baseBranches: ["main", "dev"],
    wipPrefixes: DEFAULT_GITEA_TRIGGER_POLICY.wipPrefixes,
    skipLabels: DEFAULT_GITEA_TRIGGER_POLICY.skipLabels,
    maxFindings: 5,
    model: "provider/default-model",
  });
});

test("gitea config: repo override replaces only the keys it sets; arrays replace, never concat", () => {
  const config = loadGiteaConfigFrom(POLICY_CONFIG);
  const watched = resolveTriggerPolicy(config, "owner/watched");
  assert.deepEqual(watched.wipPrefixes, ["[NO-MERGE]"]); // replaced
  assert.deepEqual(watched.skipLabels, []); // replaced with empty, not merged
  assert.deepEqual(watched.baseBranches, ["main", "dev"]); // untouched key inherits
  assert.equal(watched.maxFindings, 5);
  assert.equal(watched.model, "provider/default-model");
});

test("gitea config: model null inherits the default model; a string overrides it", () => {
  const config = loadGiteaConfigFrom(POLICY_CONFIG);
  assert.equal(resolveTriggerPolicy(config, "owner/pinned-model").model, "provider/default-model");
  assert.equal(resolveTriggerPolicy(config, "owner/everything").model, "provider/other-model");
});

test("gitea config: full override entry replaces every field", () => {
  const config = loadGiteaConfigFrom(POLICY_CONFIG);
  assert.deepEqual(resolveTriggerPolicy(config, "owner/everything"), {
    baseBranches: ["release/2.0"],
    wipPrefixes: [],
    skipLabels: ["no-review"],
    maxFindings: 1,
    model: "provider/other-model",
  });
});

function loadGiteaConfigFrom(value) {
  // Same validation path as a real file, without touching disk per assertion.
  const dir = mkdtempSync(path.join(tmpdir(), "pir-gitea-cfg-inmem-"));
  try {
    writeGiteaJson(dir, value);
    return loadGiteaConfig(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const { giteaStateFile, giteaStateKey, loadGiteaState, saveGiteaState, updateGiteaPrState } = await import(
  "../../dist/gitea/state.js"
);

test("gitea state: missing file loads as an empty store", (t) => {
  const dir = withTempDir(t);
  assert.deepEqual(loadGiteaState(dir), { prs: {} });
});

test("gitea state: save/load roundtrip, owner-only mode, tmp file gone", (t) => {
  const dir = withTempDir(t);
  const key = giteaStateKey("beiyan/pir-demo", 42);
  assert.equal(key, "beiyan/pir-demo#42");
  const state = {
    prs: {
      [key]: {
        lastHeadSha: "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d",
        reviewId: 1001,
        statusCommentId: 2002,
        lastPostedFingerprints: ["src/a.ts:fp1", "src/b.ts:fp2"],
        updatedAt: "2026-11-18T12:00:00.000Z",
      },
    },
  };
  const file = saveGiteaState(dir, state);
  assert.equal(file, path.join(dir, "gitea-state.json"));
  assert.equal(giteaStateFile(dir), file);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.throws(() => statSync(`${file}.tmp`), /ENOENT/); // atomic rename left no tmp behind
  assert.deepEqual(loadGiteaState(dir), state);

  // A second save replaces entries atomically (tmp+rename, no leftovers).
  state.prs[key].reviewId = 1003;
  saveGiteaState(dir, state);
  assert.equal(loadGiteaState(dir).prs[key].reviewId, 1003);
  assert.throws(() => statSync(`${file}.tmp`), /ENOENT/);
});

test("gitea state: per-key update rebases on the latest file and preserves other PRs", (t) => {
  const dir = withTempDir(t);
  const keyA = giteaStateKey("beiyan/pir-demo", 1);
  const keyB = giteaStateKey("beiyan/pir-demo", 2);
  const entry = (lastHeadSha, reviewId) => ({
    lastHeadSha,
    reviewId,
    statusCommentId: reviewId + 1,
    lastPostedFingerprints: [`${lastHeadSha}:fp`],
    updatedAt: "2026-11-25T00:00:00.000Z",
  });

  // Run A loads (empty) before run B writes its own key. Its update must not
  // write back the stale snapshot it started from.
  assert.deepEqual(loadGiteaState(dir), { prs: {} });
  const a = updateGiteaPrState(dir, keyA, (previous) => {
    assert.equal(previous, null);
    return entry("a".repeat(40), 100);
  });
  assert.deepEqual(loadGiteaState(dir).prs[keyA], a);

  // B adds its own key while A's "run" is still between its started and final writes.
  saveGiteaState(dir, { prs: { ...loadGiteaState(dir).prs, [keyB]: entry("b".repeat(40), 200) } });

  // A's next update rebases on the file that now contains B and touches only A.
  const a2 = updateGiteaPrState(dir, keyA, (previous) => {
    assert.deepEqual(previous, a); // latest value of its OWN key
    return { ...previous, reviewId: 101, updatedAt: "2026-11-25T00:01:00.000Z" };
  });
  const stored = loadGiteaState(dir);
  assert.deepEqual(stored.prs[keyA], a2);
  assert.equal(stored.prs[keyA].reviewId, 101);
  assert.deepEqual(stored.prs[keyB], entry("b".repeat(40), 200));

  // An update for a new key also leaves both existing entries untouched.
  updateGiteaPrState(dir, giteaStateKey("beiyan/other", 3), () => entry("c".repeat(40), 300));
  const all = loadGiteaState(dir).prs;
  assert.deepEqual(all[keyA], a2);
  assert.deepEqual(all[keyB], entry("b".repeat(40), 200));
  assert.equal(all[giteaStateKey("beiyan/other", 3)].reviewId, 300);
});

test("gitea state: corrupt or wrong-shape files are tolerated as empty", (t) => {
  const dir = withTempDir(t);
  for (const raw of ["{ not json", "[]", '{"prs": "nope"}', '{"other": 1}', "null"]) {
    writeFileSync(giteaStateFile(dir), raw);
    assert.deepEqual(loadGiteaState(dir), { prs: {} }, `raw: ${raw}`);
  }
});
