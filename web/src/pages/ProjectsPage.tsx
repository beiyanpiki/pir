import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  Activity,
  ArrowUpRight,
  Boxes,
  FolderGit2,
  Gauge,
  Search,
  ShieldAlert,
  X,
} from "lucide-react";
import { apiGet } from "../api";
import { fmtCount, relTime } from "../format";
import { useApi } from "../hooks";
import { StatusBadge } from "../components/badges";
import type { ActiveRunView, ProjectSummary } from "../types";

interface Overview {
  projects: ProjectSummary[];
  active: ActiveRunView[];
}

export function ProjectsPage() {
  const [query, setQuery] = useState("");
  const navigate = useNavigate();
  const overview = useApi<Overview>(() => apiGet<Overview>("/api/overview"), []);
  const projects = overview.data?.projects ?? [];
  const active = overview.data?.active ?? [];

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return projects;
    return projects.filter((project) =>
      [project.name, project.remote ?? "", project.projectId].some((value) => value.toLowerCase().includes(needle)),
    );
  }, [projects, query]);

  const totals = useMemo(() => ({
    runs: projects.reduce((sum, project) => sum + project.runsTotal, 0),
    findings: projects.reduce((sum, project) => sum + project.openFindings, 0),
  }), [projects]);

  return (
    <div className="page-shell">
      <header className="page-header">
        <div>
          <div className="page-eyebrow">Review state</div>
          <h1>Projects</h1>
        </div>
        <div className="page-header-actions">
          <label className="search-field">
            <Search size={15} />
            <input
              type="search"
              value={query}
              placeholder="Search projects"
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

      <section className="overview-strip" aria-label="Review totals">
        <div className="overview-stat">
          <span className="overview-stat-icon"><Boxes size={16} /></span>
          <span><small>Projects</small><strong>{fmtCount(projects.length)}</strong></span>
        </div>
        <div className="overview-stat">
          <span className="overview-stat-icon"><Gauge size={16} /></span>
          <span><small>Review runs</small><strong>{fmtCount(totals.runs)}</strong></span>
        </div>
        <div className="overview-stat">
          <span className="overview-stat-icon is-warning"><ShieldAlert size={16} /></span>
          <span><small>Open findings</small><strong>{fmtCount(totals.findings)}</strong></span>
        </div>
        <div className="overview-stat">
          <span className="overview-stat-icon is-live"><Activity size={16} /></span>
          <span><small>Active now</small><strong>{fmtCount(active.length)}</strong></span>
        </div>
      </section>

      {active.length > 0 && (
        <section className="active-strip">
          <div className="section-label"><Activity size={14} /> Active reviews</div>
          <div className="active-run-list">
            {active.map((run) => (
              <Link key={run.runId} to={`/runs/${run.projectId}/${run.runId}`} className="active-run-link">
                <span className="live-dot" />
                <span className="active-run-mode">{run.mode}</span>
                <span className="active-run-meta">{run.sessions} sessions · {relTime(run.startedAt)}</span>
                <ArrowUpRight size={14} />
              </Link>
            ))}
          </div>
        </section>
      )}

      <section className="data-section">
        <div className="data-section-head">
          <div className="section-label"><FolderGit2 size={14} /> Project inventory</div>
          <span className="section-count">{filtered.length} shown</span>
        </div>

        {overview.loading && projects.length === 0 && (
          <div className="loading-state"><span className="pir-mini-spinner" /> Loading project state…</div>
        )}
        {overview.error && <div className="error-state">{overview.error}</div>}

        {!overview.loading && filtered.length === 0 && (
          <div className="empty-state">
            <FolderGit2 size={22} />
            <strong>No projects found</strong>
            <span>{query ? "Try a different search." : "Run a review with transcripts enabled to populate this workspace."}</span>
          </div>
        )}

        {filtered.length > 0 && (
          <div className="table-scroll">
            <table className="data-table project-table">
              <thead>
                <tr>
                  <th>Project</th>
                  <th>State</th>
                  <th className="num">Runs</th>
                  <th className="num">Open</th>
                  <th>Last review</th>
                  <th aria-label="Open project" />
                </tr>
              </thead>
              <tbody>
                {filtered.map((project) => (
                  <tr key={project.projectId} data-clickable>
                    <td onClick={() => navigate(`/projects/${project.projectId}`)}>
                      <div className="project-name-cell">
                        <span className="file-type-icon"><FolderGit2 size={15} /></span>
                        <span>
                          <strong>{project.name}</strong>
                          <small>{project.remote ?? project.projectId.slice(0, 16)}</small>
                        </span>
                      </div>
                    </td>
                    <td onClick={() => navigate(`/projects/${project.projectId}`)}>
                      <StatusBadge status={project.lastRunStatus ?? "idle"} />
                    </td>
                    <td className="num" onClick={() => navigate(`/projects/${project.projectId}`)}>{fmtCount(project.runsTotal)}</td>
                    <td className="num" onClick={() => navigate(`/projects/${project.projectId}`)}>
                      <span className={project.openFindings > 0 ? "metric-warning" : "metric-muted"}>{fmtCount(project.openFindings)}</span>
                    </td>
                    <td className="muted-cell" onClick={() => navigate(`/projects/${project.projectId}`)}>
                      {project.lastRunAt ? relTime(project.lastRunAt) : "Never"}
                    </td>
                    <td className="row-action">
                      <Link
                        className="icon-button"
                        to={`/projects/${project.projectId}`}
                        aria-label={`Open ${project.name}`}
                        title="Open project"
                      >
                        <ArrowUpRight size={15} />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
