/**
 * Non-blocking git plumbing for the end-to-end driver's worker pool.
 *
 * The verifier-benchmark driver's async fetch/worktree helpers live in ../run-m0.js (the end-to-end benchmark
 * imports them from there); this module holds the end-to-end-specific plumbing a
 * depth-1 cache needs — ancestry probes and the deterministic synthetic head
 * that gives `pir find` a reviewable range without rewriting history.
 *
 * Pure plumbing only: no cache policy, no fixture knowledge, no model.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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
