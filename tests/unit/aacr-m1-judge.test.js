import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { findMetricsFile, resolveJudgeTimeoutMs, DEFAULT_JUDGE_TIMEOUT_MS } from "../../tests/eval/aacr/m1/judge.js";
import { parseOptions as parseDriverOptions } from "../../tests/eval/aacr/m1/run-aacr.js";

/** A missing N-round average must never be published as the N-round result. */
test("findMetricsFile: eval-rounds 1 takes the newest file; >1 requires the average file", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "pir-m1-metrics-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(dir, { recursive: true });
  const round1 = path.join(dir, "metrics_ocr_20260101_000000_round_1.json");
  const round2 = path.join(dir, "metrics_ocr_20260101_000000_round_2.json");
  writeFileSync(round1, "{}");
  writeFileSync(round2, "{}");
  utimesSync(round1, new Date(2026, 0, 1), new Date(2026, 0, 1));
  utimesSync(round2, new Date(2026, 0, 2), new Date(2026, 0, 2));
  assert.equal(findMetricsFile(dir, "ocr", 1), round2, "single-round mode takes the newest metrics file");
  assert.equal(findMetricsFile(dir, "ocr", 3), null, "a 3-round run without an average file is a failure, not round 2");
  const average = path.join(dir, "metrics_ocr_average.json");
  writeFileSync(average, "{}");
  assert.equal(findMetricsFile(dir, "ocr", 3), average);
  assert.equal(findMetricsFile(dir, "missing-reviewer", 1), null);
});

test("judge timeout: default 30 minutes, explicit positive override, invalid values fall back", () => {
  assert.equal(resolveJudgeTimeoutMs({}), DEFAULT_JUDGE_TIMEOUT_MS);
  assert.equal(resolveJudgeTimeoutMs({ PIR_AACR_JUDGE_TIMEOUT_MS: "" }), DEFAULT_JUDGE_TIMEOUT_MS);
  assert.equal(resolveJudgeTimeoutMs({ PIR_AACR_JUDGE_TIMEOUT_MS: "10800000" }), 10_800_000);
  for (const bad of ["0", "-1", "abc", "1.5"]) {
    assert.equal(resolveJudgeTimeoutMs({ PIR_AACR_JUDGE_TIMEOUT_MS: bad }), DEFAULT_JUDGE_TIMEOUT_MS, bad);
  }
});

test("--judge-only judges an existing round: needs --resume, a judge mode, and no fresh selection", () => {
  const ok = parseDriverOptions(["--round", "r", "--resume", "--judge-only", "--judge", "real"]);
  assert.equal(ok.judgeOnly, true);
  assert.throws(() => parseDriverOptions(["--round", "r", "--judge-only", "--judge", "real"]), /pass --resume/);
  assert.throws(() => parseDriverOptions(["--round", "r", "--resume", "--judge-only", "--judge", "off"]), /needs --judge real or mock/);
  assert.throws(() => parseDriverOptions(["--round", "r", "--resume", "--judge-only", "--judge", "real", "--limit", "5"]), /--limit\/--only are not allowed/);
  assert.throws(() => parseDriverOptions(["--round", "r", "--resume", "--judge-only", "--judge", "real", "--only", "a"]), /--limit\/--only are not allowed/);
});
