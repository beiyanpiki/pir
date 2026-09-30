import { useMemo } from "react";
import { fmtClock, fmtCost, fmtCount } from "../../format";
import type {
  AssistantMessage,
  SessionMessage,
  SessionTranscript,
  SessionUsage,
  ToolCallBlock,
  ToolResultMessage,
  UserMessage,
} from "../../types";
import { RawBlock, TextBlockView, ThinkingRow, ToolRow, UserGoalCard } from "./blocks";

type RenderItem =
  | { type: "thinking"; text: string; redacted?: boolean }
  | { type: "text"; text: string }
  | { type: "tool"; call: ToolCallBlock; result?: { text: string; isError: boolean } }
  | { type: "user"; text: string }
  | { type: "raw"; label: string; value: unknown };

/**
 * One settled session as a ZCode-style activity stream: the prompt as a
 * centered goal card, then a flat sequence of rows — thinking, prose, tool
 * calls — with the session's role quiet in the divider above.
 */
export function TranscriptView({ transcript }: { transcript: SessionTranscript }) {
  const items = useMemo(() => buildItems(transcript.messages), [transcript]);

  return (
    <div className="flex flex-col">
      <UserGoalCard text={transcript.prompt} />
      <div className="mt-4 flex flex-col gap-0.5">
        {items.map((item, index) => (
          <TranscriptItem key={index} item={item} />
        ))}
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
    <>
      {error && <div className="my-2 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-[13px] text-red-300">{error}</div>}
      {usage && (
        <div className="mt-3 flex flex-wrap gap-4 border-t border-border/60 pt-2 text-[11px] font-mono text-muted-foreground/60">
          <span>{fmtCount(usage.totalTokens)} tokens</span>
          <span>{fmtCost(usage.cost)}</span>
          <span>{usage.toolCalls ?? 0} tool calls</span>
          <span>
            {fmtClock(startedAt)} → {fmtClock(endedAt)}
          </span>
        </div>
      )}
    </>
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

/**
 * Flatten the message list into render items, pairing each toolCall with its
 * toolResult (they arrive as separate messages keyed by toolCallId). The
 * leading user message duplicates the transcript prompt and is dropped.
 * Content blocks are read structurally: transcripts come from disk and may
 * contain block shapes this UI predates.
 */
export function buildItems(messages: SessionMessage[]): RenderItem[] {
  const results = new Map<string, { text: string; isError: boolean }>();
  for (const message of messages) {
    const candidate = message as Partial<ToolResultMessage>;
    if (candidate.role === "toolResult" && typeof candidate.toolCallId === "string") {
      const content = Array.isArray(candidate.content) ? candidate.content : [];
      results.set(candidate.toolCallId, {
        text: content
          .map((block) => (block.type === "text" ? (block as { text: string }).text ?? "" : ""))
          .filter(Boolean)
          .join("\n"),
        isError: Boolean(candidate.isError),
      });
    }
  }

  const items: RenderItem[] = [];
  let userIndex = 0;
  for (const message of messages) {
    const role = (message as { role?: string }).role;
    if (role === "user") {
      userIndex += 1;
      if (userIndex === 1) continue;
      items.push({ type: "user", text: userText(message as UserMessage) });
      continue;
    }
    if (role !== "assistant") {
      items.push({ type: "raw", label: `message (${role ?? "unknown"})`, value: message });
      continue;
    }
    const assistant = message as AssistantMessage;
    const blocks = Array.isArray(assistant.content) ? assistant.content : [];
    for (const raw of blocks) {
      const block = raw as {
        type?: string;
        text?: string;
        thinking?: string;
        redacted?: boolean;
        id?: string;
        name?: string;
        arguments?: Record<string, unknown>;
      };
      if (block.type === "thinking") {
        items.push({ type: "thinking", text: block.thinking ?? "", ...(block.redacted ? { redacted: true } : {}) });
      } else if (block.type === "text") {
        items.push({ type: "text", text: block.text ?? "" });
      } else if (block.type === "toolCall" && typeof block.id === "string" && typeof block.name === "string") {
        const result = results.get(block.id);
        items.push({ type: "tool", call: { type: "toolCall", id: block.id, name: block.name, arguments: block.arguments ?? {} }, ...(result ? { result } : {}) });
      } else {
        items.push({ type: "raw", label: `block (${String(block.type)})`, value: raw });
      }
    }
    if (assistant.errorMessage) {
      items.push({ type: "raw", label: "assistant error", value: assistant.errorMessage });
    }
  }
  return items;
}

function userText(message: UserMessage): string {
  if (typeof message.content === "string") return message.content;
  const content = Array.isArray(message.content) ? message.content : [];
  return content.map((block) => (block.type === "text" ? block.text ?? "" : `[${block.type}]`)).join("\n");
}
