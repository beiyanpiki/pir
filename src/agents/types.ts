import type { TSchema } from "typebox";

/**
 * Pi-independent tool contract. The session factory adapts these to pi
 * ToolDefinitions, so core review logic stays testable without the SDK.
 */
export interface AgentToolOutput {
  /** Model-facing result text. */
  text: string;
  /** When true the agent run ends after this tool call. */
  terminate?: boolean;
}

export interface ReviewTool {
  name: string;
  description: string;
  parameters: TSchema;
  /** One-line snippet for the system prompt's available-tools section. */
  promptSnippet?: string;
  execute: (params: Record<string, unknown>) => Promise<AgentToolOutput>;
}

/** Measured SDK usage; output already includes any billed reasoning tokens. */
export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  cost: number;
  durationMs: number;
  toolCalls: number;
  /** Repeated executions of the same read/search tool with identical arguments. */
  repeatedToolCalls: number;
}

export interface AgentHandle {
  prompt(text: string): Promise<void>;
  getLastAssistantText(): string | undefined;
  /** Provider/transport error of the last turn, when pi swallowed it into the assistant message instead of rejecting. */
  getLastAssistantError(): string | undefined;
  /** Cumulative measured usage, including compactions and creation time; undefined if unavailable. */
  getUsage?(): SessionUsage | undefined;
  dispose(): void;
}

export interface SessionConfig {
  cwd: string;
  /** Trusted role description installed in the actual read-only system prompt. */
  systemRole: string;
  tools: ReviewTool[];
  /** Names of pi builtin tools the session may use (read-only set). */
  builtinTools: string[];
  /** Model id override; falls back to pi settings when unset. */
  model?: string;
  /**
   * When set, the final SDK message snapshot (retained thinking included) is
   * dumped here as JSON once the prompt settles — not provider wire traffic.
   * Compaction can replace earlier messages; see transcripts.ts.
   */
  transcriptFile?: string;
  /**
   * Live observation tap: receives every SDK session event (deltas, message
   * ends, tool executions) as-is. Purely observational — errors thrown by the
   * callback would fail the review, so consumers must not throw.
   */
  onEvent?: (event: unknown) => void;
}

export interface AgentSessionFactory {
  createSession(config: SessionConfig): Promise<AgentHandle>;
}

export const READONLY_BUILTIN_TOOLS = ["read", "grep", "find", "ls"] as const;
