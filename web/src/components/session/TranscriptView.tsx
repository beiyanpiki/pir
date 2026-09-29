import { useMemo } from "react";
import { CodeBlock } from "../CodeBlock";
import { fmtClock, fmtCost, fmtCount } from "../../format";
import type { AssistantMessage, SessionMessage, SessionTranscript, ToolCallBlock, ToolResultMessage, UserMessage } from "../../types";
import { RawBlock, TextBlockView, ThinkingBlock, ToolCallView, UserPromptBlock } from "./blocks";

type RenderItem =
  | { type: "thinking"; text: string; redacted?: boolean }
  | { type: "text"; text: string }
  | { type: "tool"; call: ToolCallBlock; result?: { text: string; isError: boolean } }
  | { type: "user"; text: string }
  | { type: "raw"; label: string; value: unknown };

/**
 * Renders one settled session transcript: the rendered prompt, then the final
 * SDK message list (thinking, text, tool calls with their results, in order).
 */
export function TranscriptView({ transcript }: { transcript: SessionTranscript }) {
  const items = useMemo(() => buildItems(transcript.messages), [transcript]);

  return (
    <div className="chat">
      <UserPromptBlock prompt={transcript.prompt} />
      {items.map((item, index) => (
        <TranscriptItem key={index} item={item} />
      ))}
      {transcript.usage && (
        <div className="stat-row" style={{ marginTop: 4 }}>
          <span className="stat"><b>{fmtCount(transcript.usage.totalTokens)}</b> tokens</span>
          <span className="stat"><b>{fmtCost(transcript.usage.cost)}</b></span>
          <span className="stat"><b>{transcript.usage.toolCalls ?? 0}</b> tool calls</span>
          <span className="stat">in <b>{transcript.startedAt ? fmtClock(transcript.startedAt) : "—"}</b></span>
          <span className="stat">out <b>{transcript.endedAt ? fmtClock(transcript.endedAt) : "—"}</b></span>
        </div>
      )}
      {transcript.error && (
        <div className="error-banner" style={{ marginBottom: 0 }}>session error: {transcript.error}</div>
      )}
    </div>
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
          call={item.call}
          result={item.result ? { text: item.result.text, isError: item.result.isError, truncated: false } : undefined}
        />
      );
    case "user":
      return <UserPromptBlock prompt={item.text} />;
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

export function TranscriptFallback({ file }: { file: string }) {
  return (
    <div className="empty-state" style={{ padding: 20 }}>
      <CodeBlock code={`transcript unavailable: ${file}`} language="text" />
    </div>
  );
}
