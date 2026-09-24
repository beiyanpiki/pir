import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 30_000;

export class GitError extends Error {
  constructor(
    message: string,
    readonly args: string[],
  ) {
    super(message);
    this.name = "GitError";
  }
}

export async function git(
  repoRoot: string,
  args: string[],
  options: { stdin?: string; timeoutMs?: number; env?: Record<string, string> } = {},
): Promise<string> {
  try {
    const result = (await execFileAsync("git", ["-C", repoRoot, ...args], {
      timeout: options.timeoutMs ?? GIT_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
      encoding: "utf8",
      env: options.env ? { ...process.env, ...options.env } : undefined,
    })) as { stdout: string };
    return result.stdout;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new GitError(`git ${args.join(" ")} failed: ${message}`, args);
  }
}

/** Binary git output (e.g. `git bundle create -`), untouched by encoding. */
export async function gitBuffer(
  repoRoot: string,
  args: string[],
  options: { timeoutMs?: number } = {},
): Promise<Buffer> {
  try {
    const result = (await execFileAsync("git", ["-C", repoRoot, ...args], {
      timeout: options.timeoutMs ?? GIT_TIMEOUT_MS,
      maxBuffer: 256 * 1024 * 1024,
      encoding: "buffer",
    })) as { stdout: Buffer };
    return result.stdout;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new GitError(`git ${args.join(" ")} failed: ${message}`, args);
  }
}

/**
 * Snapshot the current working tree (tracked modifications + untracked
 * files) as a commit object WITHOUT touching the user's index, HEAD or
 * branches: a temporary alternate index is populated, its tree is written,
 * and a commit is created with HEAD as parent. Returns the new commit sha,
 * or HEAD when the tree is clean.
 */
export async function createWorkingTreeSnapshot(repoRoot: string): Promise<string> {
  const head = (await git(repoRoot, ["rev-parse", "HEAD"])).trim();
  const tmpIndexDir = mkdtempSync(path.join(tmpdir(), "pir-index-"));
  const indexFile = path.join(tmpIndexDir, "index");
  try {
    await git(repoRoot, ["add", "-A"], { env: { GIT_INDEX_FILE: indexFile } });
    const tree = (await git(repoRoot, ["write-tree"], { env: { GIT_INDEX_FILE: indexFile } })).trim();
    const headTree = (await git(repoRoot, ["rev-parse", `HEAD^{tree}`])).trim();
    if (tree === headTree) return head;
    const commit = (
      await git(repoRoot, ["commit-tree", tree, "-p", head, "-m", "pir: working tree snapshot"], {
        env: { GIT_INDEX_FILE: indexFile },
      })
    ).trim();
    return commit;
  } finally {
    rmSync(tmpIndexDir, { recursive: true, force: true });
  }
}

/** True when the working tree or index differs from HEAD (untracked included). */
export async function isDirty(repoRoot: string): Promise<boolean> {
  const out = await git(repoRoot, ["status", "--porcelain"]);
  return out.trim().length > 0;
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    const out = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
    return out.trim() === "true";
  } catch {
    return false;
  }
}

export async function getRootCommit(repoRoot: string): Promise<string> {
  return (await git(repoRoot, ["rev-list", "--max-parents=0", "HEAD"])).trim().split("\n")[0]!.trim();
}

export async function getHeadCommit(repoRoot: string): Promise<string> {
  return (await git(repoRoot, ["rev-parse", "HEAD"])).trim();
}

export async function getRemoteUrl(repoRoot: string): Promise<string | null> {
  try {
    const out = await git(repoRoot, ["remote", "get-url", "origin"]);
    const trimmed = out.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * Normalize a git remote URL to a canonical host/owner/repo form so the same
 * repository keeps one identity across machines, clones and transports.
 *
 * git@github.com:company/payment.git  ->  github.com/company/payment
 * https://github.com/company/payment  ->  github.com/company/payment
 * ssh://git@gitlab.com/a/b.git        ->  gitlab.com/a/b
 */
export function normalizeRemoteUrl(url: string): string {
  let rest = url.trim().toLowerCase();
  if (rest.startsWith("ssh://")) {
    rest = rest.slice("ssh://".length);
    const at = rest.indexOf("@");
    if (at >= 0) rest = rest.slice(at + 1);
  } else if (rest.startsWith("git@")) {
    rest = rest.slice("git@".length).replace(":", "/");
  } else if (rest.startsWith("http://") || rest.startsWith("https://")) {
    rest = rest.slice(rest.indexOf("://") + 3);
    const at = rest.indexOf("@");
    if (at >= 0) rest = rest.slice(at + 1);
  }
  if (rest.endsWith(".git")) rest = rest.slice(0, -".git".length);
  return rest.replace(/\/+/g, "/").replace(/\/$/, "");
}

export async function getMergeBase(repoRoot: string, base: string, head: string): Promise<string> {
  return (await git(repoRoot, ["merge-base", base, head])).trim();
}

/** `git diff --name-status -z` between two refs: entries of [status, path, (origPath)]. */
export async function getNameStatus(
  repoRoot: string,
  base: string,
  head: string,
): Promise<Array<{ status: string; path: string; oldPath?: string }>> {
  const out = await git(repoRoot, ["diff", "--name-status", "-z", "-M", base, head]);
  const parts = out.split("\0").filter((p) => p.length > 0);
  const entries: Array<{ status: string; path: string; oldPath?: string }> = [];
  let i = 0;
  while (i < parts.length) {
    const status = parts[i]!;
    if (status.startsWith("R") || status.startsWith("C")) {
      const oldPath = parts[i + 1];
      const newPath = parts[i + 2];
      if (oldPath && newPath) entries.push({ status: status[0]!, path: newPath, oldPath });
      i += 3;
    } else {
      const path = parts[i + 1];
      if (path) entries.push({ status: status[0]!, path });
      i += 2;
    }
  }
  return entries;
}

export async function getDiffPatch(
  repoRoot: string,
  base: string,
  head: string,
  paths?: string[],
): Promise<string> {
  const args = ["diff", "--no-color", "-M", "-U3", `${base}...${head}`];
  if (paths && paths.length > 0) args.push("--", ...paths);
  return git(repoRoot, args);
}

export async function readFileAtCommit(repoRoot: string, commit: string, path: string): Promise<string | null> {
  try {
    return await git(repoRoot, ["show", `${commit}:${path}`]);
  } catch {
    return null;
  }
}

export async function commitExists(repoRoot: string, ref: string): Promise<boolean> {
  try {
    await git(repoRoot, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}
