import process from "node:process";
import { UsageError } from "./executor.js";

export interface RemoteOptions {
  token?: string;
  insecure?: boolean;
}

/**
 * Client side of `pir serve`: forwards the argv verbatim to the remote
 * executor endpoint and relays its output and exit code. Same CLI grammar,
 * remote engine.
 */
export async function remoteExec(serverUrl: string, argv: string[], options: RemoteOptions = {}): Promise<number> {
  if (options.insecure) {
    // Per-process opt-out for self-signed certificates; the pir CLI is
    // short-lived so the blast radius is this invocation only.
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  }
  const url = new URL(serverUrl);
  const payload = JSON.stringify({ argv: stripClientFlags(argv) });
  let response: Response;
  try {
    response = await fetch(new URL("/v1/exec", url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
      body: payload,
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

  const result = (await response.json()) as { code: number; output: string; log?: string[] };
  if (result.log && !argv.includes("--quiet")) {
    for (const line of result.log) process.stderr.write(`${line}\n`);
  }
  process.stdout.write(result.output ?? "");
  return result.code ?? 0;
}

/** Remove transport-only flags (--server URL, --token VALUE, --insecure) before forwarding. */
function stripClientFlags(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === "--server" || token === "--token") {
      i += 1; // skip the flag and its value
      continue;
    }
    if (token.startsWith("--server=") || token.startsWith("--token=")) continue;
    if (token === "--insecure") continue;
    out.push(token);
  }
  return out;
}
