import { useEffect, useMemo } from "react";
import { Link, useParams } from "react-router-dom";
import { Button, Card, Empty, Input, Result, Select, Space, Statistic, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { ArrowRightOutlined, ReloadOutlined } from "@ant-design/icons";
import { apiGet } from "../lib/api";
import { fmtTime } from "../lib/format";
import { useApi } from "../lib/hooks";
import { normalizeOffset, useQueryState } from "../lib/query";
import type { ActiveRunView, FeedbackEventView, FindingSummary, ProjectSummary } from "../lib/types";
import { PageError, PageLoading } from "../components/PageState";
import { PageHeader } from "../components/PageHeader";
import { ProjectNav } from "../components/ProjectNav";
import { FindingStatusTag, SeverityTag } from "../components/StatusTags";

type MemoryRow = {
  id: string; kind: string; claim?: string; decision?: string; rationale?: string; scope?: string;
  featureKey?: string; entityKey?: string; validUntilCommit?: string; stale: boolean;
  relatedFinding?: { runId: string; displayId: string } | null;
  [key: string]: unknown;
};
type ProjectFinding = FindingSummary & { runId: string; fingerprint: string; updatedAt: number };
type KnowledgeResponse = { findings?: ProjectFinding[]; items?: MemoryRow[]; events?: FeedbackEventView[]; total: number };
interface Overview { projects: ProjectSummary[]; active: ActiveRunView[] }

const LIMIT = 50;

export function ProjectKnowledgePage({ kind }: { kind: "findings" | "memory" | "feedback" }) {
  const { projectId = "" } = useParams();
  const { get, update } = useQueryState();
  const offset = normalizeOffset(get("offset"), LIMIT);
  const status = get("status");
  const severity = get("severity");
  const runId = get("runId");
  const draft = get("q");
  const overview = useApi<Overview>((signal) => apiGet<Overview>("/api/overview", signal), [projectId]);
  const project = overview.data?.projects.find((candidate) => candidate.projectId === projectId);
  const payload = useMemo(() => {
    const params = new URLSearchParams({ limit: String(LIMIT), offset: String(offset) });
    if (draft) params.set("q", draft);
    if (kind === "findings") {
      if (status) params.set("status", status);
      if (severity) params.set("severity", severity);
      if (runId) params.set("runId", runId);
    }
    return params.toString();
  }, [draft, kind, offset, runId, severity, status]);
  const data = useApi<KnowledgeResponse>((signal) => apiGet<KnowledgeResponse>(`/api/projects/${projectId}/${kind}?${payload}`, signal), [projectId, kind, payload]);
  const recentFeedback = useApi<KnowledgeResponse>(
    (signal) => kind === "memory" ? apiGet<KnowledgeResponse>(`/api/projects/${projectId}/feedback?limit=5`, signal) : Promise.resolve({ total: 0 }),
    [projectId, kind],
  );
  const total = data.data?.total ?? 0;

  useEffect(() => {
    if (data.data && offset > 0 && offset >= total) {
      update({ offset: total > 0 ? Math.floor((total - 1) / LIMIT) * LIMIT : null }, true);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.data, total, offset]);

  const reset = (): void => update({ q: null, status: null, severity: null, runId: null, offset: null });

  const findingColumns: ColumnsType<ProjectFinding> = [
    {
      title: "Finding",
      key: "finding",
      render: (_value, finding) => (
        <div>
          <Link to={`/runs/${projectId}/${finding.runId}?tab=findings&finding=${encodeURIComponent(finding.displayId)}`}>
            <Typography.Text strong>{finding.displayId} · {finding.title}</Typography.Text>
          </Link>
          <div className="pir-muted" style={{ fontSize: 12 }}>Run {finding.runId.slice(0, 10)} · updated {fmtTime(finding.updatedAt)}</div>
        </div>
      ),
    },
    { title: "Severity", dataIndex: "severity", key: "severity", width: 90, render: (value: string) => <SeverityTag severity={value} /> },
    { title: "Status", dataIndex: "status", key: "status", width: 110, render: (value: string) => <FindingStatusTag status={value} /> },
    { title: "Confidence", dataIndex: "confidence", key: "confidence", width: 110, render: (value: number | null) => value === null ? <span className="pir-muted">unknown</span> : `${Math.round(value * 100)}%` },
    { title: "Evidence", dataIndex: "evidenceCount", key: "evidence", width: 90, align: "right" },
    { title: "", key: "open", width: 44, render: (_value, finding) => <Link to={`/runs/${projectId}/${finding.runId}?tab=findings&finding=${encodeURIComponent(finding.displayId)}`}><ArrowRightOutlined /></Link> },
  ];

  const memoryColumns: ColumnsType<MemoryRow> = [
    {
      title: "Memory",
      key: "memory",
      render: (_value, memory) => (
        <div>
          <Typography.Text strong>{memory.claim ?? `${memory.kind}: ${memory.id}`}</Typography.Text>
          <div className="pir-muted" style={{ fontSize: 12 }}>{memory.decision ?? memory.kind} · scope {memory.scope ?? "unknown"} · {memory.stale ? <Tag color="warning">stale</Tag> : <Tag color="success">current</Tag>}</div>
          {memory.rationale && <Typography.Paragraph type="secondary" style={{ marginTop: 4, marginBottom: 0 }}>{memory.rationale}</Typography.Paragraph>}
        </div>
      ),
    },
    { title: "Feature / entity", key: "keys", width: 220, render: (_value, memory) => <span className="pir-mono pir-muted">{memory.featureKey ?? "—"} / {memory.entityKey ?? "—"}</span> },
    { title: "Valid until", dataIndex: "validUntilCommit", key: "valid", width: 140, render: (value: string | undefined) => value ? <Typography.Text code>{value.slice(0, 10)}</Typography.Text> : <span className="pir-muted">—</span> },
    { title: "Related finding", key: "related", width: 150, render: (_value, memory) => memory.relatedFinding ? <Link to={`/runs/${projectId}/${memory.relatedFinding.runId}?tab=findings&finding=${encodeURIComponent(memory.relatedFinding.displayId)}`}>{memory.relatedFinding.displayId}</Link> : <span className="pir-muted">—</span> },
  ];

  const feedbackColumns: ColumnsType<FeedbackEventView> = [
    { title: "Action", key: "action", width: 190, render: (_value, event) => <Space orientation="vertical" size={0}><Typography.Text strong>{event.action}</Typography.Text><span className="pir-muted" style={{ fontSize: 12 }}>{event.decision ?? "No decision"}</span></Space> },
    { title: "Note", dataIndex: "note", key: "note", render: (value: string | null) => value ?? <span className="pir-muted">—</span> },
    { title: "Finding", dataIndex: "findingId", key: "finding", width: 130, render: (value: string | null) => value ? <Typography.Text code>{value}</Typography.Text> : "project" },
    { title: "Scope", dataIndex: "scope", key: "scope", width: 130, render: (value: string | null) => value ?? "—" },
    { title: "Recorded", dataIndex: "ts", key: "ts", width: 170, render: (value: number) => fmtTime(value) },
  ];

  if (overview.error && !overview.data) return <PageError error={overview.error} status={overview.errorStatus} onRetry={overview.reload} />;
  if (!overview.loading && overview.data && !project) {
    return <Result status="404" title="Project not found" subTitle="This project is no longer available." extra={<Link to="/projects">Back to projects</Link>} />;
  }

  const title = kind === "findings" ? "Project findings" : kind === "memory" ? "Project memory" : "Feedback history";
  const subtitle = kind === "findings"
    ? "Project-scoped findings across review runs, with their verification state."
    : kind === "memory"
      ? "Decisions and confirmations retained for future reviews."
      : "Feedback and memory verdicts recorded for this project.";

  return (
    <div>
      <PageHeader
        breadcrumb={[{ title: "Projects", to: "/projects" }, { title: project?.name ?? projectId.slice(0, 12), to: `/projects/${projectId}` }, { title }]}
        title={title}
        subtitle={subtitle}
        actions={<Button icon={<ReloadOutlined />} loading={data.loading} onClick={data.reload}>Refresh</Button>}
      />
      <ProjectNav />

      <div className="pir-metrics">
        <Card size="small" className="pir-metric-card"><Statistic title="Matching records" value={total} /></Card>
        <Card size="small" className="pir-metric-card"><Statistic title="Project runs" value={project?.runsTotal ?? 0} /></Card>
        <Card size="small" className="pir-metric-card"><Statistic title="Open findings" value={project?.openFindings ?? 0} styles={{ content: { color: (project?.openFindings ?? 0) > 0 ? "var(--pir-warning)" : undefined } }} /></Card>
        <Card size="small" className="pir-metric-card"><Statistic title="Last review" value={project?.lastRunAt ? fmtTime(project.lastRunAt) : "Never"} styles={{ content: { fontSize: 16 } }} /></Card>
      </div>

      <Card size="small">
        <div className="pir-toolbar" style={{ justifyContent: "space-between" }}>
          <Space wrap>
            <Input.Search
              allowClear
              defaultValue={draft}
              onSearch={(value) => update({ q: value || null, offset: null })}
              placeholder={`Search project ${kind}`}
              style={{ width: 280, maxWidth: "100%" }}
            />
            {kind === "findings" && (
              <>
                <Select
                  value={status || "all"}
                  onChange={(value) => update({ status: value === "all" ? null : value, offset: null })}
                  style={{ width: 150 }}
                  options={[{ value: "all", label: "All statuses" }, ...["confirmed", "uncertain", "candidate", "rejected", "expected", "suppressed"].map((value) => ({ value, label: value[0]!.toUpperCase() + value.slice(1) }))]}
                />
                <Select
                  value={severity || "all"}
                  onChange={(value) => update({ severity: value === "all" ? null : value, offset: null })}
                  style={{ width: 140 }}
                  options={[{ value: "all", label: "All severities" }, ...["P0", "P1", "P2", "P3"].map((value) => ({ value, label: value }))]}
                />
                <Input
                  defaultValue={runId}
                  onBlur={(event) => { const value = event.target.value.trim(); if (value !== runId) update({ runId: value || null, offset: null }); }}
                  placeholder="Run ID filter"
                  style={{ width: 220, maxWidth: "100%" }}
                />
                <Button type="link" onClick={reset}>Clear filters</Button>
              </>
            )}
          </Space>
          <span className="pir-muted">{data.loading ? "Updating…" : `${total} matching`}</span>
        </div>

        {data.loading && !data.data && <PageLoading label={`Loading ${kind}…`} />}
        {data.error && !data.data && <PageError error={data.error} status={data.errorStatus} onRetry={data.reload} />}
        {data.data && (
          kind === "findings" ? (
            <Table rowKey="id" size="middle" columns={findingColumns} dataSource={data.data.findings ?? []} loading={data.loading} scroll={{ x: 900 }} pagination={{ current: Math.floor(offset / LIMIT) + 1, pageSize: LIMIT, total, showSizeChanger: false, onChange: (page) => update({ offset: page <= 1 ? null : (page - 1) * LIMIT }) }} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No matching findings" /> }} />
          ) : kind === "memory" ? (
            <Table rowKey={(row) => `${row.kind}/${row.id}`} size="middle" columns={memoryColumns} dataSource={data.data.items ?? []} loading={data.loading} scroll={{ x: 900 }} pagination={{ current: Math.floor(offset / LIMIT) + 1, pageSize: LIMIT, total, showSizeChanger: false, onChange: (page) => update({ offset: page <= 1 ? null : (page - 1) * LIMIT }) }} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No memory records" /> }} />
          ) : (
            <Table rowKey="id" size="middle" columns={feedbackColumns} dataSource={data.data.events ?? []} loading={data.loading} scroll={{ x: 820 }} pagination={{ current: Math.floor(offset / LIMIT) + 1, pageSize: LIMIT, total, showSizeChanger: false, onChange: (page) => update({ offset: page <= 1 ? null : (page - 1) * LIMIT }) }} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No feedback recorded" /> }} />
          )
        )}
        {kind === "memory" && (
          <div className="pir-section">
            <h2 className="pir-section-title">Recent feedback</h2>
            <Space orientation="vertical" size={4} style={{ marginTop: 8 }}>
              {(recentFeedback.data?.events ?? []).map((event) => <span key={event.id}><Tag>{event.action}</Tag>{event.note ?? event.decision ?? "No note"} <span className="pir-muted">· {fmtTime(event.ts)}</span></span>)}
              {(recentFeedback.data?.events ?? []).length === 0 && <span className="pir-muted">No feedback recorded. The CLI owns memory writes.</span>}
            </Space>
          </div>
        )}
      </Card>
    </div>
  );
}
