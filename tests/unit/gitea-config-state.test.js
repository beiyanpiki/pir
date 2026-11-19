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

const { giteaStateFile, giteaStateKey, loadGiteaState, saveGiteaState } = await import(
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

test("gitea state: corrupt or wrong-shape files are tolerated as empty", (t) => {
  const dir = withTempDir(t);
  for (const raw of ["{ not json", "[]", '{"prs": "nope"}', '{"other": 1}', "null"]) {
    writeFileSync(giteaStateFile(dir), raw);
    assert.deepEqual(loadGiteaState(dir), { prs: {} }, `raw: ${raw}`);
  }
});
