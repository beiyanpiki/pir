#!/usr/bin/env node
/**
 * Opt-in ReviewBench judge delegation: clone review-bench/ReviewBench at the
 * pinned SHA recorded in fixtures/REVIEWBENCH_SHA, `npm ci` there once, and
 * forward to its judge CLI against a round's judging-input directory.
 * Importing this module never clones anything; without PIR_EVAL=1 it exits
 * successfully without network access.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RB_DIR = fileURLToPath(new URL("./", import.meta.url));
const FIXTURES_DIR = path.join(RB_DIR, "fixtures");
const CACHE_DIR = path.join(RB_DIR, ".cache");
export const DEFAULT_REVIEWBENCH_REPO = "https://github.com/review-bench/ReviewBench.git";

const git = (cwd, args) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });

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

/** Marker proving `npm ci` ran for exactly this pinned SHA (one-time cost). */
export function depsMarker(repoDir, sha) {
  return path.join(repoDir, ".pir-npm-ci", `${sha}.done`);
}

/**
 * Ensure <repoDir> is a clone of repoUrl checked out (detached) at sha.
 * Pure git plumbing; testable against a local fixture remote.
 */
export function ensurePinnedCheckout(repoDir, sha, { repoUrl = DEFAULT_REVIEWBENCH_REPO } = {}) {
  if (!existsSync(repoDir)) {
    mkdirSync(path.dirname(repoDir), { recursive: true });
    execFileSync("git", ["clone", "-q", "--no-checkout", repoUrl, repoDir], { stdio: "pipe" });
  }
  try {
    git(repoDir, ["cat-file", "-e", `${sha}^{commit}`]);
  } catch {
    // The pinned SHA may not be reachable from the default branch tip.
    git(repoDir, ["fetch", "-q", "origin", sha]);
  }
  git(repoDir, ["checkout", "-q", "--detach", sha]);
  const head = git(repoDir, ["rev-parse", "HEAD"]).trim();
  if (head !== sha) throw new Error(`checkout landed on ${head}, expected ${sha}`);
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
  if (!options.candidate || !statSync(options.candidate).isDirectory()) {
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
  const repoDir = path.join(CACHE_DIR, "reviewbench");
  console.error(`ensuring review-bench/ReviewBench at pinned SHA ${sha.slice(0, 8)}…`);
  ensurePinnedCheckout(repoDir, sha, { repoUrl: options.repoUrl });
  if (!existsSync(depsMarker(repoDir, sha))) {
    console.error("running one-time npm ci in the judge clone…");
    spawnSync("npm", ["ci"], { cwd: repoDir, stdio: "inherit" });
    mkdirSync(path.dirname(depsMarker(repoDir, sha)), { recursive: true });
    writeFileSync(depsMarker(repoDir, sha), new Date().toISOString());
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
