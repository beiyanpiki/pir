import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Activity, ArrowUpRight, Boxes, ChevronLeft, ChevronRight, FolderGit2, Gauge, ShieldAlert } from "lucide-react";
import { apiGet } from "../api";
import { fmtCount, relTime } from "../format";
import { useApi } from "../hooks";
import { StatusBadge } from "../components/badges";
import { PageError, RefreshButton, SearchField } from "../components/page-controls";
import type { ActiveRunView, ProjectSummary } from "../types";

interface Overview { projects: ProjectSummary[]; active: ActiveRunView[] }
type ProjectFilter = "all" | "reviewed" | "findings";
const PAGE_SIZE = 50;

export function ProjectsPage() {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ProjectFilter>("all");
  const [sort, setSort] = useState("recent");
  const [page, setPage] = useState(0);
  const navigate = useNavigate();
  const overview = useApi<Overview>(() => apiGet<Overview>("/api/overview"), []);
  const projects = overview.data?.projects ?? [];
  const active = overview.data?.active ?? [];

  useEffect(() => {
    const timer = setInterval(overview.reload, 15_000);
    return () => clearInterval(timer);
  }, [overview.reload]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return projects.filter((project) =>
      (filter !== "reviewed" || project.runsTotal > 0) &&
      (filter !== "findings" || project.openFindings > 0) &&
      (!needle || [project.name, project.remote ?? "", project.projectId].some((value) => value.toLowerCase().includes(needle))),
    ).sort((a, b) => {
      if (sort === "name") return a.name.localeCompare(b.name);
      if (sort === "findings") return b.openFindings - a.openFindings || a.name.localeCompare(b.name);
      return (b.lastRunAt ?? 0) - (a.lastRunAt ?? 0) || a.name.localeCompare(b.name);
    });
  }, [projects, query, filter, sort]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages - 1);
  const visible = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const activeProjects = new Set(active.map((run) => run.projectId));
  const totals = useMemo(() => ({
    runs: projects.reduce((sum, project) => sum + project.runsTotal, 0),
    findings: projects.reduce((sum, project) => sum + project.openFindings, 0),
  }), [projects]);
  const resetFilters = (): void => { setQuery(""); setFilter("all"); setPage(0); };

  return (
    <div className="page-shell">
      <header className="page-header">
        <div><div className="page-eyebrow">Workspace</div><h1>Projects <span className="heading-count">{projects.length}</span></h1></div>
        <div className="page-header-actions">
          <SearchField value={query} onChange={(value) => { setQuery(value); setPage(0); }} label="Search projects" />
          <RefreshButton loading={overview.loading} onClick={overview.reload} />
        </div>
      </header>

      <section className="overview-strip" aria-label="Review totals">
        <div className="overview-stat"><span className="overview-stat-icon"><Boxes size={18} /></span><span><small>Projects</small><strong>{fmtCount(projects.length)}</strong></span></div>
        <div className="overview-stat"><span className="overview-stat-icon is-blue"><Gauge size={18} /></span><span><small>Review runs</small><strong>{fmtCount(totals.runs)}</strong></span></div>
        <div className="overview-stat"><span className="overview-stat-icon is-warning"><ShieldAlert size={18} /></span><span><small>Open findings</small><strong>{fmtCount(totals.findings)}</strong></span></div>
        <div className="overview-stat"><span className="overview-stat-icon is-live"><Activity size={18} /></span><span><small>Active now</small><strong>{fmtCount(active.length)}</strong></span></div>
      </section>

      {active.length > 0 && (
        <section className="active-strip" aria-label="Active reviews">
          <div className="section-label"><Activity size={15} /> Active reviews</div>
          <div className="active-run-list">{active.map((run) => (
            <Link key={run.runId} to={`/runs/${run.projectId}/${run.runId}`} className="active-run-link">
              <span className="live-dot" /><strong>{projects.find((project) => project.projectId === run.projectId)?.name ?? run.projectId.slice(0, 12)}</strong>
              <span className="active-run-meta">{run.mode} · {run.sessions} sessions · {relTime(run.startedAt)}</span><ArrowUpRight size={15} />
            </Link>
          ))}</div>
        </section>
      )}

      <section className="data-section" aria-label="Project inventory">
        <div className="run-toolbar">
          <div className="segmented-control" role="group" aria-label="Filter projects">
            {([["all", "All projects"], ["reviewed", "With reviews"], ["findings", "Open findings"]] as const).map(([value, label]) => (
              <button key={value} type="button" aria-pressed={filter === value} className={filter === value ? "is-active" : ""} onClick={() => { setFilter(value); setPage(0); }}>{label}</button>
            ))}
          </div>
          <label className="sort-control"><span>Sort</span><select aria-label="Sort projects" value={sort} onChange={(event) => { setSort(event.target.value); setPage(0); }}><option value="recent">Latest review</option><option value="name">Name</option><option value="findings">Open findings</option></select></label>
        </div>
        {overview.loading && !overview.data && <div className="loading-state" role="status"><span className="pir-mini-spinner" /> Loading projects…</div>}
        {overview.error && <PageError error={overview.error} retry={overview.reload} />}
        {!overview.loading && !overview.error && filtered.length === 0 && (
          <div className="empty-state"><FolderGit2 size={26} /><strong>{projects.length === 0 ? "No projects yet" : "No matching projects"}</strong>
            {(query || filter !== "all") && <button className="text-command" type="button" onClick={resetFilters}>Clear filters</button>}
          </div>
        )}
        {visible.length > 0 && (
          <div className="table-scroll" aria-busy={overview.loading}>
            <table className="data-table project-table"><thead><tr><th scope="col">Project</th><th scope="col">Last run</th><th scope="col" className="num">Runs</th><th scope="col" className="num">Open findings</th><th scope="col">Last review</th><th scope="col" aria-label="Open project" /></tr></thead>
              <tbody>{visible.map((project) => {
                const status = activeProjects.has(project.projectId) ? "running" : project.lastRunStatus === "running" ? "interrupted" : project.lastRunStatus ?? "idle";
                return (
                  <tr key={project.projectId} className="table-row-clickable" onClick={() => navigate(`/projects/${project.projectId}`)}>
                    <td className="project-primary"><Link className="project-name-cell table-primary-link" to={`/projects/${project.projectId}`}>
                      <span className="file-type-icon"><FolderGit2 size={17} /></span><span><strong title={project.name}>{project.name}</strong><small title={project.remote ?? project.projectId}>{project.remote ?? project.projectId.slice(0, 16)}</small></span>
                    </Link></td>
                    <td data-label="Last run"><StatusBadge status={status} /></td>
                    <td className="num" data-label="Runs">{fmtCount(project.runsTotal)}</td>
                    <td className="num" data-label="Open findings"><span className={project.openFindings > 0 ? "metric-warning" : "metric-muted"}>{fmtCount(project.openFindings)}</span></td>
                    <td className="muted-cell" data-label="Last review" title={project.lastRunAt ? new Date(project.lastRunAt).toLocaleString() : undefined}>{project.lastRunAt ? relTime(project.lastRunAt) : "Never"}</td>
                    <td className="row-action"><Link className="icon-button" to={`/projects/${project.projectId}`} aria-label={`Open ${project.name}`} title="Open project"><ArrowUpRight size={16} /></Link></td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
        )}
        {filtered.length > 0 && <div className="pagination"><span className="pagination-range">{currentPage * PAGE_SIZE + 1}-{Math.min((currentPage + 1) * PAGE_SIZE, filtered.length)} of {filtered.length} projects</span><button className="icon-button" type="button" disabled={currentPage === 0} aria-label="Previous page" title="Previous page" onClick={() => setPage(currentPage - 1)}><ChevronLeft size={17} /></button><span>{currentPage + 1} / {pages}</span><button className="icon-button" type="button" disabled={currentPage + 1 >= pages} aria-label="Next page" title="Next page" onClick={() => setPage(currentPage + 1)}><ChevronRight size={17} /></button></div>}
      </section>
    </div>
  );
}
