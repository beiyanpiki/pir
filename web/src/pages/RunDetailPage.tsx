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
import { RunOverview } from "../components/run-overview";
import { FindingInspector } from "../components/finding-inspector";
import { RunDetails } from "../components/run-details";
import { WorkflowTab } from "../components/workflow";
import { PageError } from "../components/page-controls";
import { InspectorToggle } from "../layout/WorkspaceShell";
import type { ActiveRunView, CoverageView, ProjectSummary, RunDetail, RunEvent } from "../types";
import { useStickToBottom } from "use-stick-to-bottom";

type InspectorTab = "overview" | "findings" | "workflow" | "coverage" | "details";

interface Overview {
  projects: ProjectSummary[];
  active: ActiveRunView[];
}

export function RunDetailPage() {
  const { projectId = "", runId = "" } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = searchParams.get("tab");
  const inspectorTab: InspectorTab = requestedTab === "findings" || requestedTab === "workflow" || requestedTab === "coverage" || requestedTab === "details" ? requestedTab : "overview";
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
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [narrowInspector, setNarrowInspector] = useState(() => window.innerWidth < 1280);
  const inspectorRef = useRef<HTMLElement | null>(null);
  const inspectorOpenerRef = useRef<HTMLElement | null>(null);
  const detail = useApi<RunDetail>((signal) => apiGet<RunDetail>(`/api/runs/${projectId}/${runId}`, signal), [projectId, runId]);
  const overview = useApi<Overview>((signal) => apiGet<Overview>("/api/overview", signal), [projectId]);
  const coverage = useApi<CoverageView>((signal) => apiGet(`/api/runs/${projectId}/${runId}/coverage`, signal), [projectId, runId]);
  useEffect(() => { setInspectorOpen(inspectorTab === "findings" && Boolean(selectedFinding)); }, [projectId, runId, selectedFinding, inspectorTab]);

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
    // Only a real element can receive focus back; the body means the page was
    // replaced under an open drawer, so keep the opener we already saved.
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body && active !== document.documentElement) {
      inspectorOpenerRef.current = active;
    }
    const background = document.querySelectorAll<HTMLElement>(".workspace-topbar, .workspace-sidebar, .run-header, .run-context-strip, .notice-bar, .session-rail, .run-stream, .run-tabs, .run-primary");
    const priorInert = [...background].map((element) => element.inert);
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
      background.forEach((element, index) => { element.inert = priorInert[index]; });
      // A run change can replace the page under the drawer, so the saved
      // opener may be detached: fall back to the current toggle instead of
      // dropping focus onto the body.
      const opener = inspectorOpenerRef.current;
      if (opener?.isConnected) {
        opener.focus();
      } else {
        // A run change closes the drawer while the next page is still
        // loading: wait briefly for its toggle instead of dropping focus on
        // the body. Bounded so a navigation away cannot spin forever.
        let attempts = 0;
        const restore = (): void => {
          const toggle = document.querySelector<HTMLElement>(".run-header-actions button");
          if (toggle) toggle.focus();
          else if (attempts++ < 60) requestAnimationFrame(restore);
        };
        restore();
      }
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
      const scroll = document.querySelector<HTMLElement>(".run-scroll");
      if (scroll) scroll.scrollTo({ top: target.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop, behavior: "instant" });
      return true;
    };
    if (jump()) return;
    // The incremental session fold mounts one effect after the replay index.
    const observer = new MutationObserver(() => { if (jump()) observer.disconnect(); });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [selectedSessionKey, runId, stopScroll, inspectorTab]);
  const selectSession = (key: string): void => {
    stopScroll();
    updateQuery({ tab: "workflow", session: key });
    const target = document.getElementById(sessionAnchor(key));
    const scroll = document.querySelector<HTMLElement>(".run-scroll");
    if (target && scroll) scroll.scrollTo({ top: target.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop, behavior: "instant" });
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
  const activeInspectorTab = inspectorTab;
  const projectedDetail: RunDetail = { ...detail.data, run: { ...run, status: displayStatus, confirmed, rejected, uncertain, rounds,
    candidates: counts?.candidates ?? run.candidates,
    incomplete: projection.end ? projection.end.status === "incomplete" : run.incomplete,
    stoppedBecause: projection.end?.stoppedBecause ?? run.stoppedBecause,
    durationMs: projection.end?.durationMs ?? duration,
    totalTokens: projection.end?.usage?.totalTokens ?? run.totalTokens,
    cost: projection.end?.usage?.cost ?? run.cost,
  } };
  const selectFinding = (id: string): void => { updateQuery({ tab: "findings", finding: id }); setInspectorOpen(true); };
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

      <nav className="run-tabs" role="tablist" aria-label="Review views" onKeyDown={(event) => {
        const tabs: InspectorTab[] = ["overview", "findings", "workflow", "coverage", "details"];
        const index = tabs.indexOf(activeInspectorTab);
        const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
        if (next === null) return; event.preventDefault(); updateQuery({ tab: tabs[next] });
        event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=tab]")[next]?.focus();
      }}>
        {(["overview", "findings", "workflow", "coverage", "details"] as const).map((tab) => <button key={tab} type="button" role="tab" id={`run-tab-${tab}`} aria-controls="run-panel" aria-selected={activeInspectorTab === tab} tabIndex={activeInspectorTab === tab ? 0 : -1} onClick={() => updateQuery({ tab })}>{tab[0].toUpperCase() + tab.slice(1)}{tab === "findings" ? ` (${projectedDetail.findings.total})` : ""}</button>)}
      </nav>
      <div className={`run-workspace review-workbench ${activeInspectorTab === "workflow" ? "has-session-rail" : ""} ${inspectorOpen ? "has-inspector" : ""}`}>
        {activeInspectorTab === "workflow" && <SessionRail sessions={workflow} selected={selectedSessionKey} onSession={selectSession} />}
        <section className={`run-primary ${activeInspectorTab === "workflow" ? "run-stream" : ""}`} id="run-panel" role="tabpanel" aria-labelledby={`run-tab-${activeInspectorTab}`}>
          <div className="run-scroll" ref={activeInspectorTab === "workflow" ? streamSticky.scrollRef : undefined}>
            <div className="stream-column" ref={activeInspectorTab === "workflow" ? streamSticky.contentRef : undefined}>
              {activeInspectorTab === "overview" && <RunOverview detail={projectedDetail} coverage={coverage.data} events={liveEvents} execution={displayStatus} connection={sseStatus} pendingCount={counts?.pending} />}
              {activeInspectorTab === "findings" && <FindingsTab key={`${projectId}/${runId}`} projectId={projectId} runId={runId} findings={detail.data.findings} selectedFinding={selectedFinding} onInspect={selectFinding} />}
              {activeInspectorTab === "coverage" && (coverage.loading && !coverage.data ? <p role="status">Loading coverage…</p> : coverage.error ? <PageError error={coverage.error} retry={coverage.reload} /> : <CoverageTab coverage={coverage.data} />)}
              {activeInspectorTab === "details" && <RunDetails detail={projectedDetail} />}
              {activeInspectorTab === "workflow" && <>
                <WorkflowTab sessions={workflow} selected={selectedSessionKey} onSession={selectSession} onFinding={selectFinding}
                  role={searchParams.get("role") ?? "all"} status={searchParams.get("status") ?? "all"} query={searchParams.get("q") ?? ""}
                  onFilter={(key, value) => updateQuery({ [key]: value === "all" || value === "" ? null : value })} />
                {liveEvents && <ActivityLog events={liveEvents} />}
                <SessionTimeline projectId={projectId} runId={runId} sessions={detail.data.sessions} liveEvents={liveEvents} awaitingLive={awaitingLive} preferPersisted={manifest !== null && projection.executionState !== "running"} />
              </>}
            </div>
          </div>
          {activeInspectorTab === "workflow" && !streamSticky.isAtBottom && <button type="button" className="icon-button stream-jump-latest" aria-label="Jump to latest" onClick={() => void streamSticky.scrollToBottom({ animation: "smooth" })}><ArrowDown size={15} /></button>}
        </section>
        {inspectorOpen && narrowInspector && <button className="inspector-scrim" type="button" aria-label="Close inspector" onClick={() => setInspectorOpen(false)} />}
        <aside id="run-inspector" ref={inspectorRef} hidden={!inspectorOpen} className={`run-inspector ${inspectorOpen ? "is-open" : ""}`} aria-label="Review inspector" role={narrowInspector && inspectorOpen ? "dialog" : "complementary"} aria-modal={narrowInspector && inspectorOpen ? true : undefined} tabIndex={-1}>
          <header className="inspector-tabs"><h2 className="inspector-title">{selectedFinding ? `Evidence ${selectedFinding}` : "Run context"}</h2><button className="icon-button inspector-close" type="button" aria-label="Close inspector" onClick={() => setInspectorOpen(false)}><X size={16} /></button></header>
          <div className="inspector-content">{selectedFinding ? <FindingInspector key={`${projectId}/${runId}/${selectedFinding}`} projectId={projectId} runId={runId} findingId={selectedFinding} /> : <RunDetails detail={projectedDetail} />}</div>
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
