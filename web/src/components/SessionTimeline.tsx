import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Empty, Skeleton, Tooltip } from "antd";
import {
  ArrowDownOutlined,
  ArrowLeftOutlined,
  ArrowRightOutlined,
  BulbOutlined,
  CheckCircleFilled,
  CloseCircleFilled,
  FileTextOutlined,
  LinkOutlined,
  LoadingOutlined,
  RobotOutlined,
  SafetyCertificateOutlined,
} from "@ant-design/icons";
import { ApiError, cachedTranscript, describeError, fetchTranscript } from "../lib/api";
import type { DerivedSession, LiveItem } from "../lib/live-fold";
import { fmtCost, fmtCount, fmtDuration, fmtTime, relTime } from "../lib/format";
import { sessionAnchor, type WorkflowSession } from "../lib/live-projection";
import type { SessionTranscript as SessionTranscriptData } from "../lib/types";
import { buildItems } from "../lib/transcript-items";
import { blocksFromLive, blocksFromTranscript, type TimelineBlock } from "../lib/workflow-timeline";
import { Markdown } from "./Markdown";
import { WorkflowToolList } from "./WorkflowToolList";

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

function timestampMs(value: string | number | null | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function durationMs(start: string | number | null | undefined, end: string | number | null | undefined, fallback?: number): number | null {
  if (typeof fallback === "number" && fallback > 0) return fallback;
  const from = timestampMs(start);
  const to = timestampMs(end);
  return from !== null && to !== null && to >= from ? to - from : null;
}

function PromptCard({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 900 || text.split("\n").length > 14;
  return (
    <div className="wf-prompt-row">
      <div className="wf-prompt">
        <div className="wf-prompt-label">Prompt</div>
        <pre className={`wf-prompt-text${long && !open ? " is-clamped" : ""}`}>{text}</pre>
        {long && (
          <button type="button" className="wf-text-action" onClick={() => setOpen((value) => !value)}>
            {open ? "Show less" : `Show full prompt · ${text.length.toLocaleString()} chars`}
          </button>
        )}
      </div>
    </div>
  );
}

function Reasoning({ block }: { block: Extract<TimelineBlock, { kind: "thinking" }> }) {
  // Reasoning is part of the review evidence, so it starts expanded; the
  // summary stays clickable to fold it away.
  return (
    <details className="wf-reasoning" open>
      <summary className="wf-reasoning-summary">
        <BulbOutlined />
        <span>Reasoning</span>
        <span className="wf-reasoning-meta">
          {block.streaming ? "streaming" : `${block.text.length.toLocaleString()} chars`}
          {block.redacted ? " · redacted" : ""}
        </span>
      </summary>
      <div className="wf-reasoning-body">
        <Markdown content={block.text} streaming={block.streaming} />
      </div>
    </details>
  );
}

function RawBlock({ block }: { block: Extract<TimelineBlock, { kind: "raw" }> }) {
  return (
    <details className="wf-raw">
      <summary>{block.label}</summary>
      <pre className="pir-code-block">{JSON.stringify(block.value, null, 2)}</pre>
    </details>
  );
}

function Block({ block }: { block: TimelineBlock }) {
  if (block.kind === "text") return <div className="wf-response"><Markdown content={block.text} streaming={block.streaming} /></div>;
  if (block.kind === "thinking") return <Reasoning block={block} />;
  if (block.kind === "tools") return <WorkflowToolList tools={block.tools} />;
  if (block.kind === "user") return <div className="wf-user-inline"><Markdown content={block.text} /></div>;
  return <RawBlock block={block} />;
}

function StatusPill({ status }: { status: string }) {
  if (status === "running") return <span className="wf-status is-running"><span className="wf-pulse" />running</span>;
  if (status === "failed") return <span className="wf-status is-failed"><CloseCircleFilled />failed</span>;
  if (status === "completed") return <span className="wf-status is-completed"><CheckCircleFilled />completed</span>;
  return <span className="wf-status is-persisted"><FileTextOutlined />persisted</span>;
}

export function SessionTimeline({
  session,
  live,
  projectId,
  runId,
  position,
  total,
  onPrev,
  onNext,
  onFinding,
  onCopy,
}: {
  session: WorkflowSession;
  live: DerivedSession | undefined;
  projectId: string;
  runId: string;
  position: number;
  total: number;
  onPrev?: () => void;
  onNext?: () => void;
  onFinding: (displayId: string) => void;
  onCopy?: () => void;
}) {
  const settled = session.status !== "running";
  const preferPersisted = settled && Boolean(session.file);
  const transcript = useTranscript(projectId, runId, session.file, preferPersisted);
  const [showLive, setShowLive] = useState(false);
  const [stick, setStick] = useState(session.status === "running");
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setShowLive(false);
    setStick(session.status === "running");
    const element = scrollRef.current;
    if (element) element.scrollTop = session.status === "running" ? element.scrollHeight : 0;
  }, [session.key, session.status]);

  const usingPersisted = preferPersisted && transcript.state.kind === "ready" && !showLive;
  const persisted = transcript.state.kind === "ready" ? transcript.state.transcript : null;
  const blocks = useMemo<TimelineBlock[]>(() => {
    if (usingPersisted && persisted) return blocksFromTranscript(buildItems(persisted.messages));
    if (live) return blocksFromLive(live.items as LiveItem[]);
    return [];
  }, [live, persisted, usingPersisted]);

  const prompt = usingPersisted && persisted ? persisted.prompt : live?.prompt;
  const usage = (usingPersisted ? persisted?.usage : live?.usage) ?? persisted?.usage ?? live?.usage;
  const model = live?.model ?? persisted?.model;
  const startedAt = live?.startedAt ?? persisted?.startedAt;
  const endedAt = live?.endedAt ?? persisted?.endedAt;
  const duration = durationMs(startedAt, endedAt, usage?.durationMs);
  const error = live?.error ?? persisted?.error;
  const running = session.status === "running";
  const loadingPersisted = preferPersisted && transcript.state.kind === "loading" && !live;

  useEffect(() => {
    if (!running || !stick) return;
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [blocks, running, stick]);

  const onScroll = (): void => {
    const element = scrollRef.current;
    if (!element) return;
    setStick(element.scrollHeight - element.scrollTop - element.clientHeight < 80);
  };

  const jump = (): void => {
    const element = scrollRef.current;
    if (element) element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
    setStick(true);
  };

  const meta: string[] = [];
  if (model) meta.push(model);
  if (duration !== null) meta.push(fmtDuration(duration));
  if (usage?.totalTokens !== undefined) meta.push(`${fmtCount(usage.totalTokens)} tokens`);
  if (usage?.cost !== undefined) meta.push(fmtCost(usage.cost));
  if (session.file) meta.push(session.file);

  return (
    <section className="wf-main" aria-label={`${session.kind} session ${session.label}`}>
      <header className="wf-head">
        <div className="wf-head-main">
          <span className={`wf-role is-${session.kind}`} aria-hidden>
            {session.kind === "verifier" ? <SafetyCertificateOutlined /> : <RobotOutlined />}
          </span>
          <div className="wf-head-copy">
            <div className="wf-title-line">
              <h2 className="wf-title">{session.label}</h2>
              <StatusPill status={session.status} />
            </div>
            <div className="wf-subline">
              <span>{session.kind}</span>
              {session.round !== undefined && <><span className="wf-dot">·</span><span>round {session.round}</span></>}
              {live?.unitId && <><span className="wf-dot">·</span><span>unit {live.unitId}</span></>}
              {live?.attempt !== undefined && <><span className="wf-dot">·</span><span>attempt {live.attempt}</span></>}
              {live?.angle && <><span className="wf-dot">·</span><span>angle {live.angle}</span></>}
              {startedAt !== undefined && <><span className="wf-dot">·</span><span>{typeof startedAt === "number" ? `started ${relTime(startedAt)}` : fmtTime(Date.parse(String(startedAt)))}</span></>}
            </div>
          </div>
        </div>
        <div className="wf-head-actions">
          <span className="wf-position">{position} / {total}</span>
          <Tooltip title="Previous session">
            <button type="button" className="wf-icon-button" onClick={onPrev} disabled={!onPrev} aria-label="Previous session"><ArrowLeftOutlined /></button>
          </Tooltip>
          <Tooltip title="Next session">
            <button type="button" className="wf-icon-button" onClick={onNext} disabled={!onNext} aria-label="Next session"><ArrowRightOutlined /></button>
          </Tooltip>
          <Tooltip title="Copy link to this session">
            <button type="button" className="wf-icon-button" onClick={onCopy} aria-label="Copy session link"><LinkOutlined /></button>
          </Tooltip>
        </div>
      </header>

      <div className="wf-meta">
        {meta.map((item, index) => <span key={`${item}-${index}`} className="wf-meta-item">{item}</span>)}
        {session.findingMappings.length > 0 && (
          <span className="wf-meta-findings">
            {session.findingMappings.map((mapping) => (
              <button type="button" key={`${mapping.from}->${mapping.to}`} className="wf-finding-link" onClick={() => onFinding(mapping.to)}>
                {mapping.from === mapping.to ? mapping.to : `${mapping.from} → ${mapping.to}`}
              </button>
            ))}
          </span>
        )}
        {preferPersisted && live && transcript.state.kind === "ready" && (
          <button type="button" className="wf-text-action" onClick={() => setShowLive((value) => !value)}>
            {showLive ? "Show persisted transcript" : "Show live buffer"}
          </button>
        )}
      </div>

      <div className="wf-scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="wf-thread" id={sessionAnchor(session.key)}>
          {preferPersisted && transcript.state.kind === "error" && (
            <Alert
              type={live ? "warning" : "error"}
              showIcon
              className="wf-alert"
              title={live ? "Persisted transcript unavailable — showing the live buffer" : "Transcript unavailable"}
              description={
                <span>
                  {transcript.state.message}{" "}
                  <button type="button" className="wf-text-action" onClick={transcript.retry}>Retry</button>
                </span>
              }
            />
          )}
          {error && <div className="wf-error"><CloseCircleFilled /> {error}</div>}
          {loadingPersisted ? (
            <Skeleton active paragraph={{ rows: 6 }} />
          ) : (
            <>
              {prompt && <PromptCard text={prompt} />}
              {blocks.map((block) => <Block key={block.key} block={block} />)}
              {blocks.length === 0 && !prompt && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No transcript content recorded" />}
              {running ? (
                <div className="wf-end is-running"><LoadingOutlined spin /> Session running{duration !== null ? ` · ${fmtDuration(duration)}` : ""}</div>
              ) : (
                <div className={`wf-end${session.status === "failed" ? " is-failed" : ""}`}>
                  {session.status === "failed" ? <CloseCircleFilled /> : <CheckCircleFilled />}
                  <span>{session.status === "failed" ? "Session failed" : "Session complete"}</span>
                  <span className="wf-end-meta">
                    {duration !== null ? fmtDuration(duration) : "duration unknown"}
                    {usage?.totalTokens !== undefined ? ` · ${fmtCount(usage.totalTokens)} tokens` : ""}
                    {usage?.cost !== undefined ? ` · ${fmtCost(usage.cost)}` : ""}
                  </span>
                </div>
              )}
            </>
          )}
        </div>
      </div>
      {running && !stick && (
        <button type="button" className="wf-jump" onClick={jump}><ArrowDownOutlined /> Jump to latest</button>
      )}
    </section>
  );
}