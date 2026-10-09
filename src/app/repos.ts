import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
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
import { getRemoteUrl, normalizeRemoteUrl } from "../changes/git.js";
import { sha256 } from "../core/types.js";
import { stateRootDbPath } from "../memory/index.js";
import { codegraphInit, codegraphSync, CodeMapError } from "../codemap/codegraph-cli.js";
import {
  CODEGRAPH_INIT_TIMEOUT_MS,
  CODEGRAPH_SYNC_TIMEOUT_MS,
} from "../codemap/codegraph-cli.js";

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
// A first-time codegraph seed build legitimately holds its lock for up to
// TWO full index inits (the seed attempt, then the worktree fallback after
// the seed init times out) plus a sync; waiters must not break that as
// staleness (dogfood F-66). A busy lock past CODEGRAPH_LOCK_WAIT_MS degrades
// the waiting review rather than queueing it behind another process's index
// build (dogfood F-61).
const CODEGRAPH_LOCK_STALE_MS = 2 * CODEGRAPH_INIT_TIMEOUT_MS + CODEGRAPH_SYNC_TIMEOUT_MS + 60_000;
const CODEGRAPH_LOCK_WAIT_MS = 60_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Serialize mutations of shared repo-root state across processes: CLI
 * invocations are not serialized by anything (unlike the server's request
 * queue), and an unguarded read-modify-write loses whichever side wrote
 * first.
 *
 * The lock file carries an owner token and is removed only if it is still
 * ours: if we stall past the stale threshold a waiter breaks the lock and
 * creates its own — deleting that one would re-open the race this lock
 * exists to close.
 */
async function withFileLock<T>(
  lockPath: string,
  options: { staleMs: number; waitMs: number; busyError: string },
  fn: () => T | Promise<T>,
): Promise<T> {
  const deadline = Date.now() + options.waitMs;
  const token = `${process.pid}-${randomUUID()}`;
  let acquired = false;
  while (!acquired) {
    try {
      writeFileSync(lockPath, token, { flag: "wx" });
      acquired = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > options.staleMs) {
          rmSync(lockPath, { force: true });
          continue;
        }
      } catch {
        continue; // the lock vanished — try to grab it right away
      }
      if (Date.now() > deadline) throw new Error(`${options.busyError}: ${lockPath}`);
      await sleep(25);
    }
  }
  try {
    return await fn();
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

function withRegistryLock<T>(fn: () => T | Promise<T>): Promise<T> {
  return withFileLock(
    `${registryPath()}.lock`,
    { staleMs: REGISTRY_LOCK_STALE_MS, waitMs: REGISTRY_LOCK_WAIT_MS, busyError: "repo registry lock busy" },
    fn,
  );
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
    await withRegistryLock(() => {
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

export async function removeRepo(name: string, purge: boolean): Promise<RepoEntry> {
  const entry = await withRegistryLock(() => {
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

// codegraph keeps its database in files named codegraph.db plus SQLite
// sidecars (-wal/-shm/-journal); the .gitignore it writes is config, not data.
const CODEGRAPH_DB_FILE = /^codegraph\.db(-wal|-shm|-journal)?$/;
// Completion marker inside a seed .codegraph: written only after a full init
// or a synced copy-back landed, so a partial database from a killed init is
// never mistaken for a usable seed (dogfood F-62).
const SEED_MARKER = "pir-seed-ok";

/**
 * Prepare a structural index for a review worktree (#64). Reviews run in
 * throwaway worktrees and codegraph 1.6.0 fixes its index at `<path>/.codegraph`
 * with no external-index option, so an index living in the project dir is
 * invisible to the review — without this step serve-mode reviews always probe
 * `initialized: false` and run degraded, codegraph installation and operator
 * willingness notwithstanding.
 *
 * With `PIR_CODEGRAPH=1` (opt-in): seed an index in the persistent project dir
 * (registered clone or bundle cache), copy it into the fresh worktree, sync it
 * to the review head, then copy the database back so the next review syncs
 * incrementally instead of re-indexing from the seed's original state. A seed
 * is trusted only when a past run marked it complete. Best effort throughout:
 * any failure strips the worktree index so the probe degrades cleanly — a
 * review is never blocked or served from a suspect index.
 */
async function activateCodegraph(repoDir: string, worktree: string): Promise<void> {
  const seedDir = path.join(repoDir, ".codegraph");
  const worktreeDir = path.join(worktree, ".codegraph");
  // A directory alone is not a usable seed: repos that follow codegraph's
  // advice commit .codegraph/.gitignore, so every clone carries a db-less
  // .codegraph directory. Judge readiness by the database file.
  const seedDb = path.join(seedDir, "codegraph.db");
  const seedMarker = path.join(seedDir, SEED_MARKER);
  // The seed is shared per-project state mutated from CLI processes too
  // (only a serve process serializes its own queue), so every
  // read-modify-write of it happens under a cross-process lock (dogfood
  // F-61). A busy lock past CODEGRAPH_LOCK_WAIT_MS degrades this review
  // rather than queueing it behind another process's index build.
  try {
    await withFileLock(
      path.join(repoDir, ".codegraph.lock"),
      { staleMs: CODEGRAPH_LOCK_STALE_MS, waitMs: CODEGRAPH_LOCK_WAIT_MS, busyError: "codegraph seed lock busy" },
      async () => {
        // Trust a pre-existing seed only when it carries the completion
        // marker from a past successful init/copy-back: `codegraph init`
        // writes codegraph.db incrementally, so a killed or failed init can
        // leave a partial database that must never be copied as if complete
        // (dogfood F-62).
        let seeded = existsSync(seedDb) && existsSync(seedMarker);
        if (!seeded) {
          try {
            await codegraphInit(repoDir);
            seeded = true; // exit 0: the CLI completed a full index build
          } catch {
            // Seeding can legitimately fail (e.g. a bundle cache dir has no
            // checkout to index, or the build timed out mid-db): a partial
            // database is not trusted — fall through to initializing in the
            // worktree, which always has the review's files checked out.
          }
        }
        if (seeded) {
          // Copy, not symlink: a tracked .codegraph/.gitignore makes the
          // worktree path a real directory (a symlink would nest inside it),
          // and a private copy keeps the review's index isolated from
          // anything else reading the seed. Async cp — a synchronous copy of
          // a large index would freeze the server's whole event loop, fast
          // read lane included (dogfood F-65).
          await copyDir(seedDir, worktreeDir);
        } else {
          await codegraphInit(worktree);
        }
        await codegraphSync(worktree);
        await copyCodegraphDbBack(worktreeDir, seedDir);
        // Only now is the seed known-complete: a synced index whose snapshot
        // was written back. The marker is what future reviews trust (F-62).
        if (!existsSync(seedMarker)) writeFileSync(seedMarker, "");
      },
    );
    // The merge-copy above force-overwrites any file under .codegraph that
    // the reviewed repo TRACKS with content differing from the seed's; git
    // excludes cannot hide a modified tracked file, so put the head's
    // content back — untracked artifacts (db, marker) are untouched
    // (dogfood F-67). Same for the seed dir: seeding may have rewritten a
    // tracked .codegraph/.gitignore in the persistent clone.
    await restoreTrackedCodegraph(worktree);
    await restoreTrackedCodegraph(repoDir);
    // The index copy is pir's own artifact, never user state — but audits
    // judge cleanliness with `git status --porcelain`, and codegraph's
    // self-including .codegraph/.gitignore keeps the directory visible as
    // untracked. Hide it via the repo's exclude file so isDirty() stays
    // honest (dogfood F-60). materializeWorktree only ever runs on pir-owned
    // dirs (registered clones, bundle caches), never a user checkout; a
    // linked worktree's --git-path resolves to the shared .git/info/exclude,
    // the one file every worktree of these server-side repos reads.
    try {
      const exclude = path.resolve((await git(worktree, ["rev-parse", "--git-path", "info/exclude"])).trim());
      if (!existsSync(exclude) || !readFileSync(exclude, "utf8").includes(".codegraph/")) {
        mkdirSync(path.dirname(exclude), { recursive: true });
        appendFileSync(exclude, "\n.codegraph/\n");
      }
    } catch {
      // Cosmetic only: audits may report the worktree dirty; the review
      // itself is unaffected.
    }
  } catch (err) {
    // A half-copied or stale index must not serve wrong structure data:
    // remove it so createCodeMap's probe degrades instead of trusting it.
    // Only pir's own artifacts go (databases, staging temps, the marker) — a
    // tracked .codegraph/.gitignore must survive, or the throwaway worktree
    // turns "dirty" on the failure path too (dogfood F-64).
    stripIndexArtifacts(worktreeDir);
    await restoreTrackedCodegraph(worktree);
    if (
      err instanceof CodeMapError &&
      (err.kind === "failed" || err.kind === "bad_output" || err.kind === "not_initialized")
    ) {
      // The seed itself is the likely culprit (torn copy-back, corruption,
      // an index the CLI refuses): drop it so the next review reseeds instead
      // of failing the same way forever. Timeouts, a lock held by a live
      // process, and a missing CLI leave the seed alone — it is fine, this
      // run just could not use it.
      rmSync(seedDir, { recursive: true, force: true });
      await restoreTrackedCodegraph(repoDir);
    }
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(`pir: codegraph activation failed: ${detail} — review continues degraded\n`);
  }
}

/** Remove exactly the files activation may have created in an index dir. */
function stripIndexArtifacts(dir: string): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    if (CODEGRAPH_DB_FILE.test(entry) || entry.includes(".pir-tmp") || entry === SEED_MARKER) {
      rmSync(path.join(dir, entry), { force: true });
    }
  }
}

/** Bring back a tracked .codegraph/.gitignore that a cleanup just deleted. */
async function restoreTrackedCodegraph(repoRoot: string): Promise<void> {
  try {
    await git(repoRoot, ["checkout", "--", ".codegraph"]);
  } catch {
    // nothing tracked under .codegraph (or already intact) — nothing to restore
  }
}

/** Async recursive directory merge (fs.cp with force) — never blocks the
 *  server's event loop the way cpSync would on a large index (F-65). */
async function copyDir(from: string, to: string): Promise<void> {
  const { cp } = await import("node:fs/promises");
  await cp(from, to, { recursive: true, force: true });
}

/**
 * Refresh the seed's database from the freshly synced worktree index.
 * Every file is staged as a temp first, stale sidecars from older snapshots
 * are dropped, then the temps are renamed into place — so a crash mid-copy
 * leaves the previous snapshot intact (never an empty-but-"initialized"
 * seed, and never a half-written database; leftover temps are inert and
 * cleaned by the next pass). Copies are async so a large database does not
 * freeze the event loop (dogfood F-65).
 */
async function copyCodegraphDbBack(from: string, to: string): Promise<void> {
  if (!existsSync(from)) return;
  mkdirSync(to, { recursive: true });
  const { cp } = await import("node:fs/promises");
  const want = readdirSync(from).filter((entry) => CODEGRAPH_DB_FILE.test(entry));
  // Unique temp names: even if a stale-looking lock ever gets broken while
  // its holder is still alive, two concurrent passes must not clobber the
  // same staging file (dogfood F-61).
  const staged = new Map(want.map((entry) => [`${entry}.pir-tmp-${randomUUID()}`, entry]));
  for (const [tmp, entry] of staged) {
    await cp(path.join(from, entry), path.join(to, tmp));
  }
  for (const entry of readdirSync(to)) {
    if (staged.has(entry)) continue;
    if (CODEGRAPH_DB_FILE.test(entry) || entry.includes(".pir-tmp")) rmSync(path.join(to, entry), { force: true });
  }
  for (const [tmp, entry] of staged) renameSync(path.join(to, tmp), path.join(to, entry));
}

async function materializeWorktree(repoDir: string, projectId: string, headCommit: string): Promise<MaterializedReview> {
  const workRoot = path.join(reposRoot(), "work");
  mkdirSync(workRoot, { recursive: true });
  const worktree = path.join(workRoot, randomUUID());
  await git(repoDir, ["worktree", "add", "--quiet", "--detach", worktree, headCommit]);
  if (process.env.PIR_CODEGRAPH === "1") {
    await activateCodegraph(repoDir, worktree);
  }
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
    // A bundle carries no remotes and this repo was built by init+fetch, so
    // without an origin the worktree-derived identity (computeProjectIdentity
    // reads the origin URL) falls back to the "local" project id while the
    // project dir, its memory db and the whole sync protocol are keyed by the
    // remote-derived id — remote memory writes would land under the wrong row
    // scoping and never sync back. Anchor origin to the client's remote so
    // both ids always agree. A dir that already has an origin (a repos-add
    // clone, a prior materialization) necessarily spelled the same normalized
    // remote — the dir name is the hash of it — so only the missing case
    // needs writing. meta.remoteUrl null (client without an origin) stays
    // remote-less: both sides then derive the same "local" id.
    if (meta.remoteUrl !== null && (await getRemoteUrl(dir)) === null) {
      await git(dir, ["remote", "add", "origin", meta.remoteUrl]);
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
 * Client side: pack the local commits (and nothing else) as a bundle (#46).
 * The transient refs under refs/pir/* are written in a throwaway bare repo
 * that READS the source's objects through `objects/info/alternates` — the
 * source checkout's refs, index, config and objects are never written, a
 * read-only .git works, and concurrent invocations cannot collide on ref
 * names. `git rev-parse --git-common-dir` resolves the shared object store,
 * so linked worktrees pack from their main repo's objects. The ref names
 * match what the server's materializeFromBundle fetches. The one local-write
 * exception is --uncommitted (createWorkingTreeSnapshot), which by design
 * records working-tree objects in the source repo before bundling.
 */
export async function createBundle(
  repoRoot: string,
  meta: { base: string | null; head: string },
): Promise<Buffer> {
  const headRef = "refs/pir/bundle-head";
  const baseRef = "refs/pir/bundle-base";
  // --git-common-dir is ".git" in a plain checkout, an absolute or ../
  // relative path in a linked worktree; objects always live under it.
  const commonDirRaw = (await git(repoRoot, ["rev-parse", "--git-common-dir"])).trim();
  const objectsDir = path.resolve(repoRoot, commonDirRaw, "objects");
  // A bare init would otherwise inherit the machine's init.defaultObjectFormat
  // (usually sha1); pointing alternates at a store of the other format cannot
  // resolve anything (dogfood F-52). The -c override pins the format on every
  // git that supports the knob and is an inert unknown key on older gits —
  // which cannot host sha256 anyway — so a machine defaulting to sha256 still
  // gets a sha1 temp repo for a sha1 source (dogfood F-53/F-54). The explicit
  // --object-format flag is added only for sha256, where Git 2.29+ is
  // guaranteed by the source repository's existence.
  let objectFormat = "sha1";
  try {
    objectFormat = (await git(repoRoot, ["rev-parse", "--show-object-format"])).trim();
  } catch {
    // --show-object-format needs Git 2.22; older gits predate sha256 entirely.
  }
  if (objectFormat !== "sha1" && objectFormat !== "sha256") {
    throw new Error(`unsupported source object format: ${objectFormat || "(empty)"}`);
  }
  const tempRepo = mkdtempSync(path.join(tmpdir(), "pir-bundle-repo-"));
  try {
    try {
      await git(tempRepo, [
        "-c",
        `init.defaultObjectFormat=${objectFormat}`,
        "init",
        "--quiet",
        "--bare",
        ...(objectFormat === "sha256" ? [`--object-format=${objectFormat}`] : []),
      ]);
      // An alternates line makes the temp repo resolve every source object
      // without copying it; missing line or wrong path fails the bundle step
      // below, never silently producing an empty bundle.
      mkdirSync(path.join(tempRepo, "objects", "info"), { recursive: true });
      writeFileSync(path.join(tempRepo, "objects", "info", "alternates"), `${objectsDir}\n`);
    } catch (err) {
      throw new Error(
        `failed to set up the temporary bundle repo at ${tempRepo}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    try {
      await git(tempRepo, ["update-ref", headRef, meta.head]);
      if (meta.base) await git(tempRepo, ["update-ref", baseRef, meta.base]);
      const revs = meta.base ? [headRef, `^${baseRef}`] : [headRef];
      return await gitBuffer(tempRepo, ["bundle", "create", "-", ...revs]);
    } catch (err) {
      // Reading objects/resolving refs happens against the source store via
      // alternates — a failure here is a source problem (missing objects, a
      // ref that does not resolve), not a temp-dir problem.
      throw new Error(
        `failed to pack the review bundle from ${objectsDir}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } finally {
    rmSync(tempRepo, { recursive: true, force: true });
  }
}

/** Centralized memory db for a materialized review (never inside the worktree). */
export function reviewDbPath(projectId: string): string {
  return stateRootDbPath(projectId);
}
