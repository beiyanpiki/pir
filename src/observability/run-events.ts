import path from "node:path";
import { mkdirSync } from "node:fs";
import type { SessionUsage } from "../agents/types.js";
import { writeTranscript } from "../agents/transcripts.js";
import type { RoundInfo } from "../core/review-state.js";
import type { CoverageSummary } from "../core/coverage.js";
import type { ActivePack } from "../plugins/index.js";

/**
 * Process-wide observation channel for review runs. The supervisor (and only
 * the supervisor) emits RunEvents here while a review executes; the web UI's
 * live registry subscribes when `pir serve` runs with the web endpoint on.
 * With no listeners emission is a no-op, so local CLI runs pay nothing beyond
 * a few object allocations.
 *
 * Session-level detail is reduced from the raw SDK event stream: streaming
 * deltas for a live feel, authoritative blocks at message_end, tool results
 * at tool_execution_end. The final transcript files remain the durable,
 * complete record; this channel is ephemeral.
 */
export type SessionBlock =
  | { type: "thinking"; text: string; redacted?: boolean }
  | { type: "text"; text: string }
  | { type: "toolCall"; id: string; name: string; arguments: unknown };

export type RunEvent =
  | {
      kind: "run-start";
      runId: string;
      projectId: string;
      seq: number;
      ts: number;
      mode: "change" | "audit";
      base: string | null;
      head: string;
      model: string | null;
    }
  | {
      kind: "progress";
      runId: string;
      projectId: string;
      seq: number;
      ts: number;
      phase: "round-start" | "round-end" | "verify" | "info" | "done";
      round?: number;
      message: string;
      /** Present on round-end: the round record just pushed to state.rounds. */
      roundInfo?: RoundInfo;
    }
  | {
      kind: "session-start";
      runId: string;
      projectId: string;
      seq: number;
      ts: number;
      sessionId: string;
      sessionKind: "reviewer" | "verifier";
      role: string;
      model: string | null;
      round?: number;
      unitId?: string;
      attempt?: number;
      displayId?: string;
      prompt: string;
    }
  | {
      kind: "session-delta";
      runId: string;
      projectId: string;
      seq: number;
      ts: number;
      sessionId: string;
      deltaType: "thinking" | "text";
      text: string;
      /**
       * Present (true) only on deltas produced by coalescing a streak of
       * raw deltas: text then spans the whole streak from its start and
       * seq is the streak's newest. Consumers append unmarked deltas and
       * may replace their held text with a marked one that extends it.
       */
      cumulative?: boolean;
    }
  | {
      kind: "session-block";
      runId: string;
      projectId: string;
      seq: number;
      ts: number;
      sessionId: string;
      block: SessionBlock;
    }
  | {
      kind: "session-tool-result";
      runId: string;
      projectId: string;
      seq: number;
      ts: number;
      sessionId: string;
      toolCallId: string;
      name: string;
      isError: boolean;
      result: string;
      truncated: boolean;
    }
  | {
      kind: "session-end";
      runId: string;
      projectId: string;
      seq: number;
      ts: number;
      sessionId: string;
      error?: string;
      usage?: SessionUsage;
    }
  | {
      kind: "run-end";
      runId: string;
      projectId: string;
      seq: number;
      ts: number;
      status: "completed" | "incomplete" | "failed";
      stoppedBecause: string;
      durationMs: number;
      usage?: SessionUsage;
      counts: RunCounts;
      findings: RunFindingSummary[];
    };

export interface RunCounts {
  rounds: number;
  candidates: number;
  confirmed: number;
  rejected: number;
  uncertain: number;
  pending: number;
}

export interface RunFindingSummary {
  displayId: string | null;
  title: string;
  severity: string;
  status: string;
}

type RunEventListener = (event: RunEvent) => void;

const listeners = new Set<RunEventListener>();

export function hasRunEventListeners(): boolean {
  return listeners.size > 0;
}

export function onRunEvent(listener: RunEventListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emitRunEvent(event: RunEvent): void {
  if (listeners.size === 0) return;
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // An observer must never fail the review it observes.
    }
  }
}

/**
 * Emit a synthetic run event. Internal: the supervisor emits through its
 * sink; this escape hatch exists for tests driving the live registry.
 */
export function emitRunEventForTest(event: RunEvent): void {
  emitRunEvent(event);
}

/** Tool results can carry whole files; the live channel ships a bounded slice. */
const MAX_TOOL_RESULT_CHARS = 128 * 1024;

function serializeToolResult(result: unknown): { result: string; truncated: boolean } {
  let text: string;
  if (typeof result === "string") text = result;
  else {
    try {
      text = JSON.stringify(result, null, 2) ?? String(result);
    } catch {
      text = String(result);
    }
  }
  if (text.length > MAX_TOOL_RESULT_CHARS) {
    return { result: `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n…[truncated]`, truncated: true };
  }
  return { result: text, truncated: false };
}

export interface SessionMeta {
  sessionKind: "reviewer" | "verifier";
  role: string;
  model?: string;
  round?: number;
  unitId?: string;
  attempt?: number;
  displayId?: string;
}

/** Per-session handle handed to reviewer/verifier rounds by the supervisor. */
export interface SessionEventEmitter {
  /** Call once with the rendered prompt, right before session.prompt(). */
  sessionStarted(prompt: string): void;
  /** Raw SDK session event; irrelevant kinds are dropped, nothing is thrown. */
  sdkEvent(event: unknown): void;
  sessionEnded(error?: string, usage?: SessionUsage): void;
}

export interface RunEndInfo {
  status: "completed" | "incomplete" | "failed";
  stoppedBecause: string;
  durationMs: number;
  usage?: SessionUsage;
  counts: RunCounts;
  findings: RunFindingSummary[];
}

export interface RunEventSink {
  readonly runId: string;
  runStarted(meta: { mode: "change" | "audit"; base: string | null; head: string; model: string | null }): void;
  progress(meta: {
    phase: "round-start" | "round-end" | "verify" | "info" | "done";
    message: string;
    round?: number;
    /** Present on round-end: the round record just pushed to state.rounds. */
    roundInfo?: RoundInfo;
  }): void;
  session(meta: SessionMeta): SessionEventEmitter;
  runEnded(info: RunEndInfo): void;
}

export function createRunEventSink(runId: string, projectId: string): RunEventSink {
  let seq = 0;
  let sessionCounter = 0;
  const next = (): number => {
    seq += 1;
    return seq;
  };

  return {
    runId,
    runStarted(meta) {
      emitRunEvent({
        kind: "run-start", runId, projectId, seq: next(), ts: Date.now(),
        mode: meta.mode, base: meta.base, head: meta.head, model: meta.model,
      });
    },
    progress(meta) {
      emitRunEvent({
        kind: "progress", runId, projectId, seq: next(), ts: Date.now(),
        phase: meta.phase, message: meta.message,
        ...(meta.round !== undefined ? { round: meta.round } : {}),
        ...(meta.roundInfo !== undefined ? { roundInfo: meta.roundInfo } : {}),
      });
    },
    session(meta) {
      sessionCounter += 1;
      const sessionId = `${meta.sessionKind}-${sessionCounter}-${runId.slice(0, 8)}`;
      let started = false;
      return {
        sessionStarted(prompt) {
          started = true;
          emitRunEvent({
            kind: "session-start", runId, projectId, seq: next(), ts: Date.now(),
            sessionId, sessionKind: meta.sessionKind, role: meta.role, model: meta.model ?? null,
            ...(meta.round !== undefined ? { round: meta.round } : {}),
            ...(meta.unitId !== undefined ? { unitId: meta.unitId } : {}),
            ...(meta.attempt !== undefined ? { attempt: meta.attempt } : {}),
            ...(meta.displayId !== undefined ? { displayId: meta.displayId } : {}),
            prompt,
          });
        },
        sdkEvent(event) {
          if (!hasRunEventListeners()) return;
          // Structural narrowing only: the SDK's event union is not re-declared
          // here, so a future SDK can add event kinds without breaking pir.
          const typed = event as {
            type?: string;
            assistantMessageEvent?: { type?: string; delta?: string };
            message?: { role?: string; content?: Array<{ type?: string }> };
            toolCallId?: string;
            toolName?: string;
            result?: unknown;
            isError?: boolean;
            reason?: string;
          };
          if (typed.type === "message_update") {
            const delta = typed.assistantMessageEvent;
            if (delta?.type === "thinking_delta" || delta?.type === "text_delta") {
              emitRunEvent({
                kind: "session-delta", runId, projectId, seq: next(), ts: Date.now(),
                sessionId, deltaType: delta.type === "thinking_delta" ? "thinking" : "text", text: delta.delta ?? "",
              });
            }
            return;
          }
          if (typed.type === "message_end") {
            const message = typed.message;
            if (message?.role !== "assistant" || !Array.isArray(message.content)) return;
            for (const raw of message.content) {
              const block = raw as { type?: string; text?: string; thinking?: string; redacted?: boolean; id?: string; name?: string; arguments?: unknown };
              if (block.type === "thinking") {
                emitRunEvent({
                  kind: "session-block", runId, projectId, seq: next(), ts: Date.now(), sessionId,
                  block: { type: "thinking", text: block.thinking ?? "", ...(block.redacted ? { redacted: true } : {}) },
                });
              } else if (block.type === "text") {
                emitRunEvent({
                  kind: "session-block", runId, projectId, seq: next(), ts: Date.now(), sessionId,
                  block: { type: "text", text: block.text ?? "" },
                });
              } else if (block.type === "toolCall" && typeof block.id === "string" && typeof block.name === "string") {
                emitRunEvent({
                  kind: "session-block", runId, projectId, seq: next(), ts: Date.now(), sessionId,
                  block: { type: "toolCall", id: block.id, name: block.name, arguments: block.arguments },
                });
              }
            }
            return;
          }
          if (typed.type === "tool_execution_end" && typeof typed.toolCallId === "string") {
            const serialized = serializeToolResult(typed.result);
            emitRunEvent({
              kind: "session-tool-result", runId, projectId, seq: next(), ts: Date.now(),
              sessionId, toolCallId: typed.toolCallId, name: typed.toolName ?? "(unknown)",
              isError: Boolean(typed.isError), ...serialized,
            });
            return;
          }
          if (typed.type === "compaction_start") {
            emitRunEvent({
              kind: "progress", runId, projectId, seq: next(), ts: Date.now(),
              phase: "info", message: `context compaction (${typed.reason ?? "unknown"}) in ${meta.sessionKind} session`,
            });
          }
        },
        sessionEnded(error, usage) {
          // A session that never started (factory failure) still deserves a
          // tombstone so live viewers are not left with an open node.
          if (!started) {
            emitRunEvent({
              kind: "session-start", runId, projectId, seq: next(), ts: Date.now(),
              sessionId, sessionKind: meta.sessionKind, role: meta.role, model: meta.model ?? null,
              ...(meta.round !== undefined ? { round: meta.round } : {}),
              ...(meta.unitId !== undefined ? { unitId: meta.unitId } : {}),
              ...(meta.attempt !== undefined ? { attempt: meta.attempt } : {}),
              ...(meta.displayId !== undefined ? { displayId: meta.displayId } : {}),
              prompt: "",
            });
          }
          emitRunEvent({
            kind: "session-end", runId, projectId, seq: next(), ts: Date.now(), sessionId,
            ...(error ? { error } : {}), ...(usage ? { usage } : {}),
          });
        },
      };
    },
    runEnded(info) {
      emitRunEvent({
        kind: "run-end", runId, projectId, seq: next(), ts: Date.now(),
        status: info.status, stoppedBecause: info.stoppedBecause, durationMs: info.durationMs,
        ...(info.usage ? { usage: info.usage } : {}), counts: info.counts, findings: info.findings,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// run.json manifest — the persisted counterpart of the stdout envelope, so the
// web UI can render rounds/plugins/usage/coverage for finished runs without
// re-running anything. Written next to the transcripts, best-effort.
// ---------------------------------------------------------------------------

export interface RunSessionRef {
  file: string;
  sessionKind: "reviewer" | "verifier";
  round?: number;
  unitId?: string;
  attempt?: number;
  displayId?: string;
}

export interface RunManifest {
  schemaVersion: 1;
  runId: string;
  projectId: string;
  mode: "change" | "audit";
  status: "completed" | "incomplete" | "failed";
  base: string | null;
  head: string;
  model: string | null;
  /** Q5: the separate verifier model when set; null = verifiers used `model`. */
  verifierModel: string | null;
  startedAt: number;
  finishedAt: number;
  stoppedBecause: string;
  incomplete: boolean;
  /** Deterministic run-level verdict from the verified findings (Q4). */
  runVerdict: "incorrect" | "correct-with-findings" | "needs-review" | "correct";
  /** Null = the run reported without a findings cap (#57). */
  maxFindings: number | null;
  /** Explicit cap policy alongside maxFindings (#57). */
  maxFindingsMode?: "capped" | "unlimited";
  rounds: RoundInfo[];
  plugins: ActivePack[];
  sessions: RunSessionRef[];
  usage?: SessionUsage;
  durationMs: number;
  estimatedTokens: number;
  /** Change mode: the reviewed file list. */
  files?: Array<{ path: string; status: string; additions: number; deletions: number }>;
  /** Audit mode: coverage ledger summary and work-unit states. */
  coverage?: CoverageSummary;
  units?: Array<{ id: string; module: string; state: string; reason?: string; files: number; attempts: number }>;
}

export function writeRunManifest(transcriptDir: string | undefined, manifest: RunManifest): void {
  if (!transcriptDir) return;
  try {
    mkdirSync(transcriptDir, { recursive: true });
  } catch {
    // writeTranscript reports the failure; a missing dir is not fatal here.
  }
  writeTranscript(path.join(transcriptDir, "run.json"), manifest);
}
