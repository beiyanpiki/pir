import { test } from "node:test";
import assert from "assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createTempGitRepo } from "../fixtures/helpers.js";
import {
  buildChangeSet, candidateDigest, commentToCandidate, decisionForVerdict, firstSentence, mapCommentCategory, parseTask, selectDiffExcerpt,
} from "../../dist/app/verify-comment.js";
import {
  buildOcrReflectionPrompt, extractFirstJsonObject, OCR_REFLECTION_ATTRIBUTION, OCR_REFLECTION_SYSTEM_PROMPT,
  parseOcrDecision, renderOcrComments, renderOcrReviewFiles,
} from "../../dist/agents/ocr-reflection-prompt.js";

const DIFF = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,3 +1,4 @@",
  " const a = 1;",
  "+const b = 2;",
  " const c = 3;",
  "@@ -20,2 +21,2 @@",
  "-const d = 4;",
  "+const d = 5;",
  "",
].join("\n");

const task = (over = {}, materialOver = {}) => ({
  id: "c0001-deadbeef", index: 1,
  comment: {
    pr_url: "https://github.com/owner/repo/pull/7", path: "src/app.ts", side: "right",
    from_line: 2, to_line: 2, note: "The new constant is unused. It should be removed.",
    category: "Maintainability and Readability", context: "Diff Level", is_ai_comment: true, source_model: "GPT-5.2", label: 1, ...over,
  },
  material: { head: "b".repeat(40), diffBase: "a".repeat(40), diffBaseKind: "merge-base", pathInDiff: true, diff: DIFF, ...materialOver },
});

test("parseTask validates every field the mapping depends on", () => {
  const parsed = parseTask(task());
  assert.equal(parsed.id, "c0001-deadbeef");
  assert.equal(parsed.material.diffBaseKind, "merge-base");
  assert.throws(() => parseTask(null), /payload must be an object/);
  assert.throws(() => parseTask({ ...task(), id: "" }), /id is required/);
  assert.throws(() => parseTask({ ...task(), comment: undefined }), /comment is required/);
  assert.throws(() => parseTask({ ...task(), comment: { ...task().comment, path: "" } }), /comment\.path is required/);
  assert.throws(() => parseTask({ ...task(), comment: { ...task().comment, from_line: 0 } }), /from_line must be a positive integer/);
  assert.throws(() => parseTask({ ...task(), comment: { ...task().comment, to_line: 1 } }), /to_line must be an integer/);
  assert.throws(() => parseTask({ ...task(), comment: { ...task().comment, note: "  " } }), /comment\.note is required/);
  // F-187: anchors are head-file lines; only the right side is representable.
  assert.throws(() => parseTask({ ...task(), comment: { ...task().comment, side: "left" } }), /comment\.side must be "right"/);
  assert.throws(() => parseTask({ ...task(), comment: { ...task().comment, side: undefined } }), /comment\.side must be "right"/);
  assert.throws(() => parseTask({ ...task(), material: { ...task().material, head: "nope" } }), /material\.head must be a 40-char hex sha/);
  assert.throws(() => parseTask({ ...task(), material: { ...task().material, diff: null } }), /material\.diff must be a string/);
  assert.equal(parseTask({ ...task(), material: { ...task().material, diffBaseKind: undefined } }).material.diffBaseKind, "unknown");
});

test("verifier-benchmark dogfood F-188: a session without a verdict is invalid, not a keep", () => {
  assert.equal(decisionForVerdict({ verdict: "rejected", confidence: 0.8 }), "kill");
  assert.equal(decisionForVerdict({ verdict: "confirmed", confidence: 0.8 }), "keep");
  // An abstention is a decision under uncertain=keep; only a session that
  // never produced a verdict is invalid.
  assert.equal(decisionForVerdict({ verdict: "uncertain", confidence: 0, uncertaintyReason: "missing-evidence" }), "keep");
  assert.equal(decisionForVerdict({ verdict: "uncertain", confidence: 0, uncertaintyReason: "tool-limit" }), "keep");
  assert.equal(decisionForVerdict({ verdict: "uncertain", confidence: 0, uncertaintyReason: "provider-error" }), "invalid");
  assert.equal(decisionForVerdict({ verdict: "uncertain", confidence: 0, uncertaintyReason: "missing-verdict" }), "invalid");
});

test("firstSentence takes the first sentence and caps very long notes", () => {
  assert.equal(firstSentence("This check is missing. It also does nothing."), "This check is missing.");
  assert.equal(firstSentence("  Whitespace\n\nis   collapsed?  yes  "), "Whitespace is collapsed?");
  assert.equal(firstSentence("No terminator here"), "No terminator here");
  const capped = firstSentence("A".repeat(500));
  assert.equal(capped.length, 200);
  assert.equal(capped.endsWith("…"), true);
});

test("mapCommentCategory is the documented total mapping", () => {
  assert.equal(mapCommentCategory("Code Defect"), "correctness");
  assert.equal(mapCommentCategory("Maintainability and Readability"), "maintainability");
  assert.equal(mapCommentCategory("Performance"), "performance");
  assert.equal(mapCommentCategory("Security Vulnerability"), "security");
  assert.equal(mapCommentCategory("Something Else"), "other");
  assert.equal(mapCommentCategory(undefined), "other");
});

test("selectDiffExcerpt keeps the hunk covering the anchor, else every hunk, capped", () => {
  const firstHunk = selectDiffExcerpt(DIFF, { path: "src/app.ts", startLine: 2, endLine: 2 });
  assert.match(firstHunk, /\+const b = 2;/);
  assert.equal(firstHunk.includes("+const d = 5;"), false);
  const secondHunk = selectDiffExcerpt(DIFF, { path: "src/app.ts", startLine: 21, endLine: 21 });
  assert.match(secondHunk, /\+const d = 5;/);
  assert.equal(secondHunk.includes("const a = 1;"), false);
  const noOverlap = selectDiffExcerpt(DIFF, { path: "src/app.ts", startLine: 900, endLine: 901 });
  assert.match(noOverlap, /const a = 1;/);
  assert.match(noOverlap, /const d = 5;/);
  assert.equal(selectDiffExcerpt(DIFF, { path: "src/other.ts", startLine: 1, endLine: 2 }), DIFF);
  assert.equal(selectDiffExcerpt("", { path: "src/app.ts", startLine: 1, endLine: 1 }), "");
  assert.match(selectDiffExcerpt(DIFF, { path: "src/app.ts", startLine: 2, endLine: 2 }, 10), /\[excerpt truncated\]$/);
});

test("commentToCandidate applies the fixed mapping", () => {
  const candidate = commentToCandidate(parseTask(task()));
  assert.equal(candidate.title, "The new constant is unused.");
  assert.equal(candidate.claim, "The new constant is unused. It should be removed.");
  assert.equal(candidate.trigger, "");
  assert.equal(candidate.category, "maintainability");
  assert.equal(candidate.severity, "P2");
  assert.deepEqual(candidate.anchors, [{ path: "src/app.ts", startLine: 2, endLine: 2 }]);
  assert.equal(candidate.evidence.length, 1);
  assert.equal(candidate.evidence[0].kind, "diff");
  assert.match(candidate.evidence[0].excerpt, /\+const b = 2;/);
  assert.equal(candidate.round, 1);
  assert.match(candidate.identity.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(candidateDigest(parseTask(task())), candidateDigest(parseTask(task())));
  assert.notEqual(candidateDigest(parseTask(task())), candidateDigest(parseTask(task({ note: "other" }))));
});

test("buildChangeSet turns the per-comment diff into a synthetic merge-base..head change set", () => {
  const changeSet = buildChangeSet("/tmp/repo", parseTask(task()));
  assert.equal(changeSet.base, "a".repeat(40));
  assert.equal(changeSet.head, "b".repeat(40));
  assert.equal(changeSet.baseCommit, changeSet.mergeBase);
  assert.equal(changeSet.files.length, 1);
  assert.equal(changeSet.files[0].path, "src/app.ts");
  assert.equal(changeSet.files[0].language, "ts");
  assert.equal(changeSet.files[0].hunks.length, 2);
  assert.equal(changeSet.churn, 3);
  assert.equal(changeSet.patch, DIFF);
  const empty = buildChangeSet("/tmp/repo", parseTask(task({}, { pathInDiff: false, diff: "" })));
  assert.deepEqual(empty.files, []);
  assert.equal(empty.patch, "");
});

test("OCR prompt port keeps upstream wording, attribution and payload shapes", () => {
  assert.equal(OCR_REFLECTION_ATTRIBUTION.project, "alibaba/open-code-review");
  assert.equal(OCR_REFLECTION_ATTRIBUTION.license, "Apache-2.0");
  assert.match(OCR_REFLECTION_SYSTEM_PROMPT, /You are a fact-checker for code review comments\./);
  assert.match(OCR_REFLECTION_SYSTEM_PROMPT, /Removing a correct comment silently destroys a real finding/);
  const prompt = buildOcrReflectionPrompt({
    diff: DIFF,
    comment: { id: "c-0", path: "src/app.ts", content: "The new constant is unused." },
  });
  assert.match(prompt.system, /fact-checker/);
  assert.match(prompt.user, /### Code Diff/);
  assert.match(prompt.user, /<file path="src\/app\.ts">/);
  assert.match(prompt.user, /\+const b = 2;/);
  assert.deepEqual(JSON.parse(prompt.user.slice(prompt.user.indexOf("[{"), prompt.user.indexOf("}]") + 2)),
    [{ id: "c-0", path: "src/app.ts", content: "The new constant is unused." }]);
  assert.match(prompt.user, /### Output/);
  assert.match(prompt.user, /report_incorrect_comments/);
  assert.match(prompt.user, /Ground A/);
  assert.match(prompt.user, /Protected subjects/);
  assert.equal(prompt.user.includes("{{diff}}"), false);
  assert.equal(prompt.user.includes("{{comments}}"), false);
  assert.deepEqual(JSON.parse(renderOcrComments([{ id: "c-0", path: "a.ts", content: "x" }])), [{ id: "c-0", path: "a.ts", content: "x" }]);
  assert.equal(renderOcrReviewFiles([{ path: "a.ts", diff: "D" }]), '<file path="a.ts">\nD\n</file>');
});

test("parseOcrDecision accepts JSON, one-word replies, and refuses to guess", () => {
  assert.equal(parseOcrDecision('{"decision":"remove","reason":"line 12 contradicts it"}').decision, "remove");
  assert.equal(parseOcrDecision('{"decision":"approve"}').decision, "approve");
  assert.equal(parseOcrDecision("Approve.").decision, "approve");
  assert.equal(parseOcrDecision("remove").decision, "remove");
  assert.equal(parseOcrDecision("I would remove it because Ground B applies.").decision, "remove");
  assert.equal(parseOcrDecision("I cannot decide").decision, "parse-error");
  assert.equal(parseOcrDecision("").decision, "parse-error");
  assert.equal(parseOcrDecision(undefined).decision, "parse-error");
  assert.equal(parseOcrDecision("approve one and remove another").decision, "parse-error");
  assert.deepEqual(extractFirstJsonObject('prefix {"a":{"b":1}} suffix'), { a: { b: 1 } });
  assert.equal(extractFirstJsonObject("no json here"), null);
  assert.equal(extractFirstJsonObject('{"broken":'), null);
  assert.deepEqual(extractFirstJsonObject('{"decision":"approve","reason":"} not the end"}'), { decision: "approve", reason: "} not the end" });
});

test("the internal command is invisible in help and refuses to run without PIR_EVAL=1", () => {
  const help = spawnSync(process.execPath, ["dist/cli/cli.js", "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.equal(help.stdout.includes("_verify-comment"), false);
  const contextual = spawnSync(process.execPath, ["dist/cli/cli.js", "find", "--help"], { encoding: "utf8" });
  assert.equal(contextual.stdout.includes("_verify-comment"), false);
  const repo = createTempGitRepo("pir-aacr-cli-");
  const home = mkdtempSync(path.join(tmpdir(), "pir-aacr-home-"));
  try {
    repo.write("a.txt", "hello\n");
    repo.commit("init");
    const result = spawnSync(process.execPath, [path.resolve("dist/cli/cli.js"), "_verify-comment", "--task-file", "x.json", "--json", "--local", "--cwd", repo.dir], {
      encoding: "utf8", cwd: repo.dir,
      env: { ...process.env, HOME: home, XDG_STATE_HOME: path.join(home, "state"), XDG_CACHE_HOME: path.join(home, "cache"),
        XDG_CONFIG_HOME: path.join(home, "cfg"), PIR_CONFIG_DIR: path.join(home, "pir"), PI_CODING_AGENT_DIR: path.join(home, "agent"),
        PIR_NO_WIZARD: "1", PIR_MODE: "local", PIR_MEMORY_DB: path.join(home, "state/memory.sqlite"), PIR_EVAL: "0" },
    });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /set PIR_EVAL=1/);
  } finally {
    repo.cleanup();
    rmSync(home, { recursive: true, force: true });
  }
});
