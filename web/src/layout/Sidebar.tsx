import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  Activity,
  ChevronDown,
  ChevronRight,
  CircleDot,
  FolderGit2,
  Gauge,
  Layers3,
  Search,
  ShieldCheck,
  X,
} from "lucide-react";
import { apiGet } from "../api";
import { fmtCount, relTime, shortSha } from "../format";
import { useApi } from "../hooks";
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

function RunLink({
  projectId,
  run,
  activeRunId,
  compact = false,
}: {
  projectId: string;
  run: Pick<RunSummary, "runId" | "head" | "startedAt" | "mode"> & {
    base?: string | null;
    status: string;
  };
  activeRunId?: string;
  compact?: boolean;
}) {
  const active = run.runId === activeRunId;
  return (
    <Link
      to={`/runs/${projectId}/${run.runId}`}
      className={`sidebar-run ${active ? "is-active" : ""} ${compact ? "is-compact" : ""}`}
      title={`${run.mode} review · ${run.status}`}
    >
      <span className={`run-state-dot ${run.status === "running" ? "is-running" : ""}`} />
      <span className="sidebar-run-title">
        {run.base ? `${shortSha(run.base, 6)}…${shortSha(run.head, 6)}` : shortSha(run.head, 8)}
      </span>
      <span className="sidebar-run-time">{relTime(run.startedAt)}</span>
    </Link>
  );
}

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
    const controller = new AbortController();
    setRuns(null);
    setError(null);
    apiGet<{ runs: RunSummary[] }>(`/api/projects/${projectId}/runs?limit=6`, controller.signal)
      .then((data) => {
        setRuns(data.runs);
      })
      .catch((cause) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      controller.abort();
    };
  }, [projectId]);

  if (error) return <div className="sidebar-error">{error}</div>;
  if (runs === null) return <div className="sidebar-loading">Loading runs…</div>;
  if (runs.length === 0) return <div className="sidebar-empty">No runs</div>;

  return (
    <div className="sidebar-runs">
      {runs.map((run) => (
        <RunLink key={run.runId} projectId={projectId} run={run} activeRunId={activeRunId} />
      ))}
    </div>
  );
}

function ProjectNode({
  project,
  activeRunId,
  activeProjectId,
  initiallyExpanded,
}: {
  project: ProjectSummary;
  activeRunId: string | undefined;
  activeProjectId: string | undefined;
  initiallyExpanded: boolean;
}) {
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const active = activeProjectId === project.projectId;

  useEffect(() => {
    if (active) setExpanded(true);
  }, [active]);

  return (
    <div className={`sidebar-project ${active ? "is-active" : ""}`}>
      <div className="sidebar-project-row">
        <button
          className="sidebar-chevron"
          type="button"
          aria-label={expanded ? `Collapse ${project.name}` : `Expand ${project.name}`}
          title={expanded ? "Collapse project" : "Expand project"}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>
        <Link className="sidebar-project-link" to={`/projects/${project.projectId}`} title={project.remote ?? project.projectId}>
          <FolderGit2 size={14} />
          <span>{project.name}</span>
        </Link>
        <span className="sidebar-count">{fmtCount(project.runsTotal)}</span>
      </div>
      {expanded && <ProjectRuns projectId={project.projectId} activeRunId={activeRunId} />}
    </div>
  );
}

export function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const location = useLocation();
  const sidebarRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [narrow, setNarrow] = useState(() => window.matchMedia("(max-width: 900px)").matches);
  const [query, setQuery] = useState("");
  const overview = useApi<Overview>((signal) => apiGet<Overview>("/api/overview", signal), []);
  usePollingReload(overview.reload, 15_000);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 900px)");
    const update = () => setNarrow(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (!open || !narrow) return;
    const sidebar = sidebarRef.current;
    if (!sidebar) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const background = document.querySelectorAll<HTMLElement>(".workspace-topbar, .workspace-main");
    const priorInert = new Map([...background].map((element) => [element, element.inert]));
    background.forEach((element) => { element.inert = true; });
    const focusable = () => [...sidebar.querySelectorAll<HTMLElement>("button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), [tabindex]")]
      .filter((element) => element.tabIndex >= 0 && element.getClientRects().length > 0);
    (focusable()[0] ?? sidebar).focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const nodes = focusable();
      if (nodes.length === 0) { event.preventDefault(); return; }
      if (event.shiftKey && document.activeElement === nodes[0]) {
        event.preventDefault(); nodes[nodes.length - 1].focus();
      } else if (!event.shiftKey && document.activeElement === nodes[nodes.length - 1]) {
        event.preventDefault(); nodes[0].focus();
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("keydown", handleKey);
      background.forEach((element) => { element.inert = priorInert.get(element) ?? false; });
      opener?.focus();
    };
  }, [open, narrow]);

  const runMatch = /^\/runs\/([^/]+)\/([^/]+)$/.exec(location.pathname);
  const projectMatch = /^\/projects\/([^/]+)$/.exec(location.pathname);
  const activeProjectId = runMatch?.[1] ?? projectMatch?.[1];
  const activeRunId = runMatch?.[2];

  const projects = overview.data?.projects ?? [];
  const activeRuns = overview.data?.active ?? [];
  const filteredProjects = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return projects.slice(0, 50);
    return projects
      .filter((project) =>
        [project.name, project.remote ?? "", project.projectId].some((value) => value.toLowerCase().includes(needle)),
      )
      .slice(0, 50);
  }, [projects, query]);

  return (
    <aside ref={sidebarRef} className={`workspace-sidebar ${open ? "is-open" : ""}`} aria-label="Projects and review runs" role={open && narrow ? "dialog" : "complementary"} aria-modal={open && narrow ? true : undefined} inert={narrow && !open} tabIndex={-1}>
      <div className="sidebar-head">
        <div>
          <div className="sidebar-eyebrow">Workspace</div>
          <div className="sidebar-title">Review runs</div>
        </div>
        <button
          className="icon-button mobile-only"
          type="button"
          aria-label="Close project navigation"
          title="Close project navigation"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </div>

      <nav className="sidebar-nav" aria-label="Primary navigation">
        <Link className={`sidebar-nav-link ${location.pathname === "/projects" ? "is-active" : ""}`} to="/projects">
          <Gauge size={15} />
          <span>Projects</span>
        </Link>
        <div className="sidebar-nav-link is-static">
          <ShieldCheck size={15} />
          <span>Read-only mode</span>
        </div>
      </nav>

      {activeRuns.length > 0 && (
        <section className="sidebar-section">
          <div className="sidebar-section-title">
            <span><Activity size={13} /> Active</span>
            <span className="sidebar-count">{activeRuns.length}</span>
          </div>
          <div className="sidebar-runs">
            {activeRuns.map((run) => (
              <RunLink key={run.runId} projectId={run.projectId} run={{ ...run, status: "running" }} activeRunId={activeRunId} compact />
            ))}
          </div>
        </section>
      )}

      <section className="sidebar-section sidebar-projects-section">
        <div className="sidebar-section-title">
          <span><Layers3 size={13} /> Projects</span>
          <span className="sidebar-count">{projects.length}</span>
        </div>

        <label className="sidebar-search">
          <Search size={14} />
          <input
            type="search"
            aria-label="Filter projects"
            value={query}
            placeholder="Filter projects"
            onChange={(event) => setQuery(event.target.value)}
          />
          {query && (
            <button type="button" aria-label="Clear project filter" title="Clear project filter" onClick={() => setQuery("")}>
              <X size={13} />
            </button>
          )}
        </label>

        <div className="sidebar-project-list">
          {overview.loading && projects.length === 0 && <div className="sidebar-loading">Loading projects…</div>}
          {overview.error && <div className="sidebar-error">{overview.error}</div>}
          {filteredProjects.map((project) => (
            <ProjectNode
              key={project.projectId}
              project={project}
              activeRunId={activeRunId}
              activeProjectId={activeProjectId}
              initiallyExpanded={project.projectId === activeProjectId}
            />
          ))}
          {!overview.loading && filteredProjects.length === 0 && (
            <div className="sidebar-empty">No matching projects</div>
          )}
        </div>
      </section>

      <div className="sidebar-footer">
        <CircleDot size={12} />
        <span>Local review state</span>
      </div>
    </aside>
  );
}
