import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { git, gitBuffer } from "../changes/git.js";
import { normalizeRemoteUrl } from "../changes/git.js";
import { sha256 } from "../core/types.js";
import { stateRootDbPath } from "../memory/index.js";

/**
 * Server-side repository registry. Repos live under PIR_REPOS_ROOT
 * (default ~/.local/share/pir/repos), one directory per projectId, plus a
 * repos.json mapping human names to entries. Review jobs never touch the
 * clone directly — each runs in a throwaway `git worktree`.
 */
export interface RepoEntry {
  name: string;
  url: string;
  projectId: string;
  addedAt: number;
}

export function reposRoot(): string {
  const root = process.env.PIR_REPOS_ROOT ?? path.join(process.env.XDG_DATA_HOME ?? path.join(process.env.HOME!, ".local", "share"), "pir", "repos");
  mkdirSync(root, { recursive: true });
  return root;
}

function registryPath(): string {
  return path.join(reposRoot(), "repos.json");
}

function readRegistry(): Record<string, RepoEntry> {
  try {
    return JSON.parse(readFileSync(registryPath(), "utf8")) as Record<string, RepoEntry>;
  } catch {
    return {};
  }
}

function writeRegistry(registry: Record<string, RepoEntry>): void {
  writeFileSync(registryPath(), JSON.stringify(registry, null, 2) + "\n");
}

export function projectIdFor(remoteUrl: string | null, rootCommit: string): string {
  const normalized = remoteUrl ? normalizeRemoteUrl(remoteUrl) : null;
  return sha256(`${normalized ?? "local"}\u0000${rootCommit}`);
}

export function repoDirFor(projectId: string): string {
  return path.join(reposRoot(), projectId);
}

export async function addRepo(source: string, name?: string): Promise<RepoEntry> {
  const isPath = existsSync(source);
  // Identity anchor: the source's own origin remote when registering a local
  // checkout, so the server lands on the same projectId the client computes.
  let remoteUrl: string;
  if (isPath) {
    try {
      remoteUrl = (await git(source, ["remote", "get-url", "origin"])).trim();
    } catch {
      remoteUrl = "";
    }
    if (!remoteUrl) remoteUrl = path.resolve(source);
  } else {
    remoteUrl = source;
  }

  const tempDir = mkdtempSync(path.join(reposRoot(), ".clone-"));
  try {
    await git(tempDir, ["clone", "--quiet", isPath ? path.resolve(source) : source, "."]);
    const rootCommit = (await git(tempDir, ["rev-list", "--max-parents=0", "HEAD"])).trim().split("\n")[0]!.trim();
    const projectId = projectIdFor(remoteUrl, rootCommit);
    const dir = repoDirFor(projectId);
    if (existsSync(dir)) {
      rmSync(tempDir, { recursive: true, force: true });
      try {
        await git(dir, ["fetch", "--all", "--quiet"]);
      } catch {
        // bundle-created repo without remotes, or offline: keep what we have
      }
    } else {
      renameSync(tempDir, dir);
    }
    const entry: RepoEntry = {
      name: name ?? defaultName(remoteUrl),
      url: remoteUrl,
      projectId,
      addedAt: Date.now(),
    };
    const registry = readRegistry();
    registry[entry.name] = entry;
    writeRegistry(registry);
    return entry;
  } catch (err) {
    rmSync(tempDir, { recursive: true, force: true });
    throw err;
  }
}

function defaultName(remoteUrl: string): string {
  const base = remoteUrl.split(/[\\/]/).pop() ?? "repo";
  return base.replace(/\.git$/, "") || "repo";
}

export function listRepos(): RepoEntry[] {
  return Object.values(readRegistry()).sort((a, b) => a.name.localeCompare(b.name));
}

export function removeRepo(name: string, purge: boolean): RepoEntry {
  const registry = readRegistry();
  const entry = registry[name];
  if (!entry) throw new Error(`repo not registered: ${name}`);
  delete registry[name];
  writeRegistry(registry);
  if (purge) {
    const dir = repoDirFor(entry.projectId);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
  return entry;
}

export function resolveRepo(spec: string): { entry: RepoEntry; dir: string } {
  const registry = readRegistry();
  const entry = registry[spec] ?? Object.values(registry).find((e) => e.projectId === spec || e.url === spec);
  if (!entry) {
    const dir = repoDirFor(projectIdFor(looksLikeUrl(spec) ? spec : null, spec));
    if (existsSync(dir)) return { entry: { name: spec, url: spec, projectId: spec, addedAt: 0 }, dir };
    throw new Error(`repo not registered: ${spec} (register with: pir repos add <url>)`);
  }
  return { entry, dir: repoDirFor(entry.projectId) };
}

function looksLikeUrl(spec: string): boolean {
  return /^[a-z]+@|:\/\/|^git@/i.test(spec);
}

// ---------------------------------------------------------------------------
// Materialization: worktrees for registered repos, bundles for unpushed code
// ---------------------------------------------------------------------------

export interface MaterializedReview {
  worktree: string;
  headCommit: string;
  projectId: string;
  cleanup: () => Promise<void>;
}

/** Materialize a review workspace from a registered clone (fetches first). */
export async function materializeRegistered(
  dir: string,
  projectId: string,
  options: { branch?: string; noFetch?: boolean } = {},
): Promise<MaterializedReview> {
  if (!options.noFetch) {
    try {
      await git(dir, ["fetch", "--all", "--quiet"]);
    } catch {
      // Offline or no credentials: review what we already have.
    }
  }
  const headCommit = options.branch
    ? (await git(dir, ["rev-parse", "--verify", `${options.branch}^{commit}`])).trim()
    : (await git(dir, ["rev-parse", "HEAD"])).trim();
  return materializeWorktree(dir, projectId, headCommit);
}

async function materializeWorktree(repoDir: string, projectId: string, headCommit: string): Promise<MaterializedReview> {
  const workRoot = path.join(reposRoot(), "work");
  mkdirSync(workRoot, { recursive: true });
  const worktree = path.join(workRoot, randomUUID());
  await git(repoDir, ["worktree", "add", "--quiet", "--detach", worktree, headCommit]);
  return {
    worktree,
    headCommit,
    projectId,
    cleanup: async () => {
      if (process.env.PIR_KEEP_WORKTREE === "1") return;
      try {
        await git(repoDir, ["worktree", "remove", "--force", worktree]);
      } catch {
        rmSync(worktree, { recursive: true, force: true });
      }
    },
  };
}

export interface BundleMeta {
  remoteUrl: string | null;
  rootCommit: string;
  base: string | null;
  head: string;
}

/**
 * Materialize a review workspace from a client-supplied git bundle — the
 * coderabbit-cli style flow: the client ships its LOCAL state (including
 * unpushed commits), the server never needs credentials for the origin.
 */
export async function materializeFromBundle(
  bundle: Buffer,
  meta: BundleMeta,
): Promise<{ review: MaterializedReview; neededFull: boolean }> {
  const projectId = projectIdFor(meta.remoteUrl, meta.rootCommit);
  const dir = repoDirFor(projectId);
  const isNew = !existsSync(dir);
  if (isNew) mkdirSync(dir, { recursive: true });

  const bundleFile = path.join(tmpdir(), `pir-bundle-${randomUUID()}.bundle`);
  const { writeFile } = await import("node:fs/promises");
  await writeFile(bundleFile, bundle);

  try {
    if (isNew) await git(dir, ["init", "--quiet"]);
    try {
      // The client packs under refs/pir/bundle-head; an explicit refspec is
      // required because a bare `git fetch <bundle>` insists on HEAD.
      await git(dir, ["fetch", "--quiet", bundleFile, "+refs/pir/bundle-head:refs/pir/last-bundle"]);
    } catch (err) {
      if (meta.base === null) throw err; // was already a full bundle
      // Thin bundle but the base is unknown here — caller must resend full.
      const error = new Error("need-full") as Error & { needFull?: boolean };
      error.needFull = true;
      if (isNew) rmSync(dir, { recursive: true, force: true });
      throw error;
    }
    // The fetched objects must contain the advertised head.
    await git(dir, ["cat-file", "-e", `${meta.head}^{commit}`]);
    return { review: await materializeWorktree(dir, projectId, meta.head), neededFull: false };
  } finally {
    rmSync(bundleFile, { force: true });
  }
}

/**
 * Client side: pack the local commits (and nothing else) as a bundle.
 * Uses transient refs under refs/pir/* — `git bundle create` only accepts
 * symbolic refs — and cleans them up afterwards. Neither the index, the
 * working tree nor any user ref is touched.
 */
export async function createBundle(
  repoRoot: string,
  meta: { base: string | null; head: string },
): Promise<Buffer> {
  const headRef = "refs/pir/bundle-head";
  const baseRef = "refs/pir/bundle-base";
  await git(repoRoot, ["update-ref", headRef, meta.head]);
  if (meta.base) await git(repoRoot, ["update-ref", baseRef, meta.base]);
  try {
    const revs = meta.base ? [headRef, `^${baseRef}`] : [headRef];
    return await gitBuffer(repoRoot, ["bundle", "create", "-", ...revs]);
  } finally {
    await git(repoRoot, ["update-ref", "-d", headRef]);
    if (meta.base) {
      try {
        await git(repoRoot, ["update-ref", "-d", baseRef]);
      } catch {
        // already gone
      }
    }
  }
}

/** Centralized memory db for a materialized review (never inside the worktree). */
export function reviewDbPath(projectId: string): string {
  return stateRootDbPath(projectId);
}
