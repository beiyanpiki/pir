import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ModelRuntime,
  resolveCliModel,
  SessionManager,
  type CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";
import type { AgentHandle, AgentSessionFactory, ReviewTool, SessionConfig } from "./types.js";

type SessionModel = NonNullable<CreateAgentSessionOptions["model"]>;
type SessionThinkingLevel = NonNullable<CreateAgentSessionOptions["thinkingLevel"]>;

/**
 * The ONLY module that imports the pi SDK. Sub-sessions run with:
 * - SessionManager.inMemory() — no persisted conversation, disposed afterwards
 * - an empty agentDir resource loader — user extensions/skills never load
 * - a builtin-tool allowlist — read-only builtins plus our custom tools
 * Model/auth still come from the real pi config via ModelRuntime.
 */
export class PiSessionFactory implements AgentSessionFactory {
  private runtimePromise: Promise<ModelRuntime> | null = null;

  private runtime(): Promise<ModelRuntime> {
    this.runtimePromise ??= ModelRuntime.create();
    return this.runtimePromise;
  }

  async createSession(config: SessionConfig): Promise<AgentHandle> {
    const emptyAgentDir = mkdtempSync(path.join(tmpdir(), "pir-session-"));
    const loader = new DefaultResourceLoader({ cwd: config.cwd, agentDir: emptyAgentDir });
    await loader.reload();

    let model: SessionModel | undefined;
    let thinkingLevel: SessionThinkingLevel | undefined;
    if (config.model) {
      const runtime = await this.runtime();
      const resolved = resolveCliModel({ cliModel: config.model, modelRuntime: runtime });
      if (resolved.error || !resolved.model) {
        throw new Error(resolved.error ?? `could not resolve model: ${config.model}`);
      }
      model = resolved.model;
      if (resolved.thinkingLevel && resolved.thinkingLevel !== "off") {
        thinkingLevel = resolved.thinkingLevel;
      }
    }

    const customTools = config.tools.map((tool) => adaptTool(tool));
    const { session } = await createAgentSession({
      cwd: config.cwd,
      model,
      thinkingLevel,
      tools: [...config.builtinTools],
      customTools,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(config.cwd),
    });

    return {
      prompt: (text) => session.prompt(text),
      getLastAssistantText: () => session.getLastAssistantText(),
      dispose: () => {
        try {
          session.dispose();
        } finally {
          rmSync(emptyAgentDir, { recursive: true, force: true });
        }
      },
    };
  }
}

function adaptTool(tool: ReviewTool) {
  return defineTool({
    name: tool.name,
    label: tool.name,
    description: tool.description,
    promptSnippet: tool.promptSnippet,
    parameters: tool.parameters,
    async execute(_toolCallId, params) {
      const out = await tool.execute(params as Record<string, unknown>);
      return {
        content: [{ type: "text" as const, text: out.text }],
        details: undefined,
        terminate: out.terminate,
      };
    },
  });
}
