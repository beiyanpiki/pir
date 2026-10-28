import { Button, Card, Col, Collapse, Descriptions, Empty, Row, Space, Statistic, Table, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { DownloadOutlined, InfoCircleOutlined, LinkOutlined } from "@ant-design/icons";
import { downloadText } from "../lib/api";
import { fmtCost, fmtCount, fmtDuration, fmtTime } from "../lib/format";
import type { CoverageView, RunDetail, RunManifest, RoundInfo } from "../lib/types";
import { CopyButton } from "./CopyButton";
import { ModeTag, RunStatusTag, VerdictTag } from "./StatusTags";

export function RunDetailsPanel({ detail, coverage }: { detail: RunDetail; coverage: CoverageView | null }) {
  const { run, manifest } = detail;
  const permalink = window.location.href;

  const roundColumns: ColumnsType<RoundInfo> = [
    { title: "Round", dataIndex: "round", key: "round", width: 80, render: (value: number) => <Tag>R{value}</Tag> },
    { title: "Candidates", dataIndex: "candidates", key: "candidates", width: 110 },
    { title: "Confirmed", dataIndex: "confirmed", key: "confirmed", width: 110 },
    { title: "Rejected", dataIndex: "rejected", key: "rejected", width: 100 },
    { title: "Uncertain", dataIndex: "uncertain", key: "uncertain", width: 100 },
    { title: "Pending", dataIndex: "pending", key: "pending", width: 90, render: (value: number | undefined) => value ?? "—" },
    { title: "Summary", dataIndex: "summary", key: "summary", render: (value: string) => <span className="pir-break">{value}</span> },
  ];

  const files = manifest?.files ?? [];

  const exportJson = (): void => {
    downloadText(`pir-${run.runId}.json`, JSON.stringify({ schemaVersion: 1, exportedAt: new Date().toISOString(), run, manifest, findings: detail.findings.items, sessions: detail.sessions, coverage }, null, 2), "application/json");
  };

  return (
    <Space orientation="vertical" size={16} style={{ width: "100%" }}>
      <Card
        size="small"
        title={<span><InfoCircleOutlined /> Run record</span>}
        extra={<Space><Tooltip title="Copy this page's URL"><CopyButton size="small" icon={<LinkOutlined />} label="Copy link" text={permalink} /></Tooltip><Button size="small" icon={<DownloadOutlined />} onClick={exportJson}>Export JSON</Button></Space>}
      >
        <Descriptions
          size="small"
          column={{ xs: 1, md: 2, xl: 3 }}
          items={[
            { key: "id", label: "Run ID", children: <Space><Typography.Text code>{run.runId}</Typography.Text><CopyButton size="small" type="text" label="" text={run.runId} /></Space> },
            { key: "status", label: "Execution", children: <RunStatusTag status={run.status} /> },
            { key: "mode", label: "Mode", children: <ModeTag mode={run.mode} /> },
            { key: "verdict", label: "Verdict", children: <VerdictTag verdict={run.runVerdict ?? manifest?.runVerdict} /> },
            { key: "base", label: "Base", children: <Typography.Text code className="pir-break">{run.base ?? "snapshot"}</Typography.Text> },
            { key: "head", label: "Head", children: <Typography.Text code className="pir-break">{run.head}</Typography.Text> },
            { key: "started", label: "Started", children: fmtTime(run.startedAt) },
            { key: "finished", label: "Finished", children: run.finishedAt ? fmtTime(run.finishedAt) : "—" },
            { key: "duration", label: "Duration", children: fmtDuration(run.durationMs) },
            { key: "updated", label: "Last update", children: run.lastUpdatedAt ? fmtTime(run.lastUpdatedAt) : "Unknown" },
            { key: "stopped", label: "Stop reason", children: run.stoppedBecause ?? manifest?.stoppedBecause ?? "Not recorded" },
            { key: "incomplete", label: "Completeness", children: run.incomplete ? <Tag color="warning">Incomplete</Tag> : <Tag color="success">Complete</Tag> },
            { key: "model", label: "Reviewer model", children: run.model ?? manifest?.model ?? "pi default" },
            { key: "verifier", label: "Verifier model", children: run.verifierModel ?? manifest?.verifierModel ?? "same as reviewer" },
            { key: "cap", label: "Findings cap", children: manifest?.maxFindings ?? "—" },
            { key: "transcripts", label: "Transcripts", children: run.transcriptsAvailable ? "Captured" : <Tag color="warning">Not captured</Tag> },
            { key: "notes", label: "Notes", children: run.notes ?? "—" },
            { key: "plugins", label: "Plugins", children: manifest?.plugins.length ? manifest.plugins.map((plugin) => <Tag key={plugin.name}>{plugin.name}{plugin.version ? ` ${plugin.version}` : ""}</Tag>) : "None recorded" },
          ]}
        />
      </Card>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Card size="small" title="Usage">
            {manifest?.usage ? (
              <Row gutter={[16, 12]}>
                <Col span={8}><Statistic title="Input" value={fmtCount(manifest.usage.inputTokens)} /></Col>
                <Col span={8}><Statistic title="Output" value={fmtCount(manifest.usage.outputTokens)} /></Col>
                <Col span={8}><Statistic title="Cache read" value={fmtCount(manifest.usage.cacheReadTokens)} /></Col>
                <Col span={8}><Statistic title="Cache write" value={fmtCount(manifest.usage.cacheWriteTokens)} /></Col>
                <Col span={8}><Statistic title="Tool calls" value={fmtCount(manifest.usage.toolCalls)} /></Col>
                <Col span={8}><Statistic title="Cost" value={fmtCost(manifest.usage.cost)} /></Col>
              </Row>
            ) : (
              <Space orientation="vertical" size={8}>
                <Typography.Text type="secondary">Per-session usage was not persisted for this run.</Typography.Text>
                <Space size={20}><Statistic title="Total tokens" value={run.totalTokens ?? "—"} /><Statistic title="Cost" value={run.cost === null ? "—" : fmtCost(run.cost)} /></Space>
              </Space>
            )}
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card size="small" title="Changed files">
            {files.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No persisted file summary" /> : (
              <Table
                rowKey="path"
                size="small"
                pagination={false}
                dataSource={files}
                scroll={{ x: 420, y: 240 }}
                columns={[
                  { title: "File", dataIndex: "path", key: "path", render: (value: string) => <Typography.Text code className="pir-break">{value}</Typography.Text> },
                  { title: "Status", dataIndex: "status", key: "status", width: 100, render: (value: string) => <Tag>{value}</Tag> },
                  { title: "+", dataIndex: "additions", key: "additions", width: 70, align: "right", render: (value: number) => <span style={{ color: "var(--pir-success)" }}>+{value}</span> },
                  { title: "−", dataIndex: "deletions", key: "deletions", width: 70, align: "right", render: (value: number) => <span style={{ color: "var(--pir-danger)" }}>−{value}</span> },
                ]}
              />
            )}
          </Card>
        </Col>
      </Row>

      <Card size="small" title="Rounds">
        {(manifest?.rounds.length ?? 0) === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No rounds recorded" /> : <Table rowKey="round" size="small" pagination={false} columns={roundColumns} dataSource={manifest?.rounds ?? []} scroll={{ x: 820 }} />}
      </Card>

      <Collapse
        size="small"
        items={[{
          key: "manifest",
          label: "Recorded manifest (raw JSON)",
          children: <pre className="pir-code-block">{JSON.stringify(manifest, null, 2)}</pre>,
        }]}
      />
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        Review sessions run without extensions, skills, hooks, or write tools. Captured transcripts include model turns, reasoning blocks, and tool calls.
      </Typography.Text>
    </Space>
  );
}

// Referenced by tests/type tooling that keeps the manifest contract visible.
export type { RunManifest };
