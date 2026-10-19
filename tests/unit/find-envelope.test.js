import { test } from "node:test";
import assert from "node:assert/strict";
import { applyChangeFilter } from "../../dist/changes/filter.js";
import { changedFileSummary } from "../../dist/changes/change-set.js";
import { envelope } from "../../dist/app/output.js";

/**
 * B1 acceptance A2: the change-mode filter's envelope change is purely
 * additive — a consumer written before B1 sees byte-identical fields, and the
 * new record is the same projection the run manifest writes.
 */

const HUNK = { newStart: 1, newLineCount: 1, oldStart: 1, oldLineCount: 1, header: "@@ -1,1 +1,1 @@", lines: ["+const a = 1;"] };

test("B1 envelope: files[] gains excluded/excludedReason without touching pre-B1 fields", () => {
  const changeSet = {
    repoRoot: "/repo", base: "base", head: "head", mergeBase: "merge", patch: "", churn: 4,
    files: [
      { path: "src/app.ts", status: "modified", additions: 3, deletions: 1, language: "ts", hunks: [HUNK] },
      { path: ".env", status: "added", additions: 1, deletions: 0, language: "", hunks: [HUNK] },
    ],
  };
  const filtered = applyChangeFilter(changeSet);
  const parsed = JSON.parse(envelope("find", { run: { id: "run-1", files: filtered.files.map(changedFileSummary) } }));
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.command, "find");
  const [app, env] = parsed.data.run.files;
  // A pre-B1 consumer reads exactly the same four keys with the same values.
  assert.deepEqual(
    { path: app.path, status: app.status, additions: app.additions, deletions: app.deletions },
    { path: "src/app.ts", status: "modified", additions: 3, deletions: 1 },
  );
  assert.deepEqual(Object.keys(app).sort(), ["additions", "deletions", "excluded", "path", "status"]);
  assert.equal(app.excluded, false);
  assert.equal("excludedReason" in app, false, "selected files stay free of the reason key");
  // The additive pair, with path/status/churn still present for the excluded file.
  assert.equal(env.path, ".env");
  assert.equal(env.status, "added");
  assert.equal(env.additions, 1);
  assert.equal(env.deletions, 0);
  assert.equal(env.excluded, true);
  assert.equal(env.excludedReason, "secret path (dotenv file); never sent to a model");
});

test("changedFileSummary is the one projection behind the envelope and the manifest", () => {
  const file = { path: "src/app.ts", status: "modified", additions: 2, deletions: 5, hunks: [HUNK], language: "ts" };
  assert.deepEqual(changedFileSummary(file), {
    path: "src/app.ts", status: "modified", additions: 2, deletions: 5, excluded: false,
  });
  assert.deepEqual(changedFileSummary({ ...file, excluded: true, excludedReason: "default policy: lockfile" }), {
    path: "src/app.ts", status: "modified", additions: 2, deletions: 5, excluded: true, excludedReason: "default policy: lockfile",
  });
});
