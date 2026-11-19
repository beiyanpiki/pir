import { test } from "node:test";
import assert from "node:assert/strict";

const { PIR_REVIEW_MARKER, PIR_STATUS_MARKER, evaluateTrigger, isWipTitle } = await import(
  "../../dist/gitea/policy.js"
);

const POLICY = {
  baseBranches: ["main"],
  wipPrefixes: ["WIP:", "[WIP]", "Draft:"],
  skipLabels: ["skip-review"],
  maxFindings: 10,
  model: null,
};

const BASE_INPUT = {
  event: "pull_request",
  action: "opened",
  title: "Add retry with backoff",
  baseRef: "main",
  labels: [],
  senderLogin: "alice",
};

const cases = [
  {
    name: "pull_request opened on a watched base is accepted",
    input: BASE_INPUT,
    code: "accepted",
  },
  {
    name: "pull_request reopened is accepted",
    input: { ...BASE_INPUT, action: "reopened" },
    code: "accepted",
  },
  {
    name: "pull_request_sync (push to an open PR) is accepted regardless of action spelling",
    input: { ...BASE_INPUT, event: "pull_request_sync", action: "synchronized" },
    code: "accepted",
  },
  {
    name: "synchronized under the umbrella pull_request event is accepted (Gitea 1.24 delivery)",
    input: { ...BASE_INPUT, event: "pull_request", action: "synchronized" },
    code: "accepted",
  },
  {
    name: "synchronized under the umbrella event still skips on a WIP title",
    input: { ...BASE_INPUT, event: "pull_request", action: "synchronized", title: "WIP: Add retry" },
    code: "wip",
  },
  {
    name: "unwatched event",
    input: { ...BASE_INPUT, event: "issues" },
    code: "unwatched-event",
  },
  {
    name: "unwatched action",
    input: { ...BASE_INPUT, action: "closed" },
    code: "unwatched-action",
  },
  {
    name: "WIP prefix skips, case-insensitively and after leading whitespace",
    input: { ...BASE_INPUT, title: "  wip: add retry" },
    code: "wip",
  },
  {
    name: "[WIP] bracket prefix skips",
    input: { ...BASE_INPUT, title: "[WIP] add retry" },
    code: "wip",
  },
  {
    name: "Draft: prefix skips",
    input: { ...BASE_INPUT, title: "Draft: add retry" },
    code: "wip",
  },
  {
    name: "draft flag skips even without a title marker",
    input: { ...BASE_INPUT, draft: true },
    code: "wip",
  },
  {
    name: "base branch not in the allowlist skips",
    input: { ...BASE_INPUT, baseRef: "release/2.0" },
    code: "base-branch",
  },
  {
    name: "skip label skips",
    input: { ...BASE_INPUT, labels: ["enhancement", "skip-review"] },
    code: "skip-label",
  },
  {
    name: "bot's own webhook skips (feedback loop breaker)",
    input: { ...BASE_INPUT, senderLogin: "pir-bot", botLogin: "pir-bot" },
    code: "bot-sender",
  },
  {
    name: "edited with the WIP marker still on the title is not a review request",
    input: { ...BASE_INPUT, action: "edited", title: "WIP: add retry" },
    code: "unwatched-action",
  },
  {
    name: "edited after WIP removal (the ready-for-review edit) is accepted",
    input: { ...BASE_INPUT, action: "edited", title: "Add retry with backoff" },
    code: "accepted",
  },
  {
    name: "draft skips even on pull_request_sync",
    input: { ...BASE_INPUT, event: "pull_request_sync", action: "synchronized", draft: true },
    code: "wip",
  },
];

test("gitea policy: trigger matrix — every reason branch", () => {
  for (const { name, input, code } of cases) {
    const decision = evaluateTrigger(input, POLICY);
    assert.equal(decision.accepted, code === "accepted", `${name}: accepted`);
    assert.match(decision.reason, new RegExp(`^${code}:`), `${name}: reason code`);
  }
});

test("gitea policy: empty baseBranches allowlist watches every base", () => {
  const decision = evaluateTrigger(BASE_INPUT, { ...POLICY, baseBranches: [] });
  assert.equal(decision.accepted, true);
  // While at it: the base-branch rule still fires for a non-empty allowlist.
  assert.match(evaluateTrigger(BASE_INPUT, { ...POLICY, baseBranches: ["release/2.0"] }).reason, /^base-branch:/);
});

test("gitea policy: bot check is inert without a botLogin", () => {
  const decision = evaluateTrigger({ ...BASE_INPUT, senderLogin: "pir-bot" }, POLICY);
  assert.equal(decision.accepted, true);
});

test("gitea policy: skip rules apply in a fixed order — WIP wins over skip-label", () => {
  const decision = evaluateTrigger(
    { ...BASE_INPUT, title: "WIP: add retry", labels: ["skip-review"] },
    POLICY,
  );
  assert.match(decision.reason, /^wip:/);
});

test("gitea policy: isWipTitle matches case-insensitively after leading whitespace", () => {
  assert.equal(isWipTitle("WIP: x", POLICY.wipPrefixes), true);
  assert.equal(isWipTitle("  wip: x", POLICY.wipPrefixes), true);
  assert.equal(isWipTitle("[wip] x", POLICY.wipPrefixes), true);
  assert.equal(isWipTitle("draft: x", POLICY.wipPrefixes), true);
  assert.equal(isWipTitle("Add wip: handling", POLICY.wipPrefixes), false); // prefix must lead
  assert.equal(isWipTitle("WIP", POLICY.wipPrefixes), false); // prefix, not substring
  assert.equal(isWipTitle("anything", []), false);
  assert.equal(isWipTitle("anything", ["  "]), false); // blank prefixes never match
});

test("gitea policy: comment markers", () => {
  assert.equal(PIR_REVIEW_MARKER, "<!-- pir:review v1 -->");
  assert.equal(PIR_STATUS_MARKER("beiyan", "pir-demo", 42), "<!-- pir:status beiyan/pir-demo#42 v1 -->");
  assert.notEqual(PIR_STATUS_MARKER("beiyan", "pir-demo", 42), PIR_STATUS_MARKER("beiyan", "pir-demo", 43));
});
