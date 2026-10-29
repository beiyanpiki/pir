import type { LiveItem } from "./live-fold";
import type { RenderItem } from "./transcript-items";

// Pure projection from a transcript (or the live fold) into the blocks the
// workflow timeline renders. Kept React-free so node:test can pin the tool
// grouping and reasoning rules without a browser.

export type ToolCategory = "read" | "search" | "memory" | "change" | "outcome" | "other";

export interface TimelineTool {
  key: string;
  name: string;
  args: unknown;
  result?: { text: string; isError: boolean; truncated?: boolean };
  running: boolean;
}

export type TimelineBlock =
  | { kind: "text"; key: string; text: string; streaming?: boolean }
  | { kind: "thinking"; key: string; text: string; redacted?: boolean; streaming?: boolean }
  | { kind: "tools"; key: string; tools: TimelineTool[]; category: ToolCategory }
  | { kind: "user"; key: string; text: string }
  | { kind: "raw"; key: string; label: string; value: unknown };

const READ_TOOLS = new Set(["read_code", "read_file", "read_image", "list_snapshot_files"]);
const SEARCH_TOOLS = new Set(["search_text", "grep", "find_symbol", "find_callers", "find_callees", "find_references"]);
const CHANGE_TOOLS = new Set(["get_change", "get_diff", "diff"]);
const OUTCOME_TOOLS = new Set(["record_candidate", "submit_verdict", "finish_round"]);

export function classifyTool(name: string): ToolCategory {
  if (OUTCOME_TOOLS.has(name)) return "outcome";
  if (READ_TOOLS.has(name)) return "read";
  if (SEARCH_TOOLS.has(name)) return "search";
  if (CHANGE_TOOLS.has(name)) return "change";
  if (/^get_.*memory$/.test(name)) return "memory";
  return "other";
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown, max = 160): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const text = value.trim().replace(/\s+/g, " ");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function toolHint(tool: Pick<TimelineTool, "name" | "args">): string | undefined {
  const args = record(tool.args);
  if (!args) return undefined;
  for (const key of ["path", "file", "query", "pattern", "symbol", "command", "unitId", "displayId", "findingId", "title", "claim", "verdict", "summary"]) {
    const value = stringValue(args[key]);
    if (value) return value;
  }
  return undefined;
}

export function outcomeTitle(tool: Pick<TimelineTool, "name" | "args">): string {
  const args = record(tool.args) ?? {};
  const title = stringValue(args.title) ?? stringValue(args.claim);
  const verdict = stringValue(args.verdict) ?? stringValue(args.status);
  const summary = stringValue(args.summary);
  if (tool.name === "record_candidate") return title ? `Candidate: ${title}` : "Candidate recorded";
  if (tool.name === "submit_verdict") return verdict ? `Verdict: ${verdict}` : "Verdict submitted";
  if (tool.name === "finish_round") return summary ? `Round finished: ${summary}` : "Round finished";
  return tool.name;
}

function pushTool(blocks: TimelineBlock[], tool: TimelineTool): void {
  const category = classifyTool(tool.name);
  const last = blocks.at(-1);
  // Outcome tools are the review's actual artifacts; each gets its own card
  // instead of disappearing into a context-tool count.
  if (category !== "outcome" && last?.kind === "tools" && last.category === category) {
    last.tools.push(tool);
    return;
  }
  blocks.push({ kind: "tools", key: `tools-${tool.key}`, tools: [tool], category });
}

function pushThinking(blocks: TimelineBlock[], block: Extract<TimelineBlock, { kind: "thinking" }>): void {
  const last = blocks.at(-1);
  if (last?.kind === "thinking" && !last.streaming && !block.streaming) {
    last.text = `${last.text}\n\n${block.text}`;
    if (block.redacted) last.redacted = true;
    return;
  }
  blocks.push(block);
}

export function blocksFromTranscript(items: RenderItem[]): TimelineBlock[] {
  const blocks: TimelineBlock[] = [];
  items.forEach((item, index) => {
    if (item.type === "tool") {
      pushTool(blocks, {
        key: item.call.id || `tool-${index}`,
        name: item.call.name,
        args: item.call.arguments,
        ...(item.result ? { result: { text: item.result.text, isError: item.result.isError } } : {}),
        running: false,
      });
      return;
    }
    if (item.type === "text") {
      if (item.text.trim()) blocks.push({ kind: "text", key: `text-${index}`, text: item.text });
      return;
    }
    if (item.type === "thinking") {
      if (item.text.trim()) pushThinking(blocks, { kind: "thinking", key: `thinking-${index}`, text: item.text, ...(item.redacted ? { redacted: true } : {}) });
      return;
    }
    if (item.type === "user") {
      if (item.text.trim()) blocks.push({ kind: "user", key: `user-${index}`, text: item.text });
      return;
    }
    blocks.push({ kind: "raw", key: `raw-${index}`, label: item.label, value: item.value });
  });
  return blocks;
}

export function blocksFromLive(items: LiveItem[]): TimelineBlock[] {
  const blocks: TimelineBlock[] = [];
  items.forEach((item, index) => {
    if (item.type === "tool") {
      pushTool(blocks, {
        key: item.callId || `tool-${index}`,
        name: item.name,
        args: item.args,
        ...(item.result ? { result: item.result } : {}),
        running: item.running,
      });
      return;
    }
    if (item.type === "text") {
      if (item.text.trim() || item.streaming) blocks.push({ kind: "text", key: `text-${index}`, text: item.text, ...(item.streaming ? { streaming: true } : {}) });
      return;
    }
    if (item.type === "thinking") {
      if (item.text.trim() || item.streaming) pushThinking(blocks, { kind: "thinking", key: `thinking-${index}`, text: item.text, ...(item.streaming ? { streaming: true } : {}) });
    }
  });
  return blocks;
}