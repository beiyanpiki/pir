import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

/**
 * Opt-in session transcripts: with PIR_TRANSCRIPTS=1 every reviewer/verifier
 * session of a run is dumped to JSON — the full message list including
 * thinking blocks and tool traffic. Sessions themselves stay in-memory and
 * disposable; this is the only place a conversation survives a run.
 */

export function transcriptsEnabled(): boolean {
  const value = process.env.PIR_TRANSCRIPTS;
  return value === "1" || value === "true";
}

/**
 * Directory for one run's transcripts, derived from the memory db the run
 * actually uses — including the explicit dbPath the server passes for its
 * bundle/worktree flows — rather than re-resolving the env chain. The image
 * bakes PIR_STATE_IN_PROJECT=1 for docker-exec mode and the serve process
 * inherits it, so env-first resolution placed transcripts inside throwaway
 * worktrees that `git worktree remove --force` deletes when the review ends.
 * Next to the db they land in <repo>/.pir (docker exec) or
 * PIR_STATE_ROOT/<projectId> (serve) and survive the run.
 */
export function runTranscriptDir(dbPath: string, runId: string): string {
  const dir = path.join(path.dirname(dbPath), "transcripts", runId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Write one transcript. Best-effort by design: a failed dump must never fail
 * the review it was recording.
 */
export function writeTranscript(file: string, payload: unknown): void {
  try {
    writeFileSync(file, `${JSON.stringify(payload, jsonReplacer, 2)}\n`, "utf8");
  } catch (err) {
    process.stderr.write(
      `pir: failed to write session transcript ${file}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "function" || typeof value === "symbol") return undefined;
  if (typeof value === "bigint") return value.toString();
  return value;
}
