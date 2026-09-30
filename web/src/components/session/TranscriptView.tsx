import { useMemo } from "react";
import { Message, MessageContent } from "@/components/ai-elements/message";
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
import { RawBlock, TextBlockView, ThinkingBlock, ToolCallView, UserBubble } from "./blocks";

type RenderItem =
  | { type: "thinking"; text: string; redacted?: boolean }
  | { type: "text"; text: string }
  | { type: "tool"; call: ToolCallBlock; result?: { text: string; isError: boolean } }
  | { type: "user"; text: string }
  | { type: "raw"; label: string; value: unknown };

type Turn =
  | { kind: "user"; text: string }
  | { kind: "assistant"; items: RenderItem[] };

/**
 * Renders one settled session transcript as a conversation: the prompt as a
 * right user bubble, then assistant turns — Reasoning for thinking,
 * MessageResponse for markdown, Tool for every call with its result.
 */
export function TranscriptView({ transcript }: { transcript: SessionTranscript }) {
  const turns = useMemo(() => groupTurns(buildItems(transcript.messages)), [transcript]);

  return (
    <div className="flex flex-col gap-5">
      <Message from="user" className="items-end">
        <MessageContent className="w-auto max-w-[88%] min-w-0 p-0">
          <UserBubble text={transcript.prompt} />
        </MessageContent>
      </Message>
      {turns.map((turn, index) =>
        turn.kind === "user" ? (
          <Message key={index} from="user" className="items-end">
            <MessageContent className="w-auto max-w-[88%] min-w-0 p-0">
              <UserBubble text={turn.text} />
            </MessageContent>
          </Message>
        ) : (
          <Message key={index} from="assistant">
            <MessageContent className="w-full p-0">
              <div className="mb-2 text-[10.5px] font-medium uppercase tracking-[0.1em] text-muted-foreground font-mono">
                {transcript.role}
                {transcript.model && transcript.model !== "(pi default)" && (
                  <span className="ml-2 normal-case tracking-normal opacity-70">{transcript.model}</span>
                )}
              </div>
              <div className="flex flex-col gap-3">
                {turn.items.map((item, itemIndex) => (
                  <TranscriptItem key={itemIndex} item={item} />
                ))}
              </div>
            </MessageContent>
          </Message>
        ),
      )}
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
      {error && <div className="error-banner">{error}</div>}
      {usage && (
        <div className="flex flex-wrap gap-4 border-t border-border pt-2 text-[11px] font-mono text-muted-foreground">
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
      return <ThinkingBlock text={item.text} redacted={item.redacted} />;
    case "text":
      return <TextBlockView text={item.text} />;
    case "tool":
      return (
        <ToolCallView
          name={item.call.name}
          args={item.call.arguments}
          result={item.result ? { text: item.result.text, isError: item.result.isError, truncated: false } : undefined}
        />
      );
    case "user":
      return <UserBubble text={item.text} />;
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

/** Consecutive assistant items form one turn; user items stand alone. */
function groupTurns(items: RenderItem[]): Turn[] {
  const turns: Turn[] = [];
  for (const item of items) {
    if (item.type === "user") {
      turns.push({ kind: "user", text: item.text });
      continue;
    }
    const last = turns[turns.length - 1];
    if (last && last.kind === "assistant") last.items.push(item);
    else turns.push({ kind: "assistant", items: [item] });
  }
  return turns;
}

function userText(message: UserMessage): string {
  if (typeof message.content === "string") return message.content;
  const content = Array.isArray(message.content) ? message.content : [];
  return content.map((block) => (block.type === "text" ? block.text ?? "" : `[${block.type}]`)).join("\n");
}
