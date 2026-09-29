import { onRunEvent, type RunEvent } from "../observability/run-events.js";
import type { SessionUsage } from "../agents/types.js";
import type { RunCounts, RunFindingSummary } from "../observability/run-events.js";

/**
 * In-memory live state for runs executing in THIS process. The registry
 * subscribes to the run-event bus and buffers each active run's timeline so
 * SSE viewers can join mid-run; the durable record remains SQLite + transcript
 * files, so buffers are bounded and dropped shortly after a run ends.
 */

export interface LiveSessionState {
  sessionId: string;
  sessionKind: "reviewer" | "verifier";
  role: string;
  model: string | null;
  round?: number;
  unitId?: string;
  attempt?: number;
  displayId?: string;
  prompt: string;
  startedAt: number;
  endedAt: number | null;
  error?: string;
  usage?: SessionUsage;
}

export interface LiveRunEnd {
  status: "completed" | "incomplete" | "failed";
  stoppedBecause: string;
  durationMs: number;
  usage?: SessionUsage;
  counts: RunCounts;
  findings: RunFindingSummary[];
  ts: number;
}

export interface LiveRunState {
  runId: string;
  projectId: string;
  mode: "change" | "audit";
  base: string | null;
  head: string;
  model: string | null;
  startedAt: number;
  lastEventAt: number;
  sessions: LiveSessionState[];
  /** Buffered events in emission order (run-level + session-level). */
  events: RunEvent[];
  end: LiveRunEnd | null;
}

export interface ActiveRunView {
  runId: string;
  projectId: string;
  mode: "change" | "audit";
  head: string;
  model: string | null;
  startedAt: number;
  sessions: number;
}

type RunEventListener = (event: RunEvent) => void;

/** Bounded buffering: deltas are the bulk, so they are evicted first. */
const MAX_BUFFERED_CHARS = 32 * 1024 * 1024;
const ENDED_RUN_GRACE_MS = 5 * 60 * 1000;
const MAX_TRACKED_RUNS = 8;

function eventChars(event: RunEvent): number {
  if (event.kind === "session-start") return event.prompt.length;
  if (event.kind === "session-tool-result") return event.result.length;
  if (event.kind === "session-delta") return event.text.length;
  if (event.kind === "session-block") {
    return event.block.type === "toolCall"
      ? JSON.stringify(event.block.arguments ?? {}).length
      : event.block.text.length;
  }
  return 0;
}

export class LiveRegistry {
  private readonly runs = new Map<string, LiveRunState>();
  private readonly unsubscribeBus: () => void;
  private bufferedChars = 0;

  constructor() {
    this.unsubscribeBus = onRunEvent((event) => this.handle(event));
  }

  dispose(): void {
    this.unsubscribeBus();
    this.runs.clear();
  }

  private run(runId: string): LiveRunState | undefined {
    return this.runs.get(runId);
  }

  private handle(event: RunEvent): void {
    let state = this.runs.get(event.runId);
    if (!state) {
      if (event.kind !== "run-start") return;
      state = {
        runId: event.runId,
        projectId: event.projectId,
        mode: event.mode,
        base: event.base,
        head: event.head,
        model: event.model,
        startedAt: event.ts,
        lastEventAt: event.ts,
        sessions: [],
        events: [],
        end: null,
      };
      this.runs.set(event.runId, state);
    }
    state.lastEventAt = event.ts;

    if (event.kind === "session-start") {
      state.sessions.push({
        sessionId: event.sessionId,
        sessionKind: event.sessionKind,
        role: event.role,
        model: event.model,
        ...(event.round !== undefined ? { round: event.round } : {}),
        ...(event.unitId !== undefined ? { unitId: event.unitId } : {}),
        ...(event.attempt !== undefined ? { attempt: event.attempt } : {}),
        ...(event.displayId !== undefined ? { displayId: event.displayId } : {}),
        prompt: event.prompt,
        startedAt: event.ts,
        endedAt: null,
      });
    } else if (event.kind === "session-end") {
      const session = state.sessions.find((candidate) => candidate.sessionId === event.sessionId);
      if (session) {
        session.endedAt = event.ts;
        if (event.error) session.error = event.error;
        if (event.usage) session.usage = event.usage;
      }
    } else if (event.kind === "run-end") {
      state.end = {
        status: event.status,
        stoppedBecause: event.stoppedBecause,
        durationMs: event.durationMs,
        ...(event.usage ? { usage: event.usage } : {}),
        counts: event.counts,
        findings: event.findings,
        ts: event.ts,
      };
    }

    state.events.push(event);
    this.bufferedChars += eventChars(event);
    if (this.bufferedChars > MAX_BUFFERED_CHARS) this.evict(state);
    this.pruneEnded();
  }

  /** Drop the oldest deltas first; structural events stay for replay fidelity. */
  private evict(state: LiveRunState): void {
    for (let i = 0; i < state.events.length && this.bufferedChars > MAX_BUFFERED_CHARS; i++) {
      const event = state.events[i]!;
      if (event.kind !== "session-delta") continue;
      this.bufferedChars -= eventChars(event);
      state.events.splice(i, 1);
      i -= 1;
    }
  }

  private pruneEnded(): void {
    const now = Date.now();
    for (const [runId, state] of this.runs) {
      if (state.end && now - state.end.ts > ENDED_RUN_GRACE_MS) {
        for (const event of state.events) this.bufferedChars -= eventChars(event);
        this.runs.delete(runId);
      }
    }
    if (this.runs.size <= MAX_TRACKED_RUNS) return;
    const ended = [...this.runs.entries()].filter(([, state]) => state.end !== null).sort((a, b) => a[1]!.end!.ts - b[1]!.end!.ts);
    for (const [runId, state] of ended.slice(0, Math.max(0, this.runs.size - MAX_TRACKED_RUNS))) {
      for (const event of state.events) this.bufferedChars -= eventChars(event);
      this.runs.delete(runId);
    }
  }

  activeRuns(): ActiveRunView[] {
    return [...this.runs.values()]
      .filter((state) => state.end === null)
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((state) => ({
        runId: state.runId, projectId: state.projectId, mode: state.mode,
        head: state.head, model: state.model, startedAt: state.startedAt, sessions: state.sessions.length,
      }));
  }

  /** Deep-enough copy for JSON serialization to a requesting client. */
  snapshot(runId: string): LiveRunState | null {
    const state = this.run(runId);
    if (!state) return null;
    return {
      ...state,
      sessions: state.sessions.map((session) => ({ ...session })),
      events: state.events.slice(),
      end: state.end ? { ...state.end } : null,
    };
  }

  /** Buffered replay followed by live delivery for one run (or all runs). */
  subscribe(runId: string | null, listener: RunEventListener): { replay: RunEvent[]; unsubscribe: () => void } {
    const replay: RunEvent[] = [];
    if (runId) {
      const state = this.run(runId);
      if (state) replay.push(...state.events);
    } else {
      for (const state of this.runs.values()) replay.push(...state.events);
      replay.sort((a, b) => a.seq - b.seq);
    }
    const wrapped = (event: RunEvent): void => {
      if (runId && event.runId !== runId) return;
      listener(event);
    };
    const off = onRunEvent(wrapped);
    return { replay, unsubscribe: off };
  }
}
