#!/usr/bin/env node
/**
 * AACR-Bench M0 — eval driver (roadmap T4).
 *
 * Spawns `pir _verify-comment` once per materialized comment with the same
 * environment isolation ReviewBench uses (tests/eval/reviewbench/run-rb.js):
 * redirected HOME/XDG, per-task cold PIR_MEMORY_DB, ephemeral credential
 * snapshot, PIR_MODE=local, PIR_TRANSCRIPTS=0, --local and --plugins none.
 * The engine under test is the built CLI, so the benchmark measures shipped
 * behavior; nothing here imports dist.
 *
 * Arms: verifier (repository-aware runVerifier) and ocr (ported reflection
 * prompt, diff-only) run over the SAME sample and model, so score.js can put
 * them side by side on one caliber.
 *
 * Opt-in eval surface: without PIR_EVAL=1 this exits 0 with a skip notice and
 * touches nothing; importing the module has no side effects.
 */
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { snapshotConfig } from "../run-eval.js";
import { DEFAULT_CACHE, directoryBytes, ensureRepoCache, git, gitEnv, readMaterialized } from "./materialize.js";
import { loadMeta, DEFAULT_META } from "./fetch-dataset.js";

const HERE = fileURLToPath(new URL("./", import.meta.url));
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const DEFAULT_MATERIALIZED = path.join(HERE, "dataset", "materialized.jsonl");
export const DEFAULT_OUT_ROOT = path.join(HERE, "out");
export const ARMS = ["verifier", "ocr"];

export const sha256 = (value) => createHash("sha256").update(value).digest("hex");

/**
 * Build identity for provenance. `dist/cli/cli.js` is a thin dispatcher, so
 * hashing that one file cannot tell two engines apart — B4's before/after
 * rounds proved it: the pre- and post-B4 builds share cli.js byte for byte
 * while behaving differently. The digest therefore covers every built module
 * under dist/ (sorted path + content), which changes whenever any behavior
 * does.
 */
export function buildDigest(distRoot) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".js")) files.push(full);
    }
  };
  walk(distRoot);
  files.sort();
  const hash = createHash("sha256");
  for (const file of files) hash.update(path.relative(distRoot, file)).update("\0").update(readFileSync(file)).update("\0");
  return hash.digest("hex");
}

/** Per-task worktree: detached head checkout, reclaimed after its run. */
export function materializeTask(repoDir, head, workDir) {
  if (existsSync(workDir)) {
    rmSync(workDir, { recursive: true, force: true });
    git(repoDir, ["worktree", "prune"]);
  }
  mkdirSync(path.dirname(workDir), { recursive: true });
  git(repoDir, ["worktree", "add", "--detach", workDir, head]);
  return workDir;
}

export function releaseTask(repoDir, workDir) {
  try {
    git(repoDir, ["worktree", "remove", "--force", workDir]);
  } catch {
    rmSync(workDir, { recursive: true, force: true });
    try { git(repoDir, ["worktree", "prune"]); } catch { /* best effort */ }
  }
}

/**
 * Async twins of the per-task git helpers, for the driver only.
 *
 * `git()` in materialize.js is execFileSync: correct for the materializer's
 * sequential loop, but inside the driver it blocks the whole event loop, so
 * every worker's checkout serializes against every other worker's — at
 * full-corpus scale (2,134 comments) that alone is hours of dead time. These
 * keep the same commands and error contract while letting the workers'
 * checkouts overlap. The sync originals stay exported for the fixture tests.
 */
const execFileAsync = promisify(execFile);

async function gitAsync(cwd, args, { env = process.env, timeoutMs = 600_000 } = {}) {
  return execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8", env: gitEnv(env), maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs,
  });
}

async function hasCommitAsync(repoDir, sha) {
  try {
    await gitAsync(repoDir, ["cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/** Depth-1 fetch of exactly one commit, without blocking the event loop. */
export async function ensureFetchedAsync(repoDir, sha, { timeoutMs } = {}) {
  if (await hasCommitAsync(repoDir, sha)) return { fetched: false };
  await gitAsync(repoDir, ["fetch", "--depth", "1", "--no-tags", "origin", sha], { timeoutMs });
  if (!(await hasCommitAsync(repoDir, sha))) throw new Error(`fetched but still missing: ${sha}`);
  return { fetched: true };
}

export async function materializeTaskAsync(repoDir, head, workDir) {
  if (existsSync(workDir)) {
    rmSync(workDir, { recursive: true, force: true });
    await gitAsync(repoDir, ["worktree", "prune"]);
  }
  mkdirSync(path.dirname(workDir), { recursive: true });
  await gitAsync(repoDir, ["worktree", "add", "--detach", workDir, head]);
  return workDir;
}

export async function releaseTaskAsync(repoDir, workDir) {
  try {
    await gitAsync(repoDir, ["worktree", "remove", "--force", workDir]);
  } catch {
    rmSync(workDir, { recursive: true, force: true });
    try { await gitAsync(repoDir, ["worktree", "prune"]); } catch { /* best effort */ }
  }
}

export function parseOptions(argv = [], env = process.env) {
  const values = {
    materialized: env.PIR_AACR_MATERIALIZED ?? DEFAULT_MATERIALIZED,
    meta: env.PIR_AACR_META ?? DEFAULT_META,
    cache: env.PIR_AACR_CACHE ?? DEFAULT_CACHE,
    outRoot: env.PIR_AACR_OUT ?? DEFAULT_OUT_ROOT,
    cli: env.PIR_AACR_CLI ?? path.join(ROOT, "dist/cli/cli.js"),
    model: env.PIR_AACR_MODEL ?? env.PIR_MODEL,
    arms: (env.PIR_AACR_ARMS ?? "verifier,ocr").split(",").map((s) => s.trim()).filter(Boolean),
    limit: env.PIR_AACR_LIMIT === undefined ? undefined : Number(env.PIR_AACR_LIMIT),
    seed: Number(env.PIR_AACR_SEED ?? 42),
    round: env.PIR_AACR_ROUND,
    concurrency: Number(env.PIR_AACR_CONCURRENCY ?? 2),
    timeoutMs: Number(env.PIR_AACR_TASK_TIMEOUT_MS ?? 1200000),
    only: env.PIR_AACR_ONLY ? env.PIR_AACR_ONLY.split(",").map((s) => s.trim()).filter(Boolean) : [],
    resume: false,
    json: env.PIR_EVAL_JSON === "1",
    help: false,
  };
  const flags = { "--materialized": "materialized", "--meta": "meta", "--cache": "cache", "--out-root": "outRoot", "--cli": "cli", "--model": "model", "--limit": "limit", "--seed": "seed", "--round": "round", "--concurrency": "concurrency", "--task-timeout": "timeoutMs", "--arms": "arms" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--resume") { values.resume = true; continue; }
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
  if (typeof values.arms === "string") values.arms = values.arms.split(",").map((s) => s.trim()).filter(Boolean);
  for (const key of ["limit", "seed", "concurrency", "timeoutMs"]) if (typeof values[key] === "string") values[key] = Number(values[key]);
  for (const arm of values.arms) if (!ARMS.includes(arm)) throw new Error(`unknown arm: ${arm} (available: ${ARMS.join(", ")})`);
  if (values.arms.length === 0) throw new Error("--arms must name at least one arm");
  for (const key of ["limit", "concurrency", "seed", "timeoutMs"]) {
    const value = values[key];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < (key === "seed" ? 0 : 1)) throw new Error(`${key} must be ${key === "seed" ? "a non-negative" : "a positive"} integer`);
  }
  for (const key of ["materialized", "meta", "cache", "outRoot", "cli"]) values[key] = path.resolve(values[key]);
  return values;
}

/** A resumed round may reuse a row only when it finished cleanly (dogfood F-182). */
export function isReusableRow(row) {
  return row?.status === "ok";
}

/** Every arm row that already finished cleanly for `taskId` can be reused. */
export function reusableForTask(previous, arms, taskId) {
  return arms.every((arm) => isReusableRow(previous.get(`${arm}|${taskId}`)));
}

/**
 * Scan an existing round directory for resumable rows. Error rows are read and
 * returned like any other row (the caller retries them) and counted per arm, so
 * a resume that retries and fixes them still reports the errors the round
 * recorded (dogfood F-182, F-189).
 */
export function readPreviousRound(roundDir, arms) {
  const rows = new Map();
  const errors = Object.fromEntries(arms.map((arm) => [arm, 0]));
  for (const arm of arms) {
    const armDir = path.join(roundDir, arm);
    if (!existsSync(armDir)) continue;
    for (const file of readdirNames(armDir)) {
      if (!file.endsWith(".json")) continue;
      const id = file.replace(/\.json$/, "");
      let row = null;
      try {
        row = JSON.parse(readFileSync(path.join(armDir, file), "utf8"));
      } catch {
        // An unreadable row cannot be proven clean, so it is retried.
      }
      rows.set(`${arm}|${id}`, row);
      if (row?.status === "error") errors[arm] += 1;
    }
  }
  return { rows, errors };
}

/** Per-arm summary counts; errors seen on disk stay visible across a resume. */
export function summarizeArm(rowsForArm, previousErrorCount = 0) {
  return {
    rows: rowsForArm.length,
    ok: rowsForArm.filter((run) => run.status === "ok").length,
    errors: Math.max(previousErrorCount, rowsForArm.filter((run) => run.status === "error").length),
    reused: rowsForArm.filter((run) => run.status === "reused").length,
  };
}

function stderrTail(text, lines = 12) {
  return String(text ?? "").trim().split("\n").slice(-lines).join("\n");
}

/** One spawned CLI run per (comment, arm); resolves with the parsed score row. */
export function runCliOnce({ cli, taskFile, arm, checkout, model, runDir, timeoutMs, env }) {
  const args = ["_verify-comment", "--task-file", taskFile, "--arm", arm, "--json", "--quiet", "--local", "--cwd", checkout, "--plugins", "none"];
  if (model) args.push("--model", model);
  mkdirSync(path.join(runDir, "home"), { recursive: true });
  return new Promise((resolve) => {
    const start = performance.now();
    let stdout = "";
    let stderr = "";
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: checkout,
      env: gitEnv(env, {
        HOME: path.join(runDir, "home"),
        XDG_STATE_HOME: path.join(runDir, "state"), XDG_CACHE_HOME: path.join(runDir, "cache"),
        XDG_CONFIG_HOME: path.join(runDir, "xdg-config"),
        PIR_STATE_ROOT: path.join(runDir, "state"),
        PIR_MEMORY_DB: path.join(runDir, "state/memory.sqlite"), PIR_CONFIG_DIR: path.join(runDir, "config"),
        PI_CODING_AGENT_DIR: path.join(runDir, "agent"), PIR_NO_WIZARD: "1", PIR_TRANSCRIPTS: "0",
        PIR_MODE: "local", PIR_EVAL: "1",
        ...(model ? { PIR_MODEL: model } : {}),
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const MAX_BUFFER = 16 * 1024 * 1024;
    child.stdout.on("data", (chunk) => { if (stdout.length < MAX_BUFFER) stdout += chunk; });
    child.stderr.on("data", (chunk) => { if (stderr.length < MAX_BUFFER) stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, wallTimeMs: Math.round(performance.now() - start), error: error.message, stderr });
    });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      const wallTimeMs = Math.round(performance.now() - start);
      if (status !== 0) {
        resolve({ ok: false, wallTimeMs, error: `CLI exited ${status}${signal ? ` signal ${signal}` : ""}`, stdout, stderr });
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        if (!parsed?.data || typeof parsed.data !== "object") throw new Error("missing data object");
        resolve({ ok: true, wallTimeMs, data: parsed.data, stderr });
      } catch (error) {
        resolve({ ok: false, wallTimeMs, error: `CLI stdout is not the expected JSON: ${error.message}`, stdout, stderr });
      }
    });
  });
}

/** Score row: the CLI result plus the dataset label and bucket fields it is scored against. */
export function scoreRow(task, arm, run) {
  const comment = task.comment;
  const base = {
    id: task.id,
    arm,
    label: comment.label,
    buckets: {
      source_model: comment.source_model ? comment.source_model : (comment.is_ai_comment ? "unknown-ai" : "human"),
      category: comment.category ?? "unknown",
      context: comment.context ?? "unknown",
      is_ai_comment: Boolean(comment.is_ai_comment),
    },
    pr: { nwo: comment.nwo ?? null, pr_number: comment.pr_number ?? null, path: comment.path },
  };
  if (!run.ok) return { ...base, status: "error", error: run.error, wallTimeMs: run.wallTimeMs, stderrTail: stderrTail(run.stderr) };
  const data = run.data;
  return {
    ...base,
    status: "ok",
    decision: data.decision,
    verdict: data.verdict ?? null,
    confidence: data.confidence ?? null,
    uncertaintyReason: data.uncertaintyReason ?? null,
    // B4: the ground a rejection named, so score.js can bucket kills by reason.
    rejectionGround: data.rejectionGround ?? null,
    rationale: data.rationale ?? null,
    ocrDecision: data.ocrDecision ?? null,
    ocrReason: data.ocrReason ?? null,
    model: data.model ?? null,
    head: data.head, diffBase: data.diffBase, diffBaseKind: data.diffBaseKind,
    pathInDiff: Boolean(data.pathInDiff),
    usage: data.usage ?? null,
    wallTimeMs: run.wallTimeMs,
    cliDurationMs: data.durationMs ?? null,
  };
}

/**
 * F-185: --resume must not stamp old rows with a new model or CLI build. A
 * round's provenance is one model id and one build, so a resume that changes
 * either would publish mixed numbers under a stamp that describes only half of
 * them. The build identity is the full dist digest (see buildDigest); the
 * entry-file sha256 stays as a compatibility check for rounds recorded before
 * the digest existed.
 */
export function assertResumeCompatible(previousSummary, { model, cliSha256, buildSha256 }) {
  if (!previousSummary) return;
  if (previousSummary.model && previousSummary.model !== model) {
    throw new Error(`--resume refuses to mix models: round was recorded with ${previousSummary.model}, this invocation uses ${model} (pick a fresh --round name)`);
  }
  const previousBuild = previousSummary.cli?.buildSha256;
  if (previousBuild && buildSha256 && previousBuild !== buildSha256) {
    throw new Error(`--resume refuses to mix CLI builds: round was recorded with build digest ${previousBuild}, this build is ${buildSha256} (rebuild, then pick a fresh --round name)`);
  }
  const previousCli = previousSummary.cli?.sha256;
  if (previousCli && cliSha256 && previousCli !== cliSha256) {
    throw new Error(`--resume refuses to mix CLI builds: round was recorded with dist/cli/cli.js sha256 ${previousCli}, this build is ${cliSha256} (rebuild, then pick a fresh --round name)`);
  }
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseOptions(argv, env);
  if (options.help) {
    console.log("PIR_EVAL=1 node tests/eval/aacr/run-m0.js [--materialized dataset/materialized.jsonl] [--round <name>] [--limit N] [--only <comment-id>]... [--arms verifier,ocr] [--model provider/model] [--concurrency N] [--task-timeout ms] [--cli dist/cli/cli.js] [--cache ~/.cache/pir-aacr] [--resume] [--json]\n" +
      "Runs pir _verify-comment once per materialized comment per arm with rb-grade isolation (cold memory, redirected HOME/XDG, --local --plugins none), writing <out-root>/<round>/<arm>/<id>.json incrementally.");
    return 0;
  }
  if (env.PIR_EVAL !== "1") {
    console.log(options.json ? JSON.stringify({ skipped: true, reason: "PIR_EVAL=1 required" }) : "skipped: set PIR_EVAL=1 to allow model evaluation");
    return 0;
  }
  if (!existsSync(options.cli) || !statSync(options.cli).isFile()) throw new Error(`CLI is not a file: ${options.cli} (run npm run build:cli)`);
  const { header, rows } = readMaterialized(options.materialized);
  if (!header) throw new Error(`materialized file has no provenance header: ${options.materialized} (run materialize.js)`);
  const meta = loadMeta(options.meta);
  if (header.dataset?.sha256 !== meta.dataset.sha256) throw new Error("materialized JSONL was built from a different dataset revision than meta.json pins");
  if (!options.model) throw new Error("set --model or PIR_MODEL (M0 results must name the exact model id)");

  const usable = rows.filter((row) => !row.error);
  const materializationErrors = rows.filter((row) => row.error);
  let selected = usable;
  if (options.only.length > 0) {
    const wanted = new Set(options.only);
    selected = selected.filter((row) => wanted.has(row.id));
    const missing = [...wanted].filter((id) => !selected.some((row) => row.id === id));
    if (missing.length > 0) throw new Error(`--only ids not materialized: ${missing.join(", ")}`);
  }
  if (options.limit !== undefined) selected = selected.slice(0, options.limit);

  const roundName = options.round ?? `${new Date().toISOString().slice(0, 10)}-m0`;
  // Degraded base-tip rows are scored normally but must be visible in every
  // summary: their material is the capture-time pair ADR-0007 §7 warns about
  // (dogfood F-181).
  const population = { materializedRows: rows.length, usable: usable.length, materializationErrors: materializationErrors.length, degradedDiffBases: usable.filter((row) => row.material?.diffBaseKind === "base-tip").length, selected: selected.length };
  const roundDir = path.join(options.outRoot, roundName);
  let previous = new Map();
  let previousErrors = Object.fromEntries(options.arms.map((arm) => [arm, 0]));
  const cliSha256 = sha256(readFileSync(options.cli));
  const buildSha256 = buildDigest(path.resolve(path.dirname(options.cli), ".."));
  let startedAt = new Date().toISOString();
  if (existsSync(roundDir)) {
    if (!options.resume) throw new Error(`round directory already exists: ${roundDir} (pick a fresh --round name, remove it, or pass --resume)`);
    const scanned = readPreviousRound(roundDir, options.arms);
    previous = scanned.rows;
    previousErrors = scanned.errors;
    const summaryPath = path.join(roundDir, "summary.json");
    if (existsSync(summaryPath)) {
      const previousSummary = JSON.parse(readFileSync(summaryPath, "utf8"));
      if (previousSummary.startedAt) startedAt = previousSummary.startedAt;
      assertResumeCompatible(previousSummary, { model: options.model, cliSha256, buildSha256 });
    }
  }
  mkdirSync(roundDir, { recursive: true });
  const configRoot = mkdtempSync(path.join(tmpdir(), "pir-m0-config-"));
  const runRoot = path.join(options.outRoot, ".cache", roundName);
  const summary = {
    schemaVersion: 1, round: roundName, startedAt, resumedAt: options.resume ? new Date().toISOString() : undefined,
    node: process.version,
    model: options.model,
    cli: { path: options.cli, sha256: cliSha256, buildSha256 },
    dataset: header.dataset, sample: header.sample, citation: header.citation,
    limits: { limit: options.limit ?? null, arms: options.arms, concurrency: options.concurrency, timeoutMs: options.timeoutMs, cache: options.cache },
    arms: {}, tasks: [], errors: [],
  };
  summary.population = population;
  try {
    const config = snapshotConfig(configRoot, env);
    summary.config = config;
    const workRoot = path.join(runRoot, "work");
    let dispatched = 0;
    let anyError = false;
    const flush = () => writeFileSync(path.join(roundDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);

    const runTask = async (task) => {
      const taskRow = { id: task.id, index: task.index, label: task.comment.label, path: task.comment.path, runs: [] };
      // A resumed round whose every arm row already exists needs no checkout:
      // paying the fetch/worktree cycle per reused task serializes the whole
      // resume behind git for no new evidence.
      if (options.resume && reusableForTask(previous, options.arms, task.id)) {
        for (const arm of options.arms) {
          console.error(`REUSED ${arm} ${task.id}`);
          taskRow.runs.push({ arm, status: "reused" });
        }
        summary.tasks.push(taskRow);
        flush();
        return;
      }
      let repoDir = null;
      let checkout = null;
      try {
        repoDir = ensureRepoCache(options.cache, task.comment.nwo);
        await ensureFetchedAsync(repoDir, task.material.head, { timeoutMs: 600000 });
        checkout = await materializeTaskAsync(repoDir, task.material.head, path.join(workRoot, task.id));
      } catch (error) {
        const message = `materialize: ${error?.message ?? error}`;
        console.error(`ERROR ${task.id} ${message}`);
        for (const arm of options.arms) {
          const row = { id: task.id, arm, label: task.comment.label, status: "error", error: message, buckets: {
            source_model: task.comment.source_model ? task.comment.source_model : (task.comment.is_ai_comment ? "unknown-ai" : "human"),
            category: task.comment.category ?? "unknown", context: task.comment.context ?? "unknown", is_ai_comment: Boolean(task.comment.is_ai_comment),
          } };
          writeResult(roundDir, arm, task.id, row);
          taskRow.runs.push({ arm, status: "error", error: message });
          anyError = true;
        }
        summary.tasks.push(taskRow);
        flush();
        return;
      }
      for (const arm of options.arms) {
        const reuse = previous.get(`${arm}|${task.id}`);
        if (options.resume && isReusableRow(reuse)) {
          console.error(`REUSED ${arm} ${task.id}`);
          taskRow.runs.push({ arm, status: "reused" });
          continue;
        }
        const runDir = path.join(runRoot, arm, task.id);
        rmSync(runDir, { recursive: true, force: true });
        mkdirSync(runDir, { recursive: true });
        for (const dir of ["agent", "config"]) cpSync(path.join(configRoot, dir), path.join(runDir, dir), { recursive: true });
        const taskFile = path.join(runDir, "task.json");
        writeFileSync(taskFile, `${JSON.stringify({ id: task.id, index: task.index, comment: task.comment, material: task.material })}\n`);
        const run = await runCliOnce({ cli: options.cli, taskFile, arm, checkout, model: options.model, runDir, timeoutMs: options.timeoutMs, env });
        const row = scoreRow(task, arm, run);
        writeResult(roundDir, arm, task.id, row);
        taskRow.runs.push({ arm, status: row.status, decision: row.decision ?? null, verdict: row.verdict ?? null,
          confidence: row.confidence ?? null, totalTokens: row.usage?.totalTokens ?? null, wallTimeMs: row.wallTimeMs,
          ...(row.error ? { error: row.error } : {}) });
        if (row.status !== "ok") {
          anyError = true;
          summary.errors.push(`${arm} ${task.id}: ${row.error}`);
          console.error(`ERROR ${arm} ${task.id}: ${row.error}`);
        } else {
          console.error(`OK ${arm} ${task.id} decision=${row.decision}${row.verdict ? ` verdict=${row.verdict}` : ""}${row.confidence === null ? "" : ` confidence=${row.confidence}`} ${row.wallTimeMs}ms tokens=${row.usage?.totalTokens ?? "?"}`);
        }
      }
      await releaseTaskAsync(repoDir, checkout);
      summary.tasks.push(taskRow);
      flush();
    };

    const worker = async () => {
      while (dispatched < selected.length) {
        await runTask(selected[dispatched++]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(options.concurrency, Math.max(1, selected.length)) }, worker));
    summary.finishedAt = new Date().toISOString();
    summary.materializationErrors = materializationErrors.length;
    summary.cacheBytes = directoryBytes(options.cache);
    for (const arm of options.arms) {
      const rowsForArm = summary.tasks.flatMap((task) => task.runs.filter((run) => run.arm === arm));
      summary.arms[arm] = summarizeArm(rowsForArm, previousErrors[arm] ?? 0);
    }
    flush();
    console.log(options.json ? JSON.stringify(summary) : JSON.stringify({ round: roundName, roundDir, tasks: summary.tasks.length, arms: summary.arms,
      errors: summary.errors.length > 0 ? summary.errors : undefined, cacheBytes: summary.cacheBytes }, null, 2));
    return anyError ? 1 : 0;
  } finally {
    rmSync(configRoot, { recursive: true, force: true });
  }
}

function readdirNames(dir) {
  try { return readdirSync(dir); } catch { return []; }
}

function writeResult(roundDir, arm, id, row) {
  const dir = path.join(roundDir, arm);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${id}.json`), `${JSON.stringify(row, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((error) => { console.error(error); process.exitCode = 3; });
}
