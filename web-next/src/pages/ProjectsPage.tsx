import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  Button,
  Card,
  Empty,
  Grid,
  Input,
  List,
  Segmented,
  Space,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import { Welcome } from "@ant-design/x";
import type { ColumnsType } from "antd/es/table";
import {
  ArrowRightOutlined,
  FolderOpenOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import { apiGet } from "../lib/api";
import { fmtCount, fmtTime, relTime, shortSha } from "../lib/format";
import { useApi } from "../lib/hooks";
import type { ActiveRunView, ProjectSummary } from "../lib/types";
import { RunStatusTag } from "../components/StatusTags";
import { PageError, PageLoading, PageSkeleton } from "../components/PageState";
import { PageHeader } from "../components/PageHeader";

interface Overview {
  projects: ProjectSummary[];
  active: ActiveRunView[];
}

type ProjectFilter = "all" | "reviewed" | "findings";

export function ProjectsPage() {
  const navigate = useNavigate();
  const screens = Grid.useBreakpoint();
  const mobile = screens.md === false;
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ProjectFilter>("all");
  const overview = useApi<Overview>((signal) => apiGet<Overview>("/api/overview", signal), []);

  useEffect(() => {
    const timer = setInterval(overview.reload, 15_000);
    return () => clearInterval(timer);
  }, [overview.reload]);

  const projects = overview.data?.projects ?? [];
  const active = overview.data?.active ?? [];
  const activeProjects = useMemo(() => new Set(active.map((run) => run.projectId)), [active]);
  const totals = useMemo(() => ({
    runs: projects.reduce((sum, project) => sum + project.runsTotal, 0),
    findings: projects.reduce((sum, project) => sum + project.openFindings, 0),
  }), [projects]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return projects.filter((project) =>
      (filter !== "reviewed" || project.runsTotal > 0) &&
      (filter !== "findings" || project.openFindings > 0) &&
      (!needle || [project.name, project.remote ?? "", project.projectId].some((value) => value.toLowerCase().includes(needle))),
    ).sort((a, b) => (b.lastRunAt ?? 0) - (a.lastRunAt ?? 0) || a.name.localeCompare(b.name));
  }, [projects, query, filter]);

  const columns: ColumnsType<ProjectSummary> = [
    {
      title: "Project",
      dataIndex: "name",
      key: "name",
      render: (_value, project) => (
        <Space size={10} align="start">
          <FolderOpenOutlined style={{ fontSize: 18, marginTop: 3, color: "var(--pir-accent)" }} />
          <div style={{ minWidth: 0 }}>
            <Link to={`/projects/${project.projectId}`} onClick={(event) => event.stopPropagation()}>
              <Typography.Text strong>{project.name}</Typography.Text>
            </Link>
            <div className="pir-muted pir-break" style={{ fontSize: 12 }}>{project.remote ?? project.projectId}</div>
          </div>
        </Space>
      ),
      sorter: (a, b) => a.name.localeCompare(b.name),
    },
    {
      title: "Last review",
      key: "lastRun",
      width: 170,
      render: (_value, project) => {
        const status = activeProjects.has(project.projectId) ? "running" : project.lastRunStatus === "running" ? "interrupted" : project.lastRunStatus ?? "unknown";
        return <Space size={6} wrap><RunStatusTag status={status} />{project.lastRunAt && <span className="pir-muted" style={{ fontSize: 12 }}>{relTime(project.lastRunAt)}</span>}</Space>;
      },
      sorter: (a, b) => (a.lastRunAt ?? 0) - (b.lastRunAt ?? 0),
    },
    {
      title: "Runs",
      dataIndex: "runsTotal",
      key: "runsTotal",
      align: "right",
      width: 90,
      sorter: (a, b) => a.runsTotal - b.runsTotal,
    },
    {
      title: "Open findings",
      dataIndex: "openFindings",
      key: "openFindings",
      align: "right",
      width: 120,
      render: (value: number) => <Tag color={value > 0 ? "warning" : "default"}>{fmtCount(value)}</Tag>,
      sorter: (a, b) => a.openFindings - b.openFindings,
    },
    {
      title: "Last activity",
      key: "lastAt",
      width: 180,
      render: (_value, project) => (
        <Tooltip title={project.lastRunAt ? fmtTime(project.lastRunAt) : "No review runs"}>
          <span className="pir-muted">{project.lastRunAt ? relTime(project.lastRunAt) : "Never"}</span>
        </Tooltip>
      ),
    },
    {
      title: "",
      key: "open",
      width: 54,
      render: (_value, project) => <Link to={`/projects/${project.projectId}`} onClick={(event) => event.stopPropagation()} aria-label={`Open ${project.name}`}><ArrowRightOutlined /></Link>,
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Workspace"
        title="Projects"
        subtitle="Read-only inventory of repositories with review state."
        actions={<Button icon={<ReloadOutlined />} loading={overview.loading} onClick={overview.reload}>Refresh</Button>}
      />

      <div className="pir-metrics">
        <Card size="small" className="pir-metric-card"><Statistic title="Projects" value={projects.length} /></Card>
        <Card size="small" className="pir-metric-card"><Statistic title="Review runs" value={totals.runs} /></Card>
        <Card size="small" className="pir-metric-card"><Statistic title="Open findings" value={totals.findings} styles={{ content: { color: totals.findings > 0 ? "var(--pir-warning)" : undefined } }} /></Card>
        <Card size="small" className="pir-metric-card"><Statistic title="Active now" value={active.length} prefix={active.length > 0 ? <ThunderboltOutlined /> : undefined} /></Card>
      </div>

      {active.length > 0 && (
        <Card size="small" style={{ marginBottom: 18 }} title={<span><span className="pir-live-dot" /> Active reviews</span>}>
          <Space orientation="vertical" size={6} style={{ width: "100%" }}>
            {active.map((run) => (
              <Button key={run.runId} type="text" style={{ width: "100%", justifyContent: "space-between" }} onClick={() => navigate(`/runs/${run.projectId}/${run.runId}`)}>
                <Space wrap>
                  <Typography.Text strong>{projects.find((project) => project.projectId === run.projectId)?.name ?? run.projectId.slice(0, 12)}</Typography.Text>
                  <Tag>{run.mode}</Tag>
                  <span className="pir-muted">{run.sessions} sessions · started {relTime(run.startedAt)}</span>
                  <span className="pir-mono pir-muted">{shortSha(run.head, 10)}</span>
                </Space>
                <ArrowRightOutlined />
              </Button>
            ))}
          </Space>
        </Card>
      )}

      {overview.loading && !overview.data && <PageLoading label="Loading projects…" />}
      {overview.error && !overview.data && <PageError error={overview.error} status={overview.errorStatus} onRetry={overview.reload} />}
      {overview.data && projects.length === 0 && (
        <Welcome
          icon={<SafetyCertificateOutlined style={{ fontSize: 42, color: "var(--pir-accent)" }} />}
          title="No review runs yet"
          description="Projects appear here after a review writes its state. Start one with the pir CLI, then refresh this page."
          extra={<Button icon={<ReloadOutlined />} loading={overview.loading} onClick={overview.reload}>Refresh</Button>}
        />
      )}

      {projects.length > 0 && (
        <Card size="small" style={{ marginTop: 8 }}>
          <div className="pir-toolbar" style={{ justifyContent: "space-between" }}>
            <Segmented
              value={filter}
              onChange={(value) => setFilter(value as ProjectFilter)}
              options={[
                { label: "All projects", value: "all" },
                { label: "With reviews", value: "reviewed" },
                { label: "Open findings", value: "findings" },
              ]}
            />
            <Input.Search
              allowClear
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search projects"
              style={{ width: 280, maxWidth: "100%" }}
            />
          </div>
          {overview.loading && <PageSkeleton />}
          {!overview.loading && overview.error && <PageError error={overview.error} status={overview.errorStatus} onRetry={overview.reload} />}
          {!overview.loading && !overview.error && (mobile ? (
            <List
              dataSource={filtered}
              pagination={{ pageSize: 20, hideOnSinglePage: true, showSizeChanger: false }}
              locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={projects.length === 0 ? "No projects" : "No matching projects"} /> }}
              renderItem={(project) => {
                const status = activeProjects.has(project.projectId) ? "running" : project.lastRunStatus === "running" ? "interrupted" : project.lastRunStatus ?? "unknown";
                return (
                  <List.Item style={{ paddingInline: 0 }}>
                    <Card size="small" className="pir-clickable" style={{ width: "100%" }} onClick={() => navigate(`/projects/${project.projectId}`)}>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "flex-start" }}>
                        <div style={{ minWidth: 0 }}>
                          <Space size={6} wrap>
                            <FolderOpenOutlined style={{ color: "var(--pir-accent)" }} />
                            <Typography.Text strong ellipsis style={{ maxWidth: 220 }}>{project.name}</Typography.Text>
                          </Space>
                          <div className="pir-muted pir-break" style={{ marginTop: 2, fontSize: 12 }}>{project.remote ?? project.projectId}</div>
                        </div>
                        <Space orientation="vertical" align="end" size={4}>
                          <RunStatusTag status={status} />
                          <ArrowRightOutlined />
                        </Space>
                      </div>
                      <Space size={12} wrap style={{ marginTop: 8, fontSize: 12 }}>
                        <span><strong>{project.runsTotal}</strong> runs</span>
                        <span><strong style={{ color: project.openFindings > 0 ? "var(--pir-warning)" : undefined }}>{project.openFindings}</strong> open findings</span>
                        <span className="pir-muted">{project.lastRunAt ? relTime(project.lastRunAt) : "No reviews"}</span>
                      </Space>
                    </Card>
                  </List.Item>
                );
              }}
            />
          ) : (
            <Table
              rowKey="projectId"
              columns={columns}
              dataSource={filtered}
              size="middle"
              scroll={{ x: 820 }}
              pagination={{ pageSize: 20, hideOnSinglePage: true, showSizeChanger: false }}
              rowClassName="pir-clickable"
              onRow={(project) => ({ onClick: () => navigate(`/projects/${project.projectId}`) })}
              locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={projects.length === 0 ? "No projects" : "No matching projects"} /> }}
            />
          ))}
        </Card>
      )}
    </div>
  );
}