import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
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
  // HOME may legitimately be unset (containers, systemd services, CI): fail
  // with actionable guidance instead of a bare TypeError from path.join.
  if (!process.env.PIR_REPOS_ROOT && !process.env.XDG_DATA_HOME && !process.env.HOME) {
    throw new Error("cannot locate the repos root: HOME and XDG_DATA_HOME are unset (set PIR_REPOS_ROOT)");
  }
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

/**
 * Atomic replace via rename, so readers never observe a torn write. The temp
 * file is fsynced first: without that, a crash right after the rename can
 * leave a zero-length registry on some filesystems — a hard outage now that
 * a corrupt registry is a loud error.
 */
function writeRegistry(registry: Record<string, RepoEntry>): void {
  const target = registryPath();
  const temp = path.join(reposRoot(), `repos.json.tmp-${process.pid}-${randomUUID()}`);
  const fd = openSync(temp, "w");
  try {
    writeSync(fd, JSON.stringify(registry, null, 2) + "\n");
    fsyncSync(fd);
  } catch (err) {
    rmSync(temp, { force: true });
    throw err;
  } finally {
    closeSync(fd);
  }
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
 *
 * The lock file carries an owner token and is removed only if it is still
 * ours: if we stall past REGISTRY_LOCK_STALE_MS a waiter breaks the lock and
 * creates its own — deleting that one would re-open the race this lock
 * exists to close.
 */
function withRegistryLock<T>(fn: () => T): T {
  const lockPath = `${registryPath()}.lock`;
  const deadline = Date.now() + REGISTRY_LOCK_WAIT_MS;
  const token = `${process.pid}-${randomUUID()}`;
  let acquired = false;
  while (!acquired) {
    try {
      writeFileSync(lockPath, token, { flag: "wx" });
      acquired = true;
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
    try {
      if (readFileSync(lockPath, "utf8") === token) {
        rmSync(lockPath, { force: true });
      }
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
 * A project dir can be shared with a `repos add` clone; those hold state the
 * server cannot rebuild from a bundle, so they must never be wiped. A dir that
 * only ever served bundle fetches (bundle flow never registers) is a cache.
 */
function isRegisteredProject(projectId: string): boolean {
  try {
    return Object.values(readRegistry()).some((entry) => entry.projectId === projectId);
  } catch {
    return true; // unreadable registry: assume registered rather than risk wiping
  }
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

  // Write the bundle temp file BEFORE creating the repo dir: a failed write
  // (ENOSPC/EACCES on tmpdir) must not leave a poisoned empty repo behind.
  const bundleFile = path.join(tmpdir(), `pir-bundle-${randomUUID()}.bundle`);
  const { writeFile } = await import("node:fs/promises");
  try {
    await writeFile(bundleFile, bundle);
  } catch (err) {
    throw new Error(`failed to write bundle temp file ${bundleFile}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (isNew) mkdirSync(dir, { recursive: true });

  try {
    if (isNew) await git(dir, ["init", "--quiet"]);
    const fetchBundle = (): Promise<string> =>
      // The client packs under refs/pir/bundle-head; an explicit refspec is
      // required because a bare `git fetch <bundle>` insists on HEAD.
      git(dir, ["fetch", "--quiet", bundleFile, "+refs/pir/bundle-head:refs/pir/last-bundle"]);
    try {
      await fetchBundle();
    } catch (err) {
      if (meta.base !== null) {
        // Thin bundle but the base is unknown here — caller must resend full.
        const error = new Error("need-full") as Error & { needFull?: boolean };
        error.needFull = true;
        if (isNew) rmSync(dir, { recursive: true, force: true });
        throw error;
      }
      // Already a full bundle, so the failure means the pre-existing cache
      // repo itself is broken (refs surviving objects that do not — e.g. an
      // interrupted gc/repack across a container redeploy). Bundle caches are
      // pure rebuildable state: wipe and re-fetch from this full bundle,
      // unless the dir also backs a registered clone.
      if (isNew || isRegisteredProject(projectId)) throw err;
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      try {
        await git(dir, ["init", "--quiet"]);
        await fetchBundle();
        process.stderr.write(`pir: rebuilt corrupt bundle cache repo at ${dir}\n`);
      } catch {
        throw err; // the bundle itself is unusable — surface the original failure
      }
    }
    // Older clients forwarded raw refs ("HEAD", "origin/x", a branch name)
    // as the head; nothing by that name exists in this repo (or it resolves
    // to the wrong commit). The fetched refs/pir/last-bundle always points
    // at the commit the client actually packed, so review that — but say so.
    // A head that is shaped like a commit id yet absent from the fetched
    // objects is a genuine client/bundle mismatch (every current client
    // packs its claimed head); fail loudly instead of silently reviewing
    // whatever was packed.
    const packedHead = (await git(dir, ["rev-parse", "--verify", "refs/pir/last-bundle^{commit}"])).trim();
    let head: string;
    if (!isCommitId(meta.head)) {
      process.stderr.write(
        `pir: client sent non-SHA head ${JSON.stringify(meta.head)}; reviewing packed head ${packedHead.slice(0, 10)}\n`,
      );
      head = packedHead;
    } else if (await commitExists(dir, meta.head)) {
      head = meta.head;
    } else {
      throw new Error(
        `bundle does not contain the claimed head ${meta.head} (packed head is ${packedHead.slice(0, 10)}); ` +
          "client/server state mismatch",
      );
    }
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
