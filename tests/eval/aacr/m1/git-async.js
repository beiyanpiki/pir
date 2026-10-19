/**
 * Non-blocking git plumbing for the M1 driver's worker pool.
 *
 * The M0 driver uses execFileSync throughout; that is fine for its serial
 * loop but would freeze every concurrent worker behind the first git call.
 * M1's same-repo-serial / cross-repo-concurrent model needs async fetch,
 * worktree and ancestry checks, so they live here and are re-exported from
 * ../run-m0.js (the M1 driver keeps importing the M0 machinery by name).
 *
 * Pure plumbing only: no cache policy, no fixture knowledge, no model.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { gitEnv } from "../materialize.js";

const execFileAsync = promisify(execFile);
const DEFAULT_GIT_TIMEOUT_MS = 600_000;
const MAX_BUFFER = 64 * 1024 * 1024;

function tail(text, lines = 8) {
  return String(text ?? "").trim().split("\n").slice(-lines).join("\n");
}

/**
 * Run git and resolve stdout. With `allowFailure`, a non-zero exit resolves
 * `{ ok: false, code, stdout, stderr }` instead of rejecting — the caller
 * decides whether "no" is an answer (ancestry, cat-file, merge-base).
 */
export async function execGitAsync(cwd, args, { env = process.env, timeoutMs = DEFAULT_GIT_TIMEOUT_MS, allowFailure = false } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      env: gitEnv(env),
      maxBuffer: MAX_BUFFER,
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, code: 0, stdout, stderr };
  } catch (error) {
    const result = {
      ok: false,
      code: typeof error?.code === "number" ? error.code : null,
      stdout: String(error?.stdout ?? ""),
      stderr: String(error?.stderr ?? ""),
      timedOut: error?.killed === true || error?.signal != null,
    };
    if (allowFailure && !result.timedOut) return result;
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr ? tail(result.stderr) : String(error?.message ?? error)}`);
  }
}

export async function hasCommitAsync(repoDir, sha, options = {}) {
  const result = await execGitAsync(repoDir, ["cat-file", "-e", `${sha}^{commit}`], { ...options, allowFailure: true });
  return result.ok;
}

/** Depth-1 fetch of exactly one commit; its tree comes with it. */
export async function ensureFetchedAsync(repoDir, sha, { timeoutMs = DEFAULT_GIT_TIMEOUT_MS, env = process.env } = {}) {
  if (await hasCommitAsync(repoDir, sha, { timeoutMs, env })) return { fetched: false };
  await execGitAsync(repoDir, ["fetch", "--depth", "1", "--no-tags", "origin", sha], { timeoutMs, env });
  if (!(await hasCommitAsync(repoDir, sha, { timeoutMs, env }))) throw new Error(`fetched but still missing: ${sha}`);
  return { fetched: true };
}

/** Detached per-instance checkout of head, isolated via git worktree. */
export async function materializeTaskAsync(repoDir, head, workDir, { timeoutMs = DEFAULT_GIT_TIMEOUT_MS, env = process.env } = {}) {
  if (workDir) {
    await rm(workDir, { recursive: true, force: true });
    await execGitAsync(repoDir, ["worktree", "prune"], { timeoutMs, env, allowFailure: true });
  }
  await mkdir(path.dirname(workDir), { recursive: true });
  await execGitAsync(repoDir, ["worktree", "add", "--detach", workDir, head], { timeoutMs, env });
  return workDir;
}

export async function releaseTaskAsync(repoDir, workDir, { timeoutMs = DEFAULT_GIT_TIMEOUT_MS, env = process.env } = {}) {
  if (!workDir) return;
  const removed = await execGitAsync(repoDir, ["worktree", "remove", "--force", workDir], { timeoutMs, env, allowFailure: true });
  if (!removed.ok) {
    await rm(workDir, { recursive: true, force: true });
    await execGitAsync(repoDir, ["worktree", "prune"], { timeoutMs, env, allowFailure: true });
  }
}

/** True when `ancestor` is reachable from `descendant` in the local object store. */
export async function hasAncestryAsync(repoDir, ancestor, descendant, options = {}) {
  const result = await execGitAsync(repoDir, ["merge-base", "--is-ancestor", ancestor, descendant], { ...options, allowFailure: true });
  return result.ok;
}

export async function treeOfAsync(repoDir, commit, options = {}) {
  const { stdout } = await execGitAsync(repoDir, ["rev-parse", "--verify", "--end-of-options", `${commit}^{tree}`], options);
  const tree = stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(tree)) throw new Error(`unexpected tree id for ${commit}: ${tree}`);
  return tree;
}

export const SYNTHETIC_HEAD_MESSAGE = (head, parent) => `pir-eval synthetic head for ${head} on ${parent}`;

/**
 * Deterministic replacement head for a shallow depth-1 cache.
 *
 * `pir find` computes `git diff <base>...<head>`, which needs a real ancestry
 * relation. A depth-1 fetch of the PR head and of the GitHub merge base gives
 * both trees but no ancestry, so merge-base fails ("no merge base"). This
 * creates a commit with the head's exact tree and the merge base as parent:
 * the reviewer sees the head tree and exactly the PR diff, while the original
 * head sha is still recorded in every row. Fixed identity + dates + message
 * make the synthetic commit content-addressed and reproducible.
 */
export async function createSyntheticHeadAsync(repoDir, { head, parent, timeoutMs = DEFAULT_GIT_TIMEOUT_MS, env = process.env } = {}) {
  if (!/^[0-9a-f]{40}$/.test(head ?? "") || !/^[0-9a-f]{40}$/.test(parent ?? "")) {
    throw new Error("synthetic head needs full 40-char head and parent shas");
  }
  if (head === parent) throw new Error(`head and merge base are the same commit (${head}); the review range is empty`);
  const tree = await treeOfAsync(repoDir, head, { timeoutMs, env });
  const fixed = {
    ...gitEnv(env),
    GIT_AUTHOR_NAME: "pir eval",
    GIT_AUTHOR_EMAIL: "eval@pir.local",
    GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
    GIT_COMMITTER_NAME: "pir eval",
    GIT_COMMITTER_EMAIL: "eval@pir.local",
    GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
  };
  const { stdout } = await execGitAsync(repoDir, [
    "commit-tree", tree, "-p", parent, "-m", SYNTHETIC_HEAD_MESSAGE(head, parent),
  ], { timeoutMs, env: fixed });
  const synthetic = stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(synthetic)) throw new Error(`git commit-tree returned an unexpected sha: ${synthetic}`);
  return { head: synthetic, tree, parent };
}
