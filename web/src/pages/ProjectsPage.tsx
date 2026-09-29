import { Link } from "react-router-dom";
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
  const overview = useApi<Overview>(() => apiGet<Overview>("/api/overview"), []);

  if (overview.loading) return <div className="loading-row"><span className="spinner" /> loading projects…</div>;
  if (overview.error) return <div className="error-banner">{overview.error}</div>;
  const projects = overview.data?.projects ?? [];
  if (projects.length === 0) {
    return (
      <div className="empty-state">
        No review state found. Run a review (with <code>PIR_TRANSCRIPTS=1</code>, or
        <code> pir serve --web</code>) and it will appear here.
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1>Projects</h1>
        <span className="sub">{projects.length} project{projects.length === 1 ? "" : "s"} with review memory</span>
      </div>
      <div className="card-grid">
        {projects.map((project) => (
          <Link key={project.projectId} to={`/projects/${project.projectId}`} style={{ textDecoration: "none", color: "inherit" }}>
            <div className="card" style={{ height: "100%" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                <strong style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{project.name}</strong>
              </div>
              <div className="stat-row" style={{ marginBottom: 6 }}>
                <span className="stat"><b>{fmtCount(project.runsTotal)}</b> runs</span>
                <span className="stat"><b style={{ color: "var(--warn)" }}>{fmtCount(project.openFindings)}</b> open findings</span>
              </div>
              <div style={{ color: "var(--text-faint)", fontSize: 12 }}>
                last run {relTime(project.lastRunAt)}{" "}
                {project.lastRunStatus && <StatusBadge status={project.lastRunStatus} />}
              </div>
              {project.remote && (
                <div className="mono" style={{ color: "var(--text-faint)", fontSize: 11, marginTop: 8, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {project.remote}
                </div>
              )}
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
