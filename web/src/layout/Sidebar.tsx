import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { apiGet, getToken, setToken } from "../api";
import { relTime } from "../format";
import { useApi } from "../hooks";
import { LiveBadge } from "../components/badges";
import type { ActiveRunView, ProjectSummary } from "../types";

interface Overview {
  projects: ProjectSummary[];
  active: ActiveRunView[];
}

function usePollingReload(reload: () => void, intervalMs: number): void {
  useEffect(() => {
    const timer = setInterval(reload, intervalMs);
    return () => clearInterval(timer);
  }, [reload, intervalMs]);
}

export function Sidebar() {
  const location = useLocation();
  const [filter, setFilter] = useState("");
  const overview = useApi<Overview>(() => apiGet<Overview>("/api/overview"), []);
  usePollingReload(overview.reload, 15_000);

  const active = overview.data?.active ?? [];
  const projects = useMemo(() => {
    const list = overview.data?.projects ?? [];
    const needle = filter.trim().toLowerCase();
    const filtered = needle
      ? list.filter((project) => project.name.toLowerCase().includes(needle) || project.projectId.startsWith(needle))
      : list;
    return filtered.slice(0, 50);
  }, [overview.data, filter]);

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <span className="logo">⌄</span>
        <span className="title">
          pir review
          <small>read-only run explorer</small>
        </span>
      </div>

      {active.length > 0 && (
        <>
          <div className="sidebar-section">
            <span>Active now</span>
            <LiveBadge label={String(active.length)} />
          </div>
          <nav>
            {active.map((run) => (
              <Link key={run.runId} className="project-link" to={`/runs/${run.projectId}/${run.runId}`}>
                <span className="dot" />
                <span className="name">{run.mode} · {run.sessions} session{run.sessions === 1 ? "" : "s"}</span>
                <span className="count">{relTime(run.startedAt)}</span>
              </Link>
            ))}
          </nav>
        </>
      )}

      <div className="sidebar-section">
        <span>Projects</span>
        <span>{overview.data ? overview.data.projects.length : "…"}</span>
      </div>
      <nav>
        <input
          type="search"
          placeholder="filter…"
          className="sidebar-filter"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
        {overview.loading && projects.length === 0 && <div className="loading-row"><span className="pir-mini-spinner" /></div>}
        {overview.error && <div style={{ color: "#e5534b", padding: "4px 8px", fontSize: 12 }}>{overview.error}</div>}
        {projects.map((project) => (
          <Link
            key={project.projectId}
            className={`project-link${location.pathname.startsWith(`/projects/${project.projectId}`) ? " active" : ""}`}
            to={`/projects/${project.projectId}`}
            title={project.remote ?? project.projectId}
          >
            <span className="name">{project.name}</span>
            <span className="count">{project.runsTotal}</span>
          </Link>
        ))}
        {!overview.loading && projects.length === 0 && (
          <div style={{ color: "var(--pir-faint)", padding: "4px 8px", fontSize: 12 }}>
            no projects — run a review with transcripts on
          </div>
        )}
      </nav>

      <div className="sidebar-footer">
        <span>read-only</span>
        {getToken() !== null && (
          <a
            href="/login"
            onClick={(event) => {
              event.preventDefault();
              setToken(null);
              window.location.href = "/login";
            }}
          >
            sign out
          </a>
        )}
      </div>
    </aside>
  );
}
