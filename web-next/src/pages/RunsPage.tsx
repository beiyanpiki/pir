import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  Button,
  Card,
  Empty,
  Grid,
  Input,
  List,
  Pagination,
  Result,
  Segmented,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { ArrowRightOutlined, ReloadOutlined } from "@ant-design/icons";
import { apiGet } from "../lib/api";
import { fmtCost, fmtCount, fmtDuration, fmtTime, relTime, shortSha } from "../lib/format";
import { useApi, useDebouncedValue } from "../lib/hooks";
import { normalizeOffset, useQueryState } from "../lib/query";
import type { ActiveRunView, ProjectSummary, RunSummary } from "../lib/types";
import { ModeTag, RunStatusTag, VerdictTag } from "../components/StatusTags";
import { PageError, PageLoading } from "../components/PageState";
import { PageHeader } from "../components/PageHeader";
import { ProjectNav } from "../components/ProjectNav";

interface RunsResponse { runs: RunSummary[]; total: number }
interface Overview { projects: ProjectSummary[]; active: ActiveRunView[] }

const PAGE_SIZE = 50;
const STATUSES = ["all", "completed", "running", "incomplete", "failed"];
const MODES = ["all", "audit", "change"];

export function RunsPage() {
  const { projectId = "" } = useParams();
  const navigate = useNavigate();
  const screens = Grid.useBreakpoint();
  const mobile = screens.md === false;
  const { get, update } = useQueryState();
  const rawOffset = get("offset");
  const offset = normalizeOffset(rawOffset, PAGE_SIZE);
  const status = STATUSES.includes(get("status")) ? get("status") : "all";
  const mode = MODES.includes(get("mode")) ? get("mode") : "all";
  const query = get("q");
  const [draft, setDraft] = useState(query);
  const lastPushed = useRef(query);
  const debounced = useDebouncedValue(draft, 250);

  const runs = useApi<RunsResponse>(
    (signal) => {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
      if (status !== "all") params.set("status", status);
      if (mode !== "all") params.set("mode", mode);
      if (query) params.set("q", query);
      return apiGet<RunsResponse>(`/api/projects/${projectId}/runs?${params}`, signal);
    },
    [projectId, offset, status, mode, query],
    { identity: [projectId] },
  );
  const overview = useApi<Overview>((signal) => apiGet<Overview>("/api/overview", signal), [projectId]);
  const project = overview.data?.projects.find((candidate) => candidate.projectId === projectId);
  const activeIds = useMemo(
    () => new Set((overview.data?.active ?? []).filter((run) => run.projectId === projectId).map((run) => run.runId)),
    [overview.data, projectId],
  );

  // A new project starts from its own view, never the previous project's page
  // or filters; the URL is the single source of truth.
  useEffect(() => {
    setDraft(query);
    lastPushed.current = query;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => {
    // Back/forward (or a project link carrying a query) replaces the URL
    // without a keystroke; reflect it in the input.
    if (query !== lastPushed.current) {
      lastPushed.current = query;
      setDraft(query);
    }
  }, [query]);

  useEffect(() => {
    if (debounced === lastPushed.current) return;
    lastPushed.current = debounced;
    update({ q: debounced || null, offset: null }, true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  const total = runs.data?.total ?? 0;
  useEffect(() => {
    if (runs.stale || !runs.data) return;
    if (offset > 0 && offset >= total) update({ offset: total > 0 ? Math.floor((total - 1) / PAGE_SIZE) * PAGE_SIZE : null }, true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runs.data, runs.stale, total, offset]);

  const setStatus = (value: string): void => update({ status: value === "all" ? null : value, offset: null });
  const setMode = (value: string): void => update({ mode: value === "all" ? null : value, offset: null });
  const refresh = (): void => { runs.reload(); overview.reload(); };

  const columns: ColumnsType<RunSummary> = [
    {
      title: "Review",
      key: "review",
      render: (_value, run) => (
        <div>
          <Link to={`/runs/${projectId}/${run.runId}`} onClick={(event) => event.stopPropagation()}>
            <Typography.Text strong className="pir-mono">
              {run.base ? `${shortSha(run.base, 7)}…${shortSha(run.head, 7)}` : `Snapshot ${shortSha(run.head, 8)}`}
            </Typography.Text>
          </Link>
          <Space size={6} wrap style={{ marginTop: 4 }}>
            <ModeTag mode={run.mode} />
            <span className="pir-muted" style={{ fontSize: 12 }}>{run.model ?? "pi default"}</span>
          </Space>
        </div>
      ),
    },
    {
      title: "Execution",
      key: "status",
      width: 150,
      render: (_value, run) => {
        const display = activeIds.has(run.runId) && run.finishedAt === null ? "running" : run.status;
        return <RunStatusTag status={display} />;
      },
    },
    {
      title: "Verdict",
      key: "verdict",
      width: 170,
      render: (_value, run) => <Space orientation="vertical" size={2}><VerdictTag verdict={run.runVerdict} />{run.incomplete && <Tag color="warning">Incomplete</Tag>}</Space>,
    },
    {
      title: "Findings",
      key: "findings",
      width: 160,
      render: (_value, run) => (
        <Space orientation="vertical" size={0}>
          <span><Typography.Text strong style={{ color: run.confirmed > 0 ? "var(--pir-danger)" : undefined }}>{run.confirmed}</Typography.Text> confirmed</span>
          <span className="pir-muted" style={{ fontSize: 12 }}>{run.rejected} rejected · {run.uncertain} uncertain</span>
        </Space>
      ),
    },
    {
      title: "Started",
      key: "started",
      width: 150,
      render: (_value, run) => (
        <Tooltip title={fmtTime(run.startedAt)}>
          <div>{relTime(run.startedAt)}</div>
          <div className="pir-muted" style={{ fontSize: 12 }}>{fmtTime(run.startedAt)}</div>
        </Tooltip>
      ),
    },
    {
      title: "Duration",
      key: "duration",
      width: 110,
      align: "right",
      render: (_value, run) => fmtDuration(run.durationMs),
    },
    {
      title: "Usage",
      key: "usage",
      width: 130,
      align: "right",
      render: (_value, run) => (
        <div>
          <div>{run.totalTokens === null ? "—" : `${fmtCount(run.totalTokens)} tok`}</div>
          <div className="pir-muted" style={{ fontSize: 12 }}>{fmtCost(run.cost)}</div>
        </div>
      ),
    },
    {
      title: "",
      key: "open",
      width: 44,
      render: (_value, run) => <Link to={`/runs/${projectId}/${run.runId}`} onClick={(event) => event.stopPropagation()} aria-label={`Open run ${run.runId}`}><ArrowRightOutlined /></Link>,
    },
  ];

  if (overview.error && !overview.data) return <PageError error={overview.error} status={overview.errorStatus} onRetry={refresh} />;
  if (!overview.loading && overview.data && !project) {
    return <Result status="404" title="Project not found" subTitle="This project is no longer available in the workspace." extra={<Link to="/projects">Back to projects</Link>} />;
  }

  return (
    <div>
      <PageHeader
        breadcrumb={[{ title: "Projects", to: "/projects" }, { title: project?.name ?? projectId.slice(0, 12) }]}
        title={project?.name ?? "Project"}
        subtitle={<span className="pir-break">{project?.remote ?? projectId}</span>}
        actions={<Button icon={<ReloadOutlined />} loading={runs.loading} onClick={refresh} aria-label="Refresh runs">Refresh</Button>}
      />
      <ProjectNav />

      <div className="pir-metrics">
        <Card size="small" className="pir-metric-card"><Statistic title="Runs" value={project?.runsTotal ?? total} /></Card>
        <Card size="small" className="pir-metric-card"><Statistic title="Open findings" value={project?.openFindings ?? 0} styles={{ content: { color: (project?.openFindings ?? 0) > 0 ? "var(--pir-warning)" : undefined } }} /></Card>
        <Card size="small" className="pir-metric-card"><Statistic title="Last review" value={project?.lastRunAt ? relTime(project.lastRunAt) : "Never"} styles={{ content: { fontSize: 18 } }} /></Card>
        <Card size="small" className="pir-metric-card"><Statistic title="Project ID" value={projectId.slice(0, 12)} styles={{ content: { fontSize: 16, fontFamily: "ui-monospace, monospace" } }} /></Card>
      </div>

      <Card size="small">
        <div className="pir-toolbar" style={{ justifyContent: "space-between" }}>
          <Space wrap>
            {mobile ? (
              <Select
                value={status}
                onChange={setStatus}
                style={{ width: 150 }}
                options={STATUSES.map((value) => ({ value, label: value === "all" ? "All runs" : value[0]!.toUpperCase() + value.slice(1) }))}
              />
            ) : (
              <Segmented value={status} onChange={(value) => setStatus(String(value))} options={STATUSES.map((value) => ({ label: value === "all" ? "All runs" : value[0]!.toUpperCase() + value.slice(1), value }))} />
            )}
            <Select
              value={mode}
              onChange={setMode}
              style={{ width: 130 }}
              options={MODES.map((value) => ({ value, label: value === "all" ? "All modes" : value[0]!.toUpperCase() + value.slice(1) }))}
            />
          </Space>
          <Input.Search
            allowClear
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Search this project's runs"
            style={{ width: 300, maxWidth: "100%" }}
          />
        </div>
        {runs.loading && !runs.data && <PageLoading label="Loading runs…" />}
        {runs.error && !runs.data && <PageError error={runs.error} status={runs.errorStatus} onRetry={refresh} />}
        {runs.data && (mobile ? (
          <>
          <List
            loading={runs.loading}
            dataSource={runs.data.runs}
            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={query ? "No runs match this search" : "No runs match these filters"} /> }}
            renderItem={(run) => {
              const display = activeIds.has(run.runId) && run.finishedAt === null ? "running" : run.status;
              return (
                <List.Item style={{ paddingInline: 0 }}>
                  <Card size="small" className="pir-clickable" style={{ width: "100%" }} onClick={() => navigate(`/runs/${projectId}/${run.runId}`)}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                      <Typography.Text strong className="pir-mono">{run.base ? `${shortSha(run.base, 7)}…${shortSha(run.head, 7)}` : `Snapshot ${shortSha(run.head, 8)}`}</Typography.Text>
                      <RunStatusTag status={display} />
                    </div>
                    <Space size={6} wrap style={{ marginTop: 6 }}><ModeTag mode={run.mode} /><VerdictTag verdict={run.runVerdict} /><span className="pir-muted" style={{ fontSize: 12 }}>{run.model ?? "pi default"}</span></Space>
                    <Space size={12} wrap style={{ marginTop: 8, fontSize: 12 }}>
                      <span><strong style={{ color: run.confirmed > 0 ? "var(--pir-danger)" : undefined }}>{run.confirmed}</strong> confirmed</span>
                      <span className="pir-muted">{run.rejected} rejected · {run.uncertain} uncertain</span>
                      <span className="pir-muted">{relTime(run.startedAt)} · {fmtDuration(run.durationMs)}</span>
                    </Space>
                  </Card>
                </List.Item>
              );
            }}
          />
          {total > PAGE_SIZE && (
            <Pagination
              style={{ marginTop: 12, textAlign: "center" }}
              current={Math.floor(offset / PAGE_SIZE) + 1}
              pageSize={PAGE_SIZE}
              total={total}
              showSizeChanger={false}
              onChange={(page) => update({ offset: page <= 1 ? null : (page - 1) * PAGE_SIZE })}
            />
          )}
          </>
        ) : (
          <Table
            rowKey="runId"
            columns={columns}
            dataSource={runs.data.runs}
            size="middle"
            loading={runs.loading}
            scroll={{ x: 1040 }}
            rowClassName="pir-clickable"
            onRow={(run) => ({ onClick: () => navigate(`/runs/${projectId}/${run.runId}`) })}
            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={query ? "No runs match this search" : "No runs match these filters"} /> }}
            pagination={{
              current: Math.floor(offset / PAGE_SIZE) + 1,
              pageSize: PAGE_SIZE,
              total,
              showSizeChanger: false,
              hideOnSinglePage: total <= PAGE_SIZE,
              onChange: (page) => update({ offset: page <= 1 ? null : (page - 1) * PAGE_SIZE }),
            }}
          />
        ))}
        {runs.stale && <div className="pir-muted" style={{ fontSize: 12, marginTop: 6 }}>Updating…</div>}
      </Card>
    </div>
  );
}