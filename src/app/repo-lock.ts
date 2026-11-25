import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Cross-process resource lock for long-lived server-side repo operations
 * (fetch, worktree add/remove, codegraph seed builds, purge).
 *
 * Unlike the registry lock in app/repos.ts, which is held for a few
 * milliseconds and may be broken after a short mtime age, a resource lock
 * names its owner: pid plus the Linux process start time, so a recycled pid
 * is not mistaken for the original holder. A holder on the same host is
 * considered alive while its pid lives (and its start token matches); only
 * then does a waiter queue, and only a provably dead owner is broken
 * immediately. Owners on another host (a shared filesystem) cannot be probed,
 * so their lock is broken only after a generous age — being conservative
 * there degrades to a busy error, never to two holders.
 *
 * The lock file is created with O_EXCL and always lives outside the state it
 * protects, so deleting that state cannot delete the lock.
 */

export interface ResourceLockOptions {
  /** How long a waiter queues before failing. Default 60s. */
  waitMs?: number;
  /** Age after which an unpromptable (other-host) owner is assumed dead. Default 30min. */
  foreignStaleMs?: number;
  /** Age after which an unparseable lock record is assumed dead. Default 60s. */
  corruptStaleMs?: number;
  /** Poll interval while a live owner keeps the lock. Default 25ms. */
  pollMs?: number;
  busyError?: string;
}

interface LockOwner {
  token: string;
  pid: number;
  host: string;
  /** Linux /proc/<pid>/stat field 22; null when unreadable. */
  procStart: string | null;
  acquiredAt: number;
}

interface LockFile {
  owner: LockOwner | null;
  raw: string;
  mtimeMs: number;
}

const DEFAULT_WAIT_MS = 60_000;
const DEFAULT_FOREIGN_STALE_MS = 30 * 60_000;
const DEFAULT_CORRUPT_STALE_MS = 60_000;
const DEFAULT_POLL_MS = 25;
// Breaking a lock is read-compare-remove under a break mutex, so a break file
// older than this can only belong to a crashed breaker.
const BREAK_LOCK_STALE_MS = 10_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function processStartToken(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const commEnd = stat.lastIndexOf(")");
    if (commEnd < 0) return null;
    // Fields after "comm)" begin at field 3; starttime is field 22.
    return stat.slice(commEnd + 2).split(" ")[19] ?? null;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLock(lockPath: string): LockFile | null {
  let raw: string;
  let mtimeMs: number;
  try {
    raw = readFileSync(lockPath, "utf8");
    mtimeMs = statSync(lockPath).mtimeMs;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  let owner: LockOwner | null = null;
  try {
    const parsed = JSON.parse(raw) as Partial<LockOwner>;
    if (typeof parsed.token === "string" && typeof parsed.pid === "number" && typeof parsed.host === "string") {
      owner = {
        token: parsed.token,
        pid: parsed.pid,
        host: parsed.host,
        procStart: typeof parsed.procStart === "string" ? parsed.procStart : null,
        acquiredAt: typeof parsed.acquiredAt === "number" ? parsed.acquiredAt : mtimeMs,
      };
    }
  } catch {
    // A torn record (holder died between create and write): judged by age.
  }
  return { owner, raw, mtimeMs };
}

function ownerIsDead(lock: LockFile, now: number, options: ResourceLockOptions): boolean {
  if (!lock.owner) return now - lock.mtimeMs > (options.corruptStaleMs ?? DEFAULT_CORRUPT_STALE_MS);
  const owner = lock.owner;
  if (owner.host !== hostname()) return now - lock.mtimeMs > (options.foreignStaleMs ?? DEFAULT_FOREIGN_STALE_MS);
  if (!pidAlive(owner.pid)) return true;
  const start = processStartToken(owner.pid);
  // Both tokens known and different: the pid was recycled after the holder died.
  return owner.procStart !== null && start !== null && start !== owner.procStart;
}

/**
 * Remove a provably dead lock. The break mutex closes the race where two
 * waiters both decide a lock is stale and the second removes the lock the
 * first just re-acquired. The re-read of the observed raw content right
 * before the unlink closes the remaining window against a fresh owner.
 */
function breakIfUnchanged(lockPath: string, observed: LockFile, now: number): boolean {
  const breakPath = `${lockPath}.break`;
  const existing = readLock(breakPath);
  if (existing) {
    if (now - existing.mtimeMs <= BREAK_LOCK_STALE_MS) return false;
    rmSync(breakPath, { force: true });
  }
  try {
    writeFileSync(breakPath, `${process.pid}-${randomUUID()}`, { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
  try {
    const current = readLock(lockPath);
    if (current && current.raw === observed.raw) {
      rmSync(lockPath, { force: true });
      return true;
    }
    return false;
  } finally {
    rmSync(breakPath, { force: true });
  }
}

function releaseIfOwner(lockPath: string, token: string): void {
  try {
    const current = readLock(lockPath);
    if (current?.owner?.token === token) rmSync(lockPath, { force: true });
  } catch {
    // Someone already broke a lock they proved stale; never delete theirs.
  }
}

/** Run `fn` while holding the cross-process lock at `lockPath`. */
export async function withResourceLock<T>(
  lockPath: string,
  options: ResourceLockOptions,
  fn: () => T | Promise<T>,
): Promise<T> {
  mkdirSync(path.dirname(lockPath), { recursive: true });
  const owner: LockOwner = {
    token: `${process.pid}-${randomUUID()}`,
    pid: process.pid,
    host: hostname(),
    procStart: processStartToken(process.pid),
    acquiredAt: Date.now(),
  };
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      writeFileSync(lockPath, JSON.stringify(owner), { flag: "wx" });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const observed = readLock(lockPath);
      if (observed === null) continue; // the holder released it — grab it now
      const now = Date.now();
      if (ownerIsDead(observed, now, options)) {
        if (!breakIfUnchanged(lockPath, observed, now)) await sleep(pollMs);
        continue;
      }
      if (now > deadline) throw new Error(`${options.busyError ?? "resource lock busy"}: ${lockPath}`);
      await sleep(pollMs);
    }
  }
  try {
    return await fn();
  } finally {
    releaseIfOwner(lockPath, owner.token);
  }
}
