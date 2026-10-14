import { useMemo } from "react";
import type { WorkflowSession } from "../live-projection";

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
      <button type="button" className={session.aliases.includes(selected ?? "") ? "is-active" : ""} onClick={() => onSession(session.key)}>
        <strong>{session.label}</strong><small>{session.kind} · {session.status}{session.round ? ` · round ${session.round}` : ""}</small>
        {session.file && <code>{session.file}</code>}
      </button>
      {session.findingIds.length > 0 && <div className="workflow-finding-links">{session.findingMappings.map((entry) =>
        <button type="button" key={`${entry.from}:${entry.to}`} onClick={() => onFinding(entry.to)}>{entry.from} → {entry.to}</button>)}</div>}
    </section>)}
    {visible.length === 0 && <div className="empty-state is-compact">No matching sessions</div>}
  </div>;
}
