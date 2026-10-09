import type {
  AssistantMessage,
  SessionMessage,
  ToolCallBlock,
  ToolResultMessage,
  UserMessage,
} from "../../types";

// Flattening the settled transcript's message list into render items. Pure
// (no React) so node:test can drive it against real transcript shapes —
// toolCall/toolResult pairing and message-role handling are the contract.

export type RenderItem =
  | { type: "thinking"; text: string; redacted?: boolean }
  | { type: "text"; text: string }
  | { type: "tool"; call: ToolCallBlock; result?: { text: string; isError: boolean } }
  | { type: "user"; text: string }
  | { type: "raw"; label: string; value: unknown };

/**
 * Flatten the message list into render items, pairing each toolCall with its
 * toolResult (they arrive as separate messages keyed by toolCallId). The
 * leading user message duplicates the transcript prompt and is dropped, and
 * the SDK `system` message is transcript plumbing — rendering it is a raw
 * JSON dump with no review content. Content blocks are read structurally:
 * transcripts come from disk and may contain block shapes this UI predates.
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
    if (role === "system") continue;
    if (role === "user") {
      userIndex += 1;
      if (userIndex === 1) continue;
      items.push({ type: "user", text: userText(message as UserMessage) });
      continue;
    }
    // Tool results are paired with their preceding tool call above. Rendering
    // them again as raw messages adds a noisy duplicate row to the timeline.
    if (role === "toolResult") continue;
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
