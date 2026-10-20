import { test } from "node:test";
import assert from "assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { git } from "../fixtures/helpers.js";
import { buildLocalRepo, comment, makeMeta, positiveSample, temporary, writeFakeCli } from "../fixtures/aacr-m1-helpers.js";
import {
  FIXTURE_META, convertRecord, fixtureDigest, instanceIdFor, loadFixture, loadFixturePin,
  parseRepoFromPrUrl, sha256, validateFixtureRows,
} from "../eval/aacr/fixtures/build-fixture.js";
import {
  listResultFiles, main as runMain, parseOptions as runOptions, resultFileFor, rowFileFor,
} from "../eval/aacr/m1/run-aacr.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AACR = path.join(HERE, "..", "eval", "aacr");
const BUILD_FIXTURE = path.join(AACR, "fixtures", "build-fixture.js");
const RUN_AACR = path.join(AACR, "m1", "run-aacr.js");

test("fixture builder: mapping, aligned comment_meta, dots preserved, digest", () => {
  return temporary((dir) => {
    const records = [
      positiveSample({
        comments: [
          comment(),
          comment({ path: "src/old.ts", side: "left", from_line: 1, to_line: 1, note: "Deleted-side note." }),
          comment({ note: "   " }), // skipped by the upstream converter rule
        ],
      }),
      positiveSample({
        githubPrUrl: "https://github.com/owner/repo.js/pull/2",
        target_commit: "c".repeat(40),
        source_commit: "d".repeat(40),
        project_main_language: "JavaScript",
        comments: [comment({ path: "index.js", from_line: 5, to_line: 9 })],
      }),
    ];
    const { doc } = makeMeta(records);
    assert.equal(doc.__meta__, FIXTURE_META);
    assert.equal(doc.rows.length, 2);
    assert.equal(doc.dataset.sha256, sha256(Buffer.from(JSON.stringify(records))));
    assert.equal(doc.dataset.records, 2);
    assert.equal(doc.dataset.comments, 4);
    assert.deepEqual(doc.dataset.commentSides, { right: 2, left: 1 });
    assert.equal(doc.citation.arxiv, "2601.19494");

    const first = doc.rows[0];
    assert.equal(first.instance_id, "example__repo@" + "b".repeat(7));
    assert.equal(first.instance_id, instanceIdFor("example/repo", "b".repeat(40)));
    assert.equal(first.repo, "example/repo");
    assert.equal(first.base_commit, "a".repeat(40));
    assert.equal(first.head_commit, "b".repeat(40));
    assert.equal(first.clone_url, "https://github.com/example/repo.git");
    assert.equal(first.change_line_count, 12);
    assert.equal(first.project_main_language, "TypeScript");
    assert.equal(first.pr_category, "Bug Fix");
    assert.equal(first.reference_comments.length, 2);
    assert.deepEqual(first.reference_comments[0], {
      path: "src/app.ts", text: "The counter can race.", start_line: 2, end_line: 2, side: "right",
    });
    assert.deepEqual(first.reference_comments[1], {
      path: "src/old.ts", text: "Deleted-side note.", start_line: 1, end_line: 1, side: "left",
    });
    assert.deepEqual(first.comment_meta[0], {
      category: "Code Defect", context: "Diff Level", is_ai_comment: true, source_model: "Gemini-3-Pro",
    });
    assert.equal(first.comment_meta.length, first.reference_comments.length);
    assert.equal(first.skipped_comments, 1);

    const second = doc.rows[1];
    assert.equal(second.instance_id, "owner__repo.js@" + "c".repeat(7), "dots are preserved");
    assert.equal(second.clone_url, "https://github.com/owner/repo.js.git");
    assert.equal(second.project_main_language, "JavaScript");
    assert.equal(second.reference_comments[0].start_line, 5);
    assert.equal(second.reference_comments[0].end_line, 9);

    assert.match(fixtureDigest(doc.rows), /^[0-9a-f]{64}$/);
    assert.equal(fixtureDigest(doc.rows), fixtureDigest([...doc.rows]));
  });
});

test("fixture builder: fails closed on malformed records and duplicate ids", () => {
  assert.throws(() => parseRepoFromPrUrl("https://gitlab.com/a/b/pull/1"), /unrecognized githubPrUrl/);
  assert.throws(() => convertRecord(positiveSample({ githubPrUrl: "https://github.com/a/b/pulls/1" })), /unrecognized/);
  assert.throws(() => convertRecord(positiveSample({ comments: [comment({ side: "middle" })] })), /side must be "left" or "right"/);
  assert.throws(() => convertRecord(positiveSample({ comments: [] })), /no usable reference comments/);
  assert.throws(() => convertRecord(positiveSample({ source_commit: "nope" })), /source_commit must be a 40-char hex sha/);

  const row = convertRecord(positiveSample());
  assert.throws(() => validateFixtureRows([row, { ...row }]), /duplicate instance_id/);
  assert.throws(() => validateFixtureRows([{ ...row, reference_comments: [] }]), /reference_comments must be non-empty/);
  assert.throws(() => validateFixtureRows([{ ...row, comment_meta: [] }]), /index-aligned/);
  assert.throws(() => validateFixtureRows([{ ...row, instance_id: "wrong@bbbbbbb" }]), /does not follow/);
});

test("fixture builder: CLI converts --from, refuses a tampered pin, gates on PIR_EVAL", async () => {
  await temporary((dir) => {
    const records = [positiveSample()];
    const { bytes, meta } = makeMeta(records);
    const metaPath = path.join(dir, "meta.json");
    const sourcePath = path.join(dir, "positive_samples.json");
    const outPath = path.join(dir, "test-set.json");
    writeFileSync(metaPath, JSON.stringify(meta));
    writeFileSync(sourcePath, bytes);

    const ok = spawnSync(process.execPath, [BUILD_FIXTURE, "--meta", metaPath, "--from", sourcePath, "--out", outPath, "--json"], {
      encoding: "utf8", env: { ...process.env, PIR_EVAL: "1" },
    });
    assert.equal(ok.status, 0, ok.stderr);
    const summary = JSON.parse(ok.stdout);
    assert.equal(summary.rows, 1);
    assert.equal(summary.records, 1);
    assert.equal(summary.sha256, meta.fixtures.sha256);
    assert.equal(summary.sides.right, 1);
    const loaded = loadFixture(outPath);
    assert.equal(loaded.header.__meta__, FIXTURE_META);
    assert.equal(loaded.rows[0].instance_id, "example__repo@" + "b".repeat(7));

    const tamperedPath = path.join(dir, "tampered.json");
    writeFileSync(tamperedPath, bytes.toString("utf8").replace("The counter can race.", "Tampered."));
    const tamperedOut = path.join(dir, "tampered-set.json");
    const tampered = spawnSync(process.execPath, [BUILD_FIXTURE, "--meta", metaPath, "--from", tamperedPath, "--out", tamperedOut], {
      encoding: "utf8", env: { ...process.env, PIR_EVAL: "1" },
    });
    assert.equal(tampered.status, 3);
    assert.match(tampered.stderr, /sha256 mismatch/);
    assert.equal(existsSync(tamperedOut), false, "a pin failure must not write the fixture");

    const gated = spawnSync(process.execPath, [BUILD_FIXTURE, "--meta", metaPath, "--from", sourcePath, "--out", outPath, "--json"], {
      encoding: "utf8", env: { ...process.env, PIR_EVAL: "0" },
    });
    assert.equal(gated.status, 0);
    assert.deepEqual(JSON.parse(gated.stdout), { skipped: true, reason: "PIR_EVAL=1 required" });

    const help = spawnSync(process.execPath, [BUILD_FIXTURE, "--help"], { encoding: "utf8", env: { ...process.env, PIR_EVAL: "0" } });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /fixtures\/build-fixture\.js/);
  });
});

test("the committed meta.json pin matches this checkout's fixture convention", () => {
  const { pin } = loadFixturePin();
  assert.equal(pin.sha256, "02c8561f1c3994a26f427d479b2a3f6e6c8e6858161fbc903b45248fa2cb2097");
  assert.equal(pin.bytes, 1117816);
  assert.equal(pin.records, 196);
  assert.equal(pin.comments, 1506);
  assert.match(pin.instanceId, /owner__name@/);
  assert.match(pin.citation, /2601\.19494/);
});

test("driver options: defaults, flag surface, and numeric/view validation", () => {
  const defaults = runOptions([], {});
  assert.equal(defaults.repeats, 1);
  assert.equal(defaults.concurrency, 1);
  assert.equal(defaults.maxRounds, 2);
  assert.equal(defaults.timeoutMs, 1800000);
  assert.equal(defaults.view, "both");
  assert.deepEqual(defaults.views, ["reported", "confirmedOnly"]);
  assert.equal(defaults.judge, "off");
  assert.equal(defaults.evalRounds, 1);
  assert.deepEqual(defaults.only, []);
  assert.equal(defaults.resume, false);
  assert.ok(defaults.fixture.endsWith(path.join("fixtures", "test-set.json")));

  const options = runOptions([
    "--limit", "5", "--repeats", "2", "--only", "a@1111111", "--only", "b@2222222,c@3333333",
    "--view", "reported", "--judge", "mock", "--max-rounds", "3", "--timeout", "5000",
    "--eval-rounds", "3", "--model", "prov/model", "--round", "smoke",
  ], {});
  assert.equal(options.limit, 5);
  assert.equal(options.repeats, 2);
  assert.deepEqual(options.only, ["a@1111111", "b@2222222", "c@3333333"]);
  assert.deepEqual(options.views, ["reported"]);
  assert.equal(options.judge, "mock");
  assert.equal(options.maxRounds, 3);
  assert.equal(options.timeoutMs, 5000);
  assert.equal(options.evalRounds, 3);
  assert.equal(options.model, "prov/model");
  assert.equal(options.round, "smoke");

  assert.throws(() => runOptions(["--view", "everything"], {}), /unknown view/);
  assert.throws(() => runOptions(["--judge", "maybe"], {}), /unknown --judge mode/);
  assert.throws(() => runOptions(["--limit", "0"], {}), /limit must be a positive integer/);
  assert.throws(() => runOptions(["--repeats", "0"], {}), /repeats must be a positive integer/);
  assert.throws(() => runOptions(["--concurrency", "nope"], {}), /concurrency must be a positive integer/);
  assert.throws(() => runOptions(["--eval-rounds", "0"], {}), /evalRounds must be a positive integer/);
  assert.throws(() => runOptions(["--only"], {}), /missing value/);
});

test("PIR_EVAL gate and --help are model-free for the driver", () => {
  const gated = spawnSync(process.execPath, [RUN_AACR, "--round", "gate-check", "--json"], {
    encoding: "utf8", env: { ...process.env, PIR_EVAL: "0" },
  });
  assert.equal(gated.status, 0, gated.stderr);
  assert.deepEqual(JSON.parse(gated.stdout), { skipped: true, reason: "PIR_EVAL=1 required" });
  assert.equal(gated.stdout.includes("gate-check"), false);
  const help = spawnSync(process.execPath, [RUN_AACR, "--help"], { encoding: "utf8", env: { ...process.env, PIR_EVAL: "0" } });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--judge off\|mock\|real/);
  assert.match(help.stdout, /--limit 20/);
});

test("driver: result/row writing, synthetic shallow head, and resume provenance", async () => {
  await temporary(async (dir) => {
    const { mirrorDir, base, head } = buildLocalRepo(dir);
    const records = [positiveSample({ source_commit: base, target_commit: head })];
    const { doc } = makeMeta(records);
    // The fixture's clone_url is what the driver feeds the shared cache; point
    // it at the local bare mirror (the real fixture uses github.com URLs).
    doc.rows[0].clone_url = pathToFileURL(mirrorDir).href;
    const fixturePath = path.join(dir, "test-set.json");
    const fixtureBytes = Buffer.from(`${JSON.stringify(doc, null, 2)}\n`);
    writeFileSync(fixturePath, fixtureBytes);

    const fakeCli = writeFakeCli(dir);
    const outRoot = path.join(dir, "out");
    const logFile = path.join(dir, "fake-cli.log");
    const home = path.join(dir, "home");
    const env = {
      ...process.env,
      PIR_EVAL: "1",
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      XDG_CACHE_HOME: path.join(home, ".cache"),
      XDG_STATE_HOME: path.join(home, ".state"),
      PIR_CONFIG_DIR: path.join(dir, "pir-config"),
      PI_CODING_AGENT_DIR: path.join(dir, "agent"),
      PIR_AACR_CACHE: path.join(dir, "cache"),
      FAKE_CLI_LOG: logFile,
    };
    const deps = { resolveMergeBase: async () => ({ sha: null, error: "offline test" }) };
    const args = [
      "--fixture", fixturePath, "--out-root", outRoot, "--round", "smoke", "--cli", fakeCli,
      "--model", "test/model", "--timeout", "20000", "--concurrency", "2", "--view", "both",
      "--limit", "1", "--seed", "42", "--json",
    ];

    const code = await runMain(args, env, deps);
    assert.equal(code, 0);

    const roundDir = path.join(outRoot, "smoke");
    const summary = JSON.parse(readFileSync(path.join(roundDir, "summary.json"), "utf8"));
    assert.equal(summary.model, "test/model");
    assert.equal(summary.cli.sha256, sha256(readFileSync(fakeCli)));
    assert.equal(summary.fixture.sha256, sha256(fixtureBytes));
    assert.equal(summary.fixture.upstream.sha256, doc.dataset.sha256);
    assert.match(summary.fixture.instanceSetDigest, /^[0-9a-f]{64}$/);
    assert.equal(summary.limits.seed, 42);
    assert.equal(summary.limits.limit, 1);
    assert.equal(summary.fixture.instanceSetDigest, fixtureDigest([doc.rows[0]]), "the digest pins the seeded selection");
    assert.deepEqual(summary.views, ["reported", "confirmedOnly"]);
    assert.equal(summary.repeats, 1);
    assert.equal(summary.instances.length, 1);
    assert.deepEqual(summary.errors, []);
    assert.deepEqual(summary.repoCounts["example/repo"], { total: 1, ok: 1, error: 0, reused: 0 });

    const instance = summary.instances[0];
    assert.equal(instance.status, "ok");
    assert.equal(instance.instanceId, "example__repo@" + head.slice(0, 7));
    assert.equal(instance.safeId, instance.instanceId);
    assert.equal(instance.baseCommit, base);
    assert.equal(instance.headCommit, head);
    assert.equal(instance.diffBase, base, "offline merge-base resolution degrades to the base tip");
    assert.equal(instance.diffBaseKind, "base-tip");
    assert.match(instance.syntheticHead, /^[0-9a-f]{40}$/);
    assert.equal(instance.reviewHead, instance.syntheticHead);
    assert.notEqual(instance.syntheticHead, head);
    assert.deepEqual(instance.views, { reported: 2, confirmedOnly: 1 });
    assert.deepEqual(instance.dropped, { anchorless: 1, total: 3 });
    assert.equal(instance.usage.total_tokens, 120);
    assert.equal(instance.durationSeconds, 1.5);
    assert.equal(instance.exitCode, 0);

    // The fake CLI saw the exact review range and benchmark flags.
    const invocations = readFileSync(logFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(invocations.length, 1);
    const argv = invocations[0].args;
    const value = (flag) => argv[argv.indexOf(flag) + 1];
    assert.equal(value("--base"), base);
    assert.equal(value("--head"), instance.syntheticHead);
    assert.equal(value("--max-rounds"), "2");
    assert.equal(value("--max-tokens"), "unlimited");
    assert.equal(value("--max-findings"), "unlimited");
    assert.equal(value("--plugins"), "none");
    assert.equal(value("--model"), "test/model");
    assert.ok(value("--cwd").endsWith(path.join(instance.safeId, "r1")));
    assert.equal(invocations[0].cwdHead, head, "the checkout is the real head tree");

    // Synthetic commit: same tree as head, parented on the merge base.
    const repoDir = path.join(dir, "cache", "repos", "example_repo");
    assert.equal(git(repoDir, ["rev-parse", `${instance.syntheticHead}^{commit}`]).trim(), instance.syntheticHead);
    assert.equal(git(repoDir, ["rev-parse", `${instance.syntheticHead}^{tree}`]).trim(), git(repoDir, ["rev-parse", `${head}^{tree}`]).trim());
    assert.equal(git(repoDir, ["rev-parse", `${instance.syntheticHead}^`]).trim(), base);

    // Upstream-shaped result files, both views.
    const reportedFile = resultFileFor(roundDir, "reported", instance.safeId);
    const confirmedFile = resultFileFor(roundDir, "confirmedOnly", instance.safeId);
    assert.deepEqual(listResultFiles(roundDir, "reported"), [`${instance.safeId}.json`]);
    const reported = JSON.parse(readFileSync(reportedFile, "utf8"));
    assert.equal(reported.review.comments.length, 2);
    assert.deepEqual(reported.review.comments[0], {
      content: "Race\n\nCounter race\n\ntwo writers", path: "src/app.ts", start_line: 2, end_line: 2,
    });
    assert.equal(reported.review.comments[1].content, "Maybe\n\nPossible issue");
    assert.equal(reported.duration_seconds, 1.5);
    assert.deepEqual(reported.review.summary, { input_tokens: 100, output_tokens: 20 });
    const confirmed = JSON.parse(readFileSync(confirmedFile, "utf8"));
    assert.equal(confirmed.review.comments.length, 1);

    // Our row keeps the normalized data + provenance.
    const row = JSON.parse(readFileSync(rowFileFor(roundDir, instance.safeId), "utf8"));
    assert.equal(row.status, "ok");
    assert.equal(row.round, "smoke");
    assert.equal(row.findings.reported.length, 2);
    assert.equal(row.findings.confirmedOnly.length, 1);
    assert.deepEqual(row.dropped, { anchorless: 1, total: 3 });
    assert.equal(row.model, "test/model");
    assert.equal(row.fixtureSha256, sha256(fixtureBytes));
    assert.equal(row.diffBaseKind, "base-tip");

    // Resume: completed rows are reused, the CLI is not spawned again.
    const resumed = await runMain([...args, "--resume"], env, deps);
    assert.equal(resumed, 0);
    assert.equal(readFileSync(logFile, "utf8").trim().split("\n").length, 1, "resume must not re-run the CLI");
    const resumedSummary = JSON.parse(readFileSync(path.join(roundDir, "summary.json"), "utf8"));
    assert.equal(resumedSummary.instances[0].status, "reused");
    assert.deepEqual(resumedSummary.repoCounts["example/repo"], { total: 1, ok: 0, error: 0, reused: 1 });

    // Provenance refusal: a different model or a different seeded subset
    // cannot be mixed into this round.
    await assert.rejects(
      runMain([...args, "--resume", "--model", "other/model"], env, deps),
      /refuses to mix models/,
    );
    await assert.rejects(
      runMain([...args, "--resume", "--seed", "43"], env, deps),
      /refuses to mix seeds: round was recorded with 42, this invocation uses 43/,
    );
    await assert.rejects(
      runMain(["--fixture", fixturePath, "--out-root", outRoot, "--round", "smoke", "--cli", fakeCli,
        "--model", "test/model", "--timeout", "20000", "--concurrency", "2", "--view", "both", "--resume"],
      env, deps),
      /refuses to mix seeds: round was recorded with 42, this invocation uses no seed/,
    );
  });
});

test("driver: exit 3 with a valid envelope is an incomplete row; garbage stays an error", async () => {
  await temporary(async (dir) => {
    const { mirrorDir, base, head } = buildLocalRepo(dir);
    const { doc } = makeMeta([positiveSample({ source_commit: base, target_commit: head })]);
    doc.rows[0].clone_url = pathToFileURL(mirrorDir).href;
    const fixturePath = path.join(dir, "test-set.json");
    writeFileSync(fixturePath, `${JSON.stringify(doc, null, 2)}\n`);
    const home = path.join(dir, "home");
    const env = {
      ...process.env,
      PIR_EVAL: "1",
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      XDG_CACHE_HOME: path.join(home, ".cache"),
      XDG_STATE_HOME: path.join(home, ".state"),
      PIR_CONFIG_DIR: path.join(dir, "pir-config"),
      PI_CODING_AGENT_DIR: path.join(dir, "agent"),
      PIR_AACR_CACHE: path.join(dir, "cache"),
    };
    const deps = { resolveMergeBase: async () => ({ sha: null, error: "offline test" }) };
    const outRoot = path.join(dir, "out");
    const run = (round, cli) => runMain([
      "--fixture", fixturePath, "--out-root", outRoot, "--round", round, "--cli", cli,
      "--model", "test/model", "--timeout", "20000", "--view", "both", "--json",
    ], env, deps);

    // Exit 3 + valid envelope: a real, truncated review, not a failed run.
    const incompleteCli = writeFakeCli(path.join(dir, "cli-incomplete"), {
      exitCode: 3, incomplete: true, pendingCandidates: 2, stoppedBecause: "budget",
    });
    assert.equal(await run("incomplete", incompleteCli), 0);
    const roundDir = path.join(outRoot, "incomplete");
    const summary = JSON.parse(readFileSync(path.join(roundDir, "summary.json"), "utf8"));
    assert.deepEqual(summary.errors, []);
    assert.equal(summary.incompleteInstances, 1);
    const instance = summary.instances[0];
    assert.equal(instance.status, "ok");
    assert.equal(instance.incomplete, true);
    assert.equal(instance.exitCode, 3);
    assert.equal(instance.stoppedBecause, "budget");
    assert.equal(instance.pendingCandidates, 2);
    const row = JSON.parse(readFileSync(rowFileFor(roundDir, instance.safeId), "utf8"));
    assert.equal(row.status, "ok");
    assert.equal(row.incomplete, true);
    assert.equal(row.exitCode, 3);
    assert.equal(existsSync(resultFileFor(roundDir, "reported", instance.safeId)), true);
    assert.equal(existsSync(resultFileFor(roundDir, "confirmedOnly", instance.safeId)), true);

    // Exit 3 with unparseable stdout is still an error row.
    const garbageCli = writeFakeCli(path.join(dir, "cli-garbage"), { exitCode: 3, garbage: true });
    assert.equal(await run("garbage", garbageCli), 1);
    const garbageDir = path.join(outRoot, "garbage");
    const garbageSummary = JSON.parse(readFileSync(path.join(garbageDir, "summary.json"), "utf8"));
    const failed = garbageSummary.instances[0];
    assert.equal(failed.status, "error");
    assert.equal(failed.exitCode, 3);
    assert.match(failed.error, /without a usable JSON envelope/);
    assert.equal(garbageSummary.incompleteInstances, 0);
    assert.equal(garbageSummary.errors.length, 1);
    assert.equal(existsSync(resultFileFor(garbageDir, "reported", failed.safeId)), false);
  });
});
