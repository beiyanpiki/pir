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

export interface AgentHandle {
  prompt(text: string): Promise<void>;
  getLastAssistantText(): string | undefined;
  /** Provider/transport error of the last turn, when pi swallowed it into the assistant message instead of rejecting. */
  getLastAssistantError(): string | undefined;
  dispose(): void;
}

export interface SessionConfig {
  cwd: string;
  /** High-level role description prepended to the task prompt. */
  systemRole: string;
  tools: ReviewTool[];
  /** Names of pi builtin tools the session may use (read-only set). */
  builtinTools: string[];
  /** Model id override; falls back to pi settings when unset. */
  model?: string;
}

export interface AgentSessionFactory {
  createSession(config: SessionConfig): Promise<AgentHandle>;
}

export const READONLY_BUILTIN_TOOLS = ["read", "grep", "find", "ls"] as const;
