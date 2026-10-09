import { test } from "node:test";
import assert from "assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseOptions, prKey, mirrorUrl, loadManifest, goldenRecallTargets, prefilterPirFindings } from "../eval/reviewbench/run-rb.js";
import { normalizeTask } from "../eval/reviewbench/normalize.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUN_RB = path.join(HERE, "..", "eval", "reviewbench", "run-rb.js");
const REAL_MANIFEST = path.join(HERE, "..", "eval", "reviewbench", "fixtures", "test-set.json");

function temporary(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "pir-rb-unit-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const entry = () => ({
  repo: "https://github.com/PierreJanineh/TechDebtMCP",
  pr_number: 135,
  base: "b".repeat(40),
  head: "16a54f0f85a9091f220418850eac6b4122782be5",
  nwo: "PierreJanineh/TechDebtMCP",
});

test("prKey derives the golden filename stem", () => {
  assert.equal(prKey(entry()), "PierreJanineh_TechDebtMCP_135-16a54f0f");
});

test("mirrorUrl targets the frozen mirror org with owner_repo naming", () => {
  assert.equal(mirrorUrl(entry()), "https://github.com/review-bench/PierreJanineh_TechDebtMCP.git");
});

test("parseOptions: defaults match the scenario-runner surface plus RB flags", () => {
  const options = parseOptions([], {});
  assert.equal(options.repeats, 1);
  assert.equal(options.taskTimeoutMs, 1800000);
  assert.equal(options.fetchTimeoutMs, 900000);
  // Unlimited by default: 14/25 vendored tasks carry >10 tp golden findings.
  assert.equal(options.maxFindings, "unlimited");
  assert.equal(options.baselineCli, undefined);
  assert.ok(options.candidateCli.endsWith(path.join("dist", "cli", "cli.js")));
  assert.deepEqual(options.only, []);
  assert.equal(options.limit, undefined);
  assert.equal(options.json, false);

  assert.equal(parseOptions(["--max-findings", "15"], {}).maxFindings, 15);
  assert.equal(parseOptions(["--max-findings", "UNLIMITED"], {}).maxFindings, "unlimited");
  assert.throws(() => parseOptions(["--max-findings", "0"], {}), /positive integer or "unlimited"/);
});

test("parseOptions: flags, repeatable --only, env fallbacks, and numeric validation", () => {
  const options = parseOptions(
    ["--round", "smoke", "--only", "a_1-aaaaaaaa", "--only", "b_2-bbbbbbbb", "--limit", "3", "--task-timeout", "5000",
      "--baseline-cli", "./old.js", "--model", "prov/model"],
    {},
  );
  assert.equal(options.round, "smoke");
  assert.deepEqual(options.only, ["a_1-aaaaaaaa", "b_2-bbbbbbbb"]);
  assert.equal(options.limit, 3);
  assert.equal(options.taskTimeoutMs, 5000);
  assert.equal(options.model, "prov/model");
  assert.ok(path.isAbsolute(options.baselineCli));

  const fromEnv = parseOptions([], { PIR_EVAL_RB_ONLY: "x_1-xxxxxxxx, y_2-yyyyyyyy", PIR_EVAL_BASELINE_CLI: "/abs/old.js" });
  assert.deepEqual(fromEnv.only, ["x_1-xxxxxxxx", "y_2-yyyyyyyy"]);
  assert.equal(fromEnv.baselineCli, "/abs/old.js");

  assert.throws(() => parseOptions(["--task-timeout", "0"], {}), /positive integer/);
  assert.throws(() => parseOptions(["--limit", "nope"], {}), /positive integer/);
  assert.throws(() => parseOptions(["--only"], {}), /missing value/);
  assert.throws(() => parseOptions(["--round"], {}), /missing value/);
});

test("loadManifest validates the real vendored fixture and its golden coverage", () => {
  const tasks = loadManifest(REAL_MANIFEST);
  assert.equal(tasks.length, 25);
  const keys = new Set(tasks.map(prKey));
  assert.equal(keys.size, 25);
  assert.ok(keys.has("PierreJanineh_TechDebtMCP_135-16a54f0f"));
});

test("prefilterPirFindings population matches what normalizeTask sends the judge", () => {
  const rows = [
    { displayId: "F-1", status: "confirmed", title: "T1", claim: "C1", trigger: "G1", anchors: [{ path: "a.ts", startLine: 1 }] },
    { displayId: "F-2", status: "uncertain", title: "T2", claim: "C2", trigger: "G2", anchors: [{ path: "b.ts", startLine: 2, endLine: 4 }] },
    { displayId: "F-3", status: "rejected", title: "T3", claim: "C3", trigger: "G3", anchors: [{ path: "c.ts", startLine: 3 }] },
    { displayId: "F-4", status: "confirmed", title: "T4", claim: "C4", trigger: "G4", anchors: [] },
    { displayId: "F-5", status: "confirmed", title: "T5", claim: "C5", trigger: "G5", anchors: [{ path: "", startLine: 5 }] },
  ];
  const manifestEntry = { repo: "https://github.com/example/repo", pr_number: 1, base: "b".repeat(40), head: "a".repeat(40) };
  const { reported, dropped } = normalizeTask({ manifestEntry, outcome: { data: { findings: rows } } });
  const pir = prefilterPirFindings(rows);
  assert.equal(pir.length, reported.findings.length);
  assert.equal(dropped.length, 2); // the same two anchorless rows normalize drops
  assert.deepEqual(pir.map((f) => f.start_line), [1, 2]);
  assert.deepEqual(pir.map((f) => f.paths), [["a.ts"], ["b.ts"]]);
  assert.equal(pir[0].message, "T1 — C1 Trigger: G1");
});

test("goldenRecallTargets keeps tp-labeled golden findings only (judge recall population)", () => {
  const golden = JSON.parse(
    readFileSync(path.join(HERE, "..", "eval", "reviewbench", "fixtures", "golden", "AA-Factory_aafactory-prototype_17-a1978cb7.json"), "utf8"),
  );
  const tpCount = golden.findings.filter((f) => f.tp_fp === "tp").length;
  assert.ok(tpCount > 0 && tpCount < golden.findings.length, "fixture should mix tp and fp labels");
  const targets = goldenRecallTargets(golden);
  assert.equal(targets.length, tpCount);
  for (const t of targets) {
    assert.deepEqual(Object.keys(t).sort(), ["end_line", "file", "message", "start_line"]);
  }
});

test("loadManifest rejects malformed or golden-less manifests", () => {
  temporary((dir) => {
    const golden = path.join(dir, "golden");
    mkdirSync(golden);
    writeFileSync(path.join(golden, "example_repo_1-aaaaaaaa.json"), "{}");
    writeFileSync(path.join(dir, "test-set.json"), JSON.stringify([
      { repo: "https://gitlab.com/example/repo", pr_number: 1, base: "a".repeat(40), head: "b".repeat(40), nwo: "example/repo" },
    ]));
    assert.throws(() => loadManifest(path.join(dir, "test-set.json")), /repo must be an upstream github URL/);

    writeFileSync(path.join(dir, "test-set.json"), JSON.stringify([
      { repo: "https://github.com/example/repo", pr_number: 1, base: "a".repeat(40), head: "b".repeat(40), nwo: "example/repo" },
    ]));
    // head b…: prKey = example_repo_1-bbbbbbbb, golden only exists for …-aaaaaaaa
    assert.throws(() => loadManifest(path.join(dir, "test-set.json")), /golden file missing for example_repo_1-bbbbbbbb/);

    writeFileSync(path.join(dir, "test-set.json"), "[]");
    assert.throws(() => loadManifest(path.join(dir, "test-set.json")), /non-empty array/);
  });
});

test("PIR_EVAL gate: no side effects, parseable skip JSON, exit 0", () => {
  const result = spawnSync(process.execPath, [RUN_RB, "--round", "gate-check", "--json"], {
    encoding: "utf8",
    env: { ...process.env, PIR_EVAL: "0" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { skipped: true, reason: "PIR_EVAL=1 required" });
  // The gate fires before any artifact creation.
  assert.equal(result.stdout.includes("gate-check"), false);
});

test("PIR_EVAL gate: plain-text skip without --json", () => {
  const result = spawnSync(process.execPath, [RUN_RB], {
    encoding: "utf8",
    env: { ...process.env, PIR_EVAL: "0" },
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^skipped: set PIR_EVAL=1/);
});

test("--help is model-free and prints the RB flag surface", () => {
  const result = spawnSync(process.execPath, [RUN_RB, "--help"], { encoding: "utf8", env: { ...process.env, PIR_EVAL: "0" } });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--round name/);
  assert.match(result.stdout, /--task-timeout N/);
  assert.match(result.stdout, /--only <pr_key>/);
});
