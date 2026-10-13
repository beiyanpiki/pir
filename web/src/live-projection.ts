import type { DerivedSession } from "./live-fold";
import type { LiveRunEnd, LiveRunMeta, RoundInfo, RunDetail, RunEvent, SessionRef } from "./types";

export type ConnectionState = "idle" | "connecting" | "open" | "unavailable" | "closed" | "error";
export type ExecutionState = "unknown" | "running" | "completed" | "incomplete" | "failed";

/** Run facts and transport health are independent: a broken stream cannot end a review. */
export interface LiveRunProjection {
  runId: string;
  executionState: ExecutionState;
  connectionState: ConnectionState;
  lastSeq: number;
  lastEventAt: number | null;
  phase: string | null;
  round: number;
  rounds: RoundInfo[];
  counts: LiveRunEnd["counts"] | null;
  end: LiveRunEnd | null;
  sessions: Array<{
    sessionId: string;
    transcriptFile?: string;
    sessionKind: "reviewer" | "verifier";
    round?: number;
    endedAt: number | null;
  }>;
}

export type ProjectionAction =
  | { type: "detail"; detail: RunDetail }
  | { type: "connection"; state: ConnectionState }
  | { type: "event"; event: RunEvent };

export function createLiveRunProjection(runId: string): LiveRunProjection {
  return {
    runId, executionState: "unknown", connectionState: "idle", lastSeq: 0,
    lastEventAt: null, phase: null, round: 0, rounds: [], counts: null, end: null, sessions: [],
  };
}

function runEnd(end: LiveRunMeta["end"]): LiveRunEnd | null {
  return end ? { ...end } : null;
}

/** Pure reducer for REST snapshots, SSE events, and transport changes. */
export function reduceLiveRunProjection(state: LiveRunProjection, action: ProjectionAction): LiveRunProjection {
  if (action.type === "connection") return state.connectionState === action.state ? state : { ...state, connectionState: action.state };

  if (action.type === "detail") {
    const { run, live, manifest } = action.detail;
    if (run.runId !== state.runId) return state;
    const end = state.end ?? runEnd(live?.end ?? null);
    const executionState: ExecutionState = end?.status as ExecutionState
      ?? (run.status === "running" && run.finishedAt === null ? "running" : run.status as ExecutionState);
    const rounds = manifest?.rounds ?? state.rounds;
    const known = new Set(state.sessions.map((session) => session.sessionId));
    const sessions = state.sessions.slice();
    for (const session of live?.sessions ?? []) {
      if (!known.has(session.sessionId)) {
        sessions.push({ sessionId: session.sessionId, sessionKind: session.sessionKind,
          ...(session.transcriptFile ? { transcriptFile: session.transcriptFile } : {}),
          ...(session.round !== undefined ? { round: session.round } : {}), endedAt: session.endedAt });
        known.add(session.sessionId);
      }
    }
    return { ...state, executionState, end, counts: end?.counts ?? state.counts,
      round: Math.max(state.round, run.rounds, ...rounds.map((item) => item.round)), rounds, sessions,
      lastEventAt: Math.max(state.lastEventAt ?? 0, live?.lastEventAt ?? 0) || null };
  }

  const event = action.event;
  if (event.kind === "ready" || event.kind === "unavailable" || event.runId !== state.runId || event.seq <= state.lastSeq) return state;
  const next: LiveRunProjection = { ...state, lastSeq: event.seq, lastEventAt: event.ts };
  if (event.kind === "run-start" && state.end === null) next.executionState = "running";
  if (event.kind === "progress") {
    next.phase = event.phase;
    if (event.round !== undefined) next.round = Math.max(next.round, event.round);
    if (event.roundInfo) {
      next.rounds = [...state.rounds.filter((round) => round.round !== event.roundInfo!.round), event.roundInfo]
        .sort((a, b) => a.round - b.round);
      next.round = Math.max(next.round, event.roundInfo.round);
      next.counts = {
        rounds: next.round,
        candidates: next.rounds.reduce((sum, round) => sum + round.fresh, 0),
        confirmed: next.rounds.reduce((sum, round) => sum + round.confirmed, 0),
        rejected: next.rounds.reduce((sum, round) => sum + round.rejected, 0),
        uncertain: next.rounds.reduce((sum, round) => sum + round.uncertain, 0),
        pending: event.roundInfo.pending ?? 0,
      };
    }
  }
  if (event.kind === "session-start") {
    if (!state.sessions.some((session) => session.sessionId === event.sessionId)) {
      next.sessions = [...state.sessions, { sessionId: event.sessionId, sessionKind: event.sessionKind,
        ...(event.transcriptFile ? { transcriptFile: event.transcriptFile } : {}),
        ...(event.round !== undefined ? { round: event.round } : {}), endedAt: null }];
    }
  }
  if (event.kind === "session-end") {
    next.sessions = state.sessions.map((session) => session.sessionId === event.sessionId ? { ...session, endedAt: event.ts } : session);
  }
  if (event.kind === "run-end") {
    next.end = { status: event.status, stoppedBecause: event.stoppedBecause, durationMs: event.durationMs,
      ...(event.usage ? { usage: event.usage } : {}), counts: event.counts, findings: event.findings, ts: event.ts };
    next.executionState = event.status as ExecutionState;
    next.counts = event.counts;
    next.round = event.counts.rounds;
    next.phase = "done";
  }
  if (state.end !== null && event.kind !== "run-end") {
    next.executionState = state.executionState;
    next.end = state.end;
    next.counts = state.end.counts;
    next.round = state.end.counts.rounds;
    next.phase = "done";
  }
  return next;
}

/** The same persisted session can be rendered live, then from its transcript. */
export interface SessionIdentity {
  key: string;
  live?: DerivedSession;
  persisted?: SessionRef;
}

function persistedFile(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

/** Prefer the durable transcript basename; runtime ids are process-local. */
export function sessionIdentity(session: Pick<DerivedSession, "sessionId" | "transcriptFile"> | Pick<SessionRef, "file">): string {
  if ("transcriptFile" in session && session.transcriptFile) return `persisted:${persistedFile(session.transcriptFile)}`;
  if ("file" in session && session.file) return `persisted:${persistedFile(session.file)}`;
  return `runtime:${"sessionId" in session ? session.sessionId : session.file}`;
}

export function mergeSessionIdentities(live: DerivedSession[], persisted: SessionRef[]): SessionIdentity[] {
  const byId = new Map<string, SessionIdentity>();
  const byFile = new Map<string, SessionIdentity>();
  const result: SessionIdentity[] = [];
  for (const session of live) {
    const item: SessionIdentity = { key: sessionIdentity(session), live: session };
    result.push(item);
    byId.set(session.sessionId, item);
    if (session.transcriptFile) byFile.set(persistedFile(session.transcriptFile), item);
  }
  for (const session of persisted) {
    const item = (session.sessionId ? byId.get(session.sessionId) : undefined) ?? byFile.get(persistedFile(session.file));
    if (item) item.persisted = session;
    else result.push({ key: `persisted:${session.file}`, persisted: session });
  }
  return result;
}
