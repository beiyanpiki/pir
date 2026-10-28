import { Button, Card, Col, Descriptions, Empty, Progress, Row, Space, Statistic, Tag, Timeline, Typography } from "antd";
import { Prompts } from "@ant-design/x";
import { ArrowRightOutlined, BulbOutlined, ClockCircleOutlined, FieldTimeOutlined, SafetyCertificateOutlined } from "@ant-design/icons";
import { SEVERITY_ORDER, fmtCost, fmtCount, fmtDuration, fmtTime, relTime } from "../lib/format";
import type { CoverageView, RunDetail, RunEvent } from "../lib/types";
import { FindingStatusTag, ModeTag, SeverityTag, VerdictTag } from "./StatusTags";

function coveragePercent(coverage: CoverageView | null | undefined): number | null {
  if (!coverage?.available) return null;
  if (coverage.mode === "change") {
    return coverage.summary.hunksTotal > 0 ? Math.round((coverage.summary.hunksCovered / coverage.summary.hunksTotal) * 100) : null;
  }
  return coverage.summary.filesInScope > 0 ? Math.round((coverage.summary.filesReviewed / coverage.summary.filesInScope) * 100) : null;
}

export function RunOverview({
  detail,
  coverage,
  events,
  execution,
  connection,
  pendingCount,
  onOpenTab,
  onOpenFinding,
}: {
  detail: RunDetail;
  coverage: CoverageView | null;
  events: RunEvent[] | null;
  execution: string;
  connection: string;
  pendingCount?: number | null;
  onOpenTab: (tab: "findings" | "workflow" | "coverage") => void;
  onOpenFinding: (displayId: string) => void;
}) {
  const { run, manifest } = detail;
  const reported = detail.findings.items.filter((finding) => finding.status === "confirmed" || finding.status === "uncertain")
    .sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9) || a.createdAt - b.createdAt);
  const progress = (events ?? []).filter((event) => event.kind === "progress").slice(-8).reverse();
  const roundActivity = [...(manifest?.rounds ?? [])].reverse().slice(0, 6);
  const pending = pendingCount ?? manifest?.rounds?.at(-1)?.pending;
  const percent = coveragePercent(coverage);
  const verdict = run.runVerdict ?? manifest?.runVerdict ?? "unknown";
  const running = execution === "running";

  return (
    <>
      <Prompts
        title="Jump to"
        wrap
        style={{ marginBottom: 16 }}
        items={[
          { key: "findings", label: "Findings", description: `${reported.length} confirmed or uncertain` },
          { key: "workflow", label: "Workflow", description: "Trace rounds, sessions, and tools" },
          { key: "coverage", label: "Coverage", description: percent === null ? "Not recorded" : `${percent}% of scope read` },
        ]}
        onItemClick={({ data }) => onOpenTab(data.key as "findings" | "workflow" | "coverage")}
      />
      <Row gutter={[16, 16]}>
      <Col xs={24} xl={14}>
        <Card
          size="small"
          title={<span><SafetyCertificateOutlined /> Outcome</span>}
          extra={running ? <Tag color="processing">Verdict pending</Tag> : <VerdictTag verdict={verdict} />}
        >
          <Space size={24} wrap>
            <Statistic title="Confirmed" value={run.confirmed} styles={{ content: { color: run.confirmed > 0 ? "var(--pir-danger)" : undefined } }} />
            <Statistic title="Uncertain" value={run.uncertain} styles={{ content: { color: run.uncertain > 0 ? "var(--pir-warning)" : undefined } }} />
            <Statistic title="Pending" value={pending ?? "—"} />
            <Statistic title="Rejected" value={run.rejected} styles={{ content: { color: "var(--pir-text-muted)" } }} />
            <Statistic title="Rounds" value={run.rounds} />
          </Space>
          <Typography.Paragraph style={{ marginTop: 16, marginBottom: 6 }}>
            {running
              ? <><Tag color="processing">Review in progress</Tag><span className="pir-muted">Stop reason: pending</span></>
              : <><Tag color={run.incomplete ? "warning" : "success"}>{run.incomplete ? "Incomplete review" : "Execution finished"}</Tag><span className="pir-muted">Stop reason: {run.stoppedBecause ?? manifest?.stoppedBecause ?? "not recorded"}</span></>}
          </Typography.Paragraph>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Execution completion only means the review stopped; it does not establish that the code is free of defects.
          </Typography.Text>
          <div style={{ marginTop: 12 }}>
            <Button size="small" onClick={() => onOpenTab("findings")} icon={<ArrowRightOutlined />}>Review findings</Button>
          </div>
        </Card>

        <Card size="small" title="Reported findings" style={{ marginTop: 16 }} extra={<Button size="small" type="link" onClick={() => onOpenTab("findings")}>All findings</Button>}>
          {reported.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={<span>No confirmed or uncertain findings</span>} />
          ) : (
            <Space orientation="vertical" size={6} style={{ width: "100%" }}>
              {reported.slice(0, 6).map((finding) => (
                <div
                  key={finding.id}
                  className="pir-finding-row"
                  role="button"
                  tabIndex={0}
                  onClick={() => onOpenFinding(finding.displayId)}
                  onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpenFinding(finding.displayId); } }}
                >
                  <div className="pir-finding-title">{finding.title}</div>
                  <div className="pir-finding-meta">
                    <Space size={4} wrap>
                      <SeverityTag severity={finding.severity} />
                      <FindingStatusTag status={finding.status} />
                      <span>{finding.displayId}</span>
                      <span>round {finding.round}</span>
                      <span>{finding.evidenceCount} evidence</span>
                      <span>{finding.confidence === null ? "confidence unknown" : `${Math.round(finding.confidence * 100)}% confidence`}</span>
                    </Space>
                  </div>
                </div>
              ))}
            </Space>
          )}
        </Card>
      </Col>

      <Col xs={24} xl={10}>
        <Card size="small" title="Scope and timing">
          <Descriptions column={1} size="small" items={[
            { key: "mode", label: "Mode", children: <ModeTag mode={run.mode} /> },
            { key: "base", label: "Base", children: <Typography.Text code>{run.base ?? "Snapshot audit"}</Typography.Text> },
            { key: "head", label: "Head", children: <Typography.Text code>{run.head}</Typography.Text> },
            { key: "started", label: "Started", children: <span title={fmtTime(run.startedAt)}>{fmtTime(run.startedAt)} · {relTime(run.startedAt)}</span> },
            { key: "updated", label: "Updated", children: run.lastUpdatedAt ? <span title={fmtTime(run.lastUpdatedAt)}>{relTime(run.lastUpdatedAt)}</span> : "Unknown" },
            { key: "duration", label: "Duration", children: fmtDuration(run.durationMs) },
            { key: "model", label: "Reviewer", children: run.model ?? manifest?.model ?? "pi default" },
            { key: "verifier", label: "Verifier", children: run.verifierModel ?? manifest?.verifierModel ?? "same as reviewer" },
          ]} />
        </Card>

        <Card
          size="small"
          title="Reading coverage"
          style={{ marginTop: 16 }}
          extra={<Button size="small" type="link" onClick={() => onOpenTab("coverage")}>Details</Button>}
        >
          {coverage?.available ? (
            <>
              <Space size={20} wrap>
                <Statistic title={coverage.mode === "change" ? "Diff hunks read" : "Files reviewed"} value={coverage.mode === "change" ? `${coverage.summary.hunksCovered}/${coverage.summary.hunksTotal}` : `${coverage.summary.filesReviewed}/${coverage.summary.filesInScope}`} />
                <Statistic title="Coverage" value={percent === null ? "—" : `${percent}%`} />
              </Space>
              {percent !== null && <Progress percent={percent} showInfo={false} style={{ marginTop: 12 }} />}
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>Coverage records what was read; it is not a guarantee that nothing was missed.</Typography.Text>
            </>
          ) : (
            <Typography.Text type="secondary">Coverage {coverage?.reason === "unavailable" ? "is unavailable" : "was not recorded"} for this run.</Typography.Text>
          )}
        </Card>

        <Card size="small" title={<span><FieldTimeOutlined /> Usage</span>} style={{ marginTop: 16 }}>
          <Space size={20} wrap>
            <Statistic title="Tokens" value={run.totalTokens === null ? "—" : fmtCount(run.totalTokens)} />
            <Statistic title="Cost" value={run.cost === null ? "—" : fmtCost(run.cost)} />
            <Statistic title="Observed" value={connection === "open" ? "Live" : connection === "connecting" ? "Connecting" : "REST snapshot"} styles={{ content: { fontSize: 16 } }} />
          </Space>
        </Card>
      </Col>

      <Col xs={24}>
        <Card size="small" title={<span><ClockCircleOutlined /> Recent activity</span>} extra={running ? <Tag color="processing">running</Tag> : <Tag>ended</Tag>}>
          {progress.length === 0 && roundActivity.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={running ? "Waiting for the next progress event" : "No progress events were captured"} />
          ) : progress.length > 0 ? (
            <Timeline
              items={progress.map((event) => ({
                color: event.kind === "progress" && event.phase === "done" ? "green" : undefined,
                content: (
                  <div>
                    <Space size={6} wrap>
                      <Tag>{event.kind === "progress" ? event.phase : event.kind}</Tag>
                      {event.kind === "progress" && event.round !== undefined && <span className="pir-muted">Round {event.round}</span>}
                      <span className="pir-muted" style={{ fontSize: 12 }}>{new Date(event.ts).toLocaleTimeString()}</span>
                    </Space>
                    <div>{event.kind === "progress" ? event.message : "Run event"}</div>
                  </div>
                ),
              }))}
            />
          ) : (
            <Timeline
              items={roundActivity.map((round) => ({
                content: (
                  <div>
                    <Space size={6} wrap><Tag>Round {round.round}</Tag><span className="pir-muted">{round.confirmed} confirmed · {round.rejected} rejected · {round.uncertain} uncertain</span></Space>
                    <div>{round.summary}</div>
                  </div>
                ),
              }))}
            />
          )}
          {progress.length === 0 && roundActivity.length > 0 && <div className="pir-muted" style={{ fontSize: 12, marginBottom: 8 }}>Reconstructed from the persisted round summary; live progress events are not retained for this run.</div>}
          <Button size="small" icon={<BulbOutlined />} onClick={() => onOpenTab("workflow")}>Open workflow</Button>
          {detail.live?.lastEventAt && <span className="pir-muted" style={{ marginLeft: 12, fontSize: 12 }}>Last event {relTime(detail.live.lastEventAt)}</span>}
        </Card>
      </Col>
      </Row>
    </>
  );
}