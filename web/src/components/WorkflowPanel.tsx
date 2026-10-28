import { useEffect, useMemo, useRef, useState } from "react";
import { App as AntApp, Empty, Grid, Input, Select } from "antd";
import {
  CheckCircleFilled,
  CloseCircleFilled,
  LoadingOutlined,
  RobotOutlined,
  SafetyCertificateOutlined,
  SearchOutlined,
  SafetyOutlined,
} from "@ant-design/icons";
import type { DerivedSession } from "../lib/live-fold";
import { sessionAnchor, type WorkflowSession } from "../lib/live-projection";
import { SessionTimeline } from "./SessionTimeline";

function basename(file: string): string {
  const normalized = file.replace(/\\/g, "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function SessionStatus({ status }: { status: string }) {
  if (status === "running") return <LoadingOutlined spin className="wf-session-status is-running" />;
  if (status === "failed") return <CloseCircleFilled className="wf-session-status is-failed" />;
  if (status === "completed") return <CheckCircleFilled className="wf-session-status is-completed" />;
  return <SafetyOutlined className="wf-session-status is-persisted" />;
}

function SessionRow({ session, active, onSelect }: { session: WorkflowSession; active: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      id={sessionAnchor(session.key)}
      className={`wf-session${active ? " is-active" : ""}`}
      aria-current={active ? "true" : undefined}
      onClick={onSelect}
    >
      <span className={`wf-session-icon is-${session.kind}`}>
        {session.kind === "verifier" ? <SafetyCertificateOutlined /> : <RobotOutlined />}
      </span>
      <span className="wf-session-copy">
        <span className="wf-session-label" title={session.label}>{session.label}</span>
        <span className="wf-session-meta">
          {session.kind}
          {session.round !== undefined ? ` · R${session.round}` : ""}
          {session.status === "archived" ? " · persisted" : ` · ${session.status}`}
        </span>
      </span>
      <SessionStatus status={session.status} />
    </button>
  );
}

function RailFilters({
  role,
  status,
  query,
  onFilter,
  compact = false,
}: {
  role: string;
  status: string;
  query: string;
  onFilter: (key: "role" | "status" | "q", value: string) => void;
  compact?: boolean;
}) {
  const [draft, setDraft] = useState(query);
  const pushed = useRef(query);
  const onFilterRef = useRef(onFilter);
  onFilterRef.current = onFilter;
  useEffect(() => {
    if (query === pushed.current) return;
    pushed.current = query;
    setDraft(query);
  }, [query]);
  useEffect(() => {
    if (draft === pushed.current) return;
    const timer = setTimeout(() => {
      pushed.current = draft;
      onFilterRef.current("q", draft);
    }, 250);
    return () => clearTimeout(timer);
  }, [draft]);

  return (
    <div className={`wf-filters${compact ? " is-compact" : ""}`}>
      <div className="wf-filter-buttons" role="group" aria-label="Filter sessions by role">
        {(["all", "reviewer", "verifier"] as const).map((value) => (
          <button
            key={value}
            type="button"
            className={`wf-filter${role === value ? " is-active" : ""}`}
            aria-pressed={role === value}
            onClick={() => onFilter("role", value)}
          >
            {value === "all" ? "All" : value === "reviewer" ? "Reviewer" : "Verifier"}
          </button>
        ))}
      </div>
      <select
        className="wf-status-select"
        aria-label="Filter sessions by status"
        value={status}
        onChange={(event) => onFilter("status", event.target.value)}
      >
        <option value="all">Any status</option>
        <option value="running">Running</option>
        <option value="completed">Completed</option>
        <option value="failed">Failed</option>
        <option value="archived">Persisted</option>
      </select>
      <Input
        className="wf-search"
        size="small"
        allowClear
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        prefix={<SearchOutlined />}
        placeholder="Find a session"
        aria-label="Search sessions"
      />
    </div>
  );
}

export function WorkflowPanel({
  projectId,
  runId,
  sessions,
  liveSessions,
  selected,
  role,
  status,
  query,
  onSelect,
  onFilter,
  onFinding,
}: {
  projectId: string;
  runId: string;
  sessions: WorkflowSession[];
  liveSessions: DerivedSession[];
  selected: string | null;
  role: string;
  status: string;
  query: string;
  onSelect: (key: string) => void;
  onFilter: (key: "role" | "status" | "q", value: string) => void;
  onFinding: (displayId: string) => void;
}) {
  const screens = Grid.useBreakpoint();
  const mobile = screens.lg === false;
  const { message } = AntApp.useApp();

  const liveBySession = useMemo(() => {
    const map = new Map<string, DerivedSession>();
    for (const session of liveSessions) {
      map.set(`runtime:${session.sessionId}`, session);
      if (session.transcriptFile) map.set(`file:${basename(session.transcriptFile)}`, session);
    }
    return map;
  }, [liveSessions]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return sessions.filter((session) => {
      if (role !== "all" && session.kind !== role) return false;
      if (status !== "all" && session.status !== status) return false;
      if (!needle) return true;
      return [session.label, session.file ?? "", session.kind, ...session.findingIds, ...session.aliases]
        .some((value) => value.toLowerCase().includes(needle));
    });
  }, [sessions, role, status, query]);

  const active = useMemo(() => {
    if (visible.length === 0) return null;
    if (!selected) return visible[0]!;
    return visible.find((session) => session.key === selected || session.aliases.includes(selected)) ?? visible[0]!;
  }, [selected, visible]);

  const activeIndex = active ? visible.findIndex((session) => session.key === active.key) : -1;
  const groups = useMemo(() => {
    const byRound = new Map<number, WorkflowSession[]>();
    for (const session of visible) {
      const round = session.round ?? 0;
      byRound.set(round, [...(byRound.get(round) ?? []), session]);
    }
    return [...byRound.entries()].sort(([a], [b]) => a - b);
  }, [visible]);

  const liveFor = (session: WorkflowSession): DerivedSession | undefined => {
    const runtime = session.aliases.find((alias) => alias.startsWith("runtime:"))?.slice(8);
    return (runtime ? liveBySession.get(`runtime:${runtime}`) : undefined)
      ?? (session.file ? liveBySession.get(`file:${basename(session.file)}`) : undefined);
  };

  const copyLink = async (): Promise<void> => {
    if (!active) return;
    const url = `${window.location.origin}${window.location.pathname}?tab=workflow&session=${encodeURIComponent(active.key)}`;
    try {
      await navigator.clipboard.writeText(url);
      void message.success("Session link copied");
    } catch {
      void message.error("The clipboard is unavailable in this browser");
    }
  };

  if (sessions.length === 0) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No review sessions recorded for this run" className="wf-empty" />;
  }

  return (
    <div className="wf-page">
      {mobile && (
        <div className="wf-mobile-tools">
          <Select
            className="wf-session-select"
            value={active?.key}
            onChange={(value) => onSelect(value)}
            placeholder="Choose a session"
            options={visible.map((session) => ({
              value: session.key,
              label: `${session.label} · ${session.kind}${session.round !== undefined ? ` · R${session.round}` : ""}`,
            }))}
          />
          <RailFilters role={role} status={status} query={query} onFilter={onFilter} compact />
        </div>
      )}

      <div className="wf-shell">
        {!mobile && (
          <aside className="wf-rail" aria-label="Review sessions">
            <div className="wf-rail-head">
              <div className="wf-rail-title">
                <span>Sessions</span>
                <span className="wf-rail-count">{visible.length} / {sessions.length}</span>
              </div>
              <RailFilters role={role} status={status} query={query} onFilter={onFilter} />
            </div>
            <div className="wf-rail-list">
              {groups.map(([round, roundSessions]) => (
                <div className="wf-round" key={round}>
                  <div className="wf-round-label">{round === 0 ? "Sessions" : `Round ${round}`}</div>
                  {roundSessions.map((session) => (
                    <SessionRow
                      key={session.key}
                      session={session}
                      active={active?.key === session.key}
                      onSelect={() => onSelect(session.key)}
                    />
                  ))}
                </div>
              ))}
              {visible.length === 0 && <div className="wf-rail-empty">No sessions match these filters.</div>}
            </div>
          </aside>
        )}

        {active ? (
          <SessionTimeline
            key={`${projectId}/${runId}/${active.key}`}
            session={active}
            live={liveFor(active)}
            projectId={projectId}
            runId={runId}
            position={activeIndex + 1}
            total={visible.length}
            onPrev={activeIndex > 0 ? () => onSelect(visible[activeIndex - 1]!.key) : undefined}
            onNext={activeIndex >= 0 && activeIndex < visible.length - 1 ? () => onSelect(visible[activeIndex + 1]!.key) : undefined}
            onFinding={onFinding}
            onCopy={() => void copyLink()}
          />
        ) : (
          <div className="wf-main wf-no-session">
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No sessions match these filters." />
          </div>
        )}
      </div>
    </div>
  );
}