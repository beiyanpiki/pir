import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  getAgentDir,
  ModelRuntime,
  resolveCliModel,
  SessionManager,
  type CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";
import type { AgentHandle, AgentSessionFactory, ReviewTool, SessionConfig } from "./types.js";

type SessionModel = NonNullable<CreateAgentSessionOptions["model"]>;
type SessionThinkingLevel = NonNullable<CreateAgentSessionOptions["thinkingLevel"]>;

interface PiStartupModel {
  modelSpec?: string;
  thinking?: SessionThinkingLevel;
}

/**
 * Sub-sessions deliberately load resources from an EMPTY agentDir (no user
 * extensions), so they cannot see the user's startup model selection. This
 * reads the real ~/.pi/agent/settings.json so reviewer/verifier sessions use
 * the same default model as interactive pi.
 */
function readPiStartupModel(): PiStartupModel {
  try {
    const settings = JSON.parse(readFileSync(path.join(getAgentDir(), "settings.json"), "utf8")) as {
      defaultProvider?: string;
      defaultModel?: string;
      defaultThinkingLevel?: string;
    };
    const prefix = settings.defaultProvider ? `${settings.defaultProvider}/` : "";
    const modelSpec = settings.defaultModel ? `${prefix}${settings.defaultModel}` : undefined;
    const raw = settings.defaultThinkingLevel;
    const thinking = ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(raw ?? "")
      ? (raw as SessionThinkingLevel)
      : undefined;
    return { modelSpec, thinking };
  } catch {
    return {};
  }
}

/**
 * The ONLY module that imports the pi SDK. Sub-sessions run with:
 * - SessionManager.inMemory() — no persisted conversation, disposed afterwards
 * - an empty agentDir resource loader — user extensions/skills never load
 * - a builtin-tool allowlist — read-only builtins plus our custom tools
 * Model/auth still come from the real pi config via ModelRuntime.
 */
export class PiSessionFactory implements AgentSessionFactory {
  private runtimePromise: Promise<ModelRuntime> | null = null;
  private startupModel: PiStartupModel | null = null;

  private runtime(): Promise<ModelRuntime> {
    this.runtimePromise ??= ModelRuntime.create();
    return this.runtimePromise;
  }

  private defaultModel(): PiStartupModel {
    this.startupModel ??= readPiStartupModel();
    return this.startupModel;
  }

  async createSession(config: SessionConfig): Promise<AgentHandle> {
    const emptyAgentDir = mkdtempSync(path.join(tmpdir(), "pir-session-"));
    const loader = new DefaultResourceLoader({ cwd: config.cwd, agentDir: emptyAgentDir });
    await loader.reload();

    let model: SessionModel | undefined;
    let thinkingLevel: SessionThinkingLevel | undefined;
    const requested = config.model ?? this.defaultModel().modelSpec;
    if (requested) {
      const runtime = await this.runtime();
      const cliProvider = requested.includes("/") ? requested.slice(0, requested.indexOf("/")) : undefined;
      const cliModel = requested.includes("/") ? requested.slice(requested.indexOf("/") + 1) : requested;
      const resolved = resolveCliModel({
        cliProvider,
        cliModel,
        cliThinking: this.defaultModel().thinking,
        modelRuntime: runtime,
      });
      if (resolved.error || !resolved.model) {
        throw new Error(resolved.error ?? `could not resolve model: ${requested}`);
      }
      model = resolved.model;
      if (resolved.thinkingLevel && resolved.thinkingLevel !== "off") {
        thinkingLevel = resolved.thinkingLevel;
      }
    }

    const customTools = config.tools.map((tool) => adaptTool(tool));
    // The tools array is a strict allowlist: custom tool names must be listed
    // alongside the read-only builtins or they get filtered out of the session.
    const { session } = await createAgentSession({
      cwd: config.cwd,
      model,
      thinkingLevel,
      tools: [...config.builtinTools, ...config.tools.map((tool) => tool.name)],
      customTools,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(config.cwd),
    });

    return {
      prompt: (text) => session.prompt(text),
      getLastAssistantText: () => session.getLastAssistantText(),
      getLastAssistantError: () => {
        const messages = session.messages;
        for (let i = messages.length - 1; i >= 0; i--) {
          const message = messages[i]!;
          if (message.role === "assistant") {
            return message.errorMessage ?? undefined;
          }
        }
        return undefined;
      },
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
