import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Code2,
  FileSearch,
  Filter,
  FolderGit2,
  Gauge,
  Search,
  ShieldAlert,
  X,
} from "lucide-react";
import { apiGet } from "../api";
import { fmtCost, fmtCount, fmtDuration, fmtTime, relTime, shortSha } from "../format";
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
const STATUSES = ["all", "completed", "running", "incomplete", "failed"];

export function RunsPage() {
  const { projectId = "" } = useParams();
  const navigate = useNavigate();
  const [offset, setOffset] = useState(0);
  const [statusFilter, setStatusFilter] = useState("all");
  const [query, setQuery] = useState("");

  const runs = useApi<RunsResponse>(
    () => apiGet<RunsResponse>(
      `/api/projects/${projectId}/runs?limit=${PAGE_SIZE}&offset=${offset}${statusFilter !== "all" ? `&status=${statusFilter}` : ""}`,
    ),
    [projectId, offset, statusFilter],
  );
  const overview = useApi<Overview>(() => apiGet<Overview>("/api/overview"), [projectId]);
  const project = overview.data?.projects.find((candidate) => candidate.projectId === projectId);
  const activeRunIds = useMemo(() => new Set(
    (overview.data?.active ?? []).filter((run) => run.projectId === projectId).map((run) => run.runId),
  ), [overview.data, projectId]);

  const allRuns = runs.data?.runs ?? [];
  const visibleRuns = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return allRuns;
    return allRuns.filter((run) =>
      [run.runId, run.base ?? "", run.head, run.model ?? "", run.notes ?? ""]
        .some((value) => value.toLowerCase().includes(needle)),
    );
  }, [allRuns, query]);

  const total = runs.data?.total ?? 0;
  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="page-shell">
      <header className="page-header project-page-header">
        <div className="project-heading">
          <Link className="icon-button" to="/projects" aria-label="Back to projects" title="Back to projects">
            <ArrowLeft size={16} />
          </Link>
          <span className="file-type-icon is-large"><FolderGit2 size={18} /></span>
          <div>
            <div className="page-eyebrow">Project</div>
            <h1>{project?.name ?? (projectId ? projectId.slice(0, 12) : "Project")}</h1>
            <div className="project-remote">{project?.remote ?? projectId}</div>
          </div>
        </div>
        <div className="page-header-actions">
          <label className="search-field">
            <Search size={15} />
            <input
              type="search"
              value={query}
              placeholder="Search runs"
              onChange={(event) => setQuery(event.target.value)}
            />
            {query && (
              <button type="button" aria-label="Clear search" title="Clear search" onClick={() => setQuery("")}>
                <X size={14} />
              </button>
            )}
          </label>
        </div>
      </header>

      <section className="project-summary-strip">
        <div><Gauge size={15} /><span><small>Total runs</small><strong>{fmtCount(project?.runsTotal ?? total)}</strong></span></div>
        <div><ShieldAlert size={15} /><span><small>Open findings</small><strong>{fmtCount(project?.openFindings ?? 0)}</strong></span></div>
        <div><Clock3 size={15} /><span><small>Last review</small><strong>{project?.lastRunAt ? relTime(project.lastRunAt) : "Never"}</strong></span></div>
        <div><Code2 size={15} /><span><small>Project ID</small><strong className="mono-value">{projectId.slice(0, 12)}</strong></span></div>
      </section>

      <section className="data-section">
        <div className="run-toolbar">
          <div className="segmented-control" role="group" aria-label="Filter runs by status">
            <Filter size={14} />
            {STATUSES.map((status) => (
              <button
                key={status}
                type="button"
                className={statusFilter === status ? "is-active" : ""}
                onClick={() => {
                  setStatusFilter(status);
                  setOffset(0);
                }}
              >
                {status}
              </button>
            ))}
          </div>
          <span className="section-count">{visibleRuns.length} of {total} runs</span>
        </div>

        {runs.loading && !runs.data && <div className="loading-state"><span className="pir-mini-spinner" /> Loading runs…</div>}
        {runs.error && <div className="error-state">{runs.error}</div>}

        {runs.data && visibleRuns.length === 0 && (
          <div className="empty-state">
            <FileSearch size={22} />
            <strong>No runs found</strong>
            <span>{query ? "Try a different search." : `No ${statusFilter === "all" ? "" : `${statusFilter} `}runs for this project.`}</span>
          </div>
        )}

        {visibleRuns.length > 0 && (
          <div className="table-scroll">
            <table className="data-table run-table">
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Review</th>
                  <th>Range</th>
                  <th>Result</th>
                  <th>Started</th>
                  <th className="num">Duration</th>
                  <th className="num">Tokens</th>
                  <th className="num">Cost</th>
                  <th>Model</th>
                  <th aria-label="Open run" />
                </tr>
              </thead>
              <tbody>
                {visibleRuns.map((run) => {
                  const live = activeRunIds.has(run.runId);
                  const displayStatus = live ? "running" : deriveDisplayStatus(run);
                  return (
                    <tr key={run.runId} data-clickable onClick={() => navigate(`/runs/${projectId}/${run.runId}`)}>
                      <td><StatusBadge status={displayStatus} /></td>
                      <td><ModeBadge mode={run.mode} /></td>
                      <td>
                        <span className="range-cell mono-value" title={`${run.base ?? ""}..${run.head}`}>
                          {run.base ? `${shortSha(run.base, 7)}…${shortSha(run.head, 7)}` : shortSha(run.head, 10)}
                        </span>
                      </td>
                      <td>
                        <span className="verdict-summary">
                          <span className="metric-success">{run.confirmed} confirmed</span>
                          <span className="metric-muted">{run.rejected} rejected</span>
                          <span className="metric-warning">{run.uncertain} uncertain</span>
                        </span>
                      </td>
                      <td className="muted-cell">
                        <span>{fmtTime(run.startedAt)}</span>
                        <small>{relTime(run.startedAt)}</small>
                      </td>
                      <td className="num">{fmtDuration(run.durationMs)}</td>
                      <td className="num">{run.totalTokens === null ? "—" : fmtCount(run.totalTokens)}</td>
                      <td className="num">{fmtCost(run.cost)}</td>
                      <td className="mono-value">{run.model ?? "pi default"}</td>
                      <td className="row-action">
                        <Link
                          className="icon-button"
                          to={`/runs/${projectId}/${run.runId}`}
                          aria-label="Open run"
                          title="Open run"
                        >
                          <ChevronRight size={15} />
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {runs.data && (
          <div className="pagination">
            <button
              className="icon-button"
              type="button"
              disabled={offset === 0}
              aria-label="Newer runs"
              title="Newer runs"
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            >
              <ChevronLeft size={16} />
            </button>
            <span>Page {page} / {pages}</span>
            <button
              className="icon-button"
              type="button"
              disabled={offset + PAGE_SIZE >= total}
              aria-label="Older runs"
              title="Older runs"
              onClick={() => setOffset(offset + PAGE_SIZE)}
            >
              <ChevronRight size={16} />
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

function deriveDisplayStatus(run: RunSummary): string {
  if (run.status === "running" && run.finishedAt === null) return "interrupted";
  return run.status;
}
