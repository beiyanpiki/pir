import { Alert, Card, Col, Empty, Progress, Row, Space, Statistic, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { FileSearchOutlined } from "@ant-design/icons";
import type { AuditFileCoverageView, AuditUnitView, CoverageView } from "../lib/types";


function unavailable(reason: "not-recorded" | "unavailable") {
  return (
    <Empty
      image={Empty.PRESENTED_IMAGE_SIMPLE}
      description={
        <span>
          {reason === "unavailable" ? "Coverage data could not be read" : "Coverage was not recorded for this run"}
          <div className="pir-muted" style={{ marginTop: 4, fontSize: 12 }}>Older runs may not have persisted a coverage ledger; unknown is not the same as zero.</div>
        </span>
      }
    />
  );
}

export function CoveragePanel({ coverage }: { coverage: CoverageView | null | undefined }) {
  if (!coverage || !coverage.available) return unavailable(coverage?.reason ?? "not-recorded");

  if (coverage.mode === "change") {
    const { summary } = coverage;
    const percent = summary.hunksTotal > 0 ? Math.round((summary.hunksCovered / summary.hunksTotal) * 100) : null;
    const fileColumns: ColumnsType<{ path: string; covered: number; total: number }> = [
      { title: "File", dataIndex: "path", key: "path", render: (value: string) => <Typography.Text code className="pir-break">{value}</Typography.Text> },
      { title: "Hunks read", key: "hunks", width: 160, render: (_value, file) => `${file.covered} / ${file.total}` },
      { title: "Status", key: "status", width: 160, render: (_value, file) => file.total === 0 ? <Tag>No hunks</Tag> : file.covered >= file.total ? <Tag color="success">Read</Tag> : file.covered > 0 ? <Tag color="warning">Partial</Tag> : <Tag>Unread</Tag> },
      { title: "Progress", key: "progress", width: 180, render: (_value, file) => <Progress percent={file.total > 0 ? Math.round((file.covered / file.total) * 100) : 0} size="small" /> },
    ];
    return (
      <Space orientation="vertical" size={16} style={{ width: "100%" }}>
        <Row gutter={[16, 16]}>
          <Col xs={24} md={8}><Card size="small"><Statistic title="Diff hunks read" value={summary.hunksCovered} suffix={`/ ${summary.hunksTotal}`} /></Card></Col>
          <Col xs={24} md={8}><Card size="small"><Statistic title="Files covered" value={summary.filesCovered} suffix={`/ ${summary.filesTotal}`} /></Card></Col>
          <Col xs={24} md={8}><Card size="small"><Statistic title="Coverage" value={percent === null ? "—" : `${percent}%`} /></Card></Col>
        </Row>
        {percent === null ? <Alert type="info" showIcon title="No diff hunks were recorded, so a percentage would be misleading." /> : <Progress percent={percent} />}
        <Card size="small" title="Files in this change">
          {summary.files.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No per-file coverage recorded" /> : <Table rowKey="path" size="small" columns={fileColumns} dataSource={summary.files} pagination={false} scroll={{ x: 640 }} />}
        </Card>
      </Space>
    );
  }

  const { summary, units, files } = coverage;
  const percent = summary.filesInScope > 0 ? Math.round((summary.filesReviewed / summary.filesInScope) * 100) : null;
  const unitColumns: ColumnsType<AuditUnitView> = [
    { title: "Unit", dataIndex: "id", key: "id", render: (value: string, unit) => <div><Typography.Text code>{value}</Typography.Text><div className="pir-muted" style={{ fontSize: 12 }}>{unit.module || "No module"}</div></div> },
    { title: "State", dataIndex: "state", key: "state", width: 130, render: (value: string) => <Tag color={value === "reviewed" ? "success" : value === "blocked" ? "warning" : value === "failed" ? "error" : "default"}>{value}</Tag> },
    { title: "Files", dataIndex: "files", key: "files", width: 90, align: "right" },
    { title: "Attempts", dataIndex: "attempts", key: "attempts", width: 100, align: "right" },
    { title: "Reason", dataIndex: "reason", key: "reason", render: (value: string | undefined) => value ?? <span className="pir-muted">—</span> },
  ];
  const fileColumns: ColumnsType<AuditFileCoverageView> = [
    { title: "File", dataIndex: "path", key: "path", render: (value: string) => <Typography.Text code className="pir-break">{value}</Typography.Text> },
    { title: "State", dataIndex: "state", key: "state", width: 130, render: (value: string) => <Tag color={value === "reviewed" ? "success" : value === "partial" ? "warning" : value === "blocked" || value === "failed" ? "error" : "default"}>{value}</Tag> },
    { title: "Ranges", key: "ranges", width: 130, render: (_value, file) => `${file.rangesReviewed} / ${file.rangesTotal}` },
    { title: "Reason", dataIndex: "reason", key: "reason", render: (value: string | undefined) => value ?? <span className="pir-muted">—</span> },
  ];

  return (
    <Space orientation="vertical" size={16} style={{ width: "100%" }}>
      <Row gutter={[16, 16]}>
        <Col xs={12} md={8} xl={4}><Card size="small"><Statistic title="In scope" value={summary.filesInScope} /></Card></Col>
        <Col xs={12} md={8} xl={4}><Card size="small"><Statistic title="Reviewed" value={summary.filesReviewed} /></Card></Col>
        <Col xs={12} md={8} xl={4}><Card size="small"><Statistic title="Partial" value={summary.filesPartial} /></Card></Col>
        <Col xs={12} md={8} xl={4}><Card size="small"><Statistic title="Unreviewed" value={summary.filesUnreviewed} /></Card></Col>
        <Col xs={12} md={8} xl={4}><Card size="small"><Statistic title="Blocked / failed" value={`${summary.filesBlocked} / ${summary.filesFailed}`} /></Card></Col>
        <Col xs={12} md={8} xl={4}><Card size="small"><Statistic title="Batches" value={`${summary.batchesCompleted} / ${summary.batchesTotal}`} /></Card></Col>
      </Row>
      {percent !== null && <Progress percent={percent} format={(value) => `${value}% files reviewed`} />}
      {summary.filesNotSelected > 0 || summary.filesExcluded > 0 ? (
        <Alert
          type="info"
          showIcon
          title="Scope accounting"
          description={`${summary.filesNotSelected} files were not selected and ${summary.filesExcluded} were excluded; they are outside the ${summary.filesInScope}-file review scope and are not counted as unreviewed.`}
        />
      ) : null}
      <Card size="small" title={`Review units (${units.length})`}>
        {units.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No work units recorded" /> : <Table rowKey="id" size="small" columns={unitColumns} dataSource={units} pagination={{ pageSize: 20, hideOnSinglePage: true }} scroll={{ x: 760 }} />}
      </Card>
      <Card size="small" title={<span><FileSearchOutlined /> File coverage ({files.length})</span>}>
        {files.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No per-file ledger recorded" /> : <Table rowKey="path" size="small" columns={fileColumns} dataSource={files} pagination={{ pageSize: 20, hideOnSinglePage: true }} scroll={{ x: 760 }} />}
      </Card>
    </Space>
  );
}
