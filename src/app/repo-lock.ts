import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Cross-process resource lock for long-lived server-side repo operations
 * (fetch, worktree add/remove, codegraph seed builds, purge).
 *
 * Unlike the registry lock in app/repos.ts, which is held for a few
 * milliseconds and may be broken after a short mtime age, a resource lock
 * names its owner and is only ever broken on PROOF that the owner is gone:
 *
 * - the owner is on this host, and its pid no longer exists; or
 * - the owner is on this host, the pid exists, but the kernel's process start
 *   token differs — the pid was recycled after the holder died.
 *
 * No age heuristic ever breaks a lock. A holder on another host cannot be
 * probed without distributed coordination, and an unreadable record proves
 * nothing, so both are left alone: waiters fail with the lock path and a
 * human decides. That keeps the one guarantee that matters — a live process
 * is never joined by a second holder — at the cost of manual recovery for a
 * dead foreign holder.
 *
 * The break mutex that serializes breaking dead locks is conservative in the
 * same way but stricter: a leftover `.break` is NEVER reclaimed automatically,
 * because proving its owner dead is not enough to prove no other breaker began
 * after the dead one (a stale unlink can delete a live breaker and let two
 * breakers delete each other's new main lock). A provably dead breaker makes
 * acquisition fail immediately and names the `.break` path; an operator stops
 * related processes, confirms none run, and removes the file by hand.
 *
 * The lock file is created atomically (write a complete record to a private
 * temp, then link it into place) and always lives outside the state it
 * protects, so deleting that state cannot delete the lock and no waiter can
 * observe a half-written owner record.
 */

export interface ResourceLockOptions {
  /** How long a waiter queues before failing. Default 60s. */
  waitMs?: number;
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

interface LockRecord {
  owner: LockOwner | null;
  raw: string;
}

const DEFAULT_WAIT_MS = 60_000;
const DEFAULT_POLL_MS = 25;

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

function newOwner(): LockOwner {
  return {
    token: `${process.pid}-${randomUUID()}`,
    pid: process.pid,
    host: hostname(),
    procStart: processStartToken(process.pid),
    acquiredAt: Date.now(),
  };
}

/**
 * Publish a complete owner record at `lockPath`, atomically and only if it
 * does not exist yet. The temp link makes a torn record impossible: waiters
 * either see no file, or the full JSON written by the owner.
 */
function tryCreateLock(lockPath: string, owner: LockOwner): boolean {
  const temp = `${lockPath}.${owner.token}.tmp`;
  writeFileSync(temp, JSON.stringify(owner));
  try {
    linkSync(temp, lockPath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  } finally {
    rmSync(temp, { force: true });
  }
}

function readLock(lockPath: string): LockRecord | null {
  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    // Something unreadable (a directory, permissions) proves nothing: treat it
    // as held-and-unprovable so waiters time out instead of spinning forever.
    return { owner: null, raw: "" };
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
        acquiredAt: typeof parsed.acquiredAt === "number" ? parsed.acquiredAt : 0,
      };
    }
  } catch {
    // Unreadable: not proof of death, so it is never broken automatically.
  }
  return { owner, raw };
}

/**
 * True only when the owner is provably dead. Everything unprovable — another
 * host, an unparseable record, a live pid whose start token cannot be read —
 * counts as alive and is handled by the waiter's deadline instead.
 */
function ownerIsProvablyDead(owner: LockOwner): boolean {
  if (owner.host !== hostname()) return false;
  if (!pidAlive(owner.pid)) return true;
  const start = processStartToken(owner.pid);
  return owner.procStart !== null && start !== null && start !== owner.procStart;
}

/**
 * Remove a provably dead lock, serialized by the break mutex.
 *
 * The break mutex is never reclaimed automatically: a leftover `.break` file
 * is not proof that no breaker is live (a stale reader-delete could remove a
 * third process's freshly created breaker and let two breakers delete each
 * other's new main lock). A breaker whose owner is provably dead is therefore
 * a loud manual-recovery error, not an automatic cleanup; a live or
 * unprovable breaker just makes the caller wait.
 *
 * Once this process holds the break mutex, no other process can break the
 * main lock (they all need this mutex), so re-reading the observed content
 * and removing the main lock is not racing another breaker.
 */
function breakIfProvablyDead(lockPath: string, observed: LockRecord): boolean {
  const breakPath = `${lockPath}.break`;
  const breaker = newOwner();
  if (!tryCreateLock(breakPath, breaker)) {
    const held = readLock(breakPath);
    if (held?.owner && ownerIsProvablyDead(held.owner)) {
      throw new Error(
        `refusing to break ${lockPath}: its break mutex ${breakPath} was left by a dead process — ` +
          "stop any related pir processes, confirm none are running, then remove that .break file by hand",
      );
    }
    return false;
  }
  try {
    const current = readLock(lockPath);
    if (current && current.raw === observed.raw) {
      rmSync(lockPath, { force: true });
      return true;
    }
    return false;
  } finally {
    releaseIfOwner(breakPath, breaker.token);
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
  const owner = newOwner();
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (tryCreateLock(lockPath, owner)) break;
    const observed = readLock(lockPath);
    if (observed === null) continue; // the holder released it — grab it now
    if (observed.owner && ownerIsProvablyDead(observed.owner)) {
      if (!breakIfProvablyDead(lockPath, observed)) await sleep(pollMs);
      continue;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `${options.busyError ?? "resource lock busy"}: ${lockPath} — if no process is running, remove that lock file by hand`,
      );
    }
    await sleep(pollMs);
  }
  try {
    return await fn();
  } finally {
    releaseIfOwner(lockPath, owner.token);
  }
}
