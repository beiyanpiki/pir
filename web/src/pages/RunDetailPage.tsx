import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { apiGet } from "../api";
import { fmtCost, fmtCount, fmtDuration, fmtTime, relTime, shortSha } from "../format";
import { useApi, useRunEvents } from "../hooks";
import { LiveBadge, ModeBadge, StatusBadge } from "../components/badges";
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

  if (detail.loading && !detail.data) return <div className="py-10 text-center text-muted-foreground"><span className="pir-mini-spinner" /> loading run…</div>;
  if (detail.error) return <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">{detail.error}</div>;
  if (!run) return <div className="pir-empty">Run not found.</div>;

  const manifest = detail.data?.manifest ?? null;
  const counts = live?.end?.counts ?? null;
  const confirmed = counts?.confirmed ?? run.confirmed;
  const rejected = counts?.rejected ?? run.rejected;
  const uncertain = counts?.uncertain ?? run.uncertain;
  const rounds = counts?.rounds ?? run.rounds;
  const duration = live && live.end === null ? now - live.startedAt : (run.durationMs ?? (run.finishedAt !== null ? run.finishedAt - run.startedAt : null));
  const isAudit = run.mode === "audit";
  const sessionsCount =
    detail.data?.sessions.length ??
    (liveEvents ? new Set(liveEvents.filter((event) => event.kind === "session-start").map((event) => (event as { sessionId: string }).sessionId)).size : 0);

  const tabs: Array<{ id: Tab; label: string; hint?: string }> = [
    { id: "timeline", label: "Timeline", hint: `${sessionsCount} sessions` },
    { id: "findings", label: "Findings", hint: `${detail.data?.findings.length ?? 0}` },
    ...(isAudit ? [{ id: "coverage" as Tab, label: "Coverage" }] : []),
    { id: "details", label: "Details" },
  ];

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">
          {run.base ? `${shortSha(run.base, 7)}…${shortSha(run.head, 7)}` : `snapshot ${shortSha(run.head, 7)}`}
        </h1>
        <ModeBadge mode={run.mode} />
        <StatusBadge status={displayStatus} />
        {sseStatus === "open" && <LiveBadge />}
        <span className="flex-1" />
        <Link to={`/projects/${projectId}`} className="text-[13px] text-muted-foreground transition-colors hover:text-foreground">
          ← all runs
        </Link>
      </div>

      <div className="pir-metrics mb-5">
        <div className="pir-metric">
          <div className="k">Started</div>
          <div className="v">{fmtTime(run.startedAt)}<small>{relTime(run.startedAt)}</small></div>
        </div>
        <div className="pir-metric">
          <div className="k">Duration</div>
          <div className="v">{fmtDuration(duration)}</div>
        </div>
        <div className="pir-metric">
          <div className="k">Rounds</div>
          <div className="v">{rounds}</div>
        </div>
        <div className="pir-metric">
          <div className="k">Findings</div>
          <div className="v">
            <span className="text-emerald-400">{confirmed}</span>
            <small>/</small>
            <span className="text-red-400">{rejected}</span>
            <small>/</small>
            <span className="text-amber-400">{uncertain}</span>
          </div>
        </div>
        <div className="pir-metric">
          <div className="k">Tokens</div>
          <div className="v">{run.totalTokens === null ? "—" : fmtCount(run.totalTokens)}<small>{fmtCost(run.cost)}</small></div>
        </div>
        <div className="pir-metric">
          <div className="k">Model</div>
          <div className="v" style={{ fontSize: 12.5 }}>{run.model ?? manifest?.model ?? "pi default"}</div>
        </div>
      </div>

      {(manifest?.stoppedBecause ?? run.notes) && (
        <div className="mb-4 text-[12.5px] text-muted-foreground">
          {manifest ? manifest.stoppedBecause : run.notes}
          {manifest?.incomplete && <span className="ml-1.5 text-amber-400">· incomplete</span>}
        </div>
      )}
      {!run.transcriptsAvailable && (
        <div className="mb-4 text-xs text-muted-foreground/80">
          Transcripts were not captured for this run (it predates PIR_TRANSCRIPTS=1) — the timeline is unavailable.
        </div>
      )}

      <div className="mb-5 inline-flex gap-1 rounded-xl border border-border bg-muted/40 p-1">
        {tabs.map((entry) => (
          <button
            key={entry.id}
            className={`rounded-lg px-3.5 py-1.5 text-[13px] transition-colors ${
              tab === entry.id ? "bg-card font-medium text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
            {entry.hint && <span className="ml-1.5 font-mono text-[10.5px] opacity-50">{entry.hint}</span>}
          </button>
        ))}
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
  const visible = open ? progress : progress.slice(-5);

  return (
    <div className="pir-panel mb-4 px-4 py-2.5 text-[12.5px]">
      <div className="flex cursor-pointer select-none items-center justify-between" onClick={() => setOpen(!open)}>
        <span className="text-[10.5px] uppercase tracking-[0.08em] text-muted-foreground">activity</span>
        {progress.length > 5 && <button className="text-[11px] font-mono text-indigo-400 hover:underline">{open ? "collapse" : `${progress.length} events`}</button>}
      </div>
      <div className="mt-1.5 flex flex-col gap-0.5">
        {visible.map((event, index) => (
          <div key={`${event.seq}-${index}`} className="flex gap-2.5">
            <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground/70">
              {new Date(event.ts).toLocaleTimeString()}
            </span>
            {event.kind === "progress" && (
              <span className="text-muted-foreground">
                <span className="font-mono text-[11px] text-sky-400">{event.phase}</span>{" "}
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
    <div className="flex flex-col gap-4">
      <div className="pir-panel px-4 py-3.5">
        <strong className="mb-2 block text-sm">Run</strong>
        <dl className="pir-kv">
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
        <div className="pir-panel overflow-x-auto">
          <table className="pir-table">
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
                  <td className="font-mono">{info.round}</td>
                  <td className="num dim">{info.candidates}</td>
                  <td className="num dim">{info.fresh}</td>
                  <td className="num text-emerald-400">{info.confirmed}</td>
                  <td className="num text-red-400">{info.rejected}</td>
                  <td className="num text-amber-400">{info.uncertain}</td>
                  <td className="num dim">{info.pending ?? 0}</td>
                  <td className="dim">{info.reviewerRan ? "ran" : "drain only"}</td>
                  <td className="dim max-w-[420px] text-xs">{info.summary}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {manifest?.files && manifest.files.length > 0 && (
        <div className="pir-panel overflow-x-auto">
          <table className="pir-table">
            <thead>
              <tr><th>File</th><th>Status</th><th className="num">+</th><th className="num">−</th></tr>
            </thead>
            <tbody>
              {manifest.files.map((file) => (
                <tr key={file.path}>
                  <td className="font-mono text-xs">{file.path}</td>
                  <td className="dim">{file.status}</td>
                  <td className="num text-emerald-400">{file.additions}</td>
                  <td className="num text-red-400">{file.deletions}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="px-1 text-xs text-muted-foreground/80">
        pir review sessions are hermetic: no extensions, skills or hooks execute inside them.
        "Plugins" above are language guidance packs injected into prompts; every model turn,
        thinking block and tool call is captured in the timeline transcripts.
      </div>
    </div>
  );
}
