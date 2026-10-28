import { useMemo, useState } from "react";
import { Button, Card, Col, Empty, Grid, Input, Row, Segmented, Select, Space, Tag, Tooltip, Typography } from "antd";
import { Conversations } from "@ant-design/x";
import { BranchesOutlined, FileTextOutlined, LinkOutlined, RobotOutlined, SafetyCertificateOutlined } from "@ant-design/icons";
import type { ConversationItemType } from "@ant-design/x";
import type { DerivedSession } from "../lib/live-fold";
import { sessionAnchor, type WorkflowSession } from "../lib/live-projection";
import { CopyButton } from "./CopyButton";
import { SessionTranscript } from "./SessionTranscript";

function SessionFilters({ role, status, query, onFilter }: {
  role: string; status: string; query: string; onFilter: (key: "role" | "status" | "q", value: string) => void;
}) {
  return (
    <Space orientation="vertical" size={8} style={{ width: "100%", marginBottom: 10 }}>
      <Segmented block size="small" value={role} onChange={(value) => onFilter("role", String(value))} options={[{ label: "All", value: "all" }, { label: "Reviewer", value: "reviewer" }, { label: "Verifier", value: "verifier" }]} />
      <Select size="small" value={status} onChange={(value) => onFilter("status", value)} style={{ width: "100%" }} options={[{ value: "all", label: "All statuses" }, { value: "running", label: "Running" }, { value: "completed", label: "Completed" }, { value: "failed", label: "Failed" }, { value: "archived", label: "Persisted" }]} />
      <Input.Search size="small" allowClear value={query} onChange={(event) => onFilter("q", event.target.value)} placeholder="Search unit, angle, finding or file" />
    </Space>
  );
}

function basename(file: string): string {
  const normalized = file.replace(/\\/g, "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

const STATUS_COLOR: Record<string, string> = {
  running: "processing",
  completed: "success",
  failed: "error",
  archived: "default",
};

export function WorkflowPanel({
  projectId,
  runId,
  sessions,
  liveSessions,
  selected,
  role,
  status,
  query,
  onSelect,
  onFilter,
  onFinding,
}: {
  projectId: string;
  runId: string;
  sessions: WorkflowSession[];
  liveSessions: DerivedSession[];
  selected: string | null;
  role: string;
  status: string;
  query: string;
  onSelect: (key: string) => void;
  onFilter: (key: "role" | "status" | "q", value: string) => void;
  onFinding: (displayId: string) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(selected ? [selected] : []));
  const screens = Grid.useBreakpoint();
  const mobile = screens.lg === false;

  const liveBySession = useMemo(() => {
    const map = new Map<string, DerivedSession>();
    for (const session of liveSessions) {
      map.set(`runtime:${session.sessionId}`, session);
      if (session.transcriptFile) map.set(`file:${basename(session.transcriptFile)}`, session);
    }
    return map;
  }, [liveSessions]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return sessions.filter((session) => {
      if (role !== "all" && session.kind !== role) return false;
      if (status !== "all" && session.status !== status) return false;
      if (!needle) return true;
      return [session.label, session.file ?? "", session.kind, ...session.findingIds, ...session.aliases]
        .some((value) => value.toLowerCase().includes(needle));
    });
  }, [sessions, role, status, query]);

  const groups = useMemo(() => {
    const byRound = new Map<number, ConversationItemType[]>();
    for (const session of visible) {
      const round = session.round ?? 0;
      const items = byRound.get(round) ?? [];
      items.push({
        key: session.key,
        group: round === 0 ? "Sessions" : `Round ${round}`,
        label: (
          <span>
            <span style={{ fontWeight: 500 }}>{session.label}</span>
            <span className="pir-muted" style={{ display: "block", fontSize: 11 }}>
              {session.kind} · {session.status}{session.file ? ` · ${basename(session.file)}` : ""}
            </span>
          </span>
        ),
        icon: session.kind === "verifier" ? <SafetyCertificateOutlined /> : <RobotOutlined />,
      });
      byRound.set(round, items);
    }
    return byRound;
  }, [visible]);

  const conversationItems = useMemo(() => {
    const ordered: ConversationItemType[] = [];
    for (const [, items] of [...groups.entries()].sort(([a], [b]) => a - b)) ordered.push(...items);
    return ordered;
  }, [groups]);

  const toggle = (key: string): void => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    onSelect(key);
  };

  if (sessions.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="No review sessions recorded for this run"
        style={{ padding: 48 }}
      />
    );
  }

  return (
    <Row gutter={[20, 16]}>
      {!mobile && <Col xs={24} lg={8} xl={7}>
        <Card size="small" title={<span><BranchesOutlined /> Sessions <span className="pir-muted">({visible.length}/{sessions.length})</span></span>}>
          <SessionFilters role={role} status={status} query={query} onFilter={onFilter} />
          <div style={{ maxHeight: "calc(100vh - 320px)", overflow: "auto" }}>
            {conversationItems.length > 0 ? (
              <Conversations
                items={conversationItems}
                activeKey={selected ?? undefined}
                groupable
                onActiveChange={(key) => {
                  const session = sessions.find((candidate) => candidate.key === key);
                  if (session) toggle(session.key);
                }}
              />
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No matching sessions" />
            )}
          </div>
        </Card>
      </Col>}
      <Col xs={24} lg={16} xl={17}>
        {mobile && <Card size="small" style={{ marginBottom: 12 }}><SessionFilters role={role} status={status} query={query} onFilter={onFilter} /></Card>}
        {visible.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No matching sessions" />}
        {visible.map((session) => {
          const live = liveBySession.get(`runtime:${session.aliases.find((alias) => alias.startsWith("runtime:"))?.slice(8) ?? ""}`)
            ?? (session.file ? liveBySession.get(`file:${basename(session.file)}`) : undefined);
          const open = expanded.has(session.key) || selected === session.key;
          return (
            <Card
              key={session.key}
              size="small"
              className="pir-session-card"
              id={sessionAnchor(session.key)}
              title={
                <div className="pir-session-title">
                  <Space size={6} wrap>
                    <Tag color={session.kind === "verifier" ? "cyan" : "blue"}>{session.kind}</Tag>
                    <Tag color={STATUS_COLOR[session.status] ?? "default"}>{session.status === "archived" ? "persisted" : session.status}</Tag>
                    <Typography.Text strong>{session.label}</Typography.Text>
                    {session.round !== undefined && <Tag>Round {session.round}</Tag>}
                  </Space>
                  <Space size={4}>
                    <Button size="small" type="text" icon={<FileTextOutlined />} onClick={() => toggle(session.key)}>
                      {open ? "Hide transcript" : "Transcript"}
                    </Button>
                    <Tooltip title="Copy a link to this session">
                      <CopyButton size="small" type="text" icon={<LinkOutlined />} label="" text={`${window.location.origin}${window.location.pathname}?tab=workflow&session=${encodeURIComponent(session.key)}`} />
                    </Tooltip>
                  </Space>
                </div>
              }
            >
              <div className="pir-session-meta">
                {session.file && <span className="pir-inline-code">{session.file}</span>}
                {session.status === "running" && <span className="pir-live-dot" style={{ marginLeft: 8 }} />}
                {live?.model && <span style={{ marginLeft: 8 }}>{live.model}</span>}
                {live?.unitId && <span style={{ marginLeft: 8 }}>unit {live.unitId}</span>}
                {live?.attempt !== undefined && <span style={{ marginLeft: 8 }}>attempt {live.attempt}</span>}
                {live?.angle && <span style={{ marginLeft: 8 }}>angle {live.angle}</span>}
              </div>
              {session.findingMappings.length > 0 && (
                <Space size={4} wrap style={{ marginTop: 8 }}>
                  <span className="pir-muted" style={{ fontSize: 12 }}>Findings:</span>
                  {session.findingMappings.map((mapping) => (
                    <Button key={`${mapping.from}->${mapping.to}`} size="small" type="link" onClick={() => onFinding(mapping.to)}>
                      {mapping.from === mapping.to ? mapping.to : `${mapping.from} → ${mapping.to}`}
                    </Button>
                  ))}
                </Space>
              )}
              {open && (
                <div style={{ marginTop: 10 }}>
                  <SessionTranscript
                    key={`${projectId}/${runId}/${session.key}`}
                    projectId={projectId}
                    runId={runId}
                    live={live}
                    file={session.file}
                    settled={session.status !== "running"}
                  />
                </div>
              )}
            </Card>
          );
        })}
      </Col>
    </Row>
  );
}