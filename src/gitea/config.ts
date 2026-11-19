import { readFileSync } from "node:fs";
import path from "node:path";
import { pirConfigDir } from "../rules/project-rules.js";

/**
 * Gitea integration configuration: `gitea.json` in the pir config dir
 * (PIR_CONFIG_DIR or ~/.pir, the same resolution as every other pir config
 * file), or — when `PIR_GITEA_JSON` is set to a non-empty value — that env
 * variable's JSON instead (the deployment-friendly source: docker and secret
 * managers inject env without volume-mounting a file). A missing file with no
 * env is not an error — it means the integration is off. A present-but-invalid
 * source IS an error: a half-parsed webhook secret or token policy is worse
 * than a loud startup failure.
 */

/** Error-context label for the env configuration source; the file path names itself. */
const ENV_SOURCE = "$PIR_GITEA_JSON";

/** Configuration error with the offending file in the message; the endpoint maps it to a usage failure. */
export class GiteaConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GiteaConfigError";
  }
}

/** Per-repo review trigger knobs; every field has a default in DEFAULT_GITEA_TRIGGER_POLICY. */
export interface GiteaTriggerPolicy {
  /** Base branches whose PRs get reviewed; empty = every base branch. */
  baseBranches: string[];
  /** Title prefixes marking a PR as work-in-progress (case-insensitive). */
  wipPrefixes: string[];
  /** PR labels that opt a PR out of review. */
  skipLabels: string[];
  /** Cap passed to the review run's --max-findings. */
  maxFindings: number;
  /** Model override for this policy level; null = inherit the pir-level default. */
  model: string | null;
}

export interface GiteaIntegrationConfig {
  /** Gitea instance base URL, http(s), no trailing slash. */
  url: string;
  /** API token for the bot account (reviews, comments, statuses). */
  token: string;
  /** Shared secret the webhooks are signed with. */
  webhookSecret: string;
  commentLanguage: "en" | "zh-CN";
  /** Commit status posted when findings exist: "success" keeps CI green, "failure" fails the SHA. */
  statusOnFindings: "success" | "failure";
  defaults: GiteaTriggerPolicy;
  /** Per-repo overrides keyed by `owner/name`; unspecified keys inherit from defaults. */
  repos: Record<string, Partial<GiteaTriggerPolicy>>;
}

export function giteaConfigFile(configDir: string): string {
  return path.join(configDir, "gitea.json");
}

export const DEFAULT_GITEA_TRIGGER_POLICY: GiteaTriggerPolicy = {
  baseBranches: ["main"],
  wipPrefixes: ["WIP:", "[WIP]", "Draft:"],
  skipLabels: ["skip-review"],
  maxFindings: 10,
  model: null,
};

const DEFAULT_COMMENT_LANGUAGE: GiteaIntegrationConfig["commentLanguage"] = "en";
const DEFAULT_STATUS_ON_FINDINGS: GiteaIntegrationConfig["statusOnFindings"] = "success";

const POLICY_KEYS = ["baseBranches", "wipPrefixes", "skipLabels", "maxFindings", "model"] as const;
const TOP_LEVEL_KEYS = [
  "url",
  "token",
  "webhookSecret",
  "commentLanguage",
  "statusOnFindings",
  "defaults",
  "repos",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, context: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new GiteaConfigError(`${context}: expected a non-empty string`);
  }
  return value.trim();
}

function stringArray(value: unknown, context: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new GiteaConfigError(`${context}: expected an array of non-empty strings`);
  }
  return value.map((entry) => (entry as string).trim());
}

/** Reject unknown keys so typos (skipLabel, webhook_secret) fail fast instead of silently not applying. */
function rejectUnknownKeys(raw: Record<string, unknown>, allowed: readonly string[], context: string): void {
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) {
      throw new GiteaConfigError(`${context}: unknown key "${key}" (allowed: ${allowed.join(", ")})`);
    }
  }
}

/**
 * Parse one policy object. `context` names it in errors; the result keeps
 * only the keys present so callers decide replace-vs-inherit per key.
 */
function parsePolicyOverride(value: unknown, context: string): Partial<GiteaTriggerPolicy> {
  if (!isRecord(value)) {
    throw new GiteaConfigError(`${context}: expected an object`);
  }
  rejectUnknownKeys(value, POLICY_KEYS, context);
  const out: Partial<GiteaTriggerPolicy> = {};
  if (value.baseBranches !== undefined) out.baseBranches = stringArray(value.baseBranches, `${context}.baseBranches`);
  if (value.wipPrefixes !== undefined) out.wipPrefixes = stringArray(value.wipPrefixes, `${context}.wipPrefixes`);
  if (value.skipLabels !== undefined) out.skipLabels = stringArray(value.skipLabels, `${context}.skipLabels`);
  if (value.maxFindings !== undefined) {
    if (
      typeof value.maxFindings !== "number" ||
      !Number.isSafeInteger(value.maxFindings) ||
      value.maxFindings < 1
    ) {
      throw new GiteaConfigError(`${context}.maxFindings: expected a positive integer`);
    }
    out.maxFindings = value.maxFindings;
  }
  if (value.model !== undefined) {
    // Explicit null = "no override, inherit"; a string pins the model.
    if (value.model !== null && (typeof value.model !== "string" || !value.model.trim())) {
      throw new GiteaConfigError(`${context}.model: expected a model id string or null`);
    }
    out.model = value.model === null ? null : value.model.trim();
  }
  return out;
}

/**
 * Parse and validate one configuration source. `source` names the file path or
 * env label in error messages. Shared by the file and `PIR_GITEA_JSON` paths
 * so the validation contract cannot drift between them.
 */
function parseGiteaConfig(raw: string, source: string): GiteaIntegrationConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new GiteaConfigError(`${source} is not valid JSON: ${(err as Error).message}`);
  }
  if (!isRecord(parsed)) {
    throw new GiteaConfigError(`${source}: expected a JSON object`);
  }
  rejectUnknownKeys(parsed, TOP_LEVEL_KEYS, source);

  const url = parseGiteaUrl(parsed.url, source);

  const commentLanguage =
    parsed.commentLanguage === undefined ? DEFAULT_COMMENT_LANGUAGE : parsed.commentLanguage;
  if (commentLanguage !== "en" && commentLanguage !== "zh-CN") {
    throw new GiteaConfigError(`${source}: commentLanguage must be "en" or "zh-CN"`);
  }
  const statusOnFindings =
    parsed.statusOnFindings === undefined ? DEFAULT_STATUS_ON_FINDINGS : parsed.statusOnFindings;
  if (statusOnFindings !== "success" && statusOnFindings !== "failure") {
    throw new GiteaConfigError(`${source}: statusOnFindings must be "success" or "failure"`);
  }

  const defaultsOverride =
    parsed.defaults === undefined ? {} : parsePolicyOverride(parsed.defaults, `${source}: defaults`);
  const defaults: GiteaTriggerPolicy = { ...DEFAULT_GITEA_TRIGGER_POLICY, ...defaultsOverride };

  const repos: Record<string, Partial<GiteaTriggerPolicy>> = {};
  if (parsed.repos !== undefined) {
    if (!isRecord(parsed.repos)) {
      throw new GiteaConfigError(`${source}: repos must be an object keyed by "owner/name"`);
    }
    for (const [repoFullName, policy] of Object.entries(parsed.repos)) {
      repos[repoFullName] = parsePolicyOverride(policy, `${source}: repos["${repoFullName}"]`);
    }
  }

  return {
    url,
    token: requireString(parsed.token, `${source}: token`),
    webhookSecret: requireString(parsed.webhookSecret, `${source}: webhookSecret`),
    commentLanguage,
    statusOnFindings,
    defaults,
    repos,
  };
}

/**
 * Load the Gitea integration config. Precedence: a non-empty `PIR_GITEA_JSON`
 * env variable wins and is parsed as the config JSON (same validation, errors
 * name `$PIR_GITEA_JSON`); otherwise `<configDir>/gitea.json`. Missing file
 * and no env → null (integration off). An invalid source → GiteaConfigError
 * naming the source and the offending key.
 */
export function loadGiteaConfig(configDir: string = pirConfigDir()): GiteaIntegrationConfig | null {
  const envRaw = process.env.PIR_GITEA_JSON;
  if (envRaw !== undefined && envRaw.trim() !== "") {
    return parseGiteaConfig(envRaw, ENV_SOURCE);
  }
  const file = giteaConfigFile(configDir);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new GiteaConfigError(`cannot read ${file}: ${(err as Error).message}`);
  }
  return parseGiteaConfig(raw, file);
}

/** http(s) URL, trailing slashes stripped so client path joins never double-slash. */
function parseGiteaUrl(value: unknown, context: string): string {
  const url = requireString(value, `${context}: url`);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new GiteaConfigError(`${context}: url is not a valid URL: ${url}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new GiteaConfigError(`${context}: url must be http(s)://…, got: ${url}`);
  }
  return url.replace(/\/+$/, "");
}

/**
 * Effective policy for one repository: defaults merged with the repo's
 * override — array fields replace wholesale (never concatenate), scalars
 * replace, and `model: null` inherits the default model.
 */
export function resolveTriggerPolicy(
  config: GiteaIntegrationConfig,
  repoFullName: string,
): GiteaTriggerPolicy {
  const defaults = config.defaults;
  const override = config.repos[repoFullName];
  // A copy either way: callers may not mutate (and thereby rewire) config.defaults.
  if (override === undefined) return { ...defaults };
  return {
    baseBranches: override.baseBranches ?? defaults.baseBranches,
    wipPrefixes: override.wipPrefixes ?? defaults.wipPrefixes,
    skipLabels: override.skipLabels ?? defaults.skipLabels,
    maxFindings: override.maxFindings ?? defaults.maxFindings,
    model: override.model ?? defaults.model,
  };
}
