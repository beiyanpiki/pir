import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { ChevronRight, FolderOpen } from "lucide-react";
import { apiGet, getToken, setToken } from "../api";
import { fmtTime, relTime, shortSha } from "../format";
import { useApi } from "../hooks";
import { LiveBadge } from "../components/badges";
import type { ActiveRunView, ProjectSummary, RunSummary } from "../types";

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

/** Recent runs of one expanded project, fetched on first expand. */
function ProjectRuns({
  projectId,
  activeRunId,
}: {
  projectId: string;
  activeRunId: string | undefined;
}) {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    apiGet<{ runs: RunSummary[] }>(`/api/projects/${projectId}/runs?limit=6`)
      .then((data) => {
        if (!cancelled) setRuns(data.runs);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  if (error) return <div className="px-3 py-1 text-xs text-red-400/80">{error}</div>;
  if (runs === null) return <div className="px-4 py-1 text-[11px] text-muted-foreground/50">loading…</div>;
  if (runs.length === 0) return <div className="px-4 py-1 text-[11px] text-muted-foreground/50">no runs yet</div>;
  return (
    <div className="flex flex-col gap-0.5">
      {runs.map((run) => {
        const isActive = run.runId === activeRunId;
        return (
          <Link
            key={run.runId}
            to={`/runs/${projectId}/${run.runId}`}
            title={`${run.mode} · ${fmtTime(run.startedAt)}`}
            className={`ml-4 flex items-center gap-2 overflow-hidden rounded-md border-l border-transparent py-1 pl-3 pr-2 text-[12.5px] transition-colors ${
              isActive
                ? "border-primary/70 bg-primary/12 text-foreground"
                : "border-border/60 text-muted-foreground hover:border-border hover:bg-muted/50 hover:text-foreground"
            }`}
          >
            <span className="shrink-0 truncate">
              {run.base ? `${shortSha(run.base, 6)}…${shortSha(run.head, 6)}` : `snapshot ${shortSha(run.head, 6)}`}
            </span>
            <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground/60">{relTime(run.startedAt)}</span>
          </Link>
        );
      })}
    </div>
  );
}

function ProjectNode({
  project,
  activeRunId,
  activeProjectId,
}: {
  project: ProjectSummary;
  activeRunId: string | undefined;
  activeProjectId: string | undefined;
}) {
  const containsActive = activeProjectId === project.projectId;
  const [expanded, setExpanded] = useState(containsActive);
  return (
    <div>
      <div
        className={`group flex items-center gap-1.5 overflow-hidden rounded-md px-2 py-1.5 transition-colors ${
          containsActive ? "text-foreground" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
        }`}
      >
        <button
          className="shrink-0 rounded p-0.5 transition-transform hover:bg-muted"
          style={{ transform: expanded ? "rotate(90deg)" : "none" }}
          onClick={() => setExpanded(!expanded)}
          aria-label={expanded ? "collapse" : "expand"}
        >
          <ChevronRight size={13} />
        </button>
        <button
          className="min-w-0 flex-1 truncate text-left text-[13px]"
          title={project.remote ?? project.projectId}
          onClick={() => setExpanded(!expanded)}
        >
          {project.name}
        </button>
        <Link
          to={`/projects/${project.projectId}`}
          className="shrink-0 rounded p-0.5 text-muted-foreground/50 opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
          title="open project"
        >
          <FolderOpen size={13} />
        </Link>
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground/60">{project.runsTotal}</span>
      </div>
      {expanded && (
        <div className="mt-0.5">
          <ProjectRuns projectId={project.projectId} activeRunId={activeRunId} />
        </div>
      )}
    </div>
  );
}

export function Sidebar() {
  const location = useLocation();
  const params = useParams();
  const overview = useApi<Overview>(() => apiGet<Overview>("/api/overview"), []);
  usePollingReload(overview.reload, 15_000);

  // /runs/:projectId/:runId tells us which tree node should be open.
  const runMatch = /^\/runs\/([0-9a-f]{64})\/([\w-]+)$/.exec(location.pathname);
  const activeProjectId = runMatch?.[1] ?? params.projectId;
  const activeRunId = runMatch?.[2];

  const active = overview.data?.active ?? [];
  const projects = useMemo(() => {
    const list = overview.data?.projects ?? [];
    // The project of the open run always stays in the list.
    return list.slice(0, 40);
  }, [overview.data]);

  return (
    <aside className="flex w-72 shrink-0 flex-col overflow-y-auto border-r border-border bg-sidebar">
      <div className="flex items-center gap-2.5 border-b border-border px-4 py-4">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/15 text-[15px] font-bold text-primary">
          ⌄
        </span>
        <span className="text-sm font-semibold leading-tight">
          pir review
          <span className="block text-[10.5px] font-normal tracking-wide text-muted-foreground">
            read-only run explorer
          </span>
        </span>
      </div>

      {active.length > 0 && (
        <>
          <div className="flex items-center justify-between px-3 pb-1.5 pt-4">
            <span className="text-[10.5px] uppercase tracking-[0.1em] text-muted-foreground">Active now</span>
            <LiveBadge label={String(active.length)} />
          </div>
          <nav className="flex flex-col gap-0.5 px-2">
            {active.map((run) => (
              <Link
                key={run.runId}
                className="flex items-center gap-2 overflow-hidden rounded-md px-2.5 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                to={`/runs/${run.projectId}/${run.runId}`}
              >
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400 shadow-[0_0_6px] shadow-emerald-400" />
                <span className="flex-1 truncate">
                  {run.mode} · {run.sessions} session{run.sessions === 1 ? "" : "s"}
                </span>
                <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground/70">{relTime(run.startedAt)}</span>
              </Link>
            ))}
          </nav>
        </>
      )}

      <div className="flex items-center justify-between px-3 pb-1.5 pt-4">
        <span className="text-[10.5px] uppercase tracking-[0.1em] text-muted-foreground">
          项目 {overview.data ? `· ${overview.data.projects.length}` : ""}
        </span>
        <Link to="/projects" className="text-[10.5px] text-muted-foreground/60 transition-colors hover:text-foreground">
          全部 →
        </Link>
      </div>
      <nav className="flex flex-col gap-0.5 px-2 pb-4">
        {overview.loading && projects.length === 0 && (
          <div className="py-4 text-center"><span className="pir-mini-spinner" /></div>
        )}
        {overview.error && <div className="px-1.5 py-1 text-xs text-red-400">{overview.error}</div>}
        {projects.map((project) => (
          <ProjectNode
            key={project.projectId}
            project={project}
            activeRunId={activeRunId}
            activeProjectId={activeProjectId}
          />
        ))}
        {!overview.loading && projects.length === 0 && (
          <div className="px-1.5 py-1 text-xs text-muted-foreground/70">
            没有项目 — run a review with transcripts on
          </div>
        )}
      </nav>

      <div className="mt-auto flex items-center justify-between border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
        <span className="font-mono">read-only</span>
        {getToken() !== null && (
          <a
            href="/login"
            className="transition-colors hover:text-foreground"
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
