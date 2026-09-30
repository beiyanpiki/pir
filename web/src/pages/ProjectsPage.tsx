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

  if (overview.loading) return <div className="py-10 text-center text-muted-foreground"><span className="pir-mini-spinner" /> loading projects…</div>;
  if (overview.error) return <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">{overview.error}</div>;
  const projects = overview.data?.projects ?? [];
  if (projects.length === 0) {
    return (
      <div className="pir-empty">
        No review state found. Run a review (with <code>PIR_TRANSCRIPTS=1</code>, or
        <code> pir serve --web</code>) and it will appear here.
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-5 flex flex-wrap items-baseline gap-3">
        <h1 className="text-xl font-semibold">Projects</h1>
        <span className="text-[13px] text-muted-foreground">
          {projects.length} project{projects.length === 1 ? "" : "s"} with review memory
        </span>
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-3.5">
        {projects.map((project) => (
          <Link
            key={project.projectId}
            to={`/projects/${project.projectId}`}
            className="block rounded-xl border border-border bg-card p-4 text-inherit no-underline transition-all hover:-translate-y-px hover:border-border hover:shadow-lg hover:shadow-black/30"
            style={{ color: "inherit" }}
          >
            <div className="mb-2 truncate text-sm font-semibold">{project.name}</div>
            <div className="pir-stat-row mb-2">
              <span className="stat"><b>{fmtCount(project.runsTotal)}</b> runs</span>
              <span className="stat"><b className="text-amber-400">{fmtCount(project.openFindings)}</b> open findings</span>
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              last run {relTime(project.lastRunAt)}
              {project.lastRunStatus && <StatusBadge status={project.lastRunStatus} />}
            </div>
            {project.remote && (
              <div className="mt-2.5 truncate font-mono text-[10.5px] text-muted-foreground/60">{project.remote}</div>
            )}
          </Link>
        ))}
      </div>
    </div>
  );
}
