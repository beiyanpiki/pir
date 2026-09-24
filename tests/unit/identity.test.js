import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { normalizeRemoteUrl } from "../../dist/changes/git.js";
import { buildIdentity, normalizeClaimText, claimSimilarity } from "../../dist/findings/identity.js";
import { computeProjectIdentity, memoryDbPath, projectStateDir } from "../../dist/memory/identity.js";
import { createTempGitRepo } from "../fixtures/helpers.js";

test("normalizeRemoteUrl collapses ssh/https/git suffixes to one form", () => {
  const a = normalizeRemoteUrl("git@github.com:company/payment.git");
  const b = normalizeRemoteUrl("https://github.com/company/payment");
  const c = normalizeRemoteUrl("ssh://git@gitlab.com/a/b.git");
  assert.equal(a, "github.com/company/payment");
  assert.equal(a, b);
  assert.equal(c, "gitlab.com/a/b");
});

test("computeProjectIdentity is stable across clones with same remote+root", async () => {
  const repo = createTempGitRepo();
  try {
    repo.write("a.txt", "hello");
    repo.commit("init");
    const first = await computeProjectIdentity(repo.dir);
    const second = await computeProjectIdentity(repo.dir);
    assert.equal(first.projectId, second.projectId);
    assert.equal(first.rootCommit.length, 40);
    assert.match(first.projectId, /^[0-9a-f]{64}$/);
  } finally {
    repo.cleanup();
  }
});

test("projectId differs when remotes differ", async () => {
  const repoA = createTempGitRepo("pir-a-");
  const repoB = createTempGitRepo("pir-b-");
  try {
    repoA.write("a.txt", "hello");
    repoA.commit("init");
    repoB.write("a.txt", "hello");
    repoB.commit("init");
    execFileSync("git", ["-C", repoA.dir, "remote", "add", "origin", "git@github.com:x/a.git"]);
    execFileSync("git", ["-C", repoB.dir, "remote", "add", "origin", "git@github.com:x/b.git"]);
    const a = await computeProjectIdentity(repoA.dir);
    const b = await computeProjectIdentity(repoB.dir);
    assert.notEqual(a.projectId, b.projectId);
  } finally {
    repoA.cleanup();
    repoB.cleanup();
  }
});

test("buildIdentity is stable under punctuation/case rewording, differs per entity", () => {
  const base = buildIdentity({
    featureKey: "payment-retry",
    entityKey: "PaymentService.retry",
    category: "correctness",
    claim: "Retry quota is consumed WITHOUT a remote attempt!",
    trigger: "gateway throws before charge",
  });
  const reworded = buildIdentity({
    featureKey: "payment-retry",
    entityKey: "PaymentService.retry",
    category: "Correctness",
    claim: "retry quota is consumed without a remote attempt",
    trigger: "gateway throws before charge",
  });
  const otherEntity = buildIdentity({
    featureKey: "payment-retry",
    entityKey: "RetryCoordinator.execute",
    category: "correctness",
    claim: "Retry quota is consumed WITHOUT a remote attempt!",
    trigger: "gateway throws before charge",
  });
  assert.equal(base.fingerprint, reworded.fingerprint);
  assert.notEqual(base.fingerprint, otherEntity.fingerprint);
  assert.equal(normalizeClaimText("retry_count  counts attempts"), "retry count counts attempts");
});

test("claimSimilarity detects near duplicates", () => {
  const a = "retry quota is consumed without an actual remote gateway attempt";
  const b = "retry quota consumed without actual remote gateway attempt";
  const c = "ledger entries are append only";
  assert.ok(claimSimilarity(a, b) >= 0.75);
  assert.ok(claimSimilarity(a, c) < 0.3);
});

test("state dir follows XDG layout and does not live inside the repo", () => {
  const dir = projectStateDir("deadbeef", "/home/tester");
  assert.ok(dir.endsWith(`${path.sep}pir${path.sep}deadbeef`) || dir.endsWith(`/pir/deadbeef`));
  assert.ok(!dir.includes("review-agents"));
  assert.ok(memoryDbPath("deadbeef", "/home/tester").endsWith("memory.sqlite"));
});
