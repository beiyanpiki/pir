import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChangeSet } from "../../dist/changes/change-set.js";
import { createTempGitRepo } from "../fixtures/helpers.js";

test("buildChangeSet captures status, hunks and churn across commits", async () => {
  const repo = createTempGitRepo();
  try {
    repo.write("src/pay.ts", ["export function charge(a: number) {", "  return a;", "}", ""].join("\n"));
    repo.write("src/keep.ts", "export const k = 1;\n");
    repo.commit("init");

    repo.write("src/pay.ts", ["export function charge(a: number, fee: number) {", "  return a + fee;", "}", ""].join("\n"));
    repo.write("src/new.ts", "export const n = 2;\n");
    repo.commit("second");

    const changeSet = await buildChangeSet(repo.dir, "HEAD^", "HEAD");
    assert.equal(changeSet.files.length, 2);

    const pay = changeSet.files.find((f) => f.path === "src/pay.ts");
    assert.equal(pay.status, "modified");
    assert.equal(pay.additions, 2);
    assert.equal(pay.deletions, 2);
    assert.equal(pay.hunks.length, 1);

    const added = changeSet.files.find((f) => f.path === "src/new.ts");
    assert.equal(added.status, "added");
    assert.equal(added.language, "ts");

    assert.equal(changeSet.churn, 5);
    assert.ok(changeSet.mergeBase.length > 0);
  } finally {
    repo.cleanup();
  }
});

test("pure rename with no content change still appears in the changeset", async () => {
  const repo = createTempGitRepo();
  try {
    repo.write("src/a.ts", "export const value = 1;\n");
    repo.commit("init");
    const { renameSync } = await import("node:fs");
    const path = await import("node:path");
    renameSync(path.join(repo.dir, "src/a.ts"), path.join(repo.dir, "src/b.ts"));
    repo.commit("rename");

    const changeSet = await buildChangeSet(repo.dir, "HEAD^", "HEAD");
    assert.equal(changeSet.files.length, 1);
    const renamed = changeSet.files[0];
    assert.equal(renamed.path, "src/b.ts");
    assert.equal(renamed.oldPath, "src/a.ts");
    assert.equal(renamed.status, "renamed");
  } finally {
    repo.cleanup();
  }
});
