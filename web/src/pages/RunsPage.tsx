import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { apiGet } from "../api";
import { fmtCost, fmtCount, fmtDuration, fmtTime, shortSha } from "../format";
import { useApi } from "../hooks";
import { ModeBadge, StatusBadge } from "../components/badges";
import type { ProjectSummary, RunSummary } from "../types";

interface RunsResponse {
  runs: RunSummary[];
  total: number;
}

interface Overview {
  projects: ProjectSummary[];
  active: Array<{ runId: string; projectId: string }>;
}

const PAGE_SIZE = 50;

export function RunsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const [offset, setOffset] = useState(0);
  const [statusFilter, setStatusFilter] = useState("");

  const runs = useApi<RunsResponse>(
    () => apiGet<RunsResponse>(`/api/projects/${projectId}/runs?limit=${PAGE_SIZE}&offset=${offset}${statusFilter ? `&status=${statusFilter}` : ""}`),
    [projectId, offset, statusFilter],
  );
  const overview = useApi<Overview>(() => apiGet<Overview>("/api/overview"), [projectId]);
  const project = overview.data?.projects.find((candidate) => candidate.projectId === projectId);
  const activeRunIds = new Set((overview.data?.active ?? []).filter((run) => run.projectId === projectId).map((run) => run.runId));

  const total = runs.data?.total ?? 0;
  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="page">
      <div className="page-header">
        <h1>{project?.name ?? (projectId ? projectId.slice(0, 12) : "project")}</h1>
        <span className="sub mono">{projectId}</span>
        {project?.remote && <span className="sub">{project.remote}</span>}
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 12, alignItems: "center" }}>
        {["", "completed", "incomplete", "failed", "running"].map((status) => (
          <button
            key={status || "all"}
            className={`copy-btn${statusFilter === status ? "" : ""}`}
            style={statusFilter === status ? { color: "var(--text)", borderColor: "var(--accent)" } : undefined}
            onClick={() => {
              setStatusFilter(status);
              setOffset(0);
            }}
          >
            {status || "all"}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <span style={{ color: "var(--text-faint)", fontSize: 12 }}>
          {project ? `${project.runsTotal} runs · ${project.openFindings} open findings` : ""}
        </span>
      </div>

      {runs.loading && !runs.data && <div className="loading-row"><span className="spinner" /> loading runs…</div>}
      {runs.error && <div className="error-banner">{runs.error}</div>}

      {runs.data && (
        <>
          <div className="card" style={{ padding: 0, overflowX: "auto" }}>
            <table className="grid">
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Mode</th>
                  <th>Range</th>
                  <th>Started</th>
                  <th className="num">Duration</th>
                  <th className="num">Rounds</th>
                  <th className="num">✓ / ✗ / ?</th>
                  <th className="num">Tokens</th>
                  <th className="num">Cost</th>
                  <th>Model</th>
                </tr>
              </thead>
              <tbody>
                {runs.data.runs.map((run) => {
                  const live = activeRunIds.has(run.runId);
                  return (
                    <tr key={run.runId} onClick={() => navigate(`/runs/${projectId}/${run.runId}`)}>
                      <td><StatusBadge status={live ? "running" : deriveDisplayStatus(run)} /></td>
                      <td><ModeBadge mode={run.mode} /></td>
                      <td className="mono dim" title={`${run.base ?? ""}..${run.head}`}>
                        {run.base ? `${shortSha(run.base, 7)}…${shortSha(run.head, 7)}` : `snapshot ${shortSha(run.head, 7)}`}
                      </td>
                      <td className="dim">{fmtTime(run.startedAt)}</td>
                      <td className="num dim">{fmtDuration(run.durationMs)}</td>
                      <td className="num dim">{run.rounds}</td>
                      <td className="num">
                        <span style={{ color: "var(--ok)" }}>{run.confirmed}</span>
                        {" / "}
                        <span style={{ color: "var(--err)" }}>{run.rejected}</span>
                        {" / "}
                        <span style={{ color: "var(--warn)" }}>{run.uncertain}</span>
                      </td>
                      <td className="num dim">{run.totalTokens === null ? "—" : fmtCount(run.totalTokens)}</td>
                      <td className="num dim">{fmtCost(run.cost)}</td>
                      <td className="dim mono" style={{ fontSize: 12 }}>{run.model ?? "—"}</td>
                    </tr>
                  );
                })}
                {runs.data.runs.length === 0 && (
                  <tr><td colSpan={10} className="dim" style={{ textAlign: "center", padding: 32 }}>no runs{statusFilter ? ` with status ${statusFilter}` : ""}</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="pagination">
            <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>‹ newer</button>
            <span>page {page} / {pages}</span>
            <button disabled={offset + PAGE_SIZE >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>older ›</button>
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
