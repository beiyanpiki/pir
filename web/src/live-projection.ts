import type { DerivedSession } from "./live-fold";
import type { LiveRunEnd, LiveRunMeta, RoundInfo, RunDetail, RunEvent, SessionRef } from "./types";

export type ConnectionState = "idle" | "connecting" | "open" | "unavailable" | "closed" | "error" | "unauthorized";
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
    const rounds = [...new Map([...(manifest?.rounds ?? []), ...state.rounds].map((round) => [round.round, round])).values()]
      .sort((a, b) => a.round - b.round);
    const sessions = state.sessions.slice();
    for (const session of live?.sessions ?? []) {
      const existing = sessions.findIndex((candidate) => candidate.sessionId === session.sessionId);
      const meta = { sessionId: session.sessionId, sessionKind: session.sessionKind,
          ...(session.transcriptFile ? { transcriptFile: session.transcriptFile } : {}),
          ...(session.round !== undefined ? { round: session.round } : {}), endedAt: session.endedAt };
      if (existing === -1) sessions.push(meta);
      else sessions[existing] = { ...sessions[existing], ...meta, endedAt: sessions[existing].endedAt ?? meta.endedAt };
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
type LiveSessionIdentity = Pick<DerivedSession, "sessionId" | "transcriptFile">;

export interface SessionIdentity<T extends LiveSessionIdentity = DerivedSession> {
  key: string;
  live?: T;
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

export function mergeSessionIdentities<T extends LiveSessionIdentity>(live: T[], persisted: SessionRef[]): SessionIdentity<T>[] {
  const byId = new Map<string, SessionIdentity<T>>();
  const byFile = new Map<string, SessionIdentity<T>>();
  const result: SessionIdentity<T>[] = [];
  for (const session of live) {
    const key = sessionIdentity(session);
    const item = byId.get(session.sessionId) ?? (session.transcriptFile ? byFile.get(persistedFile(session.transcriptFile)) : undefined)
      ?? { key, live: session };
    if (!result.includes(item)) result.push(item);
    item.live = session;
    byId.set(session.sessionId, item);
    if (session.transcriptFile) byFile.set(persistedFile(session.transcriptFile), item);
  }
  for (const session of persisted) {
    const item = (session.sessionId ? byId.get(session.sessionId) : undefined) ?? byFile.get(persistedFile(session.file));
    if (item) {
      item.persisted = session;
      item.key = sessionIdentity(session);
      byFile.set(persistedFile(session.file), item);
    }
    else {
      const archived = { key: sessionIdentity(session), persisted: session };
      result.push(archived);
      byFile.set(persistedFile(session.file), archived);
    }
  }
  return result;
}

/** Encode the whole identity; replacing punctuation would collide a.b and a-b. */
export function sessionAnchor(key: string): string {
  return `session-${encodeURIComponent(key)}`;
}

export interface WorkflowSession {
  key: string;
  aliases: string[];
  kind: string;
  status: "running" | "completed" | "failed" | "archived";
  label: string;
  file?: string;
  round?: number;
  findingIds: string[];
  findingMappings: Array<{ from: string; to: string }>;
}

/** A single reconciled index drives the workflow, rail and stream anchors. */
export function workflowSessions(events: RunEvent[] | null, refs: SessionRef[]): WorkflowSession[] {
  const starts: Array<Extract<RunEvent, { kind: "session-start" }>> = [];
  const ends = new Map<string, Extract<RunEvent, { kind: "session-end" }>>();
  for (const event of events ?? []) {
    if (event.kind === "session-start") starts.push(event);
    else if (event.kind === "session-end") ends.set(event.sessionId, event);
  }
  return mergeSessionIdentities(starts, refs).map(({ key, live, persisted }) => {
    const ref = persisted;
    const end = live ? ends.get(live.sessionId) : undefined;
    const findingMappings = (ref?.findingIdMap ?? []).map((entry) => ({
      from: ref?.idMap?.find((mapping) => mapping.to === entry.from)?.from ?? entry.from,
      to: entry.to,
    }));
    // Runtime display ids are assigned anew every run. Only an explicit map
    // makes a runtime id safe to link to a project-scoped durable finding.
    const mappedDisplayId = ref?.findingIdMap?.find((entry) => entry.from === ref.displayId)?.to;
    return {
      key, aliases: [...new Set([key, ...(live ? [sessionIdentity(live), `runtime:${live.sessionId}`] : []),
        ...(ref?.sessionId ? [`runtime:${ref.sessionId}`] : [])])],
      kind: ref?.sessionKind ?? live!.sessionKind,
      status: end ? end.error ? "failed" : "completed" : live ? "running" : "archived",
      label: mappedDisplayId ?? ref?.displayId ?? live?.displayId ?? ref?.angle ?? live?.angle ?? ref?.sessionKind ?? live!.sessionKind,
      ...(ref?.file || live?.transcriptFile ? { file: ref?.file ?? live?.transcriptFile } : {}),
      ...(ref?.round !== undefined || live?.round !== undefined ? { round: ref?.round ?? live?.round } : {}),
      findingIds: [...new Set(findingMappings.map((entry) => entry.to))], findingMappings,
    };
  });
}
