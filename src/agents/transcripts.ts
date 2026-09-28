import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { projectStateDir } from "../memory/identity.js";

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
 * Directory for one run's transcripts, mirroring the memory-db resolution:
 * PIR_STATE_IN_PROJECT (<repo>/.pir) > PIR_STATE_ROOT (<root>/<projectId>) >
 * per-project XDG default. Server-side that lands in the pir-state volume
 * next to memory.sqlite.
 */
export function runTranscriptDir(repoRoot: string, projectId: string, runId: string): string {
  const base =
    process.env.PIR_STATE_IN_PROJECT === "1"
      ? path.join(repoRoot, ".pir")
      : process.env.PIR_STATE_ROOT
        ? path.join(process.env.PIR_STATE_ROOT, projectId)
        : projectStateDir(projectId);
  const dir = path.join(base, "transcripts", runId);
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
