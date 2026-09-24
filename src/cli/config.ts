import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";

/** Usage-level error in config handling; the CLI maps it to exit code 2. */
export class UsageError extends Error {}

export interface ServerSettings {
  url: string;
  token?: string;
  insecure?: boolean;
}

export interface UserConfig {
  schemaVersion: 1;
  mode: "local" | "remote";
  /** Remote pir serve endpoint; required when mode is "remote". */
  server?: ServerSettings;
  /** Default model for local review/verify sessions ("<provider>/<model>" or fuzzy id). */
  model?: string;
}

/**
 * Where this invocation actually executes. Remote mode forwards everything
 * through POST /v1/exec (find-family via git bundles); local runs in-process.
 */
export type Transport =
  | { mode: "local" }
  | { mode: "remote"; url: string; token?: string; insecure: boolean };

export function configDir(): string {
  return process.env.PIR_CONFIG_DIR ?? path.join(os.homedir(), ".pir");
}

export function configPath(): string {
  return path.join(configDir(), "config.json");
}

/** Load ~/.pir/config.json; null when absent. Malformed files are an error, not a silent default. */
export function loadUserConfig(): UserConfig | null {
  const file = configPath();
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new UsageError(`cannot read ${file}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new UsageError(`${file} is not valid JSON: ${(err as Error).message} — fix it or re-run \`pir config\``);
  }
  return validateUserConfig(parsed, file);
}

function validateUserConfig(value: unknown, file: string): UserConfig {
  if (typeof value !== "object" || value === null) {
    throw new UsageError(`${file}: expected a JSON object`);
  }
  const raw = value as Record<string, unknown>;
  const mode = raw.mode;
  if (mode !== "local" && mode !== "remote") {
    throw new UsageError(`${file}: "mode" must be "local" or "remote"`);
  }
  const config: UserConfig = { schemaVersion: 1, mode };
  if (typeof raw.model === "string" && raw.model.trim()) config.model = raw.model.trim();
  if (raw.server !== undefined) {
    if (typeof raw.server !== "object" || raw.server === null) {
      throw new UsageError(`${file}: "server" must be an object`);
    }
    const server = raw.server as Record<string, unknown>;
    const url = parseServerUrl(server.url, file);
    if (url) {
      config.server = { url };
      if (typeof server.token === "string" && server.token) config.server.token = server.token;
      if (server.insecure === true) config.server.insecure = true;
    }
  }
  if (mode === "remote" && !config.server?.url) {
    throw new UsageError(
      `${file}: mode "remote" requires server.url (run \`pir config\` or \`pir config set server.url <url>\`)`,
    );
  }
  return config;
}

function parseServerUrl(value: unknown, context: string): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string") throw new UsageError(`${context}: server.url must be a string`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UsageError(`${context}: server.url is not a valid URL: ${value}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new UsageError(`${context}: server.url must be http(s)://…, got: ${value}`);
  }
  return value.replace(/\/+$/, "");
}

/** Persist with owner-only permissions — the file may hold a bearer token. */
export function saveUserConfig(config: UserConfig): string {
  const dir = configDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* umask quirks on exotic filesystems; best effort */
  }
  const file = configPath();
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* best effort */
  }
  return file;
}

export function deleteUserConfig(): boolean {
  const file = configPath();
  const existed = existsSync(file);
  if (existed) rmSync(file);
  return existed;
}

export function maskSecret(secret: string | undefined): string {
  if (!secret) return "(none)";
  if (secret.length <= 8) return "••••";
  return `${secret.slice(0, 4)}…${secret.slice(-4)}`;
}

/**
 * Decide where this invocation runs. Pure — no IO — so precedence is testable:
 * --server flag > --local flag > PIR_SERVER_URL > PIR_MODE > config file > local.
 * Token/insecure resolve per-invocation: flag > env > config file.
 */
export function resolveTransport(input: {
  argv: string[];
  env: Record<string, string | undefined>;
  config: UserConfig | null;
}): Transport {
  const { argv, env, config } = input;
  const serverFlag = flagValue(argv, "--server");
  const hasLocalFlag = argv.includes("--local");
  if (serverFlag && hasLocalFlag) {
    throw new UsageError("--server and --local are mutually exclusive");
  }
  if (serverFlag) return remoteTransport(serverFlag, argv, env, config);
  if (hasLocalFlag) return { mode: "local" };
  if (env.PIR_SERVER_URL) return remoteTransport(env.PIR_SERVER_URL, argv, env, config);
  if (env.PIR_MODE === "remote") return remoteTransport(undefined, argv, env, config);
  if (env.PIR_MODE === "local") return { mode: "local" };
  if (config?.mode === "remote") return remoteTransport(undefined, argv, env, config);
  return { mode: "local" };
}

function remoteTransport(
  explicitUrl: string | undefined,
  argv: string[],
  env: Record<string, string | undefined>,
  config: UserConfig | null,
): Transport {
  const url = explicitUrl ?? config?.server?.url;
  if (!url) {
    throw new UsageError(
      "remote mode needs a server URL — pass --server <url>, set PIR_SERVER_URL, or run `pir config`",
    );
  }
  const parsed = parseServerUrl(url, explicitUrl ? `--server ${explicitUrl}` : configPath());
  const token = flagValue(argv, "--token") ?? env.PIR_SERVER_TOKEN ?? config?.server?.token;
  const insecure =
    argv.includes("--insecure") || env.PIR_INSECURE === "1" || config?.server?.insecure === true;
  return { mode: "remote", url: parsed!, token, insecure };
}

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i >= 0) return argv[i + 1];
  const prefixed = argv.find((a) => a.startsWith(`${name}=`));
  return prefixed ? prefixed.slice(name.length + 1) : undefined;
}

export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/**
 * First-run setup wizard. Asks mode (local/remote), the remote endpoint when
 * applicable, and an optional default model; writes ~/.pir/config.json.
 */
export async function runWizard(): Promise<UserConfig> {
  if (!isInteractive()) {
    throw new UsageError(
      `pir config needs an interactive terminal — create ${configPath()} manually instead\n` +
        '(minimum: {"schemaVersion":1,"mode":"local"})',
    );
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write("pir first-run setup — settings are saved to " + configPath() + "\n\n");

    let mode: "local" | "remote";
    for (;;) {
      const answer = (await rl.question("Run reviews [1] locally or [2] on a remote pir server? [1] ")).trim().toLowerCase();
      if (answer === "" || answer === "1" || answer === "l" || answer === "local") {
        mode = "local";
        break;
      }
      if (answer === "2" || answer === "r" || answer === "remote") {
        mode = "remote";
        break;
      }
      process.stdout.write("  answer 1, 2, local or remote\n");
    }

    const config: UserConfig = { schemaVersion: 1, mode };

    if (mode === "remote") {
      let url = "";
      for (;;) {
        url = (await rl.question("Server URL (e.g. https://pir.svc:8790): ")).trim().replace(/\/+$/, "");
        try {
          const parsed = new URL(url);
          if (parsed.protocol === "https:" || parsed.protocol === "http:") break;
        } catch {
          /* re-prompt */
        }
        process.stdout.write("  enter a valid http(s):// URL\n");
      }
      const token = (await rl.question("Bearer token (empty if the server has none; input is echoed): ")).trim();
      const insecureAnswer = (
        await rl.question("Accept the server's self-signed certificate? [Y/n] ")
      ).trim().toLowerCase();
      config.server = { url, ...(token ? { token } : {}), ...(insecureAnswer === "" || insecureAnswer.startsWith("y") ? { insecure: true } : {}) };
    }

    const model = (
      await rl.question(
        'Default model for review sessions, e.g. anthropic/claude-opus-4 (empty = keep pi settings; browse with `pir models --all`): ',
      )
    ).trim();
    if (model) config.model = model;

    const file = saveUserConfig(config);
    process.stdout.write(`\nsaved ${file} (chmod 600)\n`);
    if (config.server) {
      process.stdout.write(
        `remote: ${config.server.url} | token ${maskSecret(config.server.token)} | tls ${
          config.server.insecure ? "self-signed accepted (--insecure)" : "verified"
        }\n`,
      );
    }
    if (config.model) process.stdout.write(`model: ${config.model}\n`);
    return config;
  } finally {
    rl.close();
  }
}

/**
 * `pir config set <key> <value>` — dotted keys: mode, model, server.url,
 * server.token, server.insecure. Empty string clears model/server.token.
 */
export function setConfigValue(config: UserConfig, key: string, value: string): UserConfig {
  const next: UserConfig = { schemaVersion: 1, mode: config.mode, ...(config.model ? { model: config.model } : {}) };
  if (config.server) next.server = { ...config.server };

  switch (key) {
    case "mode": {
      if (value !== "local" && value !== "remote") {
        throw new UsageError("mode must be local or remote");
      }
      if (value === "remote" && !next.server?.url) {
        throw new UsageError('set server.url before mode=remote (or run `pir config` for the wizard)');
      }
      next.mode = value;
      return next;
    }
    case "model": {
      const trimmed = value.trim();
      if (trimmed) next.model = trimmed;
      else delete next.model;
      return next;
    }
    case "server.url": {
      const url = parseServerUrl(value, `config set server.url ${value}`);
      if (!url) throw new UsageError("server.url cannot be empty");
      const server: ServerSettings = { url };
      if (next.server?.token) server.token = next.server.token;
      if (next.server?.insecure) server.insecure = true;
      next.server = server;
      return next;
    }
    case "server.token": {
      if (!next.server?.url) {
        throw new UsageError("set server.url before server.token");
      }
      const server: ServerSettings = { url: next.server.url };
      const trimmed = value.trim();
      if (trimmed) server.token = trimmed;
      if (next.server.insecure) server.insecure = true;
      next.server = server;
      return next;
    }
    case "server.insecure": {
      if (!next.server?.url) {
        throw new UsageError("set server.url before server.insecure");
      }
      const normalized = value.trim().toLowerCase();
      if (!["true", "false", "1", "0", "yes", "no"].includes(normalized)) {
        throw new UsageError("server.insecure must be true or false");
      }
      const server: ServerSettings = { url: next.server.url, insecure: ["true", "1", "yes"].includes(normalized) };
      if (next.server.token) server.token = next.server.token;
      next.server = server;
      return next;
    }
    default:
      throw new UsageError(
        `unknown config key: ${key} (expected mode, model, server.url, server.token or server.insecure)`,
      );
  }
}
