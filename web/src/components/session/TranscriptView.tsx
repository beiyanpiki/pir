import { useMemo } from "react";
import { fmtClock, fmtCost, fmtCount } from "../../format";
import type { SessionTranscript, SessionUsage } from "../../types";
import { RawBlock, TextBlockView, ThinkingRow, ToolRow, UserGoalCard } from "./blocks";
import { buildItems, type RenderItem } from "./transcript-items";

export { buildItems } from "./transcript-items";
export type { RenderItem } from "./transcript-items";

/**
 * One settled session as a dsh-style activity stream: the prompt as a
 * centered goal card, then a flat sequence of rows — thinking, prose, tool
 * calls — with the session's role quiet in the divider above.
 */
export function TranscriptView({ transcript }: { transcript: SessionTranscript }) {
  const items = useMemo(() => buildItems(transcript.messages), [transcript]);

  return (
    <div className="session-transcript">
      <UserGoalCard text={transcript.prompt} />
      <div className="assistant-turn">
        <div className="assistant-label">
          {transcript.role}
          {transcript.model && <span>{transcript.model}</span>}
        </div>
        <div className="session-flow-items">
          {items.map((item, index) => (
            <TranscriptItem key={index} item={item} />
          ))}
        </div>
      </div>
      <SessionFooter
        usage={transcript.usage}
        startedAt={transcript.startedAt}
        endedAt={transcript.endedAt}
        error={transcript.error}
      />
    </div>
  );
}

function SessionFooter({
  usage,
  startedAt,
  endedAt,
  error,
}: {
  usage?: SessionUsage;
  startedAt?: string;
  endedAt?: string;
  error?: string;
}) {
  if (!usage && !error) return null;
  return (
    <div className="session-footer">
      {error && <div className="my-2 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-[13px] text-red-300">{error}</div>}
      {usage && (
        <div className="session-usage">
          <span>{fmtCount(usage.totalTokens)} tokens</span>
          <span>{fmtCost(usage.cost)}</span>
          <span>{usage.toolCalls ?? 0} tool calls</span>
          <span>
            {fmtClock(startedAt)} → {fmtClock(endedAt)}
          </span>
        </div>
      )}
    </div>
  );
}

function TranscriptItem({ item }: { item: RenderItem }) {
  switch (item.type) {
    case "thinking":
      return <ThinkingRow text={item.text} redacted={item.redacted} />;
    case "text":
      return <TextBlockView text={item.text} />;
    case "tool":
      return (
        <ToolRow
          name={item.call.name}
          args={item.call.arguments}
          result={item.result ? { text: item.result.text, isError: item.result.isError, truncated: false } : undefined}
        />
      );
    case "user":
      return <UserGoalCard text={item.text} />;
    case "raw":
      return <RawBlock label={item.label} value={item.value} />;
  }
}

