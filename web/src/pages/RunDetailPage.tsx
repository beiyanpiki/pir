import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  Activity,
  ArrowDown,
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  CircleDot,
  Clock3,
  Code2,
  Coins,
  FileSearch,
  Gauge,
  Info,
  ListTree,
  RefreshCw,
  ShieldCheck,
  ShieldAlert,
  SquareTerminal,
  X,
} from "lucide-react";
import { apiGet } from "../api";
import { fmtCost, fmtCount, fmtDuration, relTime, shortSha } from "../format";
import { useApi, useRunEvents } from "../hooks";
import { LiveBadge, ModeBadge, StatusBadge } from "../components/badges";
import { SessionTimeline, sessionDomId } from "../components/session/SessionTimeline";
import { FindingsTab } from "../components/findings";
import { CoverageTab } from "../components/coverage";
import { RunDetails } from "../components/run-details";
import { InspectorToggle } from "../layout/WorkspaceShell";
import type { ActiveRunView, ProjectSummary, RunDetail, RunEvent, SessionRef } from "../types";
import { useStickToBottom } from "use-stick-to-bottom";

type InspectorTab = "findings" | "coverage" | "details";

interface Overview {
  projects: ProjectSummary[];
  active: ActiveRunView[];
}

export function RunDetailPage() {
  const { projectId = "", runId = "" } = useParams();
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("findings");
  const [inspectorOpen, setInspectorOpen] = useState(() => window.innerWidth >= 1200);
  const detail = useApi<RunDetail>(() => apiGet<RunDetail>(`/api/runs/${projectId}/${runId}`), [projectId, runId]);
  const overview = useApi<Overview>(() => apiGet<Overview>("/api/overview"), [projectId]);

  const run = detail.data?.run;
  const live = detail.data?.live ?? null;
  const ongoing = (run?.status === "running" && run.finishedAt === null) || (live !== null && live.end === null);
  const [liveEvents, setLiveEvents] = useState<RunEvent[] | null>(null);
  const maxSeqRef = useRef(0);
  const pendingLiveEventsRef = useRef<RunEvent[]>([]);
  const liveFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const streamSticky = useStickToBottom({ initial: "smooth", resize: "smooth" });

  useEffect(() => {
    if (!detail.data) return;
    const events = detail.data.live ? detail.data.live.events : null;
    maxSeqRef.current = events ? events.reduce((max, event) => Math.max(max, (event as { seq?: number }).seq ?? 0), 0) : 0;
    setLiveEvents(events ? compactLiveEvents(events) : null);
  }, [detail.data]);

  const flushLiveEvents = useCallback(() => {
    liveFlushTimerRef.current = null;
    const pending = pendingLiveEventsRef.current;
    if (pending.length === 0) return;
    pendingLiveEventsRef.current = [];
    setLiveEvents((previous) => pending.reduce<RunEvent[]>(
      (events, event) => appendLiveEvent(events, event),
      previous ?? [],
    ));
  }, []);

  const sseStatus = useRunEvents(ongoing ? runId : null, true, (event) => {
    if (event.kind === "ready" || event.kind === "unavailable") return;
    if (event.seq <= maxSeqRef.current) return;
    maxSeqRef.current = event.seq;
    pendingLiveEventsRef.current.push(event);
    if (liveFlushTimerRef.current === null) {
      liveFlushTimerRef.current = setTimeout(flushLiveEvents, 80);
    }
    if (event.kind === "run-end") {
      setTimeout(() => detail.reload(), 800);
    }
  });

  useEffect(() => () => {
    if (liveFlushTimerRef.current !== null) clearTimeout(liveFlushTimerRef.current);
  }, []);

  const now = useTicker(ongoing ? 1000 : 0);
  const displayStatus = deriveStatus(run, live, sseStatus);
  const project = overview.data?.projects.find((candidate) => candidate.projectId === projectId);

  if (detail.loading && !detail.data) {
    return <div className="page-shell"><div className="loading-state is-page"><span className="pir-mini-spinner" /> Loading review run…</div></div>;
  }
  if (detail.error) {
    return <div className="page-shell"><div className="error-state is-page">{detail.error}</div></div>;
  }
  if (!run || !detail.data) {
    return <div className="page-shell"><div className="empty-state is-page"><FileSearch size={22} /><strong>Run not found</strong></div></div>;
  }

  const manifest = detail.data.manifest;
  const counts = live?.end?.counts ?? null;
  const confirmed = counts?.confirmed ?? run.confirmed;
  const rejected = counts?.rejected ?? run.rejected;
  const uncertain = counts?.uncertain ?? run.uncertain;
  const rounds = counts?.rounds ?? run.rounds;
  const duration = live && live.end === null
    ? now - live.startedAt
    : (run.durationMs ?? (run.finishedAt !== null ? run.finishedAt - run.startedAt : null));
  const isAudit = run.mode === "audit";
  return (
    <div className="run-page">
      <header className="run-header">
        <div className="run-heading">
          <Link className="icon-button" to={`/projects/${projectId}`} aria-label="Back to project" title="Back to project">
            <ArrowLeft size={16} />
          </Link>
          <div>
            <div className="page-eyebrow">{project?.name ?? "Review run"}</div>
            <div className="run-title-line">
              <h1>
                {run.base ? `${shortSha(run.base, 8)}…${shortSha(run.head, 8)}` : `Snapshot ${shortSha(run.head, 10)}`}
              </h1>
              <ModeBadge mode={run.mode} />
              <StatusBadge status={displayStatus} />
              {sseStatus === "open" && <LiveBadge />}
            </div>
          </div>
        </div>
        <div className="run-header-actions">
          {detail.loading && <RefreshCw size={14} className="spin" />}
          <InspectorToggle open={inspectorOpen} onClick={() => setInspectorOpen((value) => !value)} />
        </div>
      </header>

      <section className="run-context-strip" aria-label="Run summary">
        <div><Clock3 size={14} /><span><small>Started</small><strong>{relTime(run.startedAt)}</strong></span></div>
        <div><Activity size={14} /><span><small>Duration</small><strong>{fmtDuration(duration)}</strong></span></div>
        <div><ListTree size={14} /><span><small>Rounds</small><strong>{rounds}</strong></span></div>
        <div><ShieldCheck size={14} /><span><small>Confirmed</small><strong className="metric-success">{confirmed}</strong></span></div>
        <div><ShieldAlert size={14} /><span><small>Rejected / uncertain</small><strong>{rejected} / {uncertain}</strong></span></div>
        <div><Coins size={14} /><span><small>Tokens / cost</small><strong>{run.totalTokens === null ? "—" : fmtCount(run.totalTokens)} · {fmtCost(run.cost)}</strong></span></div>
        <div><Code2 size={14} /><span><small>Model</small><strong>{run.model ?? manifest?.model ?? "pi default"}</strong></span></div>
      </section>

      {!run.transcriptsAvailable && (
        <div className="notice-bar"><Info size={14} /> Transcripts were not captured for this run. Findings and run metadata are still available.</div>
      )}

      <div className="run-workspace">
        <SessionRail sessions={detail.data.sessions} liveEvents={liveEvents} />

        <section className="run-stream" aria-label="Review execution stream">
          <div className="run-scroll" ref={streamSticky.scrollRef}>
            <div className="stream-column" ref={streamSticky.contentRef}>
              {liveEvents && <ActivityLog events={liveEvents} />}
              <SessionTimeline
                projectId={projectId}
                runId={runId}
                sessions={detail.data.sessions}
                liveEvents={liveEvents}
              />
            </div>
          </div>
          {!streamSticky.isAtBottom && (
            <button
              type="button"
              className="icon-button stream-jump-latest"
              aria-label="Jump to latest"
              title="Jump to latest"
              onClick={() => void streamSticky.scrollToBottom({ animation: "smooth" })}
            >
              <ArrowDown size={15} />
            </button>
          )}
        </section>

        {inspectorOpen && <button className="inspector-scrim" type="button" aria-label="Close inspector" onClick={() => setInspectorOpen(false)} />}

        <aside className={`run-inspector ${inspectorOpen ? "is-open" : ""}`} aria-label="Review inspector">
          <div className="inspector-tabs" role="tablist" aria-label="Inspector views">
            <span className="inspector-title">Inspect</span>
            <button
              type="button"
              role="tab"
              aria-selected={inspectorTab === "findings"}
              className={inspectorTab === "findings" ? "is-active" : ""}
              onClick={() => setInspectorTab("findings")}
            >
              <ShieldAlert size={14} /> Findings <span>{detail.data.findings.length}</span>
            </button>
            {isAudit && (
              <button
                type="button"
                role="tab"
                aria-selected={inspectorTab === "coverage"}
                className={inspectorTab === "coverage" ? "is-active" : ""}
                onClick={() => setInspectorTab("coverage")}
              >
                <Gauge size={14} /> Coverage
              </button>
            )}
            <button
              type="button"
              role="tab"
              aria-selected={inspectorTab === "details"}
              className={inspectorTab === "details" ? "is-active" : ""}
              onClick={() => setInspectorTab("details")}
            >
              <Info size={14} /> Details
            </button>
            <button className="icon-button inspector-close" type="button" aria-label="Close inspector" title="Close inspector" onClick={() => setInspectorOpen(false)}>
              <X size={16} />
            </button>
          </div>
          <div className="inspector-content">
            {inspectorTab === "findings" && <FindingsTab findings={detail.data.findings} />}
            {inspectorTab === "coverage" && manifest && <CoverageTab manifest={manifest} />}
            {inspectorTab === "details" && <RunDetails detail={detail.data} />}
          </div>
        </aside>
      </div>
    </div>
  );
}

function SessionRail({
  sessions,
  liveEvents,
}: {
  sessions: SessionRef[];
  liveEvents: RunEvent[] | null;
}) {
  const liveSessionIds = useMemo(() => new Set(
    (liveEvents ?? []).filter((event) => event.kind === "session-start").map((event) => (event as { sessionId: string }).sessionId),
  ), [liveEvents]);
  const grouped = useMemo(() => {
    const rounds = new Map<number, SessionRef[]>();
    for (const session of sessions) {
      const round = session.round ?? 0;
      rounds.set(round, [...(rounds.get(round) ?? []), session]);
    }
    return [...rounds.entries()].sort(([a], [b]) => a - b);
  }, [sessions]);

  const jumpTo = (session: SessionRef | { sessionId: string }): void => {
    const target = document.getElementById(sessionDomId(session));
    target?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <aside className="session-rail" aria-label="Review sessions">
      <div className="session-rail-head">
        <span><SquareTerminal size={14} /> Sessions</span>
        <span>{sessions.length || liveSessionIds.size}</span>
      </div>

      {grouped.length === 0 && liveSessionIds.size === 0 && (
        <div className="sidebar-empty">No session index</div>
      )}

      {grouped.map(([round, roundSessions]) => (
        <section className="session-round" key={round}>
          <div className="session-round-label">{round === 0 ? "Sessions" : `Round ${round}`}</div>
          {roundSessions.map((session) => (
            <button key={session.file} type="button" className="session-link" onClick={() => jumpTo(session)}>
              <span className={`session-role-icon is-${session.sessionKind}`}>
                {session.sessionKind === "reviewer" ? <CircleDot size={13} /> : <ShieldCheck size={13} />}
              </span>
              <span>
                <strong>{session.displayId ?? (session.sessionKind === "reviewer" ? "Reviewer" : "Verifier")}</strong>
                <small>{session.file}</small>
              </span>
            </button>
          ))}
        </section>
      ))}

      {[...liveSessionIds].map((sessionId) => (
        <button key={sessionId} type="button" className="session-link is-live" onClick={() => jumpTo({ sessionId })}>
          <span className="live-dot" />
          <span><strong>Live session</strong><small>{sessionId.slice(0, 8)}</small></span>
        </button>
      ))}
    </aside>
  );
}

function deriveStatus(
  run: RunDetail["run"] | undefined,
  live: RunDetail["live"] | null,
  sseStatus: string,
): string {
  if (live?.end) return live.end.status;
  if (run?.status === "running" && run.finishedAt === null) {
    return sseStatus === "open" || sseStatus === "connecting" ? "running" : "interrupted";
  }
  return run?.status ?? "unknown";
}

function useTicker(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (intervalMs <= 0) return;
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function appendLiveEvent(events: RunEvent[], event: RunEvent): RunEvent[] {
  const previous = events[events.length - 1];
  if (
    event.kind === "session-delta" &&
    previous?.kind === "session-delta" &&
    previous.sessionId === event.sessionId &&
    previous.deltaType === event.deltaType
  ) {
    const next = events.slice();
    next[next.length - 1] = {
      ...previous,
      text: previous.text + event.text,
      seq: event.seq,
      ts: event.ts,
    };
    return next;
  }
  return [...events, event];
}

function compactLiveEvents(events: RunEvent[]): RunEvent[] {
  return events.reduce<RunEvent[]>(appendLiveEvent, []);
}

function ActivityLog({ events }: { events: RunEvent[] }) {
  const [open, setOpen] = useState(false);
  const progress = useMemo(() => events.filter((event) => event.kind === "progress"), [events]);
  const visible = open ? progress : progress.slice(-5);

  if (progress.length === 0) return null;

  return (
    <section className="activity-log">
      <header>
        <span><Activity size={14} /> Run progress</span>
        {progress.length > 5 && (
          <button type="button" onClick={() => setOpen((value) => !value)}>
            {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            {open ? "Collapse" : `${progress.length} events`}
          </button>
        )}
      </header>
      <div>
        {visible.map((event, index) => (
          event.kind === "progress" ? (
            <div key={`${event.seq}-${index}`} className="activity-log-row">
              <time>{new Date(event.ts).toLocaleTimeString()}</time>
              <code>{event.phase}</code>
              <span>{event.round !== undefined ? `R${event.round} · ` : ""}{event.message}</span>
            </div>
          ) : null
        ))}
      </div>
    </section>
  );
}
