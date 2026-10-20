#!/usr/bin/env node
/**
 * AACR-Bench M1 — end-to-end eval driver (roadmap T2).
 *
 * One M1 task = one positive_samples PR. For each task:
 *   1. reuse the shared depth-1 clone cache,
 *   2. fetch the PR head and the GitHub-reported merge base (no full clone),
 *   3. make the review range explainable to `pir find` (see synthetic head
 *      below), check out the head tree in a detached worktree,
 *   4. spawn the shipped CLI:
 *
 *        pir find --base <diffBase> --head <reviewHead>
 *                 --max-rounds <N> --max-tokens unlimited
 *                 --max-findings unlimited --json --quiet --local
 *                 --cwd <checkout> --plugins none --model <id>
 *
 *   5. normalize the envelope into two upstream-shaped result views and write
 *      per-instance rows + upstream result files incrementally.
 *
 * Materialization (ADR-0009, consistent with ADR-0007 §7): the shared cache
 * holds depth-1 fetches of the head and the merge base, never a full clone.
 * A shallow cache has no ancestry relation, so `git diff base...head` inside
 * `pir find` would fail ("no merge base"). The driver therefore checks
 * ancestry and, only when it is absent, creates a deterministic synthetic head
 * commit with the head's exact tree and the merge base as parent. The
 * reviewer sees the real head tree and exactly the PR diff; the original head
 * sha stays recorded in every row. Fallback if that cannot be done: fetch a
 * blobless partial clone (`--filter=blob:none`) / full history and re-run.
 *
 * Isolation is rb-grade: redirected HOME/XDG, per-instance cold memory DB,
 * ephemeral credential snapshot, PIR_MODE=local, PIR_TRANSCRIPTS=0,
 * PIR_EVAL=1, --local and --plugins none.
 *
 * Scheduling is same-repo serial / cross-repo concurrent (repositories share
 * a cache dir; concurrent fetches into one repo would race), matching
 * upstream's own concurrency model.
 *
 * Opt-in eval surface: without PIR_EVAL=1 this exits 0 with a skip notice and
 * touches nothing; importing the module has no side effects; --help is
 * model-free; every instance failure becomes an error row and a round never
 * aborts.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { snapshotConfig } from "../../run-eval.js";
import { DEFAULT_CACHE, cachedMergeBase, ensureRepoCache, gitEnv, rememberMergeBase, resolveMergeBase } from "../materialize.js";
import { assertResumeCompatible, ensureFetchedAsync, materializeTaskAsync, releaseTaskAsync, sha256 } from "../run-m0.js";
import { mulberry32 } from "../sample.js";
import { fixtureDigest, loadFixture } from "../fixtures/build-fixture.js";
import { VIEWS, normalizeFindings, safeId, toUpstreamResult } from "./normalize-aacr.js";
import {
  DEFAULT_JUDGE_TIMEOUT_MS, assertJudgeEnv, ensureJudgeCheckout, judgeCloneDir, judgeRunId, loadJudgePin, resolveJudgeTimeoutMs, runJudge,
} from "./judge.js";
import { createSyntheticHeadAsync, hasAncestryAsync } from "./git-async.js";

const HERE = fileURLToPath(new URL("./", import.meta.url));
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
export const DEFAULT_FIXTURE = path.join(HERE, "..", "fixtures", "test-set.json");
export const DEFAULT_OUT_ROOT = path.join(HERE, "..", "out");
export const DEFAULT_META = path.join(HERE, "..", "meta.json");
export const MAX_FINDINGS = "unlimited";
export const MAX_TOKENS = "unlimited";
export const DEFAULT_VIEW = "both";
export const DEFAULT_JUDGE = "off";

/** One upstream-shaped result file per (round/repeat, view, safe_id). */
export function repeatDirFor(roundDir, repeats, repeat) {
  return repeats === 1 ? roundDir : path.join(roundDir, `repeat-${repeat}`);
}
export const resultFileFor = (repeatDir, view, id) => path.join(repeatDir, view, `${id}.json`);
export const rowFileFor = (repeatDir, id) => path.join(repeatDir, "rows", `${id}.json`);

/**
 * Seeded order for a row list, sharing M0's PRNG and Fisher-Yates loop.
 *
 * M2's change protocol runs before/after on a fixed PR subset, so the subset
 * has to be reproducible from (seed, limit) alone — the same contract M0's
 * comment sample follows. Reusing `mulberry32` and the same backwards
 * Fisher-Yates means "seed 42" shuffles consistently across both benchmarks
 * and does not drift with a Node version or a different PRNG.
 */
export function seededOrder(rows, seed) {
  if (!Array.isArray(rows)) throw new TypeError("rows must be an array");
  if (seed === undefined || seed === null) return rows.slice();
  if (!Number.isSafeInteger(seed) || seed < 0) throw new Error("seed must be a non-negative integer");
  const random = mulberry32(seed);
  const order = rows.slice();
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

/**
 * One selection rule for an invocation and for a resumed/--judge-only round:
 * --only filters, --seed shuffles, --limit truncates — in that order, so the
 * recorded (limits.only, limits.limit, limits.seed) triple reproduces exactly
 * the instance set the round ran on. Without --seed the fixture order is kept
 * (pre-M2 rounds behave identically).
 */
export function selectFixtureRows(rows, { only = [], limit, seed } = {}) {
  if (!Array.isArray(rows)) throw new TypeError("rows must be an array");
  let selected = rows;
  if (only.length > 0) {
    const wanted = new Set(only);
    selected = rows.filter((row) => wanted.has(row.instance_id));
    const missing = [...wanted].filter((id) => !rows.some((row) => row.instance_id === id));
    if (missing.length > 0) throw new Error(`--only ids not in the fixture: ${missing.join(", ")}`);
  }
  selected = seededOrder(selected, seed);
  if (limit !== undefined && limit !== null) selected = selected.slice(0, limit);
  return selected;
}

/**
 * M2 provenance: the subset (and therefore every before/after comparison on
 * it) is a pin, not an implementation detail. A different seed or a different
 * selected instance set is a different round, never a resumable one; a
 * judge-only run replays the recorded subset and must land on it exactly.
 */
export function assertSelectionCompatible(previousSummary, { selected, seed, judgeOnly = false } = {}) {
  const recordedSeed = previousSummary?.limits?.seed ?? null;
  if (!judgeOnly && recordedSeed !== (seed ?? null)) {
    throw new Error(`--resume refuses to mix seeds: round was recorded with ${recordedSeed ?? "no seed"}, this invocation uses ${seed ?? "no seed"}`);
  }
  const previousDigest = previousSummary?.fixture?.instanceSetDigest;
  if (previousDigest && previousDigest !== fixtureDigest(selected)) {
    throw new Error(`--resume refuses to change the selected instance set: round was recorded with ${previousDigest}, this invocation selects ${fixtureDigest(selected)} (pass the same --limit/--only/--seed)`);
  }
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temp, file);
}

function stderrTail(text, lines = 12, maxChars = 4000) {
  const tail = String(text ?? "").trim().split("\n").slice(-lines).join("\n");
  return tail.length > maxChars ? tail.slice(-maxChars) : tail;
}

export function parseOptions(argv = [], env = process.env) {
  const values = {
    fixture: env.PIR_AACR_FIXTURE ?? DEFAULT_FIXTURE,
    meta: env.PIR_AACR_META ?? DEFAULT_META,
    cache: env.PIR_AACR_CACHE ?? DEFAULT_CACHE,
    outRoot: env.PIR_AACR_OUT ?? DEFAULT_OUT_ROOT,
    cli: env.PIR_AACR_CLI ?? path.join(ROOT, "dist/cli/cli.js"),
    model: env.PIR_AACR_MODEL ?? env.PIR_MODEL,
    limit: env.PIR_AACR_LIMIT === undefined ? undefined : Number(env.PIR_AACR_LIMIT),
    seed: env.PIR_AACR_SEED === undefined ? undefined : Number(env.PIR_AACR_SEED),
    repeats: Number(env.PIR_AACR_REPEATS ?? 1),
    round: env.PIR_AACR_ROUND,
    concurrency: Number(env.PIR_AACR_CONCURRENCY ?? 1),
    maxRounds: Number(env.PIR_AACR_MAX_ROUNDS ?? 2),
    timeoutMs: Number(env.PIR_AACR_TIMEOUT_MS ?? env.PIR_EVAL_TASK_TIMEOUT_MS ?? 1800000),
    view: env.PIR_AACR_VIEW ?? DEFAULT_VIEW,
    judge: env.PIR_AACR_JUDGE ?? DEFAULT_JUDGE,
    evalRounds: Number(env.PIR_AACR_EVAL_ROUNDS ?? 1),
    only: env.PIR_AACR_ONLY ? env.PIR_AACR_ONLY.split(",").map((s) => s.trim()).filter(Boolean) : [],
    resume: false,
    judgeOnly: false,
    json: env.PIR_EVAL_JSON === "1",
    help: false,
  };
  const flags = {
    "--fixture": "fixture", "--meta": "meta", "--cache": "cache", "--out-root": "outRoot",
    "--cli": "cli", "--model": "model", "--limit": "limit", "--seed": "seed", "--repeats": "repeats",
    "--round": "round", "--concurrency": "concurrency", "--max-rounds": "maxRounds",
    "--timeout": "timeoutMs", "--view": "view", "--judge": "judge", "--eval-rounds": "evalRounds",
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--resume") { values.resume = true; continue; }
    if (argv[i] === "--judge-only") { values.judgeOnly = true; continue; }
    if (argv[i] === "--json") { values.json = true; continue; }
    if (argv[i] === "--help") { values.help = true; continue; }
    if (argv[i] === "--only") {
      if (!argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error(`invalid option or missing value: ${argv[i]}`);
      values.only.push(...argv[++i].split(",").map((s) => s.trim()).filter(Boolean));
      continue;
    }
    const key = flags[argv[i]];
    if (!key || !argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error(`invalid option or missing value: ${argv[i]}`);
    values[key] = argv[++i];
  }
  for (const key of ["limit", "seed", "repeats", "concurrency", "maxRounds", "timeoutMs", "evalRounds"]) {
    if (typeof values[key] === "string") values[key] = Number(values[key]);
  }
  for (const key of ["repeats", "concurrency", "maxRounds", "timeoutMs", "evalRounds"]) {
    if (!Number.isSafeInteger(values[key]) || values[key] < 1) throw new Error(`${key} must be a positive integer`);
  }
  if (values.limit !== undefined && (!Number.isSafeInteger(values.limit) || values.limit < 1)) throw new Error("limit must be a positive integer");
  if (values.seed !== undefined && (!Number.isSafeInteger(values.seed) || values.seed < 0)) throw new Error("seed must be a non-negative integer");
  if (!["both", ...VIEWS].includes(values.view)) throw new Error(`unknown view: ${values.view} (available: both, ${VIEWS.join(", ")})`);
  if (!["off", "mock", "real"].includes(values.judge)) throw new Error(`unknown --judge mode: ${values.judge} (available: off, mock, real)`);
  values.views = values.view === "both" ? [...VIEWS] : [values.view];
  if (values.judgeOnly) {
    if (values.judge === "off") throw new Error("--judge-only needs --judge real or mock");
    if (!values.resume) throw new Error("--judge-only judges an existing round; pass --resume with the same --round");
    if (values.only.length > 0 || values.limit !== undefined || values.seed !== undefined) {
      throw new Error("--judge-only judges the round's recorded selection; --limit/--only/--seed are not allowed");
    }
  }
  for (const key of ["fixture", "meta", "cache", "outRoot", "cli"]) values[key] = path.resolve(values[key]);
  return values;
}

/** Shared merge-base resolution cache (same file M0 uses; failures are never cached). */
export function loadMergeBaseCache(file) {
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    console.error(`WARN ignoring unreadable merge-base cache: ${file}`);
    return {};
  }
}

class MergeBaseStore {
  constructor(file, cache) {
    this.file = file;
    this.cache = cache;
    this.chain = Promise.resolve();
  }

  get(key) {
    return cachedMergeBase(this.cache, key);
  }

  /** Remember a successful resolution and persist it serially (atomic write). */
  remember(key, sha) {
    rememberMergeBase(this.cache, key, sha);
    this.chain = this.chain.then(() => {
      try {
        mkdirSync(path.dirname(this.file), { recursive: true });
        const temp = `${this.file}.tmp-${process.pid}`;
        writeFileSync(temp, `${JSON.stringify(this.cache, null, 2)}\n`);
        renameSync(temp, this.file);
      } catch (error) {
        console.error(`WARN could not persist merge-base cache: ${String(error?.message ?? error)}`);
      }
    });
    return this.chain;
  }

  async settle() {
    await this.chain;
  }
}

/**
 * One spawned `pir find`. Async on purpose: the worker pool must overlap
 * cross-repo runs.
 *
 * Exit status handling follows the CLI contract: 0 = clean, 1 = a finding met
 * the severity threshold, 3 = incomplete / runtime failure WITH a valid
 * envelope on stdout (`data.incomplete`, `data.stoppedBecause`). Exit 3 is a
 * real review that hit its budget or round limit, so it is accepted and the
 * row is flagged incomplete; dropping it would turn a truncated run into a
 * missing instance. Any other status, a signal kill (timeout), or unparseable
 * stdout stays an error.
 */
export function runCliOnce({ cli, checkout, base, head, maxRounds, model, runDir, timeoutMs, env }) {
  const args = [
    "find", "--base", base, "--head", head,
    "--max-rounds", String(maxRounds),
    // Explicit unlimited: B3 (ADR-0006) applies default token ceilings when
    // the flag is absent, which would measure the ceiling instead of the run.
    "--max-tokens", MAX_TOKENS,
    "--max-findings", MAX_FINDINGS,
    "--json", "--quiet", "--local", "--cwd", checkout, "--plugins", "none",
  ];
  if (model) args.push("--model", model);
  mkdirSync(path.join(runDir, "home"), { recursive: true });
  return new Promise((resolve) => {
    const start = performance.now();
    let stdout = "";
    let stderr = "";
    const MAX_BUFFER = 32 * 1024 * 1024;
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: checkout,
      env: gitEnv(env, {
        HOME: path.join(runDir, "home"),
        XDG_STATE_HOME: path.join(runDir, "state"),
        XDG_CACHE_HOME: path.join(runDir, "cache"),
        XDG_CONFIG_HOME: path.join(runDir, "xdg-config"),
        PIR_STATE_ROOT: path.join(runDir, "state"),
        PIR_MEMORY_DB: path.join(runDir, "state/memory.sqlite"),
        PIR_CONFIG_DIR: path.join(runDir, "config"),
        PI_CODING_AGENT_DIR: path.join(runDir, "agent"),
        PIR_NO_WIZARD: "1", PIR_TRANSCRIPTS: "0", PIR_MODE: "local", PIR_EVAL: "1",
        ...(model ? { PIR_MODEL: model } : {}),
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => { if (stdout.length < MAX_BUFFER) stdout += chunk; });
    child.stderr.on("data", (chunk) => { if (stderr.length < MAX_BUFFER) stderr += chunk; });
    let killTimer = null;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    }, timeoutMs);
    const finish = (result) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({ ...result, wallTimeMs: Math.round(performance.now() - start), stdout, stderr });
    };
    child.on("error", (error) => finish({ ok: false, exitCode: null, signal: null, error: `spawn failed: ${error.message}` }));
    child.on("close", (status, signal) => {
      // 0 clean, 1 threshold finding, 3 incomplete with a valid envelope.
      // status null means a signal kill (timeout) and is never accepted.
      if (status !== 0 && status !== 1 && status !== 3) {
        finish({
          ok: false, exitCode: status, signal,
          error: `CLI exited ${status}${signal ? ` signal ${signal} (task timeout ${timeoutMs}ms)` : ""}`,
        });
        return;
      }
      try {
        const envelope = JSON.parse(stdout);
        if (!envelope?.data || !Array.isArray(envelope.data.findings)) throw new Error("missing data.findings array");
        finish({ ok: true, exitCode: status, signal, envelope, data: envelope.data });
      } catch (error) {
        finish({
          ok: false, exitCode: status, signal,
          error: `CLI exited ${status} without a usable JSON envelope: ${error.message}`,
        });
      }
    });
  });
}

/** Resolve the effective diff base (GitHub merge base when available). */
async function resolveInstanceBase({ row, store, env, resolve }) {
  const key = `${row.repo}|${row.base_commit}|${row.head_commit}`;
  const cached = store.get(key);
  if (cached) return { diffBase: cached, diffBaseKind: "merge-base", resolveError: null };
  let resolved;
  try {
    resolved = await resolve(row.repo, row.base_commit, row.head_commit, { env });
  } catch (error) {
    resolved = { sha: null, error: String(error?.message ?? error) };
  }
  if (resolved?.sha) {
    await store.remember(key, resolved.sha);
    return { diffBase: resolved.sha, diffBaseKind: "merge-base", resolveError: null };
  }
  return {
    diffBase: row.base_commit,
    diffBaseKind: "base-tip",
    resolveError: resolved?.error ?? "no merge base reported",
  };
}

/**
 * The reviewer's head ref: the original head when the cache has ancestry,
 * otherwise a deterministic synthetic commit carrying the same tree.
 */
async function resolveReviewHead({ repoDir, head, diffBase, env, timeoutMs }) {
  if (await hasAncestryAsync(repoDir, diffBase, head, { env, timeoutMs })) {
    return { reviewHead: head, syntheticHead: null, syntheticTree: null };
  }
  const synthetic = await createSyntheticHeadAsync(repoDir, { head, parent: diffBase, env, timeoutMs });
  return { reviewHead: synthetic.head, syntheticHead: synthetic.head, syntheticTree: synthetic.tree };
}

function failure(message, extra = {}) {
  const error = new Error(message);
  Object.assign(error, extra);
  return error;
}

export async function main(argv = process.argv.slice(2), env = process.env, deps = {}) {
  const options = parseOptions(argv, env);
  if (options.help) {
    console.log("PIR_EVAL=1 node tests/eval/aacr/m1/run-aacr.js [--fixture fixtures/test-set.json] [--limit N] [--only <instance-id>]... [--repeats N] [--resume] [--round name] [--out-root out] [--cache ~/.cache/pir-aacr] [--cli dist/cli/cli.js] [--model provider/model] [--concurrency N] [--max-rounds N] [--timeout ms] [--view reported|confirmedOnly|both] [--judge off|mock|real] [--eval-rounds N] [--json]\n" +
      "Runs pir find once per positive_samples PR (same-repo serial, cross-repo concurrent) with rb-grade isolation, writing upstream-shaped results per view and per-instance rows incrementally.\n" +
      "Smoke: --limit 20 --concurrency 4 --model opencode-go/deepseek-v4.1-flash:medium (costs 20 model runs; never a CI gate).\n" +
      "M2 change protocol subset: --limit 50 --seed 42 (deterministic, recorded as limits.seed + fixture.instanceSetDigest; --resume refuses a different subset).\n" +
      "Exit status 3 with a valid envelope is recorded as an incomplete row, not an error; unexpected statuses, signal kills and unparseable stdout are errors.\n" +
      "--judge mock uses upstream's local similarity (zero cost); --judge real needs JUDGE_BASE_URL/JUDGE_API_KEY/JUDGE_MODEL.\n" +
      "--judge-only --resume judges an existing round's completed result files without re-running reviewers (sampled rounds).");
    return 0;
  }
  if (env.PIR_EVAL !== "1") {
    console.log(options.json ? JSON.stringify({ skipped: true, reason: "PIR_EVAL=1 required" }) : "skipped: set PIR_EVAL=1 to allow model evaluation");
    return 0;
  }
  // Fail on missing real-judge credentials or an unusable pinned judge clone
  // before spending a single model run.
  assertJudgeEnv(options.judge, env);
  const judgePin = options.judge === "off" ? null : loadJudgePin(options.meta);
  const judgeDir = judgePin ? judgeCloneDir(judgePin, env) : null;
  if (judgePin) await ensureJudgeCheckout({ judgeDir, pin: judgePin });

  const { header, rows: fixtureRows } = loadFixture(options.fixture);
  const fixtureSha256 = sha256(readFileSync(options.fixture));
  if (!existsSync(options.cli) || !statSync(options.cli).isFile()) throw new Error(`CLI is not a file: ${options.cli} (run npm run build:cli)`);
  const cliSha256 = sha256(readFileSync(options.cli));

  let selected = selectFixtureRows(fixtureRows, { only: options.only, limit: options.limit, seed: options.seed });

  const roundName = options.round ?? `${new Date().toISOString().slice(0, 10)}-m1`;
  const roundDir = path.join(options.outRoot, roundName);
  const summaryPath = path.join(roundDir, "summary.json");
  let previousSummary = null;
  if (existsSync(roundDir)) {
    if (!options.resume) throw new Error(`round directory already exists: ${roundDir} (pick a fresh --round name, remove it, or pass --resume)`);
    if (existsSync(summaryPath)) previousSummary = JSON.parse(readFileSync(summaryPath, "utf8"));
  }

  if (options.judgeOnly) {
    // ADR-0009 Iteration 3: a sampled round is judged from the completed
    // result files without re-running reviewers; the judged population is the
    // round's recorded selection, so unrun instances stay visible in
    // upstream's missing_instances instead of shrinking the sample silently.
    // The recorded triple is replayed through the same selection rule, which
    // is what keeps a seeded (M2) subset stable here.
    const recorded = previousSummary?.limits;
    if (!recorded) throw new Error(`--judge-only needs the round's summary.json: ${summaryPath}`);
    selected = selectFixtureRows(fixtureRows, {
      only: recorded.only ?? [],
      limit: recorded.limit ?? undefined,
      seed: recorded.seed ?? undefined,
    });
    if (selected.length === 0) throw new Error("--judge-only found no recorded selection to judge");
  }
  if (selected.length === 0) throw new Error("no fixture rows selected");

  const cacheFile = path.join(options.cache, "merge-bases.json");
  const store = new MergeBaseStore(cacheFile, loadMergeBaseCache(cacheFile));
  const resolve = deps.resolveMergeBase ?? resolveMergeBase;
  let configRoot = null;
  try {
    configRoot = mkdtempSync(path.join(tmpdir(), "pir-aacr-m1-config-"));
    const config = snapshotConfig(configRoot, env);
    const model = options.model ?? config.model;
    if (!model) throw new Error("set --model or PIR_MODEL, or configure a default pi model (M1 results must name the exact model id)");

    // Provenance guards: one round = one model, one CLI build, one fixture,
    // one view/repeat configuration. A silent mix publishes numbers under a
    // stamp that describes only half of them (M0 dogfood F-185, extended here).
    if (previousSummary) {
      assertResumeCompatible(previousSummary, { model, cliSha256 });
      if (previousSummary.fixture?.sha256 && previousSummary.fixture.sha256 !== fixtureSha256) {
        throw new Error(`--resume refuses to mix fixtures: round was recorded with ${previousSummary.fixture.sha256}, this fixture is ${fixtureSha256} (rebuild the round)`);
      }
      if (previousSummary.repeats !== undefined && previousSummary.repeats !== options.repeats) {
        throw new Error(`--resume refuses to mix repeat counts: round was recorded with ${previousSummary.repeats}, this invocation uses ${options.repeats}`);
      }
      if (previousSummary.view && previousSummary.view !== options.view) {
        throw new Error(`--resume refuses to mix views: round was recorded with ${previousSummary.view}, this invocation uses ${options.view}`);
      }
      assertSelectionCompatible(previousSummary, { selected, seed: options.seed, judgeOnly: options.judgeOnly });
    }

    const dirs = Array.from({ length: options.repeats }, (_, index) => repeatDirFor(roundDir, options.repeats, index + 1));
    for (const dir of dirs) {
      for (const view of options.views) mkdirSync(path.join(dir, view), { recursive: true });
      mkdirSync(path.join(dir, "rows"), { recursive: true });
    }
    const runRoot = path.join(options.outRoot, ".cache", roundName);
    const workRoot = path.join(runRoot, "work");
    mkdirSync(workRoot, { recursive: true });

    // Repo cache init is local (init + remote) and runs before the pool, so
    // no synchronous git call ever lands inside a worker.
    const repos = new Map();
    const repoErrors = new Map();
    for (const row of selected) {
      if (repos.has(row.repo) || repoErrors.has(row.repo)) continue;
      try {
        repos.set(row.repo, ensureRepoCache(options.cache, row.repo, { remote: row.clone_url }));
      } catch (error) {
        repoErrors.set(row.repo, String(error?.message ?? error));
      }
    }

    const groups = new Map();
    selected.forEach((row, index) => {
      if (!groups.has(row.repo)) groups.set(row.repo, []);
      groups.get(row.repo).push({ row, index });
    });
    const population = {
      selected: selected.length,
      repos: groups.size,
      repeats: options.repeats,
      byRepo: Object.fromEntries([...groups].map(([repo, entries]) => [repo, entries.length])),
      fixtureRows: fixtureRows.length,
    };
    const previousInstances = new Map((previousSummary?.instances ?? []).map((entry) => [`${entry.repeat}|${entry.safeId}`, entry]));
    const summary = {
      schemaVersion: 1,
      round: roundName,
      startedAt: previousSummary?.startedAt ?? new Date().toISOString(),
      resumedAt: options.resume ? new Date().toISOString() : undefined,
      node: process.version,
      model,
      cli: { path: options.cli, sha256: cliSha256 },
      fixture: {
        path: options.fixture,
        sha256: fixtureSha256,
        upstream: { repo: header.dataset.repo, commit: header.dataset.commit, file: header.dataset.file, sha256: header.dataset.sha256, records: header.dataset.records },
        citation: header.citation ?? null,
        instanceSetDigest: fixtureDigest(selected),
      },
      view: options.view,
      views: options.views,
      repeats: options.repeats,
      limits: {
        limit: options.limit ?? null, seed: options.seed ?? null, only: options.only, concurrency: options.concurrency,
        maxRounds: options.maxRounds, maxTokens: MAX_TOKENS, maxFindings: MAX_FINDINGS,
        timeoutMs: options.timeoutMs, cache: options.cache, judge: options.judge, evalRounds: options.evalRounds,
        // ADR-0009 §10: only a real-judge run with the exact judge model
        // recorded qualifies for comparison; record it with the other pins.
        judgeModel: options.judge === "real" ? (env.JUDGE_MODEL ?? null) : null,
        judgeTimeoutMs: options.judge === "real" ? resolveJudgeTimeoutMs(env) : null,
        judgeOnly: options.judgeOnly,
      },
      config,
      population,
      instances: [],
      repoCounts: {},
      incompleteInstances: 0,
      errors: [],
      // --judge off preserves a resumed round's prior judge results; an
      // active judge mode re-judges from scratch (the result dirs are the
      // current run's, so stale scores would not describe them).
      judge: options.judge === "off" ? (previousSummary?.judge ?? []) : [],
    };
    // finishedAt is absent while the round runs: a summary without it came
    // from an interrupted (partial) round.
    delete summary.finishedAt;
    const entries = new Map();
    const flush = () => {
      const sorted = [...entries.values()].sort((a, b) => a.index - b.index || a.repeat - b.repeat);
      summary.instances = sorted.map((entry) => {
        const { findings, ...visible } = entry;
        return visible;
      });
      summary.repoCounts = {};
      for (const entry of sorted) {
        const bucket = summary.repoCounts[entry.repo] ?? { total: 0, ok: 0, error: 0, reused: 0 };
        bucket.total += 1;
        if (entry.status === "error") bucket.error += 1;
        else if (entry.status === "reused") bucket.reused += 1;
        else bucket.ok += 1;
        summary.repoCounts[entry.repo] = bucket;
      }
      summary.incompleteInstances = sorted.filter((entry) => entry.incomplete === true).length;
      const instanceErrors = sorted.filter((entry) => entry.status === "error")
        .map((entry) => `${entry.instanceId} repeat ${entry.repeat}: ${entry.error}`);
      const judgeErrors = summary.judge.filter((result) => result.ok === false)
        .map((result) => `judge ${result.judgeMode} ${result.runId}: ${result.error}`);
      summary.errors = [...instanceErrors, ...judgeErrors];
      writeJson(summaryPath, summary);
    };

    const runOne = async ({ row, index, repeat }) => {
      const id = safeId(row.instance_id);
      const repeatDir = dirs[repeat - 1];
      const provenance = {
        schemaVersion: 1,
        round: roundName,
        repeat,
        index,
        instanceId: row.instance_id,
        safeId: id,
        repo: row.repo,
        baseCommit: row.base_commit,
        headCommit: row.head_commit,
        model,
        cliSha256,
        fixtureSha256,
      };
      const reuse = options.resume ? previousInstances.get(`${repeat}|${id}`) : null;
      if (reuse && reuse.status !== "error" &&
          reuse.fixtureSha256 === fixtureSha256 && reuse.model === model && reuse.cliSha256 === cliSha256 &&
          options.views.every((view) => existsSync(resultFileFor(repeatDir, view, id)))) {
        console.error(`REUSED ${id} repeat ${repeat}`);
        return { ...reuse, index, repeat, status: "reused" };
      }

      // A rerun must not leave a previous attempt's result file behind: a
      // stale file for an instance that now errors would be judged as a real
      // result. Reuse returned above, so these are never touching live output.
      for (const view of options.views) rmSync(resultFileFor(repeatDir, view, id), { force: true });

      let repoDir = repos.get(row.repo) ?? null;
      let checkout = null;
      let stage = "repo";
      try {
        if (repoDir === null) throw failure(`repo cache init failed: ${repoErrors.get(row.repo) ?? "unknown"}`);
        if (row.base_commit === row.head_commit) throw failure("base_commit and head_commit are identical (empty review range)");
        stage = "fetch-head";
        await ensureFetchedAsync(repoDir, row.head_commit, { timeoutMs: options.timeoutMs, env });
        stage = "merge-base";
        const { diffBase, diffBaseKind, resolveError } = await resolveInstanceBase({ row, store, env, resolve });
        if (diffBase === row.head_commit) throw failure(`merge base equals head (${diffBase}); empty review range`);
        if (diffBaseKind === "base-tip") {
          console.error(`WARN ${id} merge base unavailable (${resolveError}); using base tip ${row.base_commit} for this instance (not cached)`);
        }
        stage = "fetch-base";
        await ensureFetchedAsync(repoDir, diffBase, { timeoutMs: options.timeoutMs, env });
        stage = "ancestry";
        const { reviewHead, syntheticHead, syntheticTree } = await resolveReviewHead({
          repoDir, head: row.head_commit, diffBase, env, timeoutMs: options.timeoutMs,
        });
        stage = "checkout";
        checkout = await materializeTaskAsync(repoDir, row.head_commit, path.join(workRoot, id, `r${repeat}`), {
          timeoutMs: options.timeoutMs, env,
        });
        stage = "cli";
        const runDir = path.join(runRoot, `r${repeat}`, id);
        rmSync(runDir, { recursive: true, force: true });
        mkdirSync(runDir, { recursive: true });
        for (const dir of ["agent", "config"]) cpSync(path.join(configRoot, dir), path.join(runDir, dir), { recursive: true });
        let run;
        try {
          run = await runCliOnce({
            cli: options.cli, checkout, base: diffBase, head: reviewHead,
            maxRounds: options.maxRounds, model, runDir, timeoutMs: options.timeoutMs, env,
          });
        } finally {
          // The credential snapshot is per-instance and must not outlive its
          // CLI process. The run's cold memory DB stays for debugging.
          rmSync(path.join(runDir, "agent"), { recursive: true, force: true });
          rmSync(path.join(runDir, "config"), { recursive: true, force: true });
        }
        if (!run.ok) {
          throw failure(run.error, { stderrText: run.stderr, stdoutText: run.stdout, wallTimeMs: run.wallTimeMs, exitCode: run.exitCode });
        }
        stage = "normalize";
        let normalized;
        try {
          normalized = normalizeFindings(run.envelope);
        } catch (error) {
          throw failure(String(error?.message ?? error), { stderrText: run.stderr, stdoutText: run.stdout, wallTimeMs: run.wallTimeMs, exitCode: run.exitCode });
        }
        const upstreamFiles = {};
        for (const view of options.views) {
          const file = resultFileFor(repeatDir, view, id);
          writeJson(file, toUpstreamResult(normalized, { view }));
          upstreamFiles[view] = file;
        }
        // Exit 3 always means incomplete even if the envelope does not repeat
        // it; the envelope's own flag/pending work is additive.
        const incomplete = run.exitCode === 3 || run.data?.incomplete === true || (run.data?.pendingCandidates ?? 0) > 0;
        const entry = {
          ...provenance,
          status: "ok",
          diffBase,
          diffBaseKind,
          resolveError: resolveError ?? null,
          reviewHead,
          syntheticHead,
          syntheticTree,
          views: { reported: normalized.reported.length, confirmedOnly: normalized.confirmedOnly.length },
          dropped: normalized.dropped,
          durationSeconds: normalized.durationSeconds,
          usage: normalized.usage,
          usageComplete: run.data?.usageComplete ?? null,
          exitCode: run.exitCode,
          wallTimeMs: run.wallTimeMs,
          stoppedBecause: run.data?.stoppedBecause ?? null,
          incomplete,
          pendingCandidates: run.data?.pendingCandidates ?? 0,
          stderrTail: stderrTail(run.stderr),
          upstreamFiles,
        };
        const rowFile = {
          ...entry,
          findings: { reported: normalized.reported, confirmedOnly: normalized.confirmedOnly },
        };
        writeJson(rowFileFor(repeatDir, id), rowFile);
        const label = incomplete ? "INCOMPLETE" : "OK";
        console.error(`${label} ${id} repeat ${repeat} ${normalized.reported.length} reported (${normalized.confirmedOnly.length} confirmed)` +
          `${normalized.dropped.anchorless > 0 ? ` [WARN dropped ${normalized.dropped.anchorless} anchorless]` : ""}` +
          ` exit=${run.exitCode}${incomplete ? ` stoppedBecause=${run.data?.stoppedBecause ?? "?"} pending=${run.data?.pendingCandidates ?? 0}` : ""}` +
          ` diffBase=${diffBaseKind}${syntheticHead ? " synthetic-head" : ""} ${run.wallTimeMs}ms tokens=${normalized.usage?.total_tokens ?? "?"}`);
        return entry;
      } catch (error) {
        const entry = {
          ...provenance,
          status: "error",
          stage,
          error: String(error?.message ?? error),
          exitCode: error?.exitCode ?? null,
          wallTimeMs: error?.wallTimeMs ?? null,
          diffBase: null,
          diffBaseKind: null,
          reviewHead: null,
          syntheticHead: null,
          views: null,
          dropped: null,
          usage: null,
          durationSeconds: null,
          stderrTail: stderrTail(error?.stderrText ?? ""),
          stdoutTail: stderrTail(error?.stdoutText ?? ""),
        };
        const rowFile = { ...entry, findings: null };
        writeJson(rowFileFor(repeatDir, id), rowFile);
        console.error(`ERROR ${id} repeat ${repeat} ${stage}: ${entry.error}`);
        return entry;
      } finally {
        if (checkout) {
          try {
            await releaseTaskAsync(repoDir, checkout, { timeoutMs: options.timeoutMs, env });
          } catch (error) {
            console.error(`WARN ${id} could not release worktree: ${String(error?.message ?? error)}`);
          }
        }
      }
    };

    if (options.judgeOnly) {
      for (const entry of previousSummary?.instances ?? []) {
        entries.set(`${entry.repeat}|${entry.safeId}`, entry);
      }
    }
    // Cross-repo concurrency, same-repo serial: a repo's instances share one
    // cache directory, so concurrent fetches/worktree mutations would race.
    const queue = [...groups.values()];
    let next = 0;
    const worker = async () => {
      while (next < queue.length) {
        const group = queue[next++];
        for (const { row, index } of group) {
          for (let repeat = 1; repeat <= options.repeats; repeat += 1) {
            const entry = await runOne({ row, index, repeat });
            entries.set(`${repeat}|${entry.safeId}`, entry);
            flush();
          }
        }
      }
    };
    if (!options.judgeOnly) {
      await Promise.all(Array.from({ length: Math.min(options.concurrency, Math.max(1, queue.length)) }, worker));
    }
    await store.settle();

    if (options.judge !== "off") {
      for (let repeat = 1; repeat <= options.repeats; repeat += 1) {
        for (const view of options.views) {
          const runId = judgeRunId({ round: roundName, view, repeat });
          console.error(`JUDGE ${options.judge} ${view} repeat ${repeat} -> ${runId}`);
          try {
            const result = await runJudge({
              judgeMode: options.judge, judgeDir, pin: judgePin, rows: selected,
              resultsDir: path.join(dirs[repeat - 1], view), view, repeat, runId, env,
              evalRounds: options.evalRounds,
              timeoutMs: resolveJudgeTimeoutMs(env),
            });
            summary.judge.push(result);
            if (!result.ok) console.error(`ERROR judge ${runId}: ${result.error}`);
            else console.error(`JUDGE OK ${runId} balanced_score=${result.summary?.balanced_score ?? "?"}`);
          } catch (error) {
            summary.judge.push({ ok: false, judgeMode: options.judge, runId, view, repeat, error: String(error?.message ?? error) });
            console.error(`ERROR judge ${runId}: ${String(error?.message ?? error)}`);
          }
          flush();
        }
      }
    }

    summary.finishedAt = new Date().toISOString();
    flush();
    const errorCount = summary.errors.length;
    if (options.json) {
      console.log(JSON.stringify(summary));
    } else {
      console.log(JSON.stringify({
        round: roundName,
        roundDir,
        instances: summary.instances.length,
        views: options.views,
        repeats: options.repeats,
        repoCounts: summary.repoCounts,
        incompleteInstances: summary.incompleteInstances,
        judge: summary.judge.map((result) => ({
          judgeMode: result.judgeMode, runId: result.runId, ok: result.ok,
          metricsPath: result.metricsPath ?? null, balanced_score: result.summary?.balanced_score ?? null,
        })),
        errors: errorCount > 0 ? summary.errors : undefined,
      }, null, 2));
    }
    return errorCount > 0 ? 1 : 0;
  } finally {
    if (configRoot) rmSync(configRoot, { recursive: true, force: true });
  }
}

// Cheap directory listing used by the summary/debug paths; exported so tests
// can enumerate a round without re-implementing the layout.
export function listResultFiles(repeatDir, view) {
  try {
    return readdirSync(path.join(repeatDir, view)).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((error) => { console.error(error); process.exitCode = 3; });
}
