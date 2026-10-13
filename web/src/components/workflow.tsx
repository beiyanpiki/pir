import { useMemo } from "react";
import { sessionIdentity } from "../live-projection";
import type { RunEvent, SessionRef } from "../types";

export interface WorkflowSession {
  key: string;
  kind: string;
  status: "running" | "completed" | "failed" | "archived";
  label: string;
  file?: string;
  round?: number;
  findingIds: string[];
}

/** Merge the live event index with transcript refs using the same keys as the stream. */
export function workflowSessions(events: RunEvent[] | null, refs: SessionRef[]): WorkflowSession[] {
  const sessions = new Map<string, WorkflowSession>();
  for (const event of events ?? []) {
    if (event.kind === "session-start") {
      const key = sessionIdentity(event);
      sessions.set(key, { key, kind: event.sessionKind, status: "running",
        label: event.displayId ?? event.angle ?? event.sessionKind,
        ...(event.transcriptFile ? { file: event.transcriptFile } : {}),
        ...(event.round !== undefined ? { round: event.round } : {}), findingIds: [] });
    } else if (event.kind === "session-end") {
      for (const session of sessions.values()) {
        if (session.key === `runtime:${event.sessionId}` ||
          (events ?? []).some((start) => start.kind === "session-start" && start.sessionId === event.sessionId && sessionIdentity(start) === session.key)) {
          session.status = event.error ? "failed" : "completed";
        }
      }
    }
  }
  for (const ref of refs) {
    const key = sessionIdentity(ref);
    const previous = sessions.get(key);
    const findingIds = [...new Set([
      ...(ref.displayId ? [ref.findingIdMap?.find((entry) => entry.from === ref.displayId)?.to ?? ref.displayId] : []),
      ...(ref.findingIdMap ?? []).map((entry) => entry.to),
    ])];
    sessions.set(key, { key, kind: ref.sessionKind, status: previous?.status ?? "archived",
      label: ref.displayId ?? ref.angle ?? ref.sessionKind, file: ref.file, round: ref.round, findingIds });
  }
  return [...sessions.values()];
}

export function WorkflowTab({ sessions, selected, onSession, onFinding, role, status, query, onFilter }: {
  sessions: WorkflowSession[];
  selected: string | null;
  onSession: (key: string) => void;
  onFinding: (id: string) => void;
  role: string;
  status: string;
  query: string;
  onFilter: (key: "role" | "status" | "q", value: string) => void;
}) {
  const visible = useMemo(() => sessions.filter((session) =>
    (role === "all" || session.kind === role) &&
    (status === "all" || session.status === status) &&
    `${session.label} ${session.file ?? ""} ${session.findingIds.join(" ")}`.toLowerCase().includes(query.toLowerCase().trim()),
  ), [sessions, role, status, query]);
  return <div className="inspector-stack workflow-panel">
    <div className="workflow-filters">
      <select value={role} onChange={(event) => onFilter("role", event.target.value)} aria-label="Filter sessions by role">
        <option value="all">All roles</option><option value="reviewer">Reviewer</option><option value="verifier">Verifier</option>
      </select>
      <select value={status} onChange={(event) => onFilter("status", event.target.value)} aria-label="Filter sessions by status">
        <option value="all">All statuses</option><option value="running">Running</option><option value="completed">Completed</option>
        <option value="failed">Failed</option><option value="archived">Archived</option>
      </select>
      <input type="search" value={query} onChange={(event) => onFilter("q", event.target.value)} placeholder="Find a session or finding" aria-label="Search sessions" />
    </div>
    <div className="workflow-count">{visible.length} of {sessions.length} sessions</div>
    {visible.map((session) => <section className="inspector-section workflow-session" key={session.key}>
      <button type="button" className={selected === session.key ? "is-active" : ""} onClick={() => onSession(session.key)}>
        <strong>{session.label}</strong><small>{session.kind} · {session.status}{session.round ? ` · round ${session.round}` : ""}</small>
        {session.file && <code>{session.file}</code>}
      </button>
      {session.findingIds.length > 0 && <div className="workflow-finding-links">{session.findingIds.map((id) =>
        <button type="button" key={id} onClick={() => onFinding(id)}>{id}</button>)}</div>}
    </section>)}
    {visible.length === 0 && <div className="empty-state is-compact">No matching sessions</div>}
  </div>;
}
