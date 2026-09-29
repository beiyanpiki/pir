import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { apiGet } from "../api";
import { fmtCost, fmtCount, fmtDuration, fmtTime, relTime, shortSha } from "../format";
import { useApi, useRunEvents } from "../hooks";
import { ModeBadge, StatusBadge } from "../components/badges";
import { SessionTimeline } from "../components/session/SessionTimeline";
import { FindingsTab } from "../components/findings";
import { CoverageTab } from "../components/coverage";
import type { RunDetail, RunEvent } from "../types";

type Tab = "timeline" | "findings" | "coverage" | "details";

export function RunDetailPage() {
  const { projectId = "", runId = "" } = useParams();
  const [tab, setTab] = useState<Tab>("timeline");
  const detail = useApi<RunDetail>(() => apiGet<RunDetail>(`/api/runs/${projectId}/${runId}`), [projectId, runId]);

  const run = detail.data?.run;
  const live = detail.data?.live ?? null;
  const ongoing = (run?.status === "running" && run.finishedAt === null) || (live !== null && live.end === null);
  const [liveEvents, setLiveEvents] = useState<RunEvent[] | null>(null);
  const maxSeqRef = useRef(0);

  // The server's buffer is authoritative on (re)load; live appends dedupe by
  // the per-run monotonic sequence number so SSE replay never duplicates.
  useEffect(() => {
    if (!detail.data) return;
    const events = detail.data.live ? detail.data.live.events : null;
    maxSeqRef.current = events ? events.reduce((max, event) => Math.max(max, (event as { seq?: number }).seq ?? 0), 0) : 0;
    setLiveEvents(events);
  }, [detail.data]);

  const sseStatus = useRunEvents(ongoing ? runId : null, true, (event) => {
    if (event.kind === "ready" || event.kind === "unavailable") return;
    if (event.seq <= maxSeqRef.current) return;
    maxSeqRef.current = event.seq;
    setLiveEvents((previous) => [...(previous ?? []), event]);
    if (event.kind === "run-end") {
      // The manifest is written right around run-end; refetch shortly after.
      setTimeout(() => detail.reload(), 800);
    }
  });

  const now = useTicker(ongoing ? 1000 : 0);
  const displayStatus = deriveStatus(run, live, sseStatus);

  if (detail.loading && !detail.data) return <div className="loading-row"><span className="spinner" /> loading run…</div>;
  if (detail.error) return <div className="error-banner">{detail.error}</div>;
  if (!run) return <div className="empty-state">Run not found.</div>;

  const manifest = detail.data?.manifest ?? null;
  const counts = live?.end?.counts ?? null;
  const confirmed = counts?.confirmed ?? run.confirmed;
  const rejected = counts?.rejected ?? run.rejected;
  const uncertain = counts?.uncertain ?? run.uncertain;
  const rounds = counts?.rounds ?? run.rounds;
  const duration = live && live.end === null ? now - live.startedAt : (run.durationMs ?? (run.finishedAt !== null ? run.finishedAt - run.startedAt : null));
  const isAudit = run.mode === "audit";

  return (
    <div className="page">
      <div className="page-header">
        <h1>
          {run.base ? `${shortSha(run.base, 7)}…${shortSha(run.head, 7)}` : `snapshot ${shortSha(run.head, 7)}`}
        </h1>
        <ModeBadge mode={run.mode} />
        <StatusBadge status={displayStatus} />
        {sseStatus === "open" && <span className="live-pill"><span className="pulse" />live</span>}
        <span className="spacer" style={{ flex: 1 }} />
        <Link to={`/projects/${projectId}`} className="sub">← all runs</Link>
      </div>

      <div className="card" style={{ marginBottom: 18 }}>
        <div className="stat-row">
          <span className="stat">started <b>{fmtTime(run.startedAt)}</b> ({relTime(run.startedAt)})</span>
          {run.finishedAt !== null && <span className="stat">finished <b>{fmtTime(run.finishedAt)}</b></span>}
          <span className="stat">duration <b>{fmtDuration(duration)}</b></span>
          <span className="stat">rounds <b>{rounds}</b></span>
          <span className="stat">
            <b style={{ color: "var(--ok)" }}>{confirmed}</b> confirmed ·{" "}
            <b style={{ color: "var(--err)" }}>{rejected}</b> rejected ·{" "}
            <b style={{ color: "var(--warn)" }}>{uncertain}</b> uncertain
          </span>
        </div>
        <div className="stat-row" style={{ marginBottom: 0 }}>
          <span className="stat">model <b>{run.model ?? manifest?.model ?? "pi default"}</b></span>
          {run.totalTokens !== null && <span className="stat">tokens <b>{fmtCount(run.totalTokens)}</b></span>}
          {run.cost !== null && <span className="stat">cost <b>{fmtCost(run.cost)}</b></span>}
          {manifest?.plugins.map((plugin) => (
            <span key={plugin.name} className="stat">plugin <b>{plugin.name}{plugin.version ? `@${plugin.version}` : ""}</b></span>
          ))}
        </div>
        {(manifest?.stoppedBecause ?? run.notes) && (
          <div style={{ color: "var(--text-dim)", fontSize: 12.5, marginTop: 8, borderTop: "1px solid var(--border)", paddingTop: 8 }}>
            {manifest ? `${manifest.stoppedBecause}` : run.notes}
            {manifest?.incomplete && <span style={{ color: "var(--warn)" }}> · incomplete</span>}
          </div>
        )}
        {!run.transcriptsAvailable && (
          <div style={{ color: "var(--text-faint)", fontSize: 12, marginTop: 6 }}>
            Transcripts were not captured for this run (it predates PIR_TRANSCRIPTS=1) — the timeline is unavailable.
          </div>
        )}
      </div>

      <div className="tabs">
        <button className={tab === "timeline" ? "active" : ""} onClick={() => setTab("timeline")}>
          Timeline <span className="hint">{detail.data?.sessions.length ?? (liveEvents ? new Set(liveEvents.filter((event) => event.kind === "session-start").map((event) => (event as { sessionId: string }).sessionId)).size : 0)} sessions</span>
        </button>
        <button className={tab === "findings" ? "active" : ""} onClick={() => setTab("findings")}>
          Findings <span className="hint">{detail.data?.findings.length ?? 0}</span>
        </button>
        {isAudit && (
          <button className={tab === "coverage" ? "active" : ""} onClick={() => setTab("coverage")} disabled={!manifest}>
            Coverage
          </button>
        )}
        <button className={tab === "details" ? "active" : ""} onClick={() => setTab("details")}>Details</button>
      </div>

      {tab === "timeline" && (
        <>
          {liveEvents && <ActivityLog events={liveEvents} />}
          <SessionTimeline
            projectId={projectId}
            runId={runId}
            sessions={detail.data?.sessions ?? []}
            liveEvents={liveEvents}
          />
        </>
      )}
      {tab === "findings" && <FindingsTab findings={detail.data?.findings ?? []} />}
      {tab === "coverage" && manifest && <CoverageTab manifest={manifest} />}
      {tab === "details" && <DetailsTab detail={detail.data} />}
    </div>
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

/** Re-render tick for live durations; interval 0 disables. */
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
  const [visible, last] = open ? [progress, null] : [progress.slice(-5), progress.length > 5];

  return (
    <div className="card" style={{ marginBottom: 14, padding: "8px 14px", fontSize: 12.5 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer", userSelect: "none" }} onClick={() => setOpen(!open)}>
        <span style={{ color: "var(--text-faint)", textTransform: "uppercase", fontSize: 11, letterSpacing: "0.06em" }}>activity</span>
        {last && <span className="copy-btn">{open ? "collapse" : `${progress.length} events`}</span>}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 6 }}>
        {visible.map((event, index) => (
          <div key={`${event.seq}-${index}`} style={{ display: "flex", gap: 10 }}>
            <span className="mono" style={{ color: "var(--text-faint)", flexShrink: 0 }}>
              {new Date(event.ts).toLocaleTimeString()}
            </span>
            {event.kind === "progress" && (
              <span style={{ color: "var(--text-dim)" }}>
                <span className="mono" style={{ color: "var(--cyan)" }}>{event.phase}</span>{" "}
                {event.round !== undefined ? `r${event.round} · ` : ""}{event.message}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function DetailsTab({ detail }: { detail: RunDetail | null }) {
  if (!detail) return null;
  const { run, manifest } = detail;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div className="card">
        <strong style={{ display: "block", marginBottom: 8 }}>Run</strong>
        <dl className="kv">
          <dt>run id</dt><dd>{run.runId}</dd>
          <dt>mode</dt><dd>{run.mode}</dd>
          <dt>base</dt><dd>{run.base ?? "— (snapshot audit)"}</dd>
          <dt>head</dt><dd>{run.head}</dd>
          <dt>model</dt><dd>{run.model ?? manifest?.model ?? "pi default"}</dd>
          <dt>max findings</dt><dd>{manifest?.maxFindings ?? "—"}</dd>
          <dt>status</dt><dd>{run.status}</dd>
          <dt>notes</dt><dd>{run.notes ?? "—"}</dd>
          {manifest?.usage && (
            <>
              <dt>tokens</dt>
              <dd>
                in {fmtCount(manifest.usage.inputTokens)} · out {fmtCount(manifest.usage.outputTokens)} ·
                cache r {fmtCount(manifest.usage.cacheReadTokens)} / w {fmtCount(manifest.usage.cacheWriteTokens)} ·
                total {fmtCount(manifest.usage.totalTokens)} · {fmtCost(manifest.usage.cost)}
              </dd>
            </>
          )}
          {manifest && <dt>est. tokens</dt>}
          {manifest && <dd>{fmtCount(manifest.estimatedTokens)}</dd>}
        </dl>
      </div>

      {manifest && manifest.rounds.length > 0 && (
        <div className="card" style={{ padding: 0, overflowX: "auto" }}>
          <table className="grid">
            <thead>
              <tr>
                <th>Round</th>
                <th className="num">Candidates</th>
                <th className="num">Fresh</th>
                <th className="num">Confirmed</th>
                <th className="num">Rejected</th>
                <th className="num">Uncertain</th>
                <th className="num">Pending</th>
                <th>Reviewer</th>
                <th>Summary</th>
              </tr>
            </thead>
            <tbody>
              {manifest.rounds.map((info) => (
                <tr key={info.round}>
                  <td className="mono">{info.round}</td>
                  <td className="num dim">{info.candidates}</td>
                  <td className="num dim">{info.fresh}</td>
                  <td className="num" style={{ color: "var(--ok)" }}>{info.confirmed}</td>
                  <td className="num" style={{ color: "var(--err)" }}>{info.rejected}</td>
                  <td className="num" style={{ color: "var(--warn)" }}>{info.uncertain}</td>
                  <td className="num dim">{info.pending ?? 0}</td>
                  <td className="dim">{info.reviewerRan ? "ran" : "drain only"}</td>
                  <td className="dim" style={{ fontSize: 12, maxWidth: 420 }}>{info.summary}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {manifest?.files && manifest.files.length > 0 && (
        <div className="card" style={{ padding: 0, overflowX: "auto" }}>
          <table className="grid">
            <thead>
              <tr><th>File</th><th>Status</th><th className="num">+</th><th className="num">−</th></tr>
            </thead>
            <tbody>
              {manifest.files.map((file) => (
                <tr key={file.path}>
                  <td className="mono" style={{ fontSize: 12 }}>{file.path}</td>
                  <td className="dim">{file.status}</td>
                  <td className="num" style={{ color: "var(--ok)" }}>{file.additions}</td>
                  <td className="num" style={{ color: "var(--err)" }}>{file.deletions}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card" style={{ color: "var(--text-faint)", fontSize: 12 }}>
        pir review sessions are hermetic: no extensions, skills or hooks execute inside them.
        “Plugins” above are language guidance packs injected into prompts; every model turn,
        thinking block and tool call is captured in the timeline transcripts.
      </div>
    </div>
  );
}
