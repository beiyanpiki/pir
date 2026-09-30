import process from "node:process";
import { Agent } from "undici";
import { UsageError } from "./executor.js";

/**
 * Transport plumbing shared by the remote client paths (remote.ts,
 * services.ts). Node's global fetch is undici with an Agent whose defaults
 * — headersTimeout = bodyTimeout = 300 s — abort any request that waits
 * longer than 5 minutes for response headers (#32). pir serve only answers
 * once the enqueued task settles, so a long review deterministically dies at
 * ~300 s client-side while the server keeps working. The dispatcher here
 * raises both timers, sized from PIR_REMOTE_TIMEOUT.
 */

/** Default wait for a remote task: 30 minutes, in milliseconds. */
export const DEFAULT_REMOTE_TIMEOUT_MS = 30 * 60_000;

/**
 * PIR_REMOTE_TIMEOUT, in seconds: how long the client waits for response
 * headers (and between body chunks) from a pir serve instance. `0` disables
 * the timers entirely. Invalid values are usage errors rather than silent
 * fallbacks — a typo'd "18OO" must not quietly shorten an audit.
 */
export function remoteTimeoutMs(): number {
  const raw = process.env.PIR_REMOTE_TIMEOUT;
  if (raw === undefined || raw === "") return DEFAULT_REMOTE_TIMEOUT_MS;
  // Strict decimal form: Number("") coerces to 0 and Number(" ") too, and a
  // blank value silently disabling every timeout is worse than a usage error.
  if (!/^\d+$/.test(raw)) {
    throw new UsageError(`PIR_REMOTE_TIMEOUT must be a non-negative integer number of seconds, got: ${raw}`);
  }
  return Number(raw) * 1000;
}

let cached: { agent: Agent; timeoutMs: number } | undefined;

/**
 * Per-process dispatcher for the remote client's fetches. Cached (and rebuilt
 * if PIR_REMOTE_TIMEOUT changes mid-process — tests do this) so the two
 * fetches of a find share one connection pool. The CLI exits via
 * drainAndExit/process.exit, so the pool's keep-alive sockets never block
 * shutdown.
 *
 * The return type is what global fetch's RequestInit expects; undici-types
 * (bundled with @types/node) lags the undici package's own type snapshots,
 * so the otherwise-compatible Agent needs one contained cast.
 */
export function remoteDispatcher(): NonNullable<RequestInit["dispatcher"]> {
  const timeoutMs = remoteTimeoutMs();
  if (!cached || cached.timeoutMs !== timeoutMs) {
    cached = { agent: new Agent({ headersTimeout: timeoutMs, bodyTimeout: timeoutMs }), timeoutMs };
  }
  return cached.agent as unknown as NonNullable<RequestInit["dispatcher"]>;
}

/**
 * undici network failures surface as TypeError("fetch failed"); the real
 * cause — HeadersTimeoutError (UND_ERR_HEADERS_TIMEOUT), ENOTFOUND, a proxy
 * cut — lives on err.cause. Unwrap it or every transport failure looks
 * identical on screen.
 */
export function describeTransportError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as { cause?: unknown }).cause;
  if (cause instanceof Error) {
    const code = (cause as { code?: unknown }).code;
    return typeof code === "string" && code ? `${err.message} (${code}: ${cause.message})` : `${err.message} (${cause.message})`;
  }
  if (cause && typeof cause === "object") {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === "string" && code) return `${err.message} (${code})`;
  }
  return err.message;
}

/**
 * One-line stderr message for a failed transport attempt, with an actionable
 * hint when the cause is a client-side timeout (the #32 signature).
 */
export function reportUnreachable(origin: string, err: unknown): string {
  const code = transportErrorCode(err);
  const hint =
    code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_BODY_TIMEOUT"
      ? `pir: no response within ${Math.round(remoteTimeoutMs() / 1000)}s (PIR_REMOTE_TIMEOUT) — raise it (seconds, 0 disables) or check what is queued server-side\n`
      : "";
  return `pir: cannot reach ${origin}: ${describeTransportError(err)}\n${hint}`;
}

function transportErrorCode(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined;
  const cause = (err as { cause?: unknown }).cause;
  if (!cause || typeof cause !== "object") return undefined;
  const code = (cause as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
