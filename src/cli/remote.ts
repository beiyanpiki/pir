import process from "node:process";
import { UsageError } from "./executor.js";

export interface RemoteOptions {
  token?: string;
  insecure?: boolean;
}

/**
 * Client side of `pir serve`. find-family commands invoked from inside a git
 * repository take the coderabbit-cli path: the LOCAL state (unpushed commits
 * included, working tree via --uncommitted) is packed as a git bundle and
 * shipped to POST /v1/review, so the server reviews exactly what the client
 * sees — no push required. Everything else forwards verbatim to /v1/exec.
 */
export async function remoteExec(serverUrl: string, argv: string[], options: RemoteOptions = {}): Promise<number> {
  if (options.insecure) {
    // Per-process opt-out for self-signed certificates; the pir CLI is
    // short-lived so the blast radius is this invocation only.
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  }
  const url = new URL(serverUrl);
  const cleaned = stripClientFlags(argv);
  const command = cleaned.find((a) => !a.startsWith("--"));

  if (command === "find" && !cleaned.includes("--repo")) {
    return await reviewViaBundle(url, cleaned, options);
  }
  return await forwardExec(url, cleaned, options);
}

async function reviewViaBundle(url: URL, argv: string[], options: RemoteOptions): Promise<number> {
  const { isGitRepo, getHeadCommit, getRootCommit, getRemoteUrl, createWorkingTreeSnapshot, git } = await import(
    "../changes/git.js"
  );
  const cwd = process.cwd();
  if (!(await isGitRepo(cwd))) {
    process.stderr.write("pir: remote find requires a git repository (or use --repo)\n");
    return 3;
  }

  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i]!.startsWith("--") && i + 1 < argv.length && !argv[i + 1]!.startsWith("--")) {
      flags.set(argv[i]!, argv[i + 1]!);
    }
  }

  let head = flags.get("--head") ?? (await getHeadCommit(cwd));
  if (argv.includes("--uncommitted")) {
    head = await createWorkingTreeSnapshot(cwd);
    argv = argv.filter((a) => a !== "--uncommitted");
  }
  let base: string | null = flags.get("--base") ?? null;
  if (base) {
    base = (await git(cwd, ["rev-parse", "--verify", `${base}^{commit}`])).trim();
  } else {
    // Mirror the executor's default: HEAD^ when it exists.
    try {
      base = (await git(cwd, ["rev-parse", "--verify", "HEAD^"])).trim();
    } catch {
      base = null;
    }
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

  process.stderr.write(`pir: shipping local state ${base ? `${base.slice(0, 8)}..` : ""}${head.slice(0, 8)} to ${url.origin}\n`);
  let response = await send(base !== null);
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
