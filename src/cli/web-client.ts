import { UsageError } from "./executor.js";
import { remoteDispatcher, describeTransportError } from "./remote-fetch.js";
import type { UserConfig } from "./config.js";

/**
 * Client for a pir serve instance's READ-ONLY web API (`--web`, GET /api/…)
 * — the tier a browser uses. It is a separate surface from /v1/* with its
 * own optional credential (PIR_WEB_UI_TOKEN server-side), so recovery
 * commands keyed on a run URL (#48/#49) must never assume the execution
 * token works there, and vice versa (#50).
 */

/** A run reference taken from a web URL or explicit flags. */
export interface RunRef {
  origin: string;
  projectId: string;
  runId: string;
}

const PROJECT_ID_RE = /^[0-9a-f]{64}$/;
const RUN_ID_RE = /^[\w-]+$/;

/**
 * Parse `<origin>/runs/<projectId>/<runId>` (the URL the web UI and receipts
 * hand out). Extra path segments are refused — a pasted-along `/findings`
 * would silently change which resource is meant; query strings are ignored.
 * Returns null when the value is not a run URL at all.
 */
export function parseRunUrl(value: string): RunRef | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const parts = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
  if (parts.length !== 3 || parts[0] !== "runs") return null;
  const [, projectId, runId] = parts as [string, string, string];
  if (!PROJECT_ID_RE.test(projectId) || !RUN_ID_RE.test(runId)) return null;
  return { origin: url.origin, projectId, runId };
}

/**
 * Origin bindings for web-tier credentials (dogfood F-45): env credentials
 * (PIR_VIEWER_TOKEN / PIR_INSECURE) belong to the server named by --server
 * or PIR_SERVER_URL; config credentials (server.viewerToken /
 * server.insecure) belong to config server.url and ONLY to it — a transient
 * --server flag must not carry them to a different host.
 */
function envBoundOrigin(input: {
  argv: string[];
  env: Record<string, string | undefined>;
}): string | null {
  const raw = flagValue(input.argv, "--server") ?? input.env.PIR_SERVER_URL;
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

function configBoundOrigin(config: UserConfig | null): string | null {
  const raw = config?.server?.url;
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

/**
 * Viewer credential for a web-API request (#50). Precedence mirrors the
 * execution token (--viewer-token > PIR_VIEWER_TOKEN > config
 * server.viewerToken), with one hard rule: non-flag credentials are only
 * ever sent to the origin they were bound to. A run URL pasted from anywhere
 * gets either the explicit flag or an anonymous request — never another
 * server's token. The two credential kinds (viewer vs execution) never fall
 * back to each other.
 */
export function resolveViewerToken(target: string | URL, input: {
  argv?: string[];
  env: Record<string, string | undefined>;
  config: UserConfig | null;
}): { token?: string; originMatchesConfig: boolean } {
  const argv = input.argv ?? [];
  const explicit = flagValue(argv, "--viewer-token");
  if (explicit) return { token: explicit, originMatchesConfig: false };
  const origin = new URL(target.toString()).origin;
  const originMatchesConfig = configBoundOrigin(input.config) === origin;
  if (originMatchesConfig) {
    const token = input.env.PIR_VIEWER_TOKEN ?? input.config?.server?.viewerToken;
    return { ...(token ? { token } : {}), originMatchesConfig };
  }
  // Not the config's server: only the env credential, and only when this
  // invocation's --server/PIR_SERVER_URL actually names the target.
  if (envBoundOrigin({ argv, env: input.env }) === origin && input.env.PIR_VIEWER_TOKEN) {
    return { token: input.env.PIR_VIEWER_TOKEN, originMatchesConfig };
  }
  return { originMatchesConfig };
}

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i >= 0) return argv[i + 1];
  const prefixed = argv.find((a) => a.startsWith(`${name}=`));
  return prefixed ? prefixed.slice(name.length + 1) : undefined;
}

export type WebApiErrorKind = "unknown-run" | "no-web" | "auth" | "transport" | "server";

export class WebApiError extends Error {
  readonly kind: WebApiErrorKind;
  readonly status?: number;
  constructor(kind: WebApiErrorKind, message: string, status?: number) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

/**
 * TLS verification opt-out for a web request (dogfood F-41/F-45): the same
 * three switches the /v1 transport honors. Flag and env apply to any target;
 * config server.insecure only to config server.url's origin — accepting
 * self-signed certs for a server the user never configured is not theirs to
 * relax, and a --server flag does not rebind it.
 */
export function resolveInsecure(target: string | URL, input: {
  argv: string[];
  env: Record<string, string | undefined>;
  config: UserConfig | null;
}): boolean {
  if (input.argv.includes("--insecure")) return true;
  if (input.env.PIR_INSECURE === "1") return true;
  if (input.config?.server?.insecure !== true) return false;
  return configBoundOrigin(input.config) === new URL(target.toString()).origin;
}

export const VIEWER_TOKEN_HINT =
  "this server requires a viewer token for /api — pass --viewer-token <t>, set PIR_VIEWER_TOKEN, or `pir config set server.viewerToken <t>` " +
  "(it is the server's PIR_WEB_UI_TOKEN, separate from the --token execution credential)";

/** Credentials to attach to a web-API request. */
export interface WebFetchContext {
  viewerToken?: string;
}

/**
 * GET one /api resource. Errors are classified, not stringly: callers
 * translate kinds into the right message and exit code, and tests assert on
 * kinds instead of prose.
 */
export async function fetchWebApi<T>(origin: string, pathname: string, context: WebFetchContext = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(new URL(pathname, origin), {
      method: "GET",
      dispatcher: remoteDispatcher(),
      headers: {
        accept: "application/json",
        ...(context.viewerToken ? { authorization: `Bearer ${context.viewerToken}` } : {}),
      },
    });
  } catch (err) {
    throw new WebApiError("transport", `cannot reach ${origin}: ${describeTransportError(err)}`);
  }
  const payload = (await response.json().catch(() => null)) as
    | { error?: string; endpoints?: string[] }
    | null;
  if (response.status === 401 || response.status === 403) {
    throw new WebApiError("auth", VIEWER_TOKEN_HINT, response.status);
  }
  if (response.status === 404) {
    // The serve process answers unknown non-/v1 paths with a JSON body that
    // lists its endpoints; the web tier's 404s never do. That list is the
    // difference between "no such run" and "no web capability at all".
    if (Array.isArray(payload?.endpoints)) {
      throw new WebApiError(
        "no-web",
        `${origin} serves the JSON API but not the web UI — ask the operator to restart \`pir serve --web\` (run data is intact)`,
        404,
      );
    }
    const foreign = payload === null ? " (and the response was not pir JSON — check scheme, host and port)" : "";
    throw new WebApiError("unknown-run", `${payload?.error ?? "not found"}${foreign}`, 404);
  }
  if (!response.ok) {
    throw new WebApiError("server", payload?.error ?? `server error ${response.status}`, response.status);
  }
  // A 2xx body that is not pir JSON (a proxy's HTML error page with a fake
  // status, a truncated response) must classify here (dogfood F-42) — the
  // callers would otherwise crash dereferencing null.
  if (payload === null || typeof payload !== "object") {
    throw new WebApiError("server", `response was not pir JSON (status ${response.status})`, response.status);
  }
  return payload as T;
}

/**
 * `--server <url> --project <id> --run <id>` — the flag form of a run URL
 * for scripts that already know the pieces. Validated as strictly as
 * parseRunUrl. Expects the flags of the RAW argv (transport flags included).
 */
export function runRefFromFlags(flags: Map<string, string | boolean>): RunRef {
  const server = typeof flags.get("--server") === "string" ? (flags.get("--server") as string) : undefined;
  const project = typeof flags.get("--project") === "string" ? (flags.get("--project") as string) : undefined;
  const run = typeof flags.get("--run") === "string" ? (flags.get("--run") as string) : undefined;
  if (!server || !project || !run) {
    throw new UsageError(
      "pir runs needs a run URL (`pir runs status <origin>/runs/<projectId>/<runId>`) or all of --server <url> --project <id> --run <id>",
    );
  }
  let url: URL;
  try {
    url = new URL(server);
  } catch {
    throw new UsageError(`--server is not a valid URL: ${server}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UsageError(`--server must be http(s)://…, got: ${server}`);
  }
  if (!PROJECT_ID_RE.test(project)) throw new UsageError(`--project must be a 64-hex project id, got: ${project}`);
  if (!RUN_ID_RE.test(run)) throw new UsageError(`--run must match [\\w-]+, got: ${run}`);
  return { origin: url.origin, projectId: project, runId: run };
}

/**
 * The run URL form receipts and hints print: origin + /runs/… — stable
 * enough to grep for in output.
 */
export function runUrl(ref: RunRef): string {
  return `${ref.origin}/runs/${ref.projectId}/${ref.runId}`;
}

/**
 * Resolve the target for runs/findings commands from raw argv: a run URL
 * (positional for `runs status`, the --run value for findings) wins, then
 * the --server/--project/--run trio. Null when neither is present (the
 * caller decides whether that is a usage error).
 */
export function resolveRunRef(positional: string[], flags: Map<string, string | boolean>): RunRef | null {
  for (const token of positional) {
    const ref = parseRunUrl(token);
    if (ref) return ref;
  }
  const runFlag = flags.get("--run");
  if (typeof runFlag === "string") {
    const ref = parseRunUrl(runFlag);
    if (ref) return ref;
  }
  if (!flags.has("--run") && !flags.has("--project")) return null;
  return runRefFromFlags(flags);
}
