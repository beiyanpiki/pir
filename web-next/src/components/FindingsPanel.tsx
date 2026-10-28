import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Collapse, Drawer, Empty, Input, Segmented, Select, Skeleton, Space, Tag, Typography } from "antd";
import { ReloadOutlined, SafetyCertificateOutlined } from "@ant-design/icons";
import { fetchFindingDetail } from "../lib/api";
import { SEVERITY_ORDER, fmtTime } from "../lib/format";
import { useApi } from "../lib/hooks";
import type { FindingSummary, FindingView, RunDetail } from "../lib/types";
import { FindingStatusTag, SeverityTag } from "./StatusTags";
import { Markdown } from "./Markdown";
import { CopyButton } from "./CopyButton";

const REPORTED = new Set(["confirmed", "uncertain"]);

export function FindingsPanel({
  projectId,
  runId,
  detail,
  selected,
  onSelect,
  onOpenSession,
}: {
  projectId: string;
  runId: string;
  detail: RunDetail;
  selected: string | null;
  onSelect: (displayId: string | null) => void;
  onOpenSession: (sessionKey: string) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [severity, setSeverity] = useState("all");
  const [limit, setLimit] = useState(60);

  const sorted = useMemo(() => [...detail.findings.items].sort((a, b) => {
    const delta = (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9);
    return delta || a.createdAt - b.createdAt;
  }), [detail.findings.items]);
  const reported = useMemo(() => sorted.filter((finding) => REPORTED.has(finding.status)).length, [sorted]);
  const selectedSummary = selected ? sorted.find((finding) => finding.displayId === selected) : undefined;

  useEffect(() => {
    if (selectedSummary && !REPORTED.has(selectedSummary.status)) setShowAll(true);
  }, [selectedSummary]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return sorted.filter((finding) =>
      (selected === finding.displayId || showAll || REPORTED.has(finding.status)) &&
      (status === "all" || finding.status === status) &&
      (!needle || `${finding.title} ${finding.displayId} ${finding.category}`.toLowerCase().includes(needle)) &&
      (severity === "all" || finding.severity === severity),
    );
  }, [sorted, selected, showAll, status, query, severity]);

  if (detail.findings.items.length === 0) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No findings recorded for this run" style={{ padding: 42 }} />;
  }

  return (
    <div>
      <div className="pir-toolbar" style={{ justifyContent: "space-between" }}>
        <Space wrap>
          <Segmented
            value={showAll ? "all" : "reported"}
            onChange={(value) => { setShowAll(value === "all"); setLimit(60); }}
            options={[
              { label: `Reported (${reported})`, value: "reported" },
              { label: `All (${detail.findings.items.length})`, value: "all" },
            ]}
          />
          <Select
            value={status}
            onChange={(value) => { setStatus(value); setShowAll(true); }}
            style={{ width: 150 }}
            options={[{ value: "all", label: "All statuses" }, ...["confirmed", "uncertain", "candidate", "rejected", "expected", "suppressed"].map((value) => ({ value, label: value[0]!.toUpperCase() + value.slice(1) }))]}
          />
          <Select
            value={severity}
            onChange={setSeverity}
            style={{ width: 140 }}
            options={[{ value: "all", label: "All severities" }, ...["P0", "P1", "P2", "P3"].map((value) => ({ value, label: value }))]}
          />
        </Space>
        <Input.Search allowClear value={query} onChange={(event) => { setQuery(event.target.value); setLimit(60); }} placeholder="Search findings" style={{ width: 280, maxWidth: "100%" }} />
      </div>

      {!showAll && reported === 0 && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          title="No confirmed or uncertain findings"
          description={`${detail.findings.items.length} candidates were recorded but none passed verification. Rejected candidates are not engine failures; inspect them in All findings.`}
          action={<Button size="small" onClick={() => setShowAll(true)}>Show all</Button>}
        />
      )}

      {visible.slice(0, limit).map((finding) => (
        <FindingRow key={finding.id} finding={finding} selected={selected === finding.displayId} onSelect={() => onSelect(finding.displayId)} />
      ))}
      {visible.length > limit && (
        <Button type="link" onClick={() => setLimit((value) => value + 60)}>Show {visible.length - limit} more findings</Button>
      )}
      {visible.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No findings match these filters" />}

      <FindingDrawer
        projectId={projectId}
        runId={runId}
        findingId={selected}
        summary={selectedSummary}
        open={selected !== null}
        onClose={() => onSelect(null)}
        onOpenSession={onOpenSession}
      />
    </div>
  );
}

function FindingRow({ finding, selected, onSelect }: { finding: FindingSummary; selected: boolean; onSelect: () => void }) {
  return (
    <div
      className="pir-finding-row"
      role="button"
      tabIndex={0}
      style={selected ? { borderColor: "var(--pir-accent)" } : undefined}
      onClick={onSelect}
      onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(); } }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
        <div className="pir-finding-title">{finding.title}</div>
        <Space size={4} wrap>
          <SeverityTag severity={finding.severity} />
          <FindingStatusTag status={finding.status} />
        </Space>
      </div>
      <div className="pir-finding-meta">
        <span>{finding.displayId}</span>
        <span>{finding.category}</span>
        <span>round {finding.round}</span>
        <span>{finding.evidenceCount} evidence</span>
        <span>{finding.confidence === null ? "confidence unknown" : `${Math.round(finding.confidence * 100)}% confidence`}</span>
        <span>created {fmtTime(finding.createdAt)}</span>
      </div>
    </div>
  );
}

function FindingDrawer({
  projectId,
  runId,
  findingId,
  summary,
  open,
  onClose,
  onOpenSession,
}: {
  projectId: string;
  runId: string;
  findingId: string | null;
  summary: FindingSummary | undefined;
  open: boolean;
  onClose: () => void;
  onOpenSession: (sessionKey: string) => void;
}) {
  const detail = useApi<FindingView | null>(
    (signal) => findingId ? fetchFindingDetail(projectId, runId, findingId, signal) : Promise.resolve(null),
    [projectId, runId, findingId],
    { identity: [findingId] },
  );
  const finding = detail.data;
  const permalink = `${window.location.origin}${window.location.pathname}?tab=findings&finding=${encodeURIComponent(findingId ?? "")}`;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      size={620}
      title={<Space wrap><SafetyCertificateOutlined /> {summary ? summary.displayId : "Finding"} {summary && <SeverityTag severity={summary.severity} />}{summary && <FindingStatusTag status={summary.status} />}</Space>}
      extra={<CopyButton size="small" text={permalink} label="Copy link" />}
    >
      {detail.loading && !finding && <Skeleton active paragraph={{ rows: 8 }} />}
      {detail.error && <Alert type="error" showIcon title="Could not load the finding" description={detail.error} action={<Button size="small" icon={<ReloadOutlined />} onClick={detail.reload}>Retry</Button>} />}
      {finding && (
        <div>
          <Typography.Title level={4} style={{ marginTop: 0 }}>{finding.title}</Typography.Title>
          <Space size={6} wrap style={{ marginBottom: 14 }}>
            <Tag>{finding.category}</Tag>
            <Tag>round {finding.round}</Tag>
            <Tag>{finding.confidence === null ? "confidence unknown" : `${Math.round(finding.confidence * 100)}% confidence`}</Tag>
            {(finding.featureKey || finding.entityKey) && <Tag>scope {finding.featureKey ?? finding.entityKey}</Tag>}
          </Space>
          <section className="pir-drawer-section">
            <h3>Claim</h3>
            <Markdown content={finding.claim} />
          </section>
          <section className="pir-drawer-section">
            <h3>Trigger</h3>
            <Typography.Paragraph>{finding.trigger}</Typography.Paragraph>
          </section>
          <section className="pir-drawer-section">
            <h3>Anchors ({finding.anchors.length})</h3>
            {finding.anchors.length === 0 && <Typography.Text type="secondary">No source anchors recorded.</Typography.Text>}
            {finding.anchors.map((anchor, index) => (
              <div className="pir-anchor" key={`${anchor.path}:${anchor.startLine}:${index}`}>
                <div className="pir-anchor-head">
                  <Typography.Text code>{anchor.path}:{anchor.startLine}{anchor.endLine !== undefined ? `-${anchor.endLine}` : ""}</Typography.Text>
                  {anchor.lineCorrected && <Tag color="warning">line corrected{anchor.originalStartLine !== undefined ? ` from ${anchor.originalStartLine}` : ""}</Tag>}
                </div>
                {anchor.excerpt && <pre>{anchor.excerpt}</pre>}
              </div>
            ))}
          </section>
          <section className="pir-drawer-section">
            <h3>Evidence ({finding.evidence.length})</h3>
            {finding.evidence.length === 0 && <Typography.Text type="secondary">No evidence records.</Typography.Text>}
            {finding.evidence.map((item, index) => (
              <div className="pir-anchor" key={index}>
                <div className="pir-anchor-head">
                  <Tag>{item.kind}</Tag>
                  {item.path && <Typography.Text code>{item.path}{item.startLine !== undefined ? `:${item.startLine}` : ""}</Typography.Text>}
                </div>
                {item.description && <Typography.Paragraph>{item.description}</Typography.Paragraph>}
                {item.excerpt && <pre>{item.excerpt}</pre>}
              </div>
            ))}
          </section>
          <section className="pir-drawer-section">
            <h3>Verifier rationale</h3>
            {finding.verifierRationale ? <Markdown content={finding.verifierRationale} /> : <Typography.Text type="secondary">Not recorded.</Typography.Text>}
          </section>
          <section className="pir-drawer-section">
            <h3>Source sessions</h3>
            {finding.relatedSessions.length === 0 && <Typography.Text type="secondary">No session linkage recorded.</Typography.Text>}
            <Space size={6} wrap>
              {finding.relatedSessions.map((session) => (
                <Button key={`${session.relation}:${session.sessionKey}`} size="small" onClick={() => onOpenSession(session.sessionKey)}>
                  {session.relation} · {session.originalDisplayId ? `${session.originalDisplayId} → ${finding.displayId}` : session.sessionKey}
                </Button>
              ))}
            </Space>
          </section>
          {finding.memoryMatches.length > 0 && (
            <Collapse
              size="small"
              items={[{ key: "memory", label: `Memory matches (${finding.memoryMatches.length})`, children: <pre className="pir-code-block">{JSON.stringify(finding.memoryMatches, null, 2)}</pre> }]}
            />
          )}
        </div>
      )}
    </Drawer>
  );
}
