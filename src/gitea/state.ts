import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Per-PR review state for the Gitea integration: `gitea-state.json` in the
 * pir config dir, keyed by `owner/name#number`. The endpoint (later PR) uses
 * it to re-edit its own status comment instead of duplicating one per push,
 * and to skip re-posting identical findings. Reads are deliberately
 * fault-tolerant — a missing or corrupt file means "start empty", never a
 * failed webhook.
 */

/** What pir remembers about one PR's last review run. */
export interface GiteaPrState {
  /** Head SHA the last run reviewed; a new sync with the same SHA can be skipped. */
  lastHeadSha: string;
  /** Gitea review id of the last posted review, for delete-and-repost. */
  reviewId: number | null;
  /** The issue comment carrying the status line, for edit-in-place. */
  statusCommentId: number | null;
  /** Finding fingerprints (path+claim identity) already posted, to avoid repeats. */
  lastPostedFingerprints: string[];
  /** ISO timestamp of the last update to this entry. */
  updatedAt: string;
}

/**
 * File shape — a `prs` map so the store can grow new top-level sections
 * (versioning, per-instance data) without a migration.
 */
export interface GiteaStateStore {
  prs: Record<string, GiteaPrState>;
}

export function giteaStateFile(configDir: string): string {
  return path.join(configDir, "gitea-state.json");
}

/** State map key for one PR: `owner/name#number`. */
export function giteaStateKey(repoFullName: string, number: number): string {
  return `${repoFullName}#${number}`;
}

function emptyStore(): GiteaStateStore {
  return { prs: {} };
}

/**
 * Load the state store; missing, unreadable, or corrupt file → empty store.
 * Unlike gitea.json (a user-authored contract), this file is machine-owned:
 * a bad copy is repaired by the next save rather than blocking webhooks.
 */
export function loadGiteaState(configDir: string): GiteaStateStore {
  let raw: string;
  try {
    raw = readFileSync(giteaStateFile(configDir), "utf8");
  } catch {
    return emptyStore();
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return emptyStore();
    const prs = (parsed as Record<string, unknown>).prs;
    if (typeof prs !== "object" || prs === null || Array.isArray(prs)) return emptyStore();
    return { prs: prs as Record<string, GiteaPrState> };
  } catch {
    return emptyStore();
  }
}

/**
 * Persist the store atomically: tmp file in the same directory (same
 * filesystem, so the rename is atomic), then rename over the target. Mode
 * 0600 with a best-effort chmod — same belt-and-braces as the receipts
 * writer. Returns the file path.
 */
export function saveGiteaState(configDir: string, state: GiteaStateStore): string {
  mkdirSync(configDir, { recursive: true });
  const file = giteaStateFile(configDir);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* best effort */
  }
  renameSync(tmp, file);
  return file;
}

/**
 * Synchronously read-modify-write one PR entry against the latest on-disk store, so concurrent runs for different PRs cannot clobber each other by saving a stale snapshot of the whole `prs` map. The updater receives the entry currently on disk (null when absent) and must return this run's complete entry for `key`; every other key is preserved verbatim.
 *
 * Synchronous on purpose: Node runs it to completion without yielding, which makes the read-modify-write atomic among callers in this process. It does not coordinate separate processes sharing the same config dir.
 */
export function updateGiteaPrState(
  configDir: string,
  key: string,
  update: (previous: GiteaPrState | null) => GiteaPrState,
): GiteaPrState {
  const state = loadGiteaState(configDir);
  const next = update(state.prs[key] ?? null);
  state.prs[key] = next;
  saveGiteaState(configDir, state);
  return next;
}
