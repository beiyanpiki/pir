import path from "node:path";
import process from "node:process";
import { UsageError, parseArgs, pinRefsToShas } from "./executor.js";

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

  const send = async (withBase: boolean): Promise<Response> => {
    const bundle = await createBundle(cwd, { base: withBase ? base : null, head });
    return fetch(new URL("/v1/review", url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
      body: JSON.stringify({
        remoteUrl,
        rootCommit,
        base: withBase ? base : null,
        head,
        bundleBase64: bundle.toString("base64"),
        argv,
      }),
    });
  };

  process.stderr.write(`pir: shipping local state ${isFind && base ? `${base.slice(0, 8)}..` : ""}${head.slice(0, 8)} to ${url.origin}\n`);
  // Audit and the memory family ship a full-history bundle from the start
  // (there is no thin/base form to miss); find keeps its thin-first,
  // one-retry-full strategy.
  let response: Response;
  try {
    response = await send(isFind && base !== null);
  } catch (err) {
    process.stderr.write(`pir: cannot reach ${url.origin}: ${err instanceof Error ? err.message : String(err)}\n`);
    return 3;
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    process.stderr.write(`pir: server error ${response.status}: ${text.slice(0, 300)}\n`);
    return 3;
  }
  let payload = (await response.json()) as { needFull?: boolean } & RelayResult;
  if (payload.needFull) {
    process.stderr.write("pir: server needs full history, resending\n");
    response = await send(false);
    if (!response.ok) {
      process.stderr.write(`pir: server error ${response.status}\n`);
      return 3;
    }
    payload = (await response.json()) as RelayResult;
  }
  return relay(payload, argv);
}

async function forwardExec(url: URL, argv: string[], options: RemoteOptions): Promise<number> {
  let response: Response;
  try {
    response = await fetch(new URL("/v1/exec", url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
      body: JSON.stringify({ argv }),
    });
  } catch (err) {
    process.stderr.write(`pir: cannot reach ${url.origin}: ${err instanceof Error ? err.message : String(err)}\n`);
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
function stripClientFlags(argv: string[]): string[] {
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
