import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { commitExists, git, gitBuffer } from "../changes/git.js";
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

/**
 * Read the registry. A missing file is an empty registry; a corrupt one is a
 * hard error — silently returning {} here would make the next addRepo
 * persist only its own entry and wipe every other registration.
 */
function readRegistry(): Record<string, RepoEntry> {
  const file = registryPath();
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("registry root must be a JSON object");
    }
    return parsed as Record<string, RepoEntry>;
  } catch (err) {
    throw new Error(
      `cannot read repo registry ${file}: ${err instanceof Error ? err.message : String(err)} — ` +
        "fix or remove the file by hand; refusing to overwrite it",
    );
  }
}

/** Atomic replace via rename, so readers never observe a torn write. */
function writeRegistry(registry: Record<string, RepoEntry>): void {
  const target = registryPath();
  const temp = path.join(reposRoot(), `repos.json.tmp-${process.pid}-${randomUUID()}`);
  writeFileSync(temp, JSON.stringify(registry, null, 2) + "\n");
  try {
    renameSync(temp, target);
  } catch (err) {
    rmSync(temp, { force: true });
    throw err;
  }
}

/** Locks are held for milliseconds (read-mutate-write only); a holder that
 *  crashed this long ago is considered gone and its lock is broken. */
const REGISTRY_LOCK_STALE_MS = 10_000;
const REGISTRY_LOCK_WAIT_MS = 5_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Serialize registry mutations across processes: CLI invocations are not
 * serialized by anything (unlike the server's request queue), and an
 * unguarded read-modify-write loses whichever entry was written first.
 */
function withRegistryLock<T>(fn: () => T): T {
  const lockPath = `${registryPath()}.lock`;
  const deadline = Date.now() + REGISTRY_LOCK_WAIT_MS;
  let fd: number | undefined;
  while (fd === undefined) {
    try {
      fd = openSync(lockPath, "wx");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > REGISTRY_LOCK_STALE_MS) {
          rmSync(lockPath, { force: true });
          continue;
        }
      } catch {
        continue; // the lock vanished — try to grab it right away
      }
      if (Date.now() > deadline) throw new Error(`repo registry lock busy: ${lockPath}`);
      sleepSync(25);
    }
  }
  try {
    return fn();
  } finally {
    closeSync(fd);
    try {
      rmSync(lockPath, { force: true });
    } catch {
      // someone else already broke a lock they considered stale
    }
  }
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
    // The clone happened outside the lock; only the registry mutation is
    // serialized, so the lock is held for milliseconds.
    withRegistryLock(() => {
      const registry = readRegistry();
      registry[entry.name] = entry;
      writeRegistry(registry);
    });
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
  const entry = withRegistryLock(() => {
    const registry = readRegistry();
    const found = registry[name];
    if (!found) throw new Error(`repo not registered: ${name}`);
    delete registry[name];
    writeRegistry(registry);
    return found;
  });
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
    const projectId = projectIdFor(looksLikeUrl(spec) ? spec : null, spec);
    const dir = repoDirFor(projectId);
    if (existsSync(dir)) return { entry: { name: spec, url: spec, projectId, addedAt: 0 }, dir };
    throw new Error(`repo not registered: ${spec} (register with: pir repos add <url>)`);
  }
  return { entry, dir: repoDirFor(entry.projectId) };
}

function looksLikeUrl(spec: string): boolean {
  return /^[a-z]+@|:\/\/|^git@/i.test(spec);
}

function isCommitId(value: string): boolean {
  return /^[0-9a-f]{40,64}$/i.test(value);
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
    // Older clients forwarded raw refs ("HEAD", "origin/x", a branch name)
    // as the head; nothing by that name exists in this repo. The fetched
    // refs/pir/last-bundle always points at the commit the client actually
    // packed, so fall back to it instead of failing with a git fatal.
    const packedHead = (await git(dir, ["rev-parse", "--verify", "refs/pir/last-bundle^{commit}"])).trim();
    const head = isCommitId(meta.head) && (await commitExists(dir, meta.head)) ? meta.head : packedHead;
    return { review: await materializeWorktree(dir, projectId, head), neededFull: false };
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
