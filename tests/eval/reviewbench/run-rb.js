#!/usr/bin/env node
/**
 * Opt-in ReviewBench task runner: materialize vendored test-set tasks from
 * the frozen mirrors, run pir on each checkout, normalize the findings into
 * judging-input files under tests/eval/rb-out/<round>/, and emit the
 * deterministic advisory prefilter. Importing this module never starts a
 * review; without PIR_EVAL=1 it exits successfully with no network, model,
 * or database access (same contract as tests/eval/run-eval.js).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { snapshotConfig } from "../run-eval.js";
import { normalizeTask } from "./normalize.js";
import { prefilterTask, renderPrefilterMd, summarizeRound } from "./prefilter.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const RB_DIR = fileURLToPath(new URL("./", import.meta.url));
const RB_OUT_ROOT = path.join(ROOT, "tests/eval/rb-out");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const gitEnv = (env = process.env, extra = {}) => ({
  ...env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_LFS_SKIP_SMUDGE: "1",
  GIT_TERMINAL_PROMPT: "0",
  ...extra,
});
const git = (cwd, args, { env = process.env, timeoutMs } = {}) =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: gitEnv(env),
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    ...(timeoutMs ? { timeout: timeoutMs } : {}),
  });

export const MIRROR_ORG = "review-bench";

/** Task key matching the vendored golden filename stem: <owner>_<repo>_<pr>-<head8>. */
export function prKey(entry) {
  return `${entry.repo.replace("https://github.com/", "").replace("/", "_")}_${entry.pr_number}-${entry.head.slice(0, 8)}`;
}

/** Frozen mirror remote for a task: https://github.com/review-bench/<owner>_<repo>.git */
export function mirrorUrl(entry, mirrorOrg = MIRROR_ORG) {
  return `https://github.com/${mirrorOrg}/${entry.nwo.replace("/", "_")}.git`;
}

function validateEntry(entry, index) {
  const where = `manifest entry ${index}`;
  if (typeof entry.repo !== "string" || !entry.repo.startsWith("https://github.com/")) throw new Error(`${where}: repo must be an upstream github URL`);
  if (!Number.isInteger(entry.pr_number) || entry.pr_number < 1) throw new Error(`${where}: pr_number must be a positive integer`);
  for (const field of ["base", "head"]) {
    if (!/^[0-9a-f]{40}$/.test(String(entry[field] ?? ""))) throw new Error(`${where}: ${field} must be a 40-char hex sha`);
  }
  if (typeof entry.nwo !== "string" || !/^[^\s/]+\/[^\s/]+$/.test(entry.nwo)) throw new Error(`${where}: nwo must be owner/repo`);
}

/**
 * Load and validate the vendored task manifest. Every task must have its
 * golden file alongside the manifest (fixtures stay in sync by construction;
 * drift fails loudly instead of skewing rounds).
 */
export function loadManifest(manifestPath) {
  const tasks = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!Array.isArray(tasks) || tasks.length === 0) throw new Error(`manifest must be a non-empty array: ${manifestPath}`);
  const goldenDir = path.join(path.dirname(manifestPath), "golden");
  const keys = new Set();
  tasks.forEach((entry, index) => {
    validateEntry(entry, index);
    const key = prKey(entry);
    if (keys.has(key)) throw new Error(`duplicate task ${key} in manifest`);
    keys.add(key);
    if (!existsSync(path.join(goldenDir, `${key}.json`))) throw new Error(`golden file missing for ${key}: expected ${goldenDir}/${key}.json`);
  });
  return tasks;
}

export function parseOptions(argv = [], env = process.env) {
  const values = {
    repeats: env.PIR_EVAL_REPEATS ?? "1",
    baselineCli: env.PIR_EVAL_BASELINE_CLI,
    candidateCli: env.PIR_EVAL_CANDIDATE_CLI ?? path.join(ROOT, "dist/cli/cli.js"),
    model: env.PIR_MODEL,
    maxRounds: env.PIR_EVAL_MAX_ROUNDS ?? "2",
    maxTokens: env.PIR_EVAL_MAX_TOKENS ?? "400000",
    maxFindings: env.PIR_EVAL_MAX_FINDINGS ?? "10",
    taskTimeoutMs: env.PIR_EVAL_TASK_TIMEOUT_MS ?? "1800000",
    fetchTimeoutMs: env.PIR_EVAL_RB_FETCH_TIMEOUT_MS ?? "900000",
    round: env.PIR_EVAL_RB_ROUND,
    limit: env.PIR_EVAL_RB_LIMIT,
    only: env.PIR_EVAL_RB_ONLY ? env.PIR_EVAL_RB_ONLY.split(",").map((s) => s.trim()).filter(Boolean) : [],
    manifest: env.PIR_EVAL_RB_MANIFEST ?? path.join(RB_DIR, "fixtures/test-set.json"),
    json: env.PIR_EVAL_JSON === "1",
  };
  const flags = {
    "--repeats": "repeats", "--baseline-cli": "baselineCli", "--candidate-cli": "candidateCli", "--model": "model",
    "--max-rounds": "maxRounds", "--max-tokens": "maxTokens", "--max-findings": "maxFindings",
    "--task-timeout": "taskTimeoutMs", "--fetch-timeout": "fetchTimeoutMs", "--round": "round",
    "--limit": "limit", "--manifest": "manifest",
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--json") { values.json = true; continue; }
    if (argv[i] === "--help") { values.help = true; continue; }
    if (argv[i] === "--only") {
      if (!argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error(`invalid option or missing value: ${argv[i]}`);
      values.only.push(argv[++i]);
      continue;
    }
    const key = flags[argv[i]];
    if (!key || !argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error(`invalid option or missing value: ${argv[i]}`);
    values[key] = argv[++i];
  }
  for (const key of ["repeats", "maxRounds", "maxTokens", "maxFindings", "taskTimeoutMs", "fetchTimeoutMs"]) {
    if (!/^\d+$/.test(String(values[key])) || !Number.isSafeInteger(Number(values[key])) || Number(values[key]) < 1) {
      throw new Error(`${key} must be a positive integer`);
    }
    values[key] = Number(values[key]);
  }
  if (values.limit !== undefined) {
    if (!/^\d+$/.test(String(values.limit)) || Number(values.limit) < 1) throw new Error("limit must be a positive integer");
    values.limit = Number(values.limit);
  }
  for (const key of ["baselineCli", "candidateCli", "manifest"]) if (values[key]) values[key] = path.resolve(values[key]);
  return values;
}

/**
 * Per-repo object cache: git init once, remotes idempotent. `remotes`
 * overrides the URLs (tests point them at local fixture repos).
 */
export function ensureRepoCache(entry, cacheRoot, { remotes } = {}) {
  const name = entry.nwo.replace("/", "_");
  const repoDir = path.join(cacheRoot, "repos", name);
  if (!existsSync(path.join(repoDir, ".git"))) {
    if (existsSync(repoDir)) throw new Error(`cache path exists and is not a git repo: ${repoDir}`);
    mkdirSync(repoDir, { recursive: true });
    git(repoDir, ["init", "-q", "-b", "main"]);
  }
  const urls = { origin: remotes?.origin ?? mirrorUrl(entry), upstream: remotes?.upstream ?? `${entry.repo}.git` };
  for (const [remote, url] of Object.entries(urls)) {
    try {
      git(repoDir, ["remote", "add", remote, url]);
    } catch {
      git(repoDir, ["remote", "set-url", remote, url]);
    }
  }
  return { repoDir, name };
}

function missingShas(repoDir, shas) {
  return shas.filter((sha) => {
    try {
      git(repoDir, ["cat-file", "-e", `${sha}^{commit}`]);
      return false;
    } catch {
      return true;
    }
  });
}

function fetchRefspec(repoDir, remote, refspecs, timeoutMs) {
  git(repoDir, ["fetch", "--filter=blob:none", remote, ...refspecs], { timeoutMs });
}

/**
 * Fetch base+head only when a SHA is missing, preferring the frozen mirror
 * and falling back to upstream (exact SHAs first, then the PR head ref, the
 * same ladder scripts/extraction in upstream ReviewBench uses).
 */
export function ensureFetched(repoDir, { base, head, pr_number: prNumber }, { timeoutMs = 900000 } = {}) {
  if (missingShas(repoDir, [base, head]).length === 0) return { fetched: false, remote: null };
  try {
    fetchRefspec(repoDir, "origin", [base, head], timeoutMs);
    return { fetched: true, remote: "origin" };
  } catch {
    // mirror flake or missing: upstream by exact SHA, then by PR head ref.
    try {
      fetchRefspec(repoDir, "upstream", [base, head], timeoutMs);
      return { fetched: true, remote: "upstream" };
    } catch {
      fetchRefspec(repoDir, "upstream", [`pull/${prNumber}/head`], timeoutMs);
      const still = missingShas(repoDir, [base, head]);
      if (still.length > 0) throw new Error(`SHAs not reachable on mirror or upstream: ${still.join(", ")}`);
      return { fetched: true, remote: `upstream pull/${prNumber}/head` };
    }
  }
}

/** Detached per-task checkout of head, isolated via git worktree. */
export function materializeTask(repoDir, head, workDir) {
  if (existsSync(workDir)) {
    rmSync(workDir, { recursive: true, force: true });
    git(repoDir, ["worktree", "prune"]);
  }
  git(repoDir, ["worktree", "add", "--detach", workDir, head]);
  return workDir;
}

export function releaseTask(repoDir, workDir) {
  try {
    git(repoDir, ["worktree", "remove", "--force", workDir]);
  } catch {
    rmSync(workDir, { recursive: true, force: true });
    git(repoDir, ["worktree", "prune"]);
  }
}

function runPir(cli, checkout, entry, options, runDir, env) {
  const args = ["find", "--base", entry.base, "--head", entry.head, "--model", options.model,
    "--max-rounds", String(options.maxRounds), "--max-tokens", String(options.maxTokens),
    "--max-findings", String(options.maxFindings), "--json", "--quiet", "--local", "--cwd", checkout];
  mkdirSync(path.join(runDir, "home"), { recursive: true });
  const start = performance.now();
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: checkout, encoding: "utf8",
    timeout: options.taskTimeoutMs, maxBuffer: 32 * 1024 * 1024,
    env: gitEnv(env, {
      HOME: path.join(runDir, "home"),
      XDG_STATE_HOME: path.join(runDir, "state"), XDG_CACHE_HOME: path.join(runDir, "cache"),
      XDG_CONFIG_HOME: path.join(runDir, "xdg-config"), PIR_STATE_ROOT: path.join(runDir, "state"),
      // Cold memory per task, deliberately: the benchmark measures the
      // review engine, not accumulated decisions, and stays reproducible.
      PIR_MEMORY_DB: path.join(runDir, "state/memory.sqlite"), PIR_CONFIG_DIR: path.join(runDir, "config"),
      PI_CODING_AGENT_DIR: path.join(runDir, "agent"), PIR_NO_WIZARD: "1", PIR_TRANSCRIPTS: "0",
      PIR_MODE: "local", PIR_MODEL: options.model,
    }) });
  const wallTimeMs = Math.round(performance.now() - start);
  const stderrTail = (text) => String(text ?? "").trim().split("\n").slice(-12).join("\n");
  if (result.error) throw new Error(`${result.error.message}\nstderr tail:\n${stderrTail(result.stderr)}`);
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`CLI exited ${result.status}, signal ${result.signal ?? "none"}${result.signal === "SIGTERM" ? ` (task timeout ${options.taskTimeoutMs}ms)` : ""}\nstdout tail:\n${stderrTail(result.stdout)}\nstderr tail:\n${stderrTail(result.stderr)}`);
  }
  const envelope = JSON.parse(result.stdout);
  if (!envelope?.data || !Array.isArray(envelope.data.findings)) throw new Error("CLI returned no data.findings array");
  return { data: envelope.data, wallTimeMs, exitCode: result.status, stderr: result.stderr };
}

function loadGolden(manifestPath, key) {
  const goldenPath = path.join(path.dirname(manifestPath), "golden", `${key}.json`);
  return JSON.parse(readFileSync(goldenPath, "utf8"));
}

/**
 * Golden recall targets for the prefilter: tp-labeled findings only, the
 * same population the judge scores recall against (fp-labeled golden rows
 * are deliberate reviewer over-reports, not targets).
 */
export function goldenRecallTargets(golden) {
  return golden.findings
    .filter((f) => f.tp_fp === "tp")
    .map((f) => ({ file: f.file, start_line: f.start_line, end_line: f.end_line, message: f.message }));
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseOptions(argv, env);
  if (options.help) {
    console.log("PIR_EVAL=1 node tests/eval/reviewbench/run-rb.js [--round name] [--limit N] [--only <pr_key>]... [--baseline-cli dist/cli/cli.js] [--candidate-cli dist/cli/cli.js] [--model provider/model] [--max-rounds N] [--max-tokens N] [--max-findings N] [--task-timeout N] [--repeats N] [--manifest fixtures/test-set.json] [--json]\nSee tests/eval/reviewbench/README.md for the protocol, cache, and output layout.");
    return 0;
  }
  if (env.PIR_EVAL !== "1") {
    console.log(options.json ? JSON.stringify({ skipped: true, reason: "PIR_EVAL=1 required" }) : "skipped: set PIR_EVAL=1 to allow model evaluation");
    return 0;
  }
  const variants = [options.baselineCli && { name: "baseline", cli: options.baselineCli }, { name: "candidate", cli: options.candidateCli }].filter(Boolean);
  for (const variant of variants) {
    if (!statSync(variant.cli).isFile()) throw new Error(`CLI is not a file: ${variant.cli}`);
    variant.sha256 = sha256(readFileSync(variant.cli));
  }
  const tasks = loadManifest(options.manifest);
  let selected = tasks;
  if (options.only.length > 0) {
    const wanted = new Set(options.only);
    selected = tasks.filter((entry) => wanted.has(prKey(entry)));
    const found = new Set(selected.map(prKey));
    const unknown = [...wanted].filter((key) => !found.has(key));
    if (unknown.length > 0) throw new Error(`--only keys not in manifest: ${unknown.join(", ")}`);
  }
  if (options.limit !== undefined) selected = selected.slice(0, options.limit);

  const cacheRoot = path.join(RB_DIR, ".cache");
  // Ephemeral config snapshot (credentials included): one per invocation in
  // the OS temp dir, discarded in finally — no durable credential copy under
  // .cache/ (the scenario runner's snapshots are equally throwaway).
  const configRoot = mkdtempSync(path.join(tmpdir(), "pir-rb-config-"));
  try {
    const config = snapshotConfig(configRoot, env);
    options.model ??= config.model;
    if (!options.model) throw new Error("set --model or PIR_MODEL, or configure a default pi model");
    const { claimSimilarity } = await import(pathToFileURL(path.join(ROOT, "dist/findings/identity.js")).href);

    const roundName = options.round ?? `${new Date().toISOString().slice(0, 10)}-rb`;
    const roundDir = path.join(RB_OUT_ROOT, roundName);
    if (existsSync(roundDir)) throw new Error(`round directory already exists: ${roundDir} (pick a fresh --round name or remove it)`);
    mkdirSync(roundDir, { recursive: true });

    const summary = { schemaVersion: 1, round: roundName, startedAt: new Date().toISOString(), node: process.version,
      model: options.model, config, limits: { maxRounds: options.maxRounds, maxTokens: options.maxTokens,
        maxFindings: options.maxFindings, taskTimeoutMs: options.taskTimeoutMs, fetchTimeoutMs: options.fetchTimeoutMs },
      repeats: options.repeats, variants, tasks: [] };
    const prefilterAcc = new Map(); // `${variant}-run${repeat}` -> { taskResults }
    const runDirs = [];
    for (let repeat = 1; repeat <= options.repeats; repeat += 1) {
      for (const variant of variants) runDirs.push(`${variant.name}-run${repeat}`);
    }
    let anyError = false;

    for (const [index, entry] of selected.entries()) {
      const key = prKey(entry);
      const taskRow = { prKey: key, repo: entry.repo, prNumber: entry.pr_number, language: entry.language ?? null,
        repoSizeKb: entry.repo_size_kb ?? null, linesAdded: entry.lines_added ?? null, linesRemoved: entry.lines_removed ?? null,
        runs: [] };
      let repoDir = null;
      let checkout = null;
      let materializationError = null;
      try {
        const cache = ensureRepoCache(entry, cacheRoot);
        repoDir = cache.repoDir;
        const fetchInfo = ensureFetched(repoDir, entry, { timeoutMs: options.fetchTimeoutMs });
        if (fetchInfo.fetched) console.error(`fetched ${key} via ${fetchInfo.remote}`);
        checkout = materializeTask(repoDir, entry.head, path.join(cacheRoot, "work", key));
      } catch (error) {
        materializationError = String(error.message ?? error);
        console.error(`ERROR materialize ${key}: ${materializationError}`);
      }
      for (let repeat = 1; repeat <= options.repeats; repeat += 1) {
        const order = (repeat + index) % 2 === 0 ? [...variants].reverse() : variants;
        for (const variant of order) {
          const runLabel = `${variant.name}-run${repeat}`;
          if (materializationError) {
            taskRow.runs.push({ variant: variant.name, repeat, status: "error", error: `materialization: ${materializationError}` });
            anyError = true;
            continue;
          }
          const runDir = path.join(cacheRoot, "runs", roundName, runLabel, key);
          if (existsSync(runDir)) rmSync(runDir, { recursive: true, force: true });
          mkdirSync(runDir, { recursive: true });
          // Same forced-local snapshot the scenario runner gives its runs:
          // without agent credentials pir cannot authenticate the model.
          for (const dir of ["agent", "config"]) cpSync(path.join(configRoot, dir), path.join(runDir, dir), { recursive: true });
          try {
            const result = runPir(variant.cli, checkout, entry, options, runDir, env);
            const { reported, confirmedOnly, dropped } = normalizeTask({ manifestEntry: entry, outcome: result });
            const reportedDir = path.join(roundDir, runLabel);
            const confirmedDir = path.join(roundDir, `${runLabel}-confirmed-only`);
            mkdirSync(reportedDir, { recursive: true });
            mkdirSync(confirmedDir, { recursive: true });
            writeFileSync(path.join(reportedDir, `${key}.json`), `${JSON.stringify(reported, null, 2)}\n`);
            writeFileSync(path.join(confirmedDir, `${key}.json`), `${JSON.stringify(confirmedOnly, null, 2)}\n`);
            const golden = loadGolden(options.manifest, key);
            const goldenFindings = goldenRecallTargets(golden);
            const pirFindings = result.data.findings
              .filter((f) => f.status === "confirmed" || f.status === "uncertain")
              .map((f) => ({ message: `${f.title} — ${f.claim} Trigger: ${f.trigger}`, paths: (f.anchors ?? []).map((a) => a.path),
                start_line: f.anchors?.[0]?.startLine, end_line: f.anchors?.[0]?.endLine ?? f.anchors?.[0]?.startLine }));
            const prefilterResult = prefilterTask({ goldenFindings, pirFindings, similarity: claimSimilarity });
            if (!prefilterAcc.has(runLabel)) prefilterAcc.set(runLabel, []);
            prefilterAcc.get(runLabel).push({ prKey: key, goldenFindings, pirFindings, result: prefilterResult });
            const usage = result.data.usage;
            taskRow.runs.push({ variant: variant.name, repeat, status: "ok", exitCode: result.exitCode, wallTimeMs: result.wallTimeMs,
              totalTokens: usage?.totalTokens ?? null, reportedFindings: reported.findings.length,
              confirmedFindings: confirmedOnly.findings.length, droppedAnchors: dropped.length,
              dropped: dropped.length > 0 ? dropped : undefined });
            console.error(`OK ${runLabel} ${key}: ${reported.findings.length} reported (${confirmedOnly.findings.length} confirmed)` +
              `${dropped.length > 0 ? ` [WARN dropped ${dropped.length} anchorless reported findings]` : ""} in ${result.wallTimeMs}ms`);
          } catch (error) {
            taskRow.runs.push({ variant: variant.name, repeat, status: "error", error: String(error.message ?? error) });
            anyError = true;
            console.error(`ERROR ${runLabel} ${key}: ${String(error.message ?? error)}`);
          } finally {
            rmSync(runDir, { recursive: true, force: true });
          }
        }
      }
      if (checkout) releaseTask(repoDir, checkout);
      summary.tasks.push(taskRow);
    }

  summary.finishedAt = new Date().toISOString();
  summary.roundSummary = Object.fromEntries([...prefilterAcc.entries()].map(([runLabel, taskResults]) => {
    const round = summarizeRound(taskResults);
    writeFileSync(path.join(roundDir, `${runLabel}.PREFILTER.md`), renderPrefilterMd({ round: roundName, variant: runLabel, taskResults }));
    return [runLabel, round];
  }));
  writeFileSync(path.join(roundDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  const errors = summary.tasks.flatMap((t) => t.runs.filter((r) => r.status === "error").map((r) => `${t.prKey} ${r.variant}-run${r.repeat}: ${r.error}`));
  console.log(options.json ? JSON.stringify(summary) : JSON.stringify({ round: roundName, roundDir, tasks: summary.tasks.length,
    errorRuns: errors.length, roundSummary: summary.roundSummary, errors: errors.length > 0 ? errors : undefined }, null, 2));
    return anyError ? 1 : 0;
  } finally {
    rmSync(configRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((error) => { console.error(error); process.exitCode = 3; });
}
