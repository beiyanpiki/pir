import { useEffect, useMemo, useState } from "react";
import { Alert, Collapse, Empty, Skeleton, Tag, Typography } from "antd";
import { Bubble, ThoughtChain } from "@ant-design/x";
import type { BubbleItemType, ThoughtChainItemType } from "@ant-design/x";
import { BulbOutlined, RobotOutlined, UserOutlined } from "@ant-design/icons";
import { ApiError, cachedTranscript, describeError, fetchTranscript } from "../lib/api";
import type { DerivedSession, LiveItem } from "../lib/live-fold";
import type { SessionTranscript as SessionTranscriptData } from "../lib/types";
import { buildItems, type RenderItem } from "../lib/transcript-items";
import { Markdown } from "./Markdown";
import { ToolResultView, summarizeArgs } from "./ToolResultView";

type Phase =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; transcript: SessionTranscriptData }
  | { kind: "error"; message: string; status: number | null };

function useTranscript(projectId: string, runId: string, file: string | undefined, enabled: boolean) {
  const [state, setState] = useState<Phase>(() => {
    if (!file) return { kind: "idle" };
    const cached = cachedTranscript(projectId, runId, file);
    return cached ? { kind: "ready", transcript: cached } : { kind: "idle" };
  });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!file || !enabled) return;
    const cached = cachedTranscript(projectId, runId, file);
    if (cached) {
      setState({ kind: "ready", transcript: cached });
      return;
    }
    const controller = new AbortController();
    setState({ kind: "loading" });
    fetchTranscript(projectId, runId, file, controller.signal)
      .then((transcript) => setState({ kind: "ready", transcript }))
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setState({
          kind: "error",
          message: cause instanceof ApiError && cause.status === 404 ? "The persisted transcript file is missing." : describeError(cause),
          status: cause instanceof ApiError ? cause.status : null,
        });
      });
    return () => controller.abort();
  }, [projectId, runId, file, enabled, tick]);

  return { state, retry: () => setTick((value) => value + 1) };
}

function toolChain(items: Array<Extract<LiveItem, { type: "tool" }>>): React.ReactNode {
  const chain: ThoughtChainItemType[] = items.map((item) => ({
    key: item.callId,
    title: item.name,
    description: summarizeArgs(item.args),
    status: item.running ? "loading" : item.result?.isError ? "error" : "success",
    collapsible: true,
    content: <ToolResultView name={item.name} args={item.args} result={item.result} />,
  }));
  const expanded = items.filter((item) => item.result?.isError).map((item) => item.callId);
  return <ThoughtChain items={chain} defaultExpandedKeys={expanded} line="dashed" />;
}

function liveItems(items: LiveItem[]): BubbleItemType[] {
  const output: BubbleItemType[] = [];
  let pendingTools: Array<Extract<LiveItem, { type: "tool" }>> = [];
  const flushTools = (): void => {
    if (pendingTools.length === 0) return;
    output.push({ key: `tools-${output.length}`, role: "ai", content: toolChain(pendingTools) });
    pendingTools = [];
  };
  for (const item of items) {
    if (item.type === "tool") {
      pendingTools.push(item);
      continue;
    }
    flushTools();
    if (item.type === "thinking") {
      output.push({
        key: `thinking-${output.length}`,
        role: "system",
        content: (
          <Collapse
            ghost
            size="small"
            items={[{ key: "thinking", label: <span className="pir-muted"><BulbOutlined /> Reasoning {item.streaming ? "…" : ""}</span>, children: <Markdown content={item.text} streaming={item.streaming} /> }]}
          />
        ),
      });
    } else if (item.type === "text") {
      output.push({
        key: `text-${output.length}`,
        role: "ai",
        status: item.streaming ? "updating" : "success",
        content: <Markdown content={item.text} streaming={item.streaming} />,
      });
    }
  }
  flushTools();
  return output;
}

function transcriptItems(items: RenderItem[]): BubbleItemType[] {
  const output: BubbleItemType[] = [];
  let pendingTools: Array<Extract<RenderItem, { type: "tool" }>> = [];
  const flushTools = (): void => {
    if (pendingTools.length === 0) return;
    output.push({
      key: `tools-${output.length}`,
      role: "ai",
      content: (
        <ThoughtChain
          line="dashed"
          defaultExpandedKeys={pendingTools.filter((item) => item.result?.isError).map((item) => item.call.id)}
          items={pendingTools.map((item) => ({
            key: item.call.id,
            title: item.call.name,
            description: summarizeArgs(item.call.arguments),
            status: item.result?.isError ? "error" : "success",
            collapsible: true,
            content: <ToolResultView name={item.call.name} args={item.call.arguments} result={item.result ? { text: item.result.text, isError: item.result.isError } : undefined} />,
          }))}
        />
      ),
    });
    pendingTools = [];
  };
  for (const item of items) {
    if (item.type === "tool") {
      pendingTools.push(item);
      continue;
    }
    flushTools();
    if (item.type === "thinking") {
      output.push({
        key: `thinking-${output.length}`,
        role: "system",
        content: (
          <Collapse
            ghost
            size="small"
            items={[{ key: "thinking", label: <span className="pir-muted"><BulbOutlined /> Reasoning{item.redacted ? " (redacted)" : ""}</span>, children: <Markdown content={item.text} /> }]}
          />
        ),
      });
    } else if (item.type === "text") {
      output.push({ key: `text-${output.length}`, role: "ai", content: <Markdown content={item.text} /> });
    } else if (item.type === "user") {
      output.push({ key: `user-${output.length}`, role: "user", content: <Markdown content={item.text} /> });
    } else {
      output.push({
        key: `raw-${output.length}`,
        role: "system",
        content: <Collapse ghost size="small" items={[{ key: "raw", label: <span className="pir-muted">{item.label}</span>, children: <pre className="pir-code-block">{JSON.stringify(item.value, null, 2)}</pre> }]} />,
      });
    }
  }
  flushTools();
  return output;
}

const ROLES = {
  ai: { placement: "start" as const, variant: "borderless" as const, avatar: <RobotOutlined /> },
  system: { placement: "start" as const, variant: "borderless" as const },
  user: { placement: "end" as const, variant: "outlined" as const, avatar: <UserOutlined /> },
};

export function SessionTranscript({
  projectId,
  runId,
  live,
  file,
  settled,
}: {
  projectId: string;
  runId: string;
  live: DerivedSession | undefined;
  file: string | undefined;
  settled: boolean;
}) {
  // A settled session is evidence, so prefer its immutable persisted
  // transcript; the live buffer is the fallback while that load is in flight
  // or when no file was captured.
  const preferPersisted = settled && Boolean(file);
  const transcript = useTranscript(projectId, runId, file, preferPersisted);
  const [showLive, setShowLive] = useState(false);
  const usingPersisted = preferPersisted && transcript.state.kind === "ready" && !showLive;
  const items = useMemo<BubbleItemType[]>(() => {
    if (usingPersisted && transcript.state.kind === "ready") return transcriptItems(buildItems(transcript.state.transcript.messages));
    if (live) return liveItems(live.items);
    return [];
  }, [live, usingPersisted, transcript.state]);
  const prompt = usingPersisted && transcript.state.kind === "ready" ? transcript.state.transcript.prompt : live?.prompt;

  if (preferPersisted && transcript.state.kind === "loading" && !live) return <Skeleton active paragraph={{ rows: 4 }} />;

  return (
    <div>
      {preferPersisted && transcript.state.kind === "error" && (
        <Alert
          type={live ? "warning" : "error"}
          showIcon
          style={{ marginBottom: 10 }}
          title={live ? "Persisted transcript unavailable — showing the live buffer" : "Transcript unavailable"}
          description={
            <span>
              {transcript.state.message}{" "}
              <a onClick={transcript.retry} role="button" tabIndex={0}>Retry</a>
            </span>
          }
        />
      )}
      {preferPersisted && live && transcript.state.kind === "ready" && (
        <div style={{ marginBottom: 8 }}>
          <Tag>{showLive ? "Live buffer" : "Persisted transcript"}</Tag>
          <a onClick={() => setShowLive((value) => !value)} role="button" tabIndex={0}>
            {showLive ? "Show persisted transcript" : "Show live buffer"}
          </a>
        </div>
      )}
      {prompt && (
        <Collapse
          ghost
          size="small"
          style={{ marginBottom: 6 }}
          items={[{
            key: "prompt",
            label: <Typography.Text type="secondary">Prompt and scope · {prompt.length.toLocaleString()} chars</Typography.Text>,
            children: <pre className="pir-code-block">{prompt}</pre>,
          }]}
        />
      )}
      {items.length > 0 ? (
        <Bubble.List autoScroll={false} items={items} role={ROLES} className="pir-bubble-list" />
      ) : (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No transcript content recorded" />
      )}
      {usingPersisted && transcript.state.kind === "ready" && transcript.state.transcript.usage && (
        <div className="pir-muted" style={{ marginTop: 8, fontSize: 12 }}>
          {typeof transcript.state.transcript.usage.totalTokens === "number" ? `${transcript.state.transcript.usage.totalTokens.toLocaleString()} tokens` : "Token usage unknown"}
          {typeof transcript.state.transcript.usage.cost === "number" ? ` · $${transcript.state.transcript.usage.cost.toFixed(3)}` : ""}
        </div>
      )}
      {!preferPersisted && live && live.error && <Alert type="error" showIcon style={{ marginTop: 8 }} title="Session failed" description={live.error} />}
    </div>
  );
}
