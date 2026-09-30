import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, ChevronLeft, ChevronRight, Clock3, Code2, FileSearch, FolderGit2, Gauge, ShieldAlert } from "lucide-react";
import { apiGet } from "../api";
import { fmtCost, fmtCount, fmtDuration, fmtTime, relTime, shortSha } from "../format";
import { useApi } from "../hooks";
import { ModeBadge, StatusBadge } from "../components/badges";
import { PageError, RefreshButton, SearchField } from "../components/page-controls";
import type { ActiveRunView, ProjectSummary, RunSummary } from "../types";

interface RunsResponse { runs: RunSummary[]; total: number }
interface Overview { projects: ProjectSummary[]; active: ActiveRunView[] }
const PAGE_SIZE = 50;
const STATUSES = ["all", "completed", "running", "incomplete", "failed"];

export function RunsPage() {
  const { projectId = "" } = useParams();
  const navigate = useNavigate();
  const [offset, setOffset] = useState(0);
  const [statusFilter, setStatusFilter] = useState("all");
  const [query, setQuery] = useState("");
  const runs = useApi<RunsResponse>(
    () => apiGet<RunsResponse>(`/api/projects/${projectId}/runs?limit=${PAGE_SIZE}&offset=${offset}${statusFilter !== "all" ? `&status=${statusFilter}` : ""}`),
    [projectId, offset, statusFilter],
  );
  const overview = useApi<Overview>(() => apiGet<Overview>("/api/overview"), [projectId]);
  const project = overview.data?.projects.find((candidate) => candidate.projectId === projectId);
  const activeRunIds = useMemo(() => new Set((overview.data?.active ?? []).filter((run) => run.projectId === projectId).map((run) => run.runId)), [overview.data, projectId]);
  const visibleRuns = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (runs.data?.runs ?? []).filter((run) => !needle || [run.runId, run.base ?? "", run.head, run.model ?? "", run.notes ?? ""].some((value) => value.toLowerCase().includes(needle)));
  }, [runs.data, query]);
  const total = runs.data?.total ?? 0;
  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const refresh = (): void => { runs.reload(); overview.reload(); };

  return (
    <div className="page-shell">
      <header className="page-header project-page-header">
        <div className="project-heading">
          <Link className="icon-button" to="/projects" aria-label="Back to projects" title="Back to projects"><ArrowLeft size={17} /></Link>
          <span className="file-type-icon is-large"><FolderGit2 size={21} /></span>
          <div><div className="page-eyebrow">Project</div><h1 title={project?.name}>{project?.name ?? projectId.slice(0, 12)}</h1><div className="project-remote" title={project?.remote ?? projectId}>{project?.remote ?? projectId}</div></div>
        </div>
        <div className="page-header-actions"><RefreshButton loading={runs.loading} onClick={refresh} /></div>
      </header>
      <section className="project-summary-strip" aria-label="Project summary">
        <div><Gauge size={17} /><span><small>Total runs</small><strong>{fmtCount(project?.runsTotal ?? total)}</strong></span></div>
        <div><ShieldAlert size={17} /><span><small>Open findings</small><strong className="metric-warning">{fmtCount(project?.openFindings ?? 0)}</strong></span></div>
        <div><Clock3 size={17} /><span><small>Last review</small><strong>{project?.lastRunAt ? relTime(project.lastRunAt) : "Never"}</strong></span></div>
        <div><Code2 size={17} /><span><small>Project ID</small><strong title={projectId}>{projectId.slice(0, 12)}</strong></span></div>
      </section>
      <section className="data-section" aria-label="Review runs">
        <div className="data-section-head"><h2 className="section-label">Review runs <span className="section-count">{total}</span></h2><SearchField value={query} onChange={setQuery} label="Search this page" /></div>
        <div className="run-toolbar">
          <div className="segmented-control" role="group" aria-label="Filter runs by status">{STATUSES.map((status) => (
            <button key={status} type="button" aria-pressed={statusFilter === status} className={statusFilter === status ? "is-active" : ""} onClick={() => { setStatusFilter(status); setOffset(0); }}>{status === "all" ? "All runs" : status[0].toUpperCase() + status.slice(1)}</button>
          ))}</div>
          <span className="section-count" role="status">{runs.loading ? "Updating…" : `${visibleRuns.length} shown`}</span>
        </div>
        {runs.loading && !runs.data && <div className="loading-state" role="status"><span className="pir-mini-spinner" /> Loading runs…</div>}
        {runs.error && <PageError error={runs.error} retry={refresh} />}
        {!runs.loading && !runs.error && runs.data && visibleRuns.length === 0 && <div className="empty-state"><FileSearch size={26} /><strong>No matching runs</strong>{(query || statusFilter !== "all") && <button className="text-command" type="button" onClick={() => { setQuery(""); setStatusFilter("all"); setOffset(0); }}>Clear filters</button>}</div>}
        {visibleRuns.length > 0 && <div className="table-scroll" aria-busy={runs.loading}>
          <table className="data-table run-table"><thead><tr><th scope="col">Review</th><th scope="col">Status</th><th scope="col">Findings</th><th scope="col">Started</th><th scope="col" className="num">Duration</th><th scope="col" className="num">Usage</th><th scope="col" aria-label="Open run" /></tr></thead>
            <tbody>{visibleRuns.map((run) => {
              const status = activeRunIds.has(run.runId) ? "running" : run.status === "running" && run.finishedAt === null ? "interrupted" : run.status;
              const href = `/runs/${projectId}/${run.runId}`;
              return <tr key={run.runId} className="table-row-clickable" onClick={() => navigate(href)}>
                <td className="run-primary"><Link className="table-primary-link run-name-cell" to={href}>
                  <strong className="range-cell" title={`${run.base ?? "Snapshot"}..${run.head}`}>{run.base ? `${shortSha(run.base, 7)}…${shortSha(run.head, 7)}` : `Snapshot ${shortSha(run.head, 8)}`}</strong>
                  <span className="run-name-meta"><ModeBadge mode={run.mode} /><small title={run.model ?? undefined}>{run.model ?? "pi default"}</small></span>
                </Link></td>
                <td data-label="Status"><StatusBadge status={status} /></td>
                <td data-label="Findings"><span className="verdict-summary"><span className={run.confirmed > 0 ? "metric-warning" : "metric-muted"}>{run.confirmed} confirmed</span><small>{run.rejected} rejected · {run.uncertain} uncertain</small></span></td>
                <td className="muted-cell" data-label="Started" title={fmtTime(run.startedAt)}>{relTime(run.startedAt)}<small>{fmtTime(run.startedAt)}</small></td>
                <td className="num" data-label="Duration">{fmtDuration(run.durationMs)}</td>
                <td className="num usage-cell" data-label="Usage"><span>{run.totalTokens === null ? "—" : `${fmtCount(run.totalTokens)} tok`}</span><small>{fmtCost(run.cost)}</small></td>
                <td className="row-action"><Link className="icon-button" to={href} aria-label={`Open run ${run.runId}`} title="Open run"><ChevronRight size={17} /></Link></td>
              </tr>;
            })}</tbody>
          </table>
        </div>}
        {runs.data && total > 0 && <div className="pagination"><span className="pagination-range">{offset + 1}-{Math.min(offset + PAGE_SIZE, total)} of {total} runs</span><button className="icon-button" type="button" disabled={offset === 0 || runs.loading} aria-label="Newer runs" title="Newer runs" onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}><ChevronLeft size={17} /></button><span>{page} / {pages}</span><button className="icon-button" type="button" disabled={offset + PAGE_SIZE >= total || runs.loading} aria-label="Older runs" title="Older runs" onClick={() => setOffset(offset + PAGE_SIZE)}><ChevronRight size={17} /></button></div>}
      </section>
    </div>
  );
}
