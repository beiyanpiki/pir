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
    <aside className="flex w-64 shrink-0 flex-col overflow-y-auto border-r border-border bg-sidebar">
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
          Projects {overview.data ? `· ${overview.data.projects.length}` : ""}
        </span>
      </div>
      <nav className="flex flex-col gap-0.5 px-2 pb-4">
        <input
          type="search"
          placeholder="filter projects…"
          className="mb-1.5 w-full rounded-md border border-border bg-input/40 px-2.5 py-1.5 text-xs outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-primary/60"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
        {overview.loading && projects.length === 0 && (
          <div className="py-4 text-center"><span className="pir-mini-spinner" /></div>
        )}
        {overview.error && <div className="px-1.5 py-1 text-xs text-red-400">{overview.error}</div>}
        {projects.map((project) => (
          <Link
            key={project.projectId}
            className={`flex items-center gap-2 overflow-hidden rounded-md px-2.5 py-1.5 text-[13px] transition-colors ${
              location.pathname.startsWith(`/projects/${project.projectId}`)
                ? "bg-primary/12 text-foreground"
                : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
            }`}
            to={`/projects/${project.projectId}`}
            title={project.remote ?? project.projectId}
          >
            <span className="flex-1 truncate">{project.name}</span>
            <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground/70">{project.runsTotal}</span>
          </Link>
        ))}
        {!overview.loading && projects.length === 0 && (
          <div className="px-1.5 py-1 text-xs text-muted-foreground/70">
            no projects — run a review with transcripts on
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
