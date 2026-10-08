import path from "node:path";
import process from "node:process";
import { UsageError, parseArgs, pinRefsToShas } from "./executor.js";
import { remoteDispatcher, reportUnreachable } from "./remote-fetch.js";
import type { JobView } from "./jobs.js";

/**
 * createBundle failed before any bytes left the machine (#44): a local git
 * problem (read-only .git, missing objects), never a connectivity one.
 */
export class BundlePrepError extends Error {}

export interface RemoteOptions {
  token?: string;
  insecure?: boolean;
}

/**
 * Commands that ship as a bundle — kept in sync with the server's
 * REVIEW_ENDPOINT_COMMANDS whitelist. Beyond find/audit this is the whole
 * memory family: on a stock serve instance /v1/exec has no repo context to
 * run them against (the workspace is an empty mount point), so the
 * bundle-materialized worktree is the only path that reaches the project's
 * central memory db.
 */
const REVIEW_COMMANDS = new Set(["find", "audit", "memory", "findings", "feedback", "remember", "verify-fix"]);

/**
 * Client side of `pir serve`. Repo-context commands invoked from inside a git
 * repository take the coderabbit-cli path: the LOCAL state (unpushed commits
 * included, working tree via --uncommitted) is packed as a git bundle and
 * shipped to POST /v1/review, so the server runs them against exactly what
 * the client sees — no push required. Everything else forwards verbatim to
 * /v1/exec.
 */
export async function remoteExec(serverUrl: string, argv: string[], options: RemoteOptions = {}): Promise<number> {
  if (options.insecure) {
    // Per-process opt-out for self-signed certificates; the pir CLI is
    // short-lived so the blast radius is this invocation only.
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  }
  // Build the dispatcher up front: an invalid PIR_REMOTE_TIMEOUT must surface
  // as a UsageError here (exit 2 + usage text in cli.ts), not be swallowed by
  // the transport-error catches below and misreported as an unreachable
  // server (dogfood F-20).
  remoteDispatcher();
  const url = new URL(serverUrl);
  const cleaned = stripClientFlags(argv);

  if (wantsBundle(cleaned)) {
    return await reviewViaBundle(url, cleaned, options);
  }
  return await forwardExec(url, cleaned, options);
}

/**
 * A repo-context command over the caller's own checkout ships as a bundle.
 * `memory sync` never does: it merges the caller's own db and always runs in
 * the local process anyway (and /v1/exec refuses it with the right message).
 * parseArgs is the authority on the command (it skips value-flag values, so
 * `--model glm find` is still a find), matching the server's own check.
 */
export function wantsBundle(cleanedArgv: string[]): boolean {
  const { positional } = parseArgs(cleanedArgv);
  if (positional[0] === "memory" && positional[1] === "sync") return false;
  const command = positional[0];
  return (
    command !== undefined &&
    REVIEW_COMMANDS.has(command) &&
    !cleanedArgv.some((a) => a === "--repo" || a.startsWith("--repo="))
  );
}

/**
 * Pure db reads the server can answer without the worktree (#38): shipped
 * bundle-free first (3 KB request instead of a full-history upload) and
 * served off the serial queue while an audit is in flight. On refusal
 * (needFull / an old server's 400 on the empty bundle) the caller falls
 * back to the normal bundle path.
 */
export function isBundleFreeRead(cleanedArgv: string[]): boolean {
  const { positional } = parseArgs(cleanedArgv);
  return positional[0] === "findings" && ["list", "show"].includes(positional[1] ?? "list");
}

/**
 * Async submission (#38): audits run hours to days — hours no single client
 * wait should own. Default for audit; PIR_REMOTE_ASYNC=1 extends it to any
 * review command (a find expected to be long, for example).
 */
export function wantsAsyncSubmit(cleanedArgv: string[]): boolean {
  if (process.env.PIR_REMOTE_ASYNC === "1") return true;
  return parseArgs(cleanedArgv).positional[0] === "audit";
}

async function reviewViaBundle(url: URL, argv: string[], options: RemoteOptions): Promise<number> {
  const { isGitRepo, getHeadCommit, getRootCommit, getRemoteUrl, createWorkingTreeSnapshot, git } = await import(
    "../changes/git.js"
  );
  const parsed = parseArgs(argv);
  const command = parsed.positional[0];
  // find compares base..head. audit and the memory family have no comparison
  // semantics — they need a repo context at head, packed as a full bundle.
  const isFind = command === "find";
  // The repo to pack: an explicit --cwd names the caller's checkout (the
  // server drops --cwd before running in the materialized worktree).
  const cwdFlag = parsed.flags.get("--cwd");
  const cwd = typeof cwdFlag === "string" ? path.resolve(cwdFlag) : process.cwd();
  if (!(await isGitRepo(cwd))) {
    process.stderr.write(`pir: remote ${command} requires a git repository (or use --repo)\n`);
    return 3;
  }
  if (!isFind && argv.includes("--uncommitted")) {
    process.stderr.write("pir: --uncommitted is a find-only flag\n");
    return 2;
  }

  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith("--")) continue;
    const eq = token.indexOf("=");
    if (eq > 0) {
      flags.set(token.slice(0, eq), token.slice(eq + 1));
    } else if (i + 1 < argv.length && !argv[i + 1]!.startsWith("--")) {
      flags.set(token, argv[i + 1]!);
    }
  }

  if (argv.includes("--uncommitted") && (flags.has("--head") || argv.some((a) => a.startsWith("--head=")))) {
    process.stderr.write("pir: --uncommitted reviews the working tree and cannot be combined with an explicit --head\n");
    return 2;
  }
  const headFlag = flags.get("--head");
  let head = headFlag
    ? (await git(cwd, ["rev-parse", "--verify", `${headFlag}^{commit}`])).trim()
    : await getHeadCommit(cwd);
  if (argv.includes("--uncommitted")) {
    head = await createWorkingTreeSnapshot(cwd);
    argv = argv.filter((a) => a !== "--uncommitted");
  }
  let base: string | null = null;
  if (isFind) {
    const baseFlag = flags.get("--base");
    if (baseFlag) {
      base = (await git(cwd, ["rev-parse", "--verify", `${baseFlag}^{commit}`])).trim();
    } else {
      // Mirror the executor's default: HEAD^ when it exists.
      try {
        base = (await git(cwd, ["rev-parse", "--verify", "HEAD^"])).trim();
      } catch {
        base = null;
      }
    }
    argv = pinRefsToShas(argv, { base, head });
  } else {
    // No comparison base exists (audits, memory family); ship the
    // head-pinned bundle.
    argv = pinRefsToShas(argv, { base: null, head });
  }

  const [remoteUrl, rootCommit] = await Promise.all([getRemoteUrl(cwd), getRootCommit(cwd)]);
  const { createBundle } = await import("../app/repos.js");

  const send = async (opts: { withBase: boolean; noBundle?: boolean; async?: boolean }): Promise<Response> => {
    let bundle: Buffer;
    if (opts.noBundle) {
      bundle = Buffer.alloc(0);
    } else {
      try {
        bundle = await createBundle(cwd, { base: opts.withBase ? base : null, head });
      } catch (err) {
        // #44: bundle preparation is local git work that happens before any
        // network IO — reporting it as an unreachable server sent users
        // hunting for connectivity problems while the real cause was e.g. a
        // read-only .git.
        throw new BundlePrepError(err instanceof Error ? err.message : String(err));
      }
    }
    return fetch(new URL("/v1/review", url), {
      method: "POST",
      // undici's default 300 s headersTimeout would kill any review queued
      // behind a long task (#32); the dispatcher sizes the wait from
      // PIR_REMOTE_TIMEOUT.
      dispatcher: remoteDispatcher(),
      headers: {
        "content-type": "application/json",
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
      body: JSON.stringify({
        remoteUrl,
        rootCommit,
        base: opts.withBase ? base : null,
        head,
        bundleBase64: bundle.toString("base64"),
        argv,
        ...(opts.noBundle ? { noBundle: true } : {}),
        ...(opts.async ? { async: true } : {}),
      }),
    });
  };

  /**
   * Transient bundle-free read failures retry the SAME request (#45): a busy
   * or broken server cannot be fixed by uploading full history, so the
   * bundle-free lane never "upgrades" to a bundle for 429/5xx.
   */
  const NO_BUNDLE_RETRIES = 2;

  const submit = async (opts: { withBase: boolean; noBundle?: boolean; async?: boolean }, attempt = 0): Promise<number> => {
    let response: Response;
    try {
      response = await send(opts);
    } catch (err) {
      if (err instanceof BundlePrepError) {
        process.stderr.write(reportBundlePrepFailure(err));
        return 3;
      }
      process.stderr.write(reportUnreachable(url.origin, err));
      return 3;
    }
    // Response-decoding stage (#44): an ok response that is not JSON is a
    // broken contract, not an empty success to relay.
    const raw = await response.text().catch(() => "");
    let payload = {} as { needFull?: boolean; jobId?: string } & RelayResult;
    try {
      payload = JSON.parse(raw) as { needFull?: boolean; jobId?: string } & RelayResult;
    } catch {
      if (response.ok) {
        process.stderr.write(
          `pir: server response was not valid JSON (response-decoding stage): ${raw.slice(0, 200) || "(empty body)"}\n`,
        );
        return 3;
      }
      // Non-ok bodies are reported by status below; keep the empty payload.
    }
    if (response.status === 401 || response.status === 403) {
      // Auth failures can never be fixed by a bundle resend or a retry (#45).
      process.stderr.write(`pir: server rejected the request (${response.status}); check --token\n`);
      return 3;
    }
    if (
      opts.noBundle === true &&
      !response.ok &&
      (response.status === 429 || response.status >= 500) &&
      attempt < NO_BUNDLE_RETRIES
    ) {
      const waitMs = retryDelayMs(response, attempt);
      process.stderr.write(
        `pir: server answered ${response.status}; retrying the bundle-free request in ${Math.round(waitMs / 1000)}s ` +
          `(attempt ${attempt + 2} of ${NO_BUNDLE_RETRIES + 1})\n`,
      );
      await sleep(waitMs);
      return await submit(opts, attempt + 1);
    }
    // A refused bundle-free read retries with the real bundle: an explicit
    // needFull from a current server, or the empty-bundle materialization
    // failure (HTTP 400) of a server predating the bundle-free lane (#45).
    // Usage errors never reach this branch on either server generation —
    // both answer them 200 with code 2 — so a 400 here is a recognized
    // compatibility response, not a usage problem.
    const refusedNoBundle = opts.noBundle === true && (payload.needFull === true || response.status === 400);
    if (!response.ok && !refusedNoBundle) {
      const text = raw.slice(0, 300) || JSON.stringify(payload);
      process.stderr.write(`pir: server error ${response.status}: ${text}\n`);
      return 3;
    }
    if (refusedNoBundle) {
      process.stderr.write(payload.needFull ? "pir: server needs full history, resending\n" : "pir: server refused the bundle-free request, resending with bundle\n");
      return await submit({ withBase: false, async: opts.async });
    }
    // A sync thin-bundle attempt the server could not apply answers
    // 200 {needFull:true} with no jobId — resending full history instead of
    // relaying that marker as an empty success (the sync twin of the async
    // F-30 retry below).
    if (payload.needFull === true && opts.withBase) {
      process.stderr.write("pir: server needs full history, resending\n");
      return await submit({ withBase: false, async: opts.async });
    }
    if (payload.jobId) {
      let settled: JobView;
      try {
        settled = await followJob(url, payload.jobId, options, argv);
      } catch (err) {
        process.stderr.write(`pir: ${err instanceof Error ? err.message : String(err)}\n`);
        return 3;
      }
      // A thin bundle the server could not apply reports failure with the
      // needFull marker: resend full history instead of surfacing it (the
      // async equivalent of the sync needFull retry, dogfood F-30). The
      // resend is a full bundle, so it cannot needFull again.
      if (settled.status === "failed" && (settled.error ?? "").startsWith("needFull") && opts.withBase) {
        process.stderr.write("pir: server needs full history, resending\n");
        return await submit({ withBase: false, async: opts.async });
      }
      if (settled.status === "failed") {
        process.stderr.write(`pir: job ${settled.jobId.slice(0, 8)} failed: ${settled.error ?? "unknown error"}\n`);
        return 3;
      }
      if (settled.result?.truncated) {
        process.stderr.write("pir: warning: job output was truncated server-side (size cap)\n");
      }
      // relay() prints the result's log channel — everything the polling
      // already streamed is excluded, so only the tail (usage text on a
      // code-2 finish, dogfood F-32) lands here.
      const printedDuringPoll = Math.min(settled.logTotal, settled.result?.log.length ?? 0);
      return relay(
        { code: settled.result?.code ?? 0, output: settled.result?.output ?? "", log: settled.result?.log.slice(printedDuringPoll) ?? [] },
        argv,
      );
    }
    return relay(payload, argv);
  };

  const readonly = isBundleFreeRead(argv);
  const asyncSubmit = wantsAsyncSubmit(argv);
  if (readonly) {
    // Bundle-free first (first contact falls back to a bundled resend above).
    process.stderr.write(`pir: asking ${url.origin} for findings (bundle-free)\n`);
    return await submit({ withBase: false, noBundle: true });
  }
  process.stderr.write(
    asyncSubmit
      ? `pir: submitting ${command} of ${head.slice(0, 8)} to ${url.origin} (async job)\n`
      : `pir: shipping local state ${isFind && base ? `${base.slice(0, 8)}..` : ""}${head.slice(0, 8)} to ${url.origin}\n`,
  );
  // Audit and the memory family ship a full-history bundle from the start
  // (there is no thin/base form to miss); find keeps its thin-first,
  // one-retry-full strategy.
  return await submit({ withBase: isFind && base !== null, async: asyncSubmit });
}

/**
 * Follow an async job to its end: stream progress lines as they arrive and
 * hand the settled record back to the caller for relay/retry decisions. No
 * overall deadline — Ctrl-C detaches, and the result stays fetchable via
 * `pir jobs fetch`.
 */
async function followJob(url: URL, jobId: string, options: RemoteOptions, argv: string[]): Promise<JobView> {
  const { pollJobToEnd } = await import("./jobs.js");
  process.stderr.write(
    `pir: accepted as job ${jobId.slice(0, 8)} — polling ${url.origin} until it finishes (Ctrl-C detaches; fetch later with \`pir jobs fetch ${jobId.slice(0, 8)}\`)\n`,
  );
  return await pollJobToEnd(jobId, {
    url: url.origin,
    ...(options.token ? { token: options.token } : {}),
    ...(options.insecure ? { insecure: true } : {}),
    onLog: (lines) => {
      if (!argv.includes("--quiet")) {
        for (const line of lines) process.stderr.write(`${line}\n`);
      }
    },
  });
}

async function forwardExec(url: URL, argv: string[], options: RemoteOptions): Promise<number> {
  let response: Response;
  try {
    response = await fetch(new URL("/v1/exec", url), {
      method: "POST",
      // Same #32 dispatcher as the review path: forwarded commands queue
      // server-side behind whatever task is already running.
      dispatcher: remoteDispatcher(),
      headers: {
        "content-type": "application/json",
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
      body: JSON.stringify({ argv }),
    });
  } catch (err) {
    process.stderr.write(reportUnreachable(url.origin, err));
    return 3;
  }

  if (response.status === 401 || response.status === 403) {
    process.stderr.write(`pir: server rejected the request (${response.status}); check --token\n`);
    return 3;
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    process.stderr.write(`pir: server error ${response.status}: ${text.slice(0, 400)}\n`);
    return 3;
  }
  return relay((await response.json()) as RelayResult, argv);
}

interface RelayResult {
  code: number;
  output: string;
  log?: string[];
}

function relay(result: RelayResult, argv: string[]): number {
  if (result.log && !argv.includes("--quiet")) {
    for (const line of result.log) process.stderr.write(`${line}\n`);
  }
  process.stdout.write(result.output ?? "");
  return result.code ?? 0;
}

/** Remove transport-only flags (--server URL, --token VALUE, --insecure, --local, --no-wizard) before forwarding. */
export function stripClientFlags(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === "--server" || token === "--token") {
      i += 1; // skip the flag and its value
      continue;
    }
    if (token.startsWith("--server=") || token.startsWith("--token=")) continue;
    if (token === "--insecure" || token === "--local" || token === "--no-wizard") continue;
    out.push(token);
  }
  return out;
}

/**
 * #44: a bundle-preparation failure names the local stage and keeps the git
 * cause. It must never say "cannot reach" or suggest raising PIR_REMOTE_TIMEOUT.
 */
export function reportBundlePrepFailure(err: BundlePrepError): string {
  return `pir: failed to prepare the review bundle locally — a local git error, not a server connectivity problem: ${err.message}\n`;
}

/**
 * Backoff for the bounded bundle-free retry (#45): 1s then 5s, honoring
 * Retry-After capped at 30s. An absent header is NOT a zero delay —
 * Headers.get returns null and Number(null) === 0 would slip through a
 * naive isFinite guard, collapsing the backoff to back-to-back retries
 * (dogfood F-38).
 */
function retryDelayMs(response: Response, attempt: number): number {
  const header = response.headers.get("retry-after");
  const seconds = header === null ? Number.NaN : Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000);
  return attempt === 0 ? 1_000 : 5_000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
