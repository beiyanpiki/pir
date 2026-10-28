import { useMemo } from "react";
import { Link, useParams } from "react-router-dom";
import { Button, Card, Col, Empty, Row, Select, Space, Table, Tabs, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { SwapOutlined } from "@ant-design/icons";
import { apiGet } from "../lib/api";
import { fmtTime, shortSha } from "../lib/format";
import { useApi } from "../lib/hooks";
import { useQueryState } from "../lib/query";
import type { RunSummary } from "../lib/types";
import { PageError, PageLoading } from "../components/PageState";
import { PageHeader } from "../components/PageHeader";
import { ProjectNav } from "../components/ProjectNav";
import { FindingStatusTag, RunStatusTag, SeverityTag, VerdictTag } from "../components/StatusTags";

interface Finding {
  displayId: string;
  runId: string;
  title: string;
  severity: string;
  status: string;
  confidence: number | null;
  anchors: unknown[];
}
interface CompareRow {
  fingerprint: string;
  before: Finding | null;
  after: Finding | null;
}
interface Comparison {
  leftRun: RunSummary;
  rightRun: RunSummary;
  added: CompareRow[];
  removed: CompareRow[];
  changed: CompareRow[];
  unchanged: CompareRow[];
}
interface RunsResponse { runs: RunSummary[]; total: number }

function runLabel(run: RunSummary): string {
  const range = run.base ? `${shortSha(run.base, 7)}…${shortSha(run.head, 7)}` : `Snapshot ${shortSha(run.head, 8)}`;
  return `${range} · ${fmtTime(run.startedAt)} · ${run.status}`;
}

export function ComparePage() {
  const { projectId = "" } = useParams();
  const { get, update } = useQueryState();
  const leftRunId = get("leftRunId");
  const rightRunId = get("rightRunId");
  const runs = useApi<RunsResponse>((signal) => apiGet<RunsResponse>(`/api/projects/${projectId}/runs?limit=200`, signal), [projectId]);
  const comparison = useApi<Comparison | null>(
    (signal) => leftRunId && rightRunId
      ? apiGet<Comparison>(`/api/projects/${projectId}/run-compare?${new URLSearchParams({ leftRunId, rightRunId })}`, signal)
      : Promise.resolve(null),
    [projectId, leftRunId, rightRunId],
  );
  const options = useMemo(() => (runs.data?.runs ?? []).map((run) => ({ value: run.runId, label: runLabel(run) })), [runs.data]);

  const columns: ColumnsType<CompareRow> = [
    {
      title: "Finding",
      key: "finding",
      render: (_value, row) => {
        const finding = row.after ?? row.before;
        if (!finding) return <span className="pir-muted">—</span>;
        return (
          <div>
            <Typography.Text strong>{finding.title}</Typography.Text>
            <div className="pir-muted" style={{ fontSize: 12 }}>{finding.displayId} · {finding.severity} · {finding.status}{finding.confidence === null ? "" : ` · ${Math.round(finding.confidence * 100)}% confidence`}</div>
          </div>
        );
      },
    },
    {
      title: "Before",
      key: "before",
      width: 220,
      render: (_value, row) => row.before
        ? <Link to={`/runs/${projectId}/${row.before.runId}?tab=findings&finding=${encodeURIComponent(row.before.displayId)}`}><Space size={4}><SeverityTag severity={row.before.severity} /><FindingStatusTag status={row.before.status} /><span>{row.before.displayId}</span></Space></Link>
        : <Tag>absent</Tag>,
    },
    {
      title: "After",
      key: "after",
      width: 220,
      render: (_value, row) => row.after
        ? <Link to={`/runs/${projectId}/${row.after.runId}?tab=findings&finding=${encodeURIComponent(row.after.displayId)}`}><Space size={4}><SeverityTag severity={row.after.severity} /><FindingStatusTag status={row.after.status} /><span>{row.after.displayId}</span></Space></Link>
        : <Tag>absent</Tag>,
    },
    {
      title: "Fingerprint",
      dataIndex: "fingerprint",
      key: "fingerprint",
      width: 180,
      render: (value: string) => <Typography.Text code>{value.slice(0, 14)}</Typography.Text>,
    },
  ];

  const groups = comparison.data;

  return (
    <div>
      <PageHeader
        breadcrumb={[{ title: "Projects", to: "/projects" }, { title: "Project", to: `/projects/${projectId}` }, { title: "Compare runs" }]}
        title="Compare review runs"
        subtitle="Compare findings by stable fingerprint. Runtime display IDs differ between runs and are never used as the identity."
      />
      <ProjectNav />

      <Card size="small" style={{ marginBottom: 16 }}>
        <Row gutter={[12, 12]} align="middle">
          <Col xs={24} md={10}>
            <div className="pir-sider-label" style={{ padding: 0 }}>Earlier run</div>
            <Select
              showSearch
              style={{ width: "100%" }}
              value={leftRunId || undefined}
              onChange={(value) => update({ leftRunId: value })}
              options={options}
              placeholder="Select a run"
              loading={runs.loading}
              optionFilterProp="label"
            />
          </Col>
          <Col xs={24} md={4} style={{ textAlign: "center" }}>
            <Button icon={<SwapOutlined />} disabled={!leftRunId || !rightRunId} onClick={() => update({ leftRunId: rightRunId, rightRunId: leftRunId })}>Swap</Button>
          </Col>
          <Col xs={24} md={10}>
            <div className="pir-sider-label" style={{ padding: 0 }}>Later run</div>
            <Select
              showSearch
              style={{ width: "100%" }}
              value={rightRunId || undefined}
              onChange={(value) => update({ rightRunId: value })}
              options={options}
              placeholder="Select a run"
              loading={runs.loading}
              optionFilterProp="label"
            />
          </Col>
        </Row>
        {runs.error && <PageError error={runs.error} status={runs.errorStatus} onRetry={runs.reload} />}
      </Card>

      {!leftRunId || !rightRunId ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={`Select two runs to compare${(runs.data?.total ?? 0) < 2 ? " — this project has fewer than two runs" : ""}`} />
      ) : comparison.loading && !comparison.data ? (
        <PageLoading label="Comparing runs…" />
      ) : comparison.error ? (
        <PageError error={comparison.error} status={comparison.errorStatus} onRetry={comparison.reload} />
      ) : groups ? (
        <>
          <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
            {([["Earlier", groups.leftRun], ["Later", groups.rightRun]] as const).map(([label, run]) => (
              <Col xs={24} md={12} key={label}>
                <Card size="small" title={`${label} run · ${shortSha(run.head, 10)}`}>
                  <Space size={6} wrap><RunStatusTag status={run.status} /><VerdictTag verdict={run.runVerdict} /><Tag>{run.mode}</Tag><span className="pir-muted">{fmtTime(run.startedAt)}</span></Space>
                  <div className="pir-muted" style={{ marginTop: 6, fontSize: 12 }}>{run.confirmed} confirmed · {run.rejected} rejected · {run.uncertain} uncertain</div>
                </Card>
              </Col>
            ))}
          </Row>
          <Tabs
            items={[
              { key: "added", label: `Added (${groups.added.length})`, children: <Table rowKey="fingerprint" size="small" columns={columns} dataSource={groups.added} pagination={false} scroll={{ x: 820 }} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No added findings" /> }} /> },
              { key: "removed", label: `Removed (${groups.removed.length})`, children: <Table rowKey="fingerprint" size="small" columns={columns} dataSource={groups.removed} pagination={false} scroll={{ x: 820 }} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No removed findings" /> }} /> },
              { key: "changed", label: `Changed (${groups.changed.length})`, children: <Table rowKey="fingerprint" size="small" columns={columns} dataSource={groups.changed} pagination={false} scroll={{ x: 820 }} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No changed findings" /> }} /> },
              { key: "unchanged", label: `Unchanged (${groups.unchanged.length})`, children: <Table rowKey="fingerprint" size="small" columns={columns} dataSource={groups.unchanged} pagination={false} scroll={{ x: 820 }} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No unchanged findings" /> }} /> },
            ]}
          />
        </>
      ) : null}
    </div>
  );
}
