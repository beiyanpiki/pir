import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { GiteaWebhookError, parseGiteaEvent, parsePullRequestPayload, verifyGiteaSignature } =
  await import("../../dist/gitea/webhook.js");

const SECRET = "webhook-secret-0123456789";
const BODY = JSON.stringify({ hello: "pir", n: 42 });

function hexSha256(body, secret = SECRET) {
  return createHmac("sha256", secret).update(body).digest("hex");
}

function loadFixture(name) {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "gitea", name);
  return readFileSync(file, "utf8");
}

test("gitea signature: x-gitea-signature accepts a correct HMAC over the raw body", () => {
  assert.equal(verifyGiteaSignature(BODY, SECRET, { "x-gitea-signature": hexSha256(BODY) }), true);
  // The raw bytes, not a re-serialization, are what gets signed.
  assert.equal(verifyGiteaSignature(Buffer.from(BODY, "utf8"), SECRET, { "x-gitea-signature": hexSha256(BODY) }), true);
  // Wrong secret, wrong body, wrong digest all fail.
  assert.equal(verifyGiteaSignature(BODY, "other-secret", { "x-gitea-signature": hexSha256(BODY) }), false);
  assert.equal(verifyGiteaSignature(BODY, SECRET, { "x-gitea-signature": hexSha256(`${BODY} `) }), false);
  assert.equal(
    verifyGiteaSignature(BODY, SECRET, { "x-gitea-signature": hexSha256(BODY).slice(0, 63) + "0" }),
    false,
  );
});

test("gitea signature: x-hub-signature-256 sha256=<hex> form and header-name case-insensitivity", () => {
  assert.equal(verifyGiteaSignature(BODY, SECRET, { "x-hub-signature-256": `sha256=${hexSha256(BODY)}` }), true);
  assert.equal(verifyGiteaSignature(BODY, SECRET, { "X-Hub-Signature-256": `sha256=${hexSha256(BODY)}` }), true);
  assert.equal(verifyGiteaSignature(BODY, SECRET, { "X-Gitea-Signature": hexSha256(BODY).toUpperCase() }), true);
  // Array-valued headers (Node's raw form) use the first entry.
  assert.equal(verifyGiteaSignature(BODY, SECRET, { "x-gitea-signature": [hexSha256(BODY)] }), true);
});

test("gitea signature: absent, empty, or malformed digests are rejected, never accepted", () => {
  assert.equal(verifyGiteaSignature(BODY, SECRET, {}), false);
  assert.equal(verifyGiteaSignature(BODY, SECRET, { "x-gitea-signature": "" }), false);
  assert.equal(verifyGiteaSignature(BODY, SECRET, { "x-gitea-signature": "   " }), false);
  assert.equal(verifyGiteaSignature(BODY, SECRET, { "x-hub-signature-256": "" }), false);
  assert.equal(verifyGiteaSignature(BODY, SECRET, { "x-gitea-signature": "not-hex-at-all" }), false);
  assert.equal(verifyGiteaSignature(BODY, SECRET, { "x-hub-signature-256": `sha1=${hexSha256(BODY)}` }), false);
  assert.equal(verifyGiteaSignature(BODY, SECRET, { "x-gitea-signature": hexSha256(BODY).slice(0, 32) }), false);
});

test("gitea event headers: event + eventType, case-insensitive keys, missing event is an error", () => {
  assert.deepEqual(parseGiteaEvent({ "x-gitea-event": "pull_request", "x-gitea-event-type": "pull_request_sync" }), {
    event: "pull_request",
    eventType: "pull_request_sync",
  });
  assert.deepEqual(parseGiteaEvent({ "X-Gitea-Event": "pull_request_comment" }), {
    event: "pull_request_comment",
    eventType: null,
  });
  assert.deepEqual(parseGiteaEvent({ "x-gitea-event": ["pull_request_sync"] }), {
    event: "pull_request_sync",
    eventType: null,
  });
  assert.throws(() => parseGiteaEvent({}), GiteaWebhookError);
  assert.throws(() => parseGiteaEvent({ "x-gitea-event-type": "pull_request_sync" }), GiteaWebhookError);
});

test("gitea payload: opened fixture parses into the typed view", () => {
  const view = parsePullRequestPayload(loadFixture("pull-request-opened.json"));
  assert.equal(view.action, "opened");
  assert.equal(view.number, 42);
  assert.equal(view.title, "Add retry with backoff to the login client");
  assert.equal(
    view.body,
    "Retries idempotent POSTs up to three times before giving up.\n\nCloses #7.",
  );
  assert.equal(view.draft, false);
  assert.equal(view.baseRef, "main");
  assert.equal(view.baseSha, "9d1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c");
  assert.equal(view.headRef, "feat/login-retry");
  assert.equal(view.headSha, "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d");
  assert.equal(view.htmlUrl, "https://gitea.example.com/beiyan/pir-demo/pulls/42");
  // The head repo is where the PR head lives, so its clone_url wins over the base repository's.
  assert.equal(view.cloneUrl, "https://gitea.example.com/alice/pir-demo.git");
  assert.equal(view.repoFullName, "beiyan/pir-demo");
  assert.deepEqual(view.labels, ["enhancement"]);
  assert.equal(view.senderLogin, "alice");
  assert.equal(view.prUser, "alice");
});

test("gitea payload: sync fixture (no draft field, synchronized action) parses", () => {
  const view = parsePullRequestPayload(Buffer.from(loadFixture("pull-request-sync.json"), "utf8"));
  assert.equal(view.action, "synchronized");
  assert.equal(view.headSha, "5f6e7d8c9b0a1f2e3d4c5b6a7988091726354e5d");
  assert.equal(view.draft, undefined);
  assert.deepEqual(view.labels, ["enhancement"]);
});

test("gitea payload: edited fixture (WIP removed) parses with the clean title", () => {
  const view = parsePullRequestPayload(loadFixture("pull-request-edited.json"));
  assert.equal(view.action, "edited");
  assert.equal(view.title, "Add retry with backoff to the login client");
  assert.ok(!view.title.startsWith("WIP:"));
});

test("gitea payload: head repo fallbacks — ssh_url, then the top-level repository", () => {
  const base = JSON.parse(loadFixture("pull-request-opened.json"));
  delete base.pull_request.head.repo.clone_url;
  let view = parsePullRequestPayload(JSON.stringify(base));
  assert.equal(view.cloneUrl, "git@gitea.example.com:alice/pir-demo.git");

  delete base.pull_request.head.repo;
  view = parsePullRequestPayload(JSON.stringify(base));
  assert.equal(view.cloneUrl, "https://gitea.example.com/beiyan/pir-demo.git");

  delete base.repository.clone_url;
  view = parsePullRequestPayload(JSON.stringify(base));
  assert.equal(view.cloneUrl, "git@gitea.example.com:beiyan/pir-demo.git");
});

test("gitea payload: repoFullName falls back to owner/login + name", () => {
  const payload = JSON.parse(loadFixture("pull-request-opened.json"));
  delete payload.repository.full_name;
  const view = parsePullRequestPayload(JSON.stringify(payload));
  assert.equal(view.repoFullName, "beiyan/pir-demo");
});

test("gitea payload: null body normalizes to empty string, missing labels to []", () => {
  const payload = JSON.parse(loadFixture("pull-request-opened.json"));
  payload.pull_request.body = null;
  delete payload.pull_request.labels;
  const view = parsePullRequestPayload(JSON.stringify(payload));
  assert.equal(view.body, "");
  assert.deepEqual(view.labels, []);
});

test("gitea payload: malformed payloads throw instead of half-parsing", () => {
  assert.throws(() => parsePullRequestPayload("{ not json"), GiteaWebhookError);
  assert.throws(() => parsePullRequestPayload("[]"), GiteaWebhookError);
  // Required fields are validated in reading order: action, then number, then pull_request.
  assert.throws(() => parsePullRequestPayload(JSON.stringify({ action: "opened" })), /payload\.number/);
  const missing = (mutate) => {
    const payload = JSON.parse(loadFixture("pull-request-opened.json"));
    mutate(payload);
    assert.throws(() => parsePullRequestPayload(JSON.stringify(payload)), GiteaWebhookError);
  };
  missing((p) => delete p.action);
  missing((p) => (p.action = ""));
  missing((p) => delete p.number);
  missing((p) => (p.number = 0));
  missing((p) => (p.number = "42"));
  missing((p) => delete p.pull_request.title);
  missing((p) => delete p.pull_request.base.ref);
  missing((p) => delete p.pull_request.head.sha);
  missing((p) => delete p.pull_request.html_url);
  missing((p) => delete p.repository);
  missing((p) => delete p.sender.login);
  missing((p) => delete p.pull_request.user);
  missing((p) => (p.pull_request.labels = [{ nope: 1 }]));
  missing((p) => {
    delete p.repository.full_name;
    delete p.repository.owner;
  });
  missing((p) => {
    delete p.pull_request.head.repo;
    delete p.repository.clone_url;
    delete p.repository.ssh_url;
  });
});
