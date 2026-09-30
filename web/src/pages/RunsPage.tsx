import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { apiGet } from "../api";
import { fmtCost, fmtCount, fmtDuration, fmtTime, shortSha } from "../format";
import { useApi } from "../hooks";
import { ModeBadge, StatusBadge } from "../components/badges";
import type { ActiveRunView, ProjectSummary, RunSummary } from "../types";

interface RunsResponse {
  runs: RunSummary[];
  total: number;
}

interface Overview {
  projects: ProjectSummary[];
  active: ActiveRunView[];
}

const PAGE_SIZE = 50;

export function RunsPage() {
  const { projectId = "" } = useParams();
  const navigate = useNavigate();
  const [offset, setOffset] = useState(0);
  const [statusFilter, setStatusFilter] = useState("");

  const runs = useApi<RunsResponse>(
    () => apiGet<RunsResponse>(`/api/projects/${projectId}/runs?limit=${PAGE_SIZE}&offset=${offset}${statusFilter ? `&status=${statusFilter}` : ""}`),
    [projectId, offset, statusFilter],
  );
  const overview = useApi<Overview>(() => apiGet<Overview>("/api/overview"), [projectId]);
  const project = overview.data?.projects.find((candidate) => candidate.projectId === projectId);
  const activeRunIds = new Set(
    (overview.data?.active ?? []).filter((run) => run.projectId === projectId).map((run) => run.runId),
  );

  const total = runs.data?.total ?? 0;
  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-5 flex flex-wrap items-baseline gap-3">
        <h1 className="text-xl font-semibold">{project?.name ?? (projectId ? projectId.slice(0, 12) : "project")}</h1>
        {project?.remote && <span className="text-[13px] text-muted-foreground">{project.remote}</span>}
        <span className="font-mono text-[11px] text-muted-foreground/60">{projectId}</span>
      </div>

      <div className="mb-3.5 flex flex-wrap items-center gap-1.5">
        {["", "completed", "incomplete", "failed", "running"].map((status) => (
          <button
            key={status || "all"}
            className={`rounded-full px-3 py-1 font-mono text-[11.5px] transition-colors ${
              statusFilter === status
                ? "bg-primary/15 text-foreground"
                : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
            }`}
            onClick={() => {
              setStatusFilter(status);
              setOffset(0);
            }}
          >
            {status || "all"}
          </button>
        ))}
        <span className="ml-auto text-xs text-muted-foreground">
          {project ? `${project.runsTotal} runs · ${project.openFindings} open findings` : ""}
        </span>
      </div>

      {runs.loading && !runs.data && <div className="py-10 text-center text-muted-foreground"><span className="pir-mini-spinner" /> loading runs…</div>}
      {runs.error && <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">{runs.error}</div>}

      {runs.data && (
        <>
          <div className="pir-panel overflow-x-auto">
            <table className="pir-table">
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Mode</th>
                  <th>Range</th>
                  <th>Started</th>
                  <th className="num">Duration</th>
                  <th className="num">Rounds</th>
                  <th className="num">✓ / ✕ / ?</th>
                  <th className="num">Tokens</th>
                  <th className="num">Cost</th>
                  <th>Model</th>
                </tr>
              </thead>
              <tbody>
                {runs.data.runs.map((run) => {
                  const live = activeRunIds.has(run.runId);
                  return (
                    <tr key={run.runId} data-clickable onClick={() => navigate(`/runs/${projectId}/${run.runId}`)}>
                      <td><StatusBadge status={live ? "running" : deriveDisplayStatus(run)} /></td>
                      <td><ModeBadge mode={run.mode} /></td>
                      <td className="dim font-mono text-xs" title={`${run.base ?? ""}..${run.head}`}>
                        {run.base ? `${shortSha(run.base, 7)}…${shortSha(run.head, 7)}` : `snapshot ${shortSha(run.head, 7)}`}
                      </td>
                      <td className="dim">{fmtTime(run.startedAt)}</td>
                      <td className="num dim">{fmtDuration(run.durationMs)}</td>
                      <td className="num dim">{run.rounds}</td>
                      <td className="num">
                        <span className="text-emerald-400">{run.confirmed}</span>
                        {" / "}
                        <span className="text-red-400">{run.rejected}</span>
                        {" / "}
                        <span className="text-amber-400">{run.uncertain}</span>
                      </td>
                      <td className="num dim">{run.totalTokens === null ? "—" : fmtCount(run.totalTokens)}</td>
                      <td className="num dim">{fmtCost(run.cost)}</td>
                      <td className="dim font-mono text-xs">{run.model ?? "—"}</td>
                    </tr>
                  );
                })}
                {runs.data.runs.length === 0 && (
                  <tr><td colSpan={10} className="dim py-8 text-center">no runs{statusFilter ? ` with status ${statusFilter}` : ""}</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="mt-3.5 flex items-center justify-end gap-2.5 text-[12.5px] text-muted-foreground">
            <button className="rounded-md border border-border px-3 py-1 transition-colors hover:border-primary/60 hover:text-foreground disabled:opacity-40" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>‹ newer</button>
            <span>page {page} / {pages}</span>
            <button className="rounded-md border border-border px-3 py-1 transition-colors hover:border-primary/60 hover:text-foreground disabled:opacity-40" disabled={offset + PAGE_SIZE >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>older ›</button>
          </div>
        </>
      )}
    </div>
  );
}

/** A "running" row with no finish and no live registry presence was interrupted. */
function deriveDisplayStatus(run: RunSummary): string {
  if (run.status === "running" && run.finishedAt === null) return "interrupted";
  return run.status;
}
