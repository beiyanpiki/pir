import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
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
import { mergeEvents } from "../live-fold";
import { createLiveRunProjection, reduceLiveRunProjection, sessionAnchor, workflowSessions, type WorkflowSession } from "../live-projection";
import { LiveBadge, ModeBadge, StatusBadge } from "../components/badges";
import { SessionTimeline } from "../components/session/SessionTimeline";
import { FindingsTab } from "../components/findings";
import { CoverageTab } from "../components/coverage";
import { RunDetails } from "../components/run-details";
import { WorkflowTab } from "../components/workflow";
import { PageError } from "../components/page-controls";
import { InspectorToggle } from "../layout/WorkspaceShell";
import type { ActiveRunView, ProjectSummary, RunDetail, RunEvent } from "../types";
import { useStickToBottom } from "use-stick-to-bottom";

type InspectorTab = "findings" | "workflow" | "coverage" | "details";

interface Overview {
  projects: ProjectSummary[];
  active: ActiveRunView[];
}

export function RunDetailPage() {
  const { projectId = "", runId = "" } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = searchParams.get("tab");
  const inspectorTab: InspectorTab = requestedTab === "workflow" || requestedTab === "coverage" || requestedTab === "details" ? requestedTab : "findings";
  const selectedSession = searchParams.get("session");
  const selectedFinding = searchParams.get("finding");
  const updateQuery = useCallback((changes: Record<string, string | null>) => {
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous);
      for (const [key, value] of Object.entries(changes)) {
        if (value === null) next.delete(key);
        else next.set(key, value);
      }
      return next;
    });
  }, [setSearchParams]);
  const [inspectorOpen, setInspectorOpen] = useState(() => window.innerWidth >= 1280);
  const [narrowInspector, setNarrowInspector] = useState(() => window.innerWidth < 1280);
  const inspectorRef = useRef<HTMLElement | null>(null);
  const inspectorOpenerRef = useRef<HTMLElement | null>(null);
  const detail = useApi<RunDetail>((signal) => apiGet<RunDetail>(`/api/runs/${projectId}/${runId}`, signal), [projectId, runId]);
  const overview = useApi<Overview>((signal) => apiGet<Overview>("/api/overview", signal), [projectId]);
  const run = detail.data?.run;
  const live = detail.data?.live ?? null;
  const [liveEvents, setLiveEvents] = useState<RunEvent[] | null>(null);
  const [projection, setProjection] = useState(() => createLiveRunProjection(runId));
  const ongoing = projection.end === null && projection.executionState !== "completed" &&
    projection.executionState !== "incomplete" && projection.executionState !== "failed" &&
    ((run?.status === "running" && run.finishedAt === null) || (live !== null && live.end === null));
  const maxSeqRef = useRef(0);
  const pendingLiveEventsRef = useRef<RunEvent[]>([]);
  const liveFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const calibrationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastCalibrationRef = useRef(0);
  const receivedReadyRef = useRef(false);
  const streamSticky = useStickToBottom({ initial: selectedSession ? false : "smooth", resize: "smooth" });
  const { stopScroll } = streamSticky;
  const calibrate = useCallback(() => {
    if (calibrationTimerRef.current !== null) return;
    calibrationTimerRef.current = setTimeout(() => {
      calibrationTimerRef.current = null;
      lastCalibrationRef.current = Date.now();
      detail.reload();
    }, Math.max(240, 1_000 - (Date.now() - lastCalibrationRef.current)));
  }, [detail.reload]);

  useEffect(() => {
    const update = (): void => setNarrowInspector(window.innerWidth < 1280);
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  useEffect(() => {
    if (!inspectorOpen || !narrowInspector) return;
    const inspector = inspectorRef.current;
    if (!inspector) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body && active !== document.documentElement) {
      inspectorOpenerRef.current = active;
    }
    const background = document.querySelectorAll<HTMLElement>(".workspace-topbar, .workspace-sidebar, .run-header, .run-context-strip, .notice-bar, .session-rail, .run-stream");
    background.forEach((element) => { element.inert = true; });
    const focusable = (): HTMLElement[] => [...inspector.querySelectorAll<HTMLElement>("button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])")];
    (focusable()[0] ?? inspector).focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") { event.preventDefault(); setInspectorOpen(false); return; }
      if (event.key !== "Tab") return;
      const nodes = focusable();
      if (nodes.length === 0) { event.preventDefault(); return; }
      if (event.shiftKey && document.activeElement === nodes[0]) { event.preventDefault(); nodes[nodes.length - 1].focus(); }
      else if (!event.shiftKey && document.activeElement === nodes[nodes.length - 1]) { event.preventDefault(); nodes[0].focus(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      background.forEach((element) => { element.inert = false; });
      // A run change can replace the page under the drawer, so the saved
      // opener may be detached: fall back to the current toggle instead of
      // dropping focus onto the body.
      const opener = inspectorOpenerRef.current;
      if (opener?.isConnected) opener.focus();
      else document.querySelector<HTMLElement>(".run-header-actions button")?.focus();
    };
  }, [inspectorOpen, narrowInspector, detail.data !== null && !detail.error]);

  // Live events arrive over SSE only (the REST detail ships metadata, not the
  // replay buffer), so switching runs must reset the sequence cursor — a stale
  // high-water mark would silently drop the next run's early events.
  useEffect(() => {
    if (liveFlushTimerRef.current !== null) clearTimeout(liveFlushTimerRef.current);
    if (calibrationTimerRef.current !== null) clearTimeout(calibrationTimerRef.current);
    liveFlushTimerRef.current = null;
    calibrationTimerRef.current = null;
    lastCalibrationRef.current = 0;
    receivedReadyRef.current = false;
    maxSeqRef.current = 0;
    pendingLiveEventsRef.current = [];
    setLiveEvents(null);
    setProjection(createLiveRunProjection(runId));
    return () => {
      if (liveFlushTimerRef.current !== null) clearTimeout(liveFlushTimerRef.current);
      if (calibrationTimerRef.current !== null) clearTimeout(calibrationTimerRef.current);
    };
  }, [projectId, runId]);

  useEffect(() => {
    if (detail.data) setProjection((previous) => reduceLiveRunProjection(previous, { type: "detail", detail: detail.data! }));
  }, [detail.data]);

  const flushLiveEvents = useCallback(() => {
    liveFlushTimerRef.current = null;
    const pending = pendingLiveEventsRef.current;
    if (pending.length === 0) return;
    pendingLiveEventsRef.current = [];
    setLiveEvents((previous) => mergeEvents(previous ?? [], pending));
    setProjection((previous) => pending.reduce((state, event) => reduceLiveRunProjection(state, { type: "event", event }), previous));
  }, []);

  const sseStatus = useRunEvents(ongoing ? runId : null, true, (event) => {
    if (event.kind === "ready") {
      if (receivedReadyRef.current) calibrate();
      receivedReadyRef.current = true;
      return;
    }
    if (event.kind === "unavailable") { calibrate(); return; }
    if (event.runId !== runId || event.projectId !== projectId || event.seq <= maxSeqRef.current) return;
    maxSeqRef.current = event.seq;
    pendingLiveEventsRef.current.push(event);
    if (liveFlushTimerRef.current === null) liveFlushTimerRef.current = setTimeout(flushLiveEvents, 80);
    if (event.kind === "run-end" || (event.kind === "progress" && event.phase === "round-end") ||
        (event.kind === "session-end" && [...(liveEvents ?? []), ...pendingLiveEventsRef.current]
          .some((start) => start.kind === "session-start" && start.sessionId === event.sessionId && start.sessionKind === "verifier"))) {
      calibrate();
    }
  });

  useEffect(() => {
    setProjection((previous) => reduceLiveRunProjection(previous, { type: "connection", state: sseStatus }));
  }, [sseStatus]);

  const now = useTicker(ongoing ? 1000 : 0);
  const displayStatus = projection.executionState !== "unknown" ? projection.executionState : deriveStatus(run, live);
  const project = overview.data?.projects.find((candidate) => candidate.projectId === projectId);
  // While the SSE replay has not landed yet, hold the stream on a spinner
  // instead of flashing the settled "no transcripts" state for a live run.
  const awaitingLive = ongoing && liveEvents === null && sseStatus !== "unavailable" && sseStatus !== "error" && sseStatus !== "unauthorized";
  const workflow = useMemo(() => workflowSessions(liveEvents, detail.data?.sessions ?? []), [liveEvents, detail.data?.sessions]);
  const selectedSessionKey = workflow.find((session) => session.aliases.includes(selectedSession ?? ""))?.key ?? selectedSession;
  useEffect(() => {
    if (!selectedSessionKey) return;
    stopScroll();
    const jump = (): boolean => {
      const target = document.getElementById(sessionAnchor(selectedSessionKey));
      if (!target) return false;
      target.scrollIntoView({ block: "start" });
      return true;
    };
    if (jump()) return;
    // The incremental session fold mounts one effect after the replay index.
    const observer = new MutationObserver(() => { if (jump()) observer.disconnect(); });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [selectedSessionKey, runId, stopScroll]);
  const selectSession = (key: string): void => {
    stopScroll();
    updateQuery({ tab: "workflow", session: key });
    document.getElementById(sessionAnchor(key))?.scrollIntoView({ block: "start" });
  };
  useEffect(() => {
    if (inspectorTab !== "findings" || !selectedFinding) return;
    document.getElementById(`finding-${selectedFinding}`)?.scrollIntoView({ block: "center" });
  }, [inspectorTab, selectedFinding, detail.data?.findings]);

  if (detail.loading && !detail.data) {
    return <div className="page-shell"><div className="loading-state is-page"><span className="pir-mini-spinner" /> Loading review run…</div></div>;
  }
  if (detail.error && !detail.data) {
    return <div className="page-shell"><PageError error={detail.error} retry={detail.reload} /></div>;
  }
  if (!run || !detail.data) {
    return <div className="page-shell"><div className="empty-state is-page"><FileSearch size={22} /><strong>Run not found</strong></div></div>;
  }

  const manifest = detail.data.manifest;
  const counts = projection.counts ?? live?.end?.counts ?? null;
  const confirmed = counts?.confirmed ?? run.confirmed;
  const rejected = counts?.rejected ?? run.rejected;
  const uncertain = counts?.uncertain ?? run.uncertain;
  const rounds = projection.round || counts?.rounds || run.rounds;
  const duration = live && live.end === null
    ? now - live.startedAt
    : (run.durationMs ?? (run.finishedAt !== null ? run.finishedAt - run.startedAt : null));
  const isAudit = run.mode === "audit";
  const activeInspectorTab = inspectorTab === "coverage" && !isAudit ? "findings" : inspectorTab;
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

      {ongoing && sseStatus !== "open" && <div className="notice-bar" role="status"><Info size={14} />
        {sseStatus === "unavailable" ? "Live connection unavailable. Run state is awaiting confirmation." :
          sseStatus === "error" || sseStatus === "closed" ? "Live connection disconnected. Reconnecting; run state is awaiting confirmation." : "Connecting to live stream…"}
      </div>}
      {detail.error && <div className="notice-bar" role="status"><Info size={14} /> {detail.error} <button type="button" className="text-command" onClick={detail.reload}>Retry</button></div>}
      {!run.transcriptsAvailable && (
        <div className="notice-bar"><Info size={14} /> Transcripts were not captured for this run. Findings and run metadata are still available.</div>
      )}

      <div className={`run-workspace ${inspectorOpen ? "has-inspector" : ""}`}>
        <SessionRail sessions={workflow} selected={selectedSessionKey} onSession={selectSession} />

        <section className="run-stream" aria-label="Review execution stream">
          <div className="run-scroll" ref={streamSticky.scrollRef}>
            <div className="stream-column" ref={streamSticky.contentRef}>
              {liveEvents && <ActivityLog events={liveEvents} />}
              <SessionTimeline
                projectId={projectId}
                runId={runId}
                sessions={detail.data.sessions}
                liveEvents={liveEvents}
                awaitingLive={awaitingLive}
                preferPersisted={manifest !== null && projection.executionState !== "running"}
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

        {inspectorOpen && narrowInspector && <button className="inspector-scrim" type="button" aria-label="Close inspector" onClick={() => setInspectorOpen(false)} />}

        <aside ref={inspectorRef} className={`run-inspector ${inspectorOpen ? "is-open" : ""}`} aria-label="Review inspector" role={narrowInspector && inspectorOpen ? "dialog" : "complementary"} aria-modal={narrowInspector && inspectorOpen ? true : undefined} tabIndex={-1}>
          <div className="inspector-tabs" role="tablist" aria-label="Inspector views">
            <span className="inspector-title">Inspect</span>
            <button
              type="button"
              role="tab"
              aria-selected={activeInspectorTab === "findings"}
              className={activeInspectorTab === "findings" ? "is-active" : ""}
              onClick={() => updateQuery({ tab: "findings" })}
            >
              <ShieldAlert size={14} /> Findings <span>{detail.data.findings.total}</span>
            </button>
            <button type="button" role="tab" aria-selected={activeInspectorTab === "workflow"}
              className={activeInspectorTab === "workflow" ? "is-active" : ""}
              onClick={() => updateQuery({ tab: "workflow" })}>
              <ListTree size={14} /> Workflow <span>{workflow.length}</span>
            </button>
            {isAudit && (
              <button
                type="button"
                role="tab"
                aria-selected={activeInspectorTab === "coverage"}
                className={activeInspectorTab === "coverage" ? "is-active" : ""}
                onClick={() => updateQuery({ tab: "coverage" })}
              >
                <Gauge size={14} /> Coverage
              </button>
            )}
            <button
              type="button"
              role="tab"
              aria-selected={activeInspectorTab === "details"}
              className={activeInspectorTab === "details" ? "is-active" : ""}
              onClick={() => updateQuery({ tab: "details" })}
            >
              <Info size={14} /> Details
            </button>
            <button className="icon-button inspector-close" type="button" aria-label="Close inspector" title="Close inspector" onClick={() => setInspectorOpen(false)}>
              <X size={16} />
            </button>
          </div>
          <div className="inspector-content">
            {activeInspectorTab === "findings" && <FindingsTab projectId={projectId} runId={runId} findings={detail.data.findings} selectedFinding={selectedFinding} />}
            {activeInspectorTab === "workflow" && <WorkflowTab sessions={workflow} selected={selectedSession}
              onSession={selectSession}
              onFinding={(id) => updateQuery({ tab: "findings", finding: id })}
              role={searchParams.get("role") ?? "all"} status={searchParams.get("status") ?? "all"} query={searchParams.get("q") ?? ""}
              onFilter={(key, value) => updateQuery({ [key]: value === "all" || value === "" ? null : value })} />}
            {activeInspectorTab === "coverage" && manifest && <CoverageTab manifest={manifest} />}
            {activeInspectorTab === "details" && <RunDetails detail={detail.data} />}
          </div>
        </aside>
      </div>
    </div>
  );
}

function SessionRail({ sessions, selected, onSession }: {
  sessions: WorkflowSession[];
  selected: string | null;
  onSession: (key: string) => void;
}) {
  const grouped = useMemo(() => {
    const rounds = new Map<number, WorkflowSession[]>();
    for (const session of sessions) {
      const round = session.round ?? 0;
      rounds.set(round, [...(rounds.get(round) ?? []), session]);
    }
    return [...rounds.entries()].sort(([a], [b]) => a - b);
  }, [sessions]);
  return <aside className="session-rail" aria-label="Review sessions">
    <div className="session-rail-head"><span><SquareTerminal size={14} /> Sessions</span><span>{sessions.length}</span></div>
    {sessions.length === 0 && <div className="sidebar-empty">No session index</div>}
    {grouped.map(([round, roundSessions]) => <section className="session-round" key={round}>
      <div className="session-round-label">{round === 0 ? "Sessions" : `Round ${round}`}</div>
      {roundSessions.map((session) => <button key={session.key} type="button"
        className={`session-link ${session.status === "running" ? "is-live" : ""}`}
        aria-current={selected === session.key ? "true" : undefined} onClick={() => onSession(session.key)}>
        <span className={`session-role-icon is-${session.kind}`}>
          {session.kind === "reviewer" ? <CircleDot size={13} /> : <ShieldCheck size={13} />}
        </span>
        <span><strong>{session.label}</strong><small>{session.file ?? session.status}</small></span>
      </button>)}
    </section>)}
  </aside>;
}

function deriveStatus(
  run: RunDetail["run"] | undefined,
  live: RunDetail["live"] | null,
): string {
  if (live?.end) return live.end.status;
  if (run?.status === "running" && run.finishedAt === null) return "running";
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
