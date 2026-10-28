import { useEffect, useMemo, useState } from "react";
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import {
  App as AntApp,
  Badge,
  Button,
  Divider,
  Drawer,
  Grid,
  Input,
  Layout,
  Menu,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import {
  AppstoreOutlined,
  ExperimentOutlined,
  HistoryOutlined,
  LogoutOutlined,
  MenuOutlined,
  MessageOutlined,
  MoonOutlined,
  ReadOutlined,
  SafetyCertificateOutlined,
  SunOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import { apiGet, getToken, setToken } from "../lib/api";
import { useApi } from "../lib/hooks";
import type { ActiveRunView, ProjectSummary } from "../lib/types";
import { useThemeMode } from "../theme";

const { Header, Sider, Content } = Layout;

interface Overview {
  projects: ProjectSummary[];
  active: ActiveRunView[];
}

function usePolling(reload: () => void, intervalMs: number): void {
  useEffect(() => {
    const timer = setInterval(reload, intervalMs);
    return () => clearInterval(timer);
  }, [reload, intervalMs]);
}

function ProjectSider({ projectId, runId, onNavigate }: { projectId: string | undefined; runId: string | undefined; onNavigate?: () => void }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [query, setQuery] = useState("");
  const overview = useApi<Overview>((signal) => apiGet<Overview>("/api/overview", signal), []);
  usePolling(overview.reload, 15_000);
  const projects = overview.data?.projects ?? [];
  const active = overview.data?.active ?? [];
  const current = projects.find((project) => project.projectId === projectId);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const rows = projects.filter((project) =>
      !needle || [project.name, project.remote ?? "", project.projectId].some((value) => value.toLowerCase().includes(needle)),
    );
    return rows.slice(0, 20);
  }, [projects, query]);

  const section = projectId
    ? location.pathname.startsWith(`/projects/${projectId}`)
      ? location.pathname.slice(`/projects/${projectId}`.length).replace(/^\//, "") || "runs"
      : "runs"
    : "projects";

  const nav = (path: string): void => {
    navigate(path);
    onNavigate?.();
  };

  return (
    <div className="pir-sider-inner">
      <Menu
        mode="inline"
        selectedKeys={[section]}
        items={[
          { key: "projects", icon: <AppstoreOutlined />, label: "Projects", onClick: () => nav("/projects") },
          ...(projectId
            ? [
                { type: "divider" as const },
                {
                  key: "runs",
                  icon: <HistoryOutlined />,
                  label: "Runs",
                  onClick: () => nav(`/projects/${projectId}`),
                },
                { key: "findings", icon: <SafetyCertificateOutlined />, label: "Findings", onClick: () => nav(`/projects/${projectId}/findings`) },
                { key: "memory", icon: <ReadOutlined />, label: "Memory", onClick: () => nav(`/projects/${projectId}/memory`) },
                { key: "feedback", icon: <MessageOutlined />, label: "Feedback", onClick: () => nav(`/projects/${projectId}/feedback`) },
                { key: "compare", icon: <ExperimentOutlined />, label: "Compare runs", onClick: () => nav(`/projects/${projectId}/compare`) },
              ]
            : []),
        ]}
        style={{ borderInlineEnd: "none", background: "transparent" }}
      />

      {projectId && current && (
        <div style={{ padding: "14px 14px 4px" }}>
          <div className="pir-sider-label" style={{ padding: 0 }}>Current project</div>
          <Typography.Text strong ellipsis title={current.name}>{current.name}</Typography.Text>
          <div className="pir-muted" style={{ fontSize: 12 }}>{current.remote ?? current.projectId.slice(0, 14)}</div>
        </div>
      )}

      {active.length > 0 && (
        <>
          <div className="pir-sider-label" style={{ marginTop: 12 }}><ThunderboltOutlined /> Active reviews</div>
          {active.slice(0, 6).map((run) => (
            <button
              key={run.runId}
              type="button"
              className={`pir-sider-project ${run.runId === runId ? "is-active" : ""}`}
              onClick={() => nav(`/runs/${run.projectId}/${run.runId}`)}
              title={`${run.mode} · ${run.head.slice(0, 10)}`}
            >
              <span className="pir-live-dot" />
              {projects.find((project) => project.projectId === run.projectId)?.name ?? run.projectId.slice(0, 10)}
              <span className="pir-muted"> · {run.mode}</span>
            </button>
          ))}
        </>
      )}

      <div className="pir-sider-label" style={{ marginTop: 16 }}>Recent projects</div>
      <Input.Search
        size="small"
        allowClear
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Filter projects"
        style={{ marginBottom: 6, paddingInline: 4 }}
      />
      {overview.loading && projects.length === 0 && <div className="pir-sider-project">Loading projects…</div>}
      {overview.error && <div className="pir-sider-project" style={{ color: "var(--pir-danger)" }}>{overview.error}</div>}
      {filtered.map((project) => (
        <button
          key={project.projectId}
          type="button"
          className={`pir-sider-project ${project.projectId === projectId ? "is-active" : ""}`}
          onClick={() => nav(`/projects/${project.projectId}`)}
          title={project.remote ?? project.projectId}
        >
          {project.name}
        </button>
      ))}
      {!overview.loading && !overview.error && filtered.length === 0 && projects.length > 0 && (
        <div className="pir-sider-project">No matching projects</div>
      )}

      <Divider style={{ margin: "16px 0 8px" }} />
      <div className="pir-muted" style={{ fontSize: 11, padding: "0 10px" }}>
        <Badge status="default" /> Local review state · read only
      </div>
    </div>
  );
}

function HeaderBar({ onOpenNav }: { onOpenNav: () => void }) {
  const { mode, toggle } = useThemeMode();
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const hasToken = getToken() !== null;
  const signOut = (): void => {
    setToken(null);
    void message.success("Signed out");
    navigate("/login", { replace: true });
  };
  return (
    <Header className="pir-header" style={{ paddingInline: 16 }}>
      <Button className="pir-mobile-only" type="text" icon={<MenuOutlined />} onClick={onOpenNav} aria-label="Open navigation" />
      <Link className="pir-brand" to="/projects" aria-label="pir review workspace home">
        <span className="pir-brand-mark">π</span>
        <span>pir</span>
      </Link>
      <span className="pir-header-context">Review workspace</span>
      <span className="pir-header-spacer" />
      <Tag color="default" icon={<SafetyCertificateOutlined />}>Read only</Tag>
      <Tooltip title={mode === "dark" ? "Switch to light theme" : "Switch to dark theme"}>
        <Button type="text" icon={mode === "dark" ? <SunOutlined /> : <MoonOutlined />} onClick={toggle} aria-label="Toggle color theme" />
      </Tooltip>
      {hasToken && (
        <Tooltip title="Sign out">
          <Button type="text" icon={<LogoutOutlined />} onClick={signOut} aria-label="Sign out" />
        </Tooltip>
      )}
    </Header>
  );
}

export function WorkspaceLayout() {
  const location = useLocation();
  const screens = Grid.useBreakpoint();
  const [navOpen, setNavOpen] = useState(false);
  const desktop = Boolean(screens.lg);

  useEffect(() => setNavOpen(false), [location.pathname]);

  const match = /^\/runs\/([^/]+)\/([^/]+)/.exec(location.pathname);
  const projectMatch = /^\/projects\/([^/]+)/.exec(location.pathname);
  const projectId = match?.[1] ?? projectMatch?.[1];
  const runId = match?.[2];

  return (
    <Layout className="pir-shell">
      <HeaderBar onOpenNav={() => setNavOpen(true)} />
      <Layout>
        {desktop ? (
          <Sider width={236} className="pir-sider" breakpoint="lg" collapsedWidth={0}>
            <ProjectSider projectId={projectId} runId={runId} />
          </Sider>
        ) : (
          <Drawer
            placement="left"
            size={286}
            open={navOpen}
            onClose={() => setNavOpen(false)}
            title="pir workspace"
            styles={{ body: { padding: 0 } }}
          >
            <ProjectSider projectId={projectId} runId={runId} onNavigate={() => setNavOpen(false)} />
          </Drawer>
        )}
        <Content>
          <div className="pir-content">
            <Outlet />
          </div>
        </Content>
      </Layout>
    </Layout>
  );
}