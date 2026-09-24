import { readFileSync } from "node:fs";
import process from "node:process";
import path from "node:path";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";

/** One row of the pi model catalog, flattened for CLI/JSON output. */
export interface CatalogModel {
  provider: string;
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  images: boolean;
  /** Whether pi has credentials for this model's provider. */
  authenticated: boolean;
}

export interface ListModelsOptions {
  /** true: full static catalog; false (default): only authenticated providers. */
  all?: boolean;
  /** Restrict to one provider id (case-insensitive). */
  provider?: string;
  /** Case-insensitive substring filter over provider, id and name. */
  search?: string;
}

export interface ListModelsResult {
  models: CatalogModel[];
  /** pi catalog load diagnostics, if any (non-fatal). */
  loadError?: string;
}

export interface StartupModel {
  modelSpec?: string;
  thinking?: string;
}

/**
 * Sub-sessions deliberately load resources from an EMPTY agentDir (no user
 * extensions), so they cannot see the user's startup model selection. This
 * reads the real ~/.pi/agent/settings.json so reviewer/verifier sessions use
 * the same default model as interactive pi.
 */
export function readPiStartupModel(): StartupModel {
  try {
    const settings = JSON.parse(readFileSync(path.join(getAgentDir(), "settings.json"), "utf8")) as {
      defaultProvider?: string;
      defaultModel?: string;
      defaultThinkingLevel?: string;
    };
    const prefix = settings.defaultProvider ? `${settings.defaultProvider}/` : "";
    const modelSpec = settings.defaultModel ? `${prefix}${settings.defaultModel}` : undefined;
    return { modelSpec, thinking: settings.defaultThinkingLevel };
  } catch {
    return {};
  }
}

/** Default model spec in precedence order: PIR_MODEL env, then pi settings. */
export function currentDefaultModelSpec(): string | undefined {
  return process.env.PIR_MODEL || readPiStartupModel().modelSpec || undefined;
}

/**
 * List models from pi's catalog. `ModelRuntime.create()` uses the offline
 * static catalog by default (no network), so this works in any environment.
 */
export async function listPiModels(options: ListModelsOptions = {}): Promise<ListModelsResult> {
  const runtime = await ModelRuntime.create();
  const loadError = runtime.getError();
  const base = options.all ? [...runtime.getModels()] : [...(await runtime.getAvailable())];
  let models: CatalogModel[] = base.map((m) => ({
    provider: m.provider,
    id: m.id,
    name: m.name,
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
    reasoning: Boolean(m.reasoning),
    images: m.input.includes("image"),
    authenticated: runtime.hasConfiguredAuth(m.provider),
  }));
  if (options.provider) {
    const provider = options.provider.toLowerCase();
    models = models.filter((m) => m.provider.toLowerCase() === provider);
  }
  if (options.search) {
    const search = options.search.toLowerCase();
    models = models.filter((m) => `${m.provider} ${m.id} ${m.name}`.toLowerCase().includes(search));
  }
  models.sort((a, b) =>
    a.provider === b.provider ? a.id.localeCompare(b.id) : a.provider.localeCompare(b.provider),
  );
  return { models, loadError };
}
