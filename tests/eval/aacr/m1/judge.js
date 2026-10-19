/**
 * AACR-Bench M1 — judging delegation (roadmap T4).
 *
 * M1 never builds a judge. It reuses the pinned upstream framework
 * (alibaba/aacr-bench @ the commit in meta.json's `framework` block):
 *
 *   1. resolve a depth-1 clone of the pinned commit,
 *   2. write the selected fixture rows as upstream's `evaluation/data/aacr_bench.jsonl`,
 *   3. copy our per-view, upstream-shaped result files into
 *      `evaluation/results/aacr_bench/<reviewer>/<run_id>/`,
 *   4. run `python -m pipeline run --stage eval` from `evaluation/` and relay
 *      the metrics JSON + summary lines.
 *
 * Reviewer: upstream's CLI only accepts ocr|claude|codex, and our result files
 * are OCR-shaped (`review.comments[{content,path,start_line,end_line}]`), so
 * the delegation uses `--reviewer ocr` by default. `evaluate.py`'s OCR builder
 * is exactly the fallback shape M1 writes.
 *
 * Modes:
 *   off   skip entirely
 *   mock  JUDGE_USE_MOCK=true (local similarity; pipeline validation only)
 *   real  JUDGE_BASE_URL / JUDGE_API_KEY / JUDGE_MODEL are required and passed
 *         through; missing credentials fail before any benchmark run starts
 *
 * Nothing here modifies tracked upstream files: writes go only into the
 * gitignored `evaluation/data/` and `evaluation/results/` directories, and the
 * clone itself lives outside this worktree ($PIR_AACR_JUDGE_DIR or
 * $PIR_AACR_CACHE/aacr-bench@<commit>).
 */
import { execFile, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CACHE } from "../materialize.js";

const execFileAsync = promisify(execFile);
const HERE = fileURLToPath(new URL("./", import.meta.url));
const WORKTREE_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
export const DEFAULT_META = path.join(HERE, "..", "meta.json");
export const JUDGE_MODES = ["off", "mock", "real"];
export const UPSTREAM_REVIEWERS = ["ocr", "claude", "codex"];
export const DEFAULT_REVIEWER = "ocr";
export const BENCHMARK_KEY = "aacr_bench";
export const REAL_JUDGE_ENV = ["JUDGE_BASE_URL", "JUDGE_API_KEY", "JUDGE_MODEL"];
export const DEFAULT_GIT_TIMEOUT_MS = 600_000;
export const DEFAULT_JUDGE_TIMEOUT_MS = 1_800_000;

const tail = (text, lines = 20) => String(text ?? "").trim().split("\n").slice(-lines).join("\n");

/** The pinned upstream framework from meta.json (repo + 40-char commit). */
export function loadJudgePin(metaPath = DEFAULT_META) {
  const meta = JSON.parse(readFileSync(metaPath, "utf8"));
  const framework = meta?.framework;
  if (!framework?.repo || !framework?.commit) throw new Error(`meta.json is missing framework.repo/framework.commit: ${metaPath}`);
  if (!/^[0-9a-f]{40}$/.test(String(framework.commit))) throw new Error("meta.json framework.commit must be a 40-char hex sha");
  return { repo: framework.repo, commit: framework.commit, license: framework.license ?? "Apache-2.0", citation: meta.citation ?? null };
}

/** Default judge clone location: outside the worktree, pinned by commit. */
export function judgeCloneDir(pin, env = process.env) {
  if (env.PIR_AACR_JUDGE_DIR) return path.resolve(env.PIR_AACR_JUDGE_DIR);
  return path.join(env.PIR_AACR_CACHE ?? DEFAULT_CACHE, `aacr-bench@${pin.commit}`);
}

function assertOutsideWorktree(dir) {
  const resolved = path.resolve(dir);
  const root = path.resolve(WORKTREE_ROOT);
  if (resolved === root || resolved.startsWith(root + path.sep)) {
    throw new Error(`the judge clone must live outside the worktree: ${resolved} (set PIR_AACR_JUDGE_DIR or PIR_AACR_CACHE outside ${root})`);
  }
}

async function git(cwd, args, { timeoutMs = DEFAULT_GIT_TIMEOUT_MS } = {}) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
      encoding: "utf8", timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    });
    return stdout;
  } catch (error) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${tail(error?.stderr ?? error?.message ?? error, 6)}`);
  }
}

/**
 * Ensure the pinned upstream clone exists at `judgeDir` and is checked out at
 * `pin.commit`. An existing directory at another commit fails loudly: judge
 * drift silently invalidates every comparison (the M2 change protocol depends
 * on the pin).
 */
export async function ensureJudgeCheckout({ judgeDir, pin, timeoutMs = DEFAULT_GIT_TIMEOUT_MS } = {}) {
  const resolved = path.resolve(judgeDir);
  assertOutsideWorktree(resolved);
  const gitDir = path.join(resolved, ".git");
  if (existsSync(resolved) && !existsSync(gitDir)) {
    // Tolerate only an empty leftover directory from a previous failed init.
    if (readdirSync(resolved).length > 0) throw new Error(`judge clone path exists and is not a git repository: ${resolved}`);
  }
  let head = null;
  if (existsSync(gitDir)) {
    try {
      head = (await git(resolved, ["rev-parse", "HEAD"], { timeoutMs })).trim();
    } catch {
      // An interrupted init/fetch can leave .git with an unborn branch. Treat
      // it as resumable; a real clone at another commit is still drift below.
      head = null;
    }
    if (head === pin.commit) return { dir: resolved, cloned: false, commit: head };
    if (head !== null) {
      throw new Error(`judge clone is at ${head}, expected pinned ${pin.commit}: ${resolved} (check out the pinned commit or point PIR_AACR_JUDGE_DIR at a fresh cache path)`);
    }
  }
  mkdirSync(path.dirname(resolved), { recursive: true });
  await git(path.dirname(resolved), ["init", "-q", "-b", "main", resolved], { timeoutMs });
  const remote = pin.repo.endsWith(".git") ? pin.repo : `${pin.repo}.git`;
  try {
    await git(resolved, ["remote", "add", "origin", remote], { timeoutMs });
  } catch {
    await git(resolved, ["remote", "set-url", "origin", remote], { timeoutMs });
  }
  await git(resolved, ["fetch", "--depth", "1", "--no-tags", "origin", pin.commit], { timeoutMs });
  await git(resolved, ["checkout", "-q", "--detach", "FETCH_HEAD"], { timeoutMs });
  const checkedOut = (await git(resolved, ["rev-parse", "HEAD"], { timeoutMs })).trim();
  if (checkedOut !== pin.commit) throw new Error(`judge checkout landed on ${checkedOut}, expected ${pin.commit}`);
  return { dir: resolved, cloned: head === null, commit: checkedOut };
}

export const upstreamEvaluationDir = (judgeDir) => path.join(judgeDir, "evaluation");
export const upstreamDatasetPath = (judgeDir) => path.join(upstreamEvaluationDir(judgeDir), "data", `${BENCHMARK_KEY}.jsonl`);
export const upstreamResultsDir = (judgeDir, reviewer, runId) =>
  path.join(upstreamEvaluationDir(judgeDir), "results", BENCHMARK_KEY, reviewer, runId);
export const upstreamMetricsDir = (judgeDir, reviewer, runId) =>
  path.join(upstreamEvaluationDir(judgeDir), "metrics", BENCHMARK_KEY, reviewer, runId);

/** Standard-format row for upstream's schema.py (extras from the fixture are not forwarded). */
export function upstreamRow(row) {
  return {
    instance_id: row.instance_id,
    repo: row.repo,
    base_commit: row.base_commit,
    head_commit: row.head_commit,
    clone_url: row.clone_url,
    reference_comments: row.reference_comments.map((comment) => ({
      path: comment.path,
      text: comment.text,
      start_line: comment.start_line,
      end_line: comment.end_line,
      side: comment.side,
    })),
  };
}

/** Write upstream's JSONL dataset atomically (only the gitignored data dir is touched). */
export function writeUpstreamDataset(datasetPath, rows) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error("judge dataset needs at least one row");
  mkdirSync(path.dirname(datasetPath), { recursive: true });
  const body = rows.map((row) => JSON.stringify(upstreamRow(row))).join("\n") + "\n";
  const temp = `${datasetPath}.tmp-${process.pid}`;
  writeFileSync(temp, body);
  renameSync(temp, datasetPath);
  return { path: datasetPath, rows: rows.length, bytes: Buffer.byteLength(body) };
}

/** Upstream make_run_id sanitization: [^A-Za-z0-9._-]+ -> "-", trimmed. */
export function sanitizeRunId(value) {
  return String(value ?? "").trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "run";
}

/** One judge run per (round, view, repeat): the directory name in upstream's results tree. */
export function judgeRunId({ round, view, repeat = 1 }) {
  return sanitizeRunId(`${round}-${view}${repeat > 1 ? `-r${repeat}` : ""}`);
}

/** Copy our per-view result files into upstream's run directory (replacing it). */
export function copyResultsIntoUpstream({ sourceDir, destDir }) {
  if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) throw new Error(`result directory does not exist: ${sourceDir}`);
  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });
  let copied = 0;
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    copyFileSync(path.join(sourceDir, entry.name), path.join(destDir, entry.name));
    copied += 1;
  }
  return { destDir, copied };
}

/** Controlled judge environment; real mode fails closed when credentials are missing. */
export function judgeEnv({ judgeMode, env = process.env } = {}) {
  if (!JUDGE_MODES.includes(judgeMode)) throw new Error(`unknown judge mode: ${judgeMode} (available: ${JUDGE_MODES.join(", ")})`);
  if (judgeMode === "off") return {};
  if (judgeMode === "mock") return { ...env, JUDGE_USE_MOCK: "true" };
  assertJudgeEnv("real", env);
  const { JUDGE_USE_MOCK: _ignored, ...rest } = env;
  return {
    ...rest,
    JUDGE_USE_MOCK: "false",
    JUDGE_BASE_URL: env.JUDGE_BASE_URL,
    JUDGE_API_KEY: env.JUDGE_API_KEY,
    JUDGE_MODEL: env.JUDGE_MODEL,
  };
}

/** Throws when --judge real is requested without the three upstream JUDGE_* variables. */
export function assertJudgeEnv(judgeMode, env = process.env) {
  if (!JUDGE_MODES.includes(judgeMode)) throw new Error(`unknown judge mode: ${judgeMode} (available: ${JUDGE_MODES.join(", ")})`);
  if (judgeMode !== "real") return;
  const missing = REAL_JUDGE_ENV.filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new Error(`--judge real needs ${missing.join(", ")} (upstream judge credentials); use --judge mock for a zero-cost pipeline check or --judge off to skip`);
  }
}

/** Prefer upstream's venv when it exists, then PIR_AACR_PYTHON, then python3. */
export function resolvePython(judgeDir, env = process.env) {
  if (env.PIR_AACR_PYTHON) return env.PIR_AACR_PYTHON;
  const venv = path.join(upstreamEvaluationDir(judgeDir), ".venv", "bin", "python");
  return existsSync(venv) ? venv : "python3";
}

/**
 * Pure invocation description (tests assert it without spawning Python).
 * `--reviewer` must be one upstream's CLI accepts; M1's result files use the
 * OCR shape, so `ocr` is the default and the evaluation falls through
 * evaluate.py's OCR builder.
 */
export function buildJudgeInvocation({
  judgeDir, reviewer = DEFAULT_REVIEWER, dataset = `data/${BENCHMARK_KEY}.jsonl`, runId,
  evalRounds = 1, judgeMode = "mock", env = process.env, python,
} = {}) {
  if (!judgeDir) throw new Error("buildJudgeInvocation needs judgeDir");
  if (!UPSTREAM_REVIEWERS.includes(reviewer)) {
    throw new Error(`upstream pipeline --reviewer only accepts ${UPSTREAM_REVIEWERS.join(", ")} (M1 writes OCR-shaped results, use "ocr")`);
  }
  if (!runId) throw new Error("buildJudgeInvocation needs runId");
  if (!Number.isSafeInteger(evalRounds) || evalRounds < 1) throw new Error("evalRounds must be a positive integer");
  const args = ["-m", "pipeline", "run", "--stage", "eval", "--reviewer", reviewer, "--dataset", dataset, "--run-id", runId];
  if (evalRounds > 1) args.push("--eval-rounds", String(evalRounds));
  return {
    command: python ?? resolvePython(judgeDir, env),
    args,
    cwd: upstreamEvaluationDir(judgeDir),
    env: { ...judgeEnv({ judgeMode, env }), PYTHONUNBUFFERED: "1" },
  };
}

function spawnCapture(command, args, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const MAX_BUFFER = 16 * 1024 * 1024;
    let settled = false;
    const finish = (result) => { if (!settled) { settled = true; resolve(result); } };
    let child;
    try {
      child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      finish({ code: null, signal: null, timedOut: false, stdout, stderr, error: String(error?.message ?? error) });
      return;
    }
    child.stdout.on("data", (chunk) => { if (stdout.length < MAX_BUFFER) stdout += chunk; });
    child.stderr.on("data", (chunk) => { if (stderr.length < MAX_BUFFER) stderr += chunk; });
    const terminate = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 10_000).unref?.();
    }, timeoutMs);
    child.on("error", (error) => { clearTimeout(terminate); finish({ code: null, signal: null, timedOut: false, stdout, stderr, error: error.message }); });
    child.on("close", (code, signal) => { clearTimeout(terminate); finish({ code, signal, timedOut: signal != null, stdout, stderr, error: null }); });
  });
}

/** Newest metrics file for this run (the average file when multi-round). */
export function findMetricsFile(metricsDir, reviewer, evalRounds = 1) {
  if (!existsSync(metricsDir)) return null;
  const candidates = readdirSync(metricsDir)
    .filter((name) => name.startsWith(`metrics_${reviewer}_`) && name.endsWith(".json"))
    .map((name) => path.join(metricsDir, name));
  if (candidates.length === 0) return null;
  if (evalRounds > 1) {
    const average = candidates.find((file) => file.endsWith("_average.json"));
    if (average) return average;
  }
  candidates.sort((a, b) => (statSync(b).mtimeMs ?? 0) - (statSync(a).mtimeMs ?? 0));
  return candidates[0];
}

const SUMMARY_LINE = /(precis|recall|balanced|准确率|召回率|平衡分数|missing|缺失|评测结果已保存|评测汇总)/i;

/**
 * Run one delegated evaluation. Never throws for a judge/pipeline failure:
 * the caller records `ok:false` + `error` on the round and keeps the results.
 */
export async function runJudge({
  judgeMode, judgeDir, pin, rows, resultsDir, view, repeat = 1, runId,
  reviewer = DEFAULT_REVIEWER, evalRounds = 1, env = process.env, timeoutMs = DEFAULT_JUDGE_TIMEOUT_MS,
} = {}) {
  if (judgeMode === "off") return { skipped: true, judgeMode };
  assertJudgeEnv(judgeMode, env);
  const checkout = await ensureJudgeCheckout({ judgeDir, pin, timeoutMs: DEFAULT_GIT_TIMEOUT_MS });
  const dataset = writeUpstreamDataset(upstreamDatasetPath(judgeDir), rows);
  const copied = copyResultsIntoUpstream({ sourceDir: resultsDir, destDir: upstreamResultsDir(judgeDir, reviewer, runId) });
  // A re-judge of the same run id must not pick up a previous metrics file.
  const metricsDir = upstreamMetricsDir(judgeDir, reviewer, runId);
  rmSync(metricsDir, { recursive: true, force: true });
  const invocation = buildJudgeInvocation({ judgeDir, reviewer, runId, evalRounds, judgeMode, env });
  const result = await spawnCapture(invocation.command, invocation.args, { cwd: invocation.cwd, env: invocation.env, timeoutMs });
  const metricsPath = findMetricsFile(metricsDir, reviewer, evalRounds);
  let summary = null;
  let metricsError = null;
  if (metricsPath) {
    try {
      summary = JSON.parse(readFileSync(metricsPath, "utf8")).summary ?? null;
    } catch (error) {
      metricsError = `metrics file is not valid JSON: ${String(error?.message ?? error)}`;
    }
  }
  const ok = result.error == null && result.code === 0 && metricsPath != null && summary != null;
  const error = result.error
    ?? (result.code !== 0 ? `upstream judge exited ${result.code}${result.signal ? ` signal ${result.signal}` : ""}` : null)
    ?? (metricsPath == null ? `upstream judge wrote no metrics file under ${metricsDir}` : null)
    ?? metricsError;
  return {
    ok,
    skipped: false,
    judgeMode,
    reviewer,
    runId,
    view: view ?? null,
    repeat,
    cloned: checkout.cloned,
    dataset,
    resultsDir: copied.destDir,
    copiedFiles: copied.copied,
    metricsPath: metricsPath ?? null,
    summary,
    summaryLines: String(result.stdout ?? "").split("\n").map((line) => line.trim()).filter((line) => line && SUMMARY_LINE.test(line)).slice(-20),
    stdoutTail: tail(result.stdout),
    stderrTail: tail(result.stderr),
    exitCode: result.code,
    error,
  };
}
