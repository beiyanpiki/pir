#!/usr/bin/env node
/**
 * Opt-in ReviewBench judge delegation: clone review-bench/ReviewBench at the
 * pinned SHA recorded in fixtures/REVIEWBENCH_SHA, `npm ci` there once, and
 * forward to its judge CLI against a round's judging-input directory.
 * Importing this module never clones anything; without PIR_EVAL=1 it exits
 * successfully without network access.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RB_DIR = fileURLToPath(new URL("./", import.meta.url));
const FIXTURES_DIR = path.join(RB_DIR, "fixtures");
const CACHE_DIR = path.join(RB_DIR, ".cache");
export const DEFAULT_REVIEWBENCH_REPO = "https://github.com/review-bench/ReviewBench.git";

// Network-bound clone/fetch/checkout are bounded so a hung transfer
// cannot stall bench:judge indefinitely.
const GIT_TIMEOUT_MS = 600_000;

const git = (cwd, args) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: GIT_TIMEOUT_MS });

export function parseOptions(argv = [], env = process.env) {
  const values = {
    candidate: env.RB_JUDGE_CANDIDATE,
    output: env.RB_JUDGE_OUTPUT,
    provider: env.RB_JUDGE_PROVIDER,
    model: env.RB_JUDGE_MODEL,
    repoUrl: env.RB_JUDGE_REPO_URL ?? DEFAULT_REVIEWBENCH_REPO,
    json: env.PIR_EVAL_JSON === "1",
    extra: [],
  };
  const flags = { "--candidate": "candidate", "--output": "output", "--provider": "provider", "--model": "model" };
  const forwarded = [];
  let afterSeparator = false;
  for (let i = 0; i < argv.length; i++) {
    if (values.help === undefined && argv[i] === "--help") { values.help = true; continue; }
    if (argv[i] === "--") { afterSeparator = true; continue; }
    if (afterSeparator) { forwarded.push(argv[i]); continue; }
    if (argv[i] === "--json") { values.json = true; continue; }
    const key = flags[argv[i]];
    if (!key || !argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error(`invalid option or missing value: ${argv[i]}`);
    values[key] = argv[++i];
  }
  values.extra = forwarded;
  for (const key of ["candidate", "output"]) if (values[key]) values[key] = path.resolve(values[key]);
  return values;
}

export function readPinnedSha(shaFile = path.join(FIXTURES_DIR, "REVIEWBENCH_SHA")) {
  const sha = readFileSync(shaFile, "utf8").trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`invalid pinned SHA in ${shaFile}: ${sha}`);
  return sha;
}

/** Marker recording which pinned SHA the installed node_modules belong to. */
export function depsMarker(repoDir) {
  return path.join(repoDir, ".pir-npm-ci", "done");
}

/**
 * Ensure <repoDir> is a clone of repoUrl checked out (detached) at sha.
 * Pure git plumbing; testable against a local fixture remote.
 *
 * Failure handling distinguishes transient from local problems: a failed
 * SHA fetch (network) propagates without touching the valid cache, while a
 * local checkout failure triggers one wipe-and-reclone recovery.
 */
export function ensurePinnedCheckout(repoDir, sha, { repoUrl = DEFAULT_REVIEWBENCH_REPO } = {}) {
  const cloneAt = () => {
    rmSync(repoDir, { recursive: true, force: true });
    mkdirSync(path.dirname(repoDir), { recursive: true });
    execFileSync("git", ["clone", "-q", "--no-checkout", repoUrl, repoDir], { stdio: "pipe", timeout: GIT_TIMEOUT_MS });
  };
  const checkoutPinned = () => {
    git(repoDir, ["checkout", "-q", "--detach", sha]);
    const head = git(repoDir, ["rev-parse", "HEAD"]).trim();
    if (head !== sha) throw new Error(`checkout landed on ${head}, expected ${sha}`);
  };

  if (!existsSync(path.join(repoDir, ".git"))) cloneAt();
  try {
    git(repoDir, ["cat-file", "-e", `${sha}^{commit}`]);
  } catch {
    // Network-bound: a failure here is transient — the existing cache (and
    // its npm ci install) must survive for the retry.
    git(repoDir, ["fetch", "-q", "origin", sha]);
  }
  try {
    checkoutPinned();
  } catch (error) {
    console.error(`pinned checkout failed (${String(error.message ?? error)}); wiping the cache and re-cloning at ${sha.slice(0, 8)}…`);
    cloneAt();
    try {
      git(repoDir, ["cat-file", "-e", `${sha}^{commit}`]);
    } catch {
      git(repoDir, ["fetch", "-q", "origin", sha]);
    }
    checkoutPinned();
  }
  return repoDir;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseOptions(argv, env);
  if (options.help) {
    console.log("PIR_EVAL=1 RB_JUDGE_PROVIDER=p RB_JUDGE_MODEL=m npm run bench:judge -- --candidate <rb-out round dir> [--output scores.json] [-- extra judge flags]\nCredentials pass through the provider's documented env vars. Judge provider/model and the pinned ReviewBench SHA must be recorded in RESULTS.md rows.");
    return 0;
  }
  if (env.PIR_EVAL !== "1") {
    console.log(options.json ? JSON.stringify({ skipped: true, reason: "PIR_EVAL=1 required" }) : "skipped: set PIR_EVAL=1 to allow model evaluation");
    return 0;
  }
  // Argument validation fires before any clone or install.
  if (!options.candidate || !existsSync(options.candidate) || !statSync(options.candidate).isDirectory()) {
    throw new Error(`--candidate must be an existing judging-input directory (e.g. tests/eval/rb-out/<round>/candidate-run1): ${options.candidate ?? "(missing)"}`);
  }
  if (!options.provider) throw new Error("set --provider or RB_JUDGE_PROVIDER (recorded in RESULTS.md rows)");
  if (!options.model) throw new Error("set --model or RB_JUDGE_MODEL (recorded in RESULTS.md rows)");
  if (!options.output) {
    // Default beside the candidate dir, never inside it: the judge's
    // directory loader would choke on a non-candidate JSON file.
    options.output = `${options.candidate.replace(/\/+$/, "")}.scores.json`;
  }
  if (existsSync(options.output)) throw new Error(`refusing to overwrite artifact: ${options.output}`);

  const sha = readPinnedSha();
  // RB_JUDGE_CACHE_DIR lets tests sandbox the clone; production keeps it in
  // the worktree's .cache (gitignored, shared across rounds).
  const cacheDir = env.RB_JUDGE_CACHE_DIR ?? CACHE_DIR;
  const repoDir = path.join(cacheDir, "reviewbench");
  console.error(`ensuring review-bench/ReviewBench at pinned SHA ${sha.slice(0, 8)}…`);
  ensurePinnedCheckout(repoDir, sha, { repoUrl: options.repoUrl });
  const marker = depsMarker(repoDir);
  const installedFor = existsSync(marker) ? readFileSync(marker, "utf8").trim() : null;
  if (installedFor !== sha) {
    console.error("running one-time npm ci in the judge clone…");
    const install = spawnSync("npm", ["ci"], { cwd: repoDir, stdio: "inherit" });
    if (install.error || install.status !== 0) {
      throw new Error(`npm ci failed in the judge clone (exit ${install.status ?? install.error?.message ?? "?"}) — deps marker NOT written, fix the cause and re-run`);
    }
    mkdirSync(path.dirname(marker), { recursive: true });
    writeFileSync(marker, sha);
  }

  const judgeArgs = ["--prefix", repoDir, "run", "judge", "--",
    "--candidate", options.candidate,
    "--manifest", path.join(FIXTURES_DIR, "test-set.json"),
    "--golden", path.join(FIXTURES_DIR, "golden"),
    "--provider", options.provider, "--model", options.model,
    "--output", options.output, ...options.extra];
  console.error(`judging ${options.candidate} → ${options.output}`);
  const result = spawnSync("npm", judgeArgs, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`judge exited ${result.status}`);
  console.log(options.json ? JSON.stringify({ output: options.output, provider: options.provider, model: options.model, reviewbenchSha: sha }) : options.output);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((error) => { console.error(error); process.exitCode = 3; });
}
