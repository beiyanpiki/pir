import path from "node:path";
import process from "node:process";
import { UsageError, parseArgs, pinRefsToShas } from "./executor.js";
import { remoteDispatcher, reportUnreachable } from "./remote-fetch.js";

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
    const bundle = opts.noBundle
      ? Buffer.alloc(0)
      : await createBundle(cwd, { base: opts.withBase ? base : null, head });
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

  const submit = async (opts: { withBase: boolean; noBundle?: boolean; async?: boolean }): Promise<number> => {
    let response: Response;
    try {
      response = await send(opts);
    } catch (err) {
      process.stderr.write(reportUnreachable(url.origin, err));
      return 3;
    }
    let payload = (await response.json().catch(() => ({}))) as { needFull?: boolean; jobId?: string } & RelayResult;
    // A refused bundle-free read (first contact: db not created yet; or an
    // old server that tried to materialize the empty bundle and 400'd)
    // retries with the real bundle instead of surfacing the refusal.
    const refusedNoBundle = opts.noBundle === true && (!response.ok || payload.needFull === true);
    if (!response.ok && !refusedNoBundle) {
      const text = JSON.stringify(payload).slice(0, 300);
      process.stderr.write(`pir: server error ${response.status}: ${text}\n`);
      return 3;
    }
    if (refusedNoBundle) {
      process.stderr.write(payload.needFull ? "pir: server needs full history, resending\n" : "pir: server refused the bundle-free request, resending with bundle\n");
      try {
        response = await send({ withBase: false, async: opts.async });
      } catch (err) {
        process.stderr.write(reportUnreachable(url.origin, err));
        return 3;
      }
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        process.stderr.write(`pir: server error ${response.status}: ${text.slice(0, 300)}\n`);
        return 3;
      }
      payload = (await response.json()) as RelayResult;
    }
    if (payload.jobId) {
      return await followJob(url, payload.jobId, options, argv);
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
 * relay the result exactly as the sync path would have. No overall deadline —
 * Ctrl-C detaches, and the result stays fetchable via `pir jobs fetch`.
 */
async function followJob(url: URL, jobId: string, options: RemoteOptions, argv: string[]): Promise<number> {
  const { pollJobToEnd } = await import("./jobs.js");
  process.stderr.write(
    `pir: accepted as job ${jobId.slice(0, 8)} — polling ${url.origin} until it finishes (Ctrl-C detaches; fetch later with \`pir jobs fetch ${jobId.slice(0, 8)}\`)\n`,
  );
  try {
    const job = await pollJobToEnd(jobId, {
      url: url.origin,
      ...(options.token ? { token: options.token } : {}),
      ...(options.insecure ? { insecure: true } : {}),
      onLog: (lines) => {
        if (!argv.includes("--quiet")) {
          for (const line of lines) process.stderr.write(`${line}\n`);
        }
      },
    });
    if (job.status === "failed") {
      process.stderr.write(`pir: job ${jobId.slice(0, 8)} failed: ${job.error ?? "unknown error"}\n`);
      return 3;
    }
    if (job.result?.truncated) {
      process.stderr.write("pir: warning: job output was truncated server-side (size cap)\n");
    }
    return relay({ code: job.result?.code ?? 0, output: job.result?.output ?? "", log: [] }, argv);
  } catch (err) {
    process.stderr.write(`pir: ${err instanceof Error ? err.message : String(err)}\n`);
    return 3;
  }
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
