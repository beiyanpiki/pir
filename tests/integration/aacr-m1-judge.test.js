import { test } from "node:test";
import assert from "assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { git } from "../fixtures/helpers.js";
import { buildLocalRepo, makeMeta, positiveSample, temporary } from "../fixtures/aacr-m1-helpers.js";
import {
  assertJudgeEnv, buildJudgeInvocation, copyResultsIntoUpstream, ensureJudgeCheckout, judgeEnv, judgeRunId,
  upstreamRow, writeUpstreamDataset,
} from "../eval/aacr/m1/judge.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

test("judge: pure invocation builder, env control, dataset and result copying", async () => {
  await temporary(async (dir) => {
    const judgeDir = path.join(dir, "judge-clone");
    const env = { JUDGE_BASE_URL: "https://judge.example/v1", JUDGE_API_KEY: "secret", JUDGE_MODEL: "judge-model" };
    const mock = buildJudgeInvocation({ judgeDir, runId: "m1-smoke-reported", judgeMode: "mock", env, python: "python3" });
    assert.equal(mock.command, "python3");
    assert.deepEqual(mock.args, ["-m", "pipeline", "run", "--stage", "eval", "--reviewer", "ocr", "--dataset", "data/aacr_bench.jsonl", "--run-id", "m1-smoke-reported"]);
    assert.equal(mock.cwd, path.join(judgeDir, "evaluation"));
    assert.equal(mock.env.JUDGE_USE_MOCK, "true");
    assert.equal(buildJudgeInvocation({ judgeDir, runId: "r", judgeMode: "mock", env, python: "python3", evalRounds: 3 }).args.at(-1), "3");

    const real = buildJudgeInvocation({ judgeDir, runId: "r", judgeMode: "real", env, python: "python3" });
    assert.equal(real.env.JUDGE_USE_MOCK, "false");
    assert.equal(real.env.JUDGE_API_KEY, "secret");
    assert.throws(() => buildJudgeInvocation({ judgeDir, runId: "r", judgeMode: "real", env: {}, python: "python3" }), /JUDGE_BASE_URL/);
    assert.throws(() => buildJudgeInvocation({ judgeDir, runId: "r", judgeMode: "mock", reviewer: "pir", python: "python3" }), /only accepts/);
    assert.throws(() => buildJudgeInvocation({ judgeDir, judgeMode: "mock", python: "python3" }), /runId/);

    assert.deepEqual(judgeEnv({ judgeMode: "mock", env: {} }), { JUDGE_USE_MOCK: "true" });
    assert.deepEqual(judgeEnv({ judgeMode: "off", env: {} }), {});
    assert.throws(() => assertJudgeEnv("real", {}), /JUDGE_BASE_URL, JUDGE_API_KEY, JUDGE_MODEL/);
    assert.doesNotThrow(() => assertJudgeEnv("mock", {}));

    assert.equal(judgeRunId({ round: "2026-10-19/m1 smoke", view: "reported", repeat: 1 }), "2026-10-19-m1-smoke-reported");
    assert.equal(judgeRunId({ round: "r", view: "confirmedOnly", repeat: 2 }), "r-confirmedOnly-r2");

    const { doc } = makeMeta([positiveSample()]);
    const datasetPath = path.join(judgeDir, "evaluation", "data", "aacr_bench.jsonl");
    const written = writeUpstreamDataset(datasetPath, doc.rows);
    assert.equal(written.rows, 1);
    const lines = readFileSync(datasetPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(lines.length, 1);
    assert.deepEqual(lines[0], upstreamRow(doc.rows[0]));
    assert.deepEqual(Object.keys(lines[0]).sort(), ["base_commit", "clone_url", "head_commit", "instance_id", "reference_comments", "repo"]);

    const sourceDir = path.join(dir, "reported");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(path.join(sourceDir, "a.json"), "{}");
    writeFileSync(path.join(sourceDir, "notes.txt"), "ignore me");
    const destDir = path.join(judgeDir, "evaluation", "results", "aacr_bench", "ocr", "r");
    mkdirSync(destDir, { recursive: true });
    writeFileSync(path.join(destDir, "stale.json"), "{}");
    const copied = copyResultsIntoUpstream({ sourceDir, destDir });
    assert.equal(copied.copied, 1);
    assert.equal(existsSync(path.join(destDir, "a.json")), true);
    assert.equal(existsSync(path.join(destDir, "stale.json")), false, "a re-judge must not leave stale result files");
    assert.equal(existsSync(path.join(destDir, "notes.txt")), false);
  });
});

test("judge: pinned checkout fetches depth 1, refuses drift and worktree copies", async () => {
  await temporary(async (dir) => {
    const { mirrorDir, base, head } = buildLocalRepo(dir);
    const pin = { repo: pathToFileURL(mirrorDir).href, commit: head, license: "Apache-2.0" };
    const judgeDir = path.join(dir, "judge-clone");
    const first = await ensureJudgeCheckout({ judgeDir, pin });
    assert.equal(first.cloned, true);
    assert.equal(git(judgeDir, ["rev-parse", "HEAD"]).trim(), head);
    const second = await ensureJudgeCheckout({ judgeDir, pin });
    assert.equal(second.cloned, false);
    await assert.rejects(ensureJudgeCheckout({ judgeDir, pin: { ...pin, commit: base } }), /expected pinned/);
    await assert.rejects(
      ensureJudgeCheckout({ judgeDir: path.join(HERE, "..", "..", "inside-worktree-judge"), pin }),
      /outside the worktree/,
    );
  });
});
