import process from "node:process";
import { UsageError, helpFor, parseArgs } from "./executor.js";
import { describeTransportError, remoteDispatcher } from "./remote-fetch.js";

/**
 * Client side of the server's job contract (#38): `pir jobs` inspects and
 * picks up /v1/review work that was submitted asynchronously (audits by
 * default) or whose sync client disconnected mid-wait. The CLI's own audit
 * path reuses the same polling loop.
 */

export interface RemoteTarget {
  url: string;
  token?: string;
  insecure?: boolean;
}

export interface JobView {
  jobId: string;
  command: string;
  argv: string[];
  status: "queued" | "running" | "completed" | "failed";
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  logTotal: number;
  log: string[];
  result: { code: number; output: string; log: string[]; truncated: boolean } | null;
  error: string | null;
  clientGone: boolean;
}

/** GET /v1/jobs[/<id>] — throws Error with the server's message on !ok. */
export async function fetchJobs(target: RemoteTarget, jobId?: string): Promise<JobView[] | JobView> {
  let response: Response;
  try {
    response = await fetch(new URL(jobId ? `/v1/jobs/${jobId}` : "/v1/jobs", target.url), {
      method: "GET",
      dispatcher: remoteDispatcher(),
      headers: {
        "content-type": "application/json",
        ...(target.token ? { authorization: `Bearer ${target.token}` } : {}),
      },
    });
  } catch (err) {
    // The caller prefixes "pir: "; reportUnreachable would double it.
    throw new Error(`cannot reach ${new URL(target.url).origin}: ${describeTransportError(err)}`);
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error(`server rejected the request (${response.status}); check --token`);
  }
  const payload = (await response.json().catch(() => null)) as { jobs?: JobView[]; job?: JobView; error?: string } | null;
  if (!response.ok) {
    if (response.status === 404 && !jobId) {
      throw new Error(`this server has no /v1/jobs endpoint (it predates the job contract; upgrade pir on the server)`);
    }
    throw new Error(payload?.error ?? `server error ${response.status}`);
  }
  if (jobId) {
    if (!payload?.job) throw new Error(`server returned no job for id ${jobId}`);
    return payload.job;
  }
  return payload?.jobs ?? [];
}

export interface PollOptions extends RemoteTarget {
  /** Delay between status polls (default 5s). */
  intervalMs?: number;
  /** Consecutive network failures tolerated before giving up (default 5). */
  maxConsecutiveFailures?: number;
  /** New log lines callback — the audit path prints them as they arrive. */
  onLog?: (lines: string[]) => void;
  /** Progress signal for wait animations; not printed by default. */
  onStatus?: (job: JobView) => void;
}

/**
 * Poll a job until it settles, streaming new log lines. No overall deadline
 * by design: an async audit may legitimately run for days; each individual
 * request is fast, and a dead server surfaces as repeated network failures
 * (or a 404 once it has restarted and lost the in-memory registry).
 */
export async function pollJobToEnd(jobId: string, options: PollOptions): Promise<JobView> {
  const intervalMs = options.intervalMs ?? 5000;
  const maxConsecutiveFailures = options.maxConsecutiveFailures ?? 5;
  // Track the SERVER's total (logTotal), not the window length: the retained
  // log slides forward once the cap kicks in, which would shift array
  // indices and either re-print or silently drop lines.
  let printedTotal = 0;
  let failures = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let job: JobView;
    try {
      job = (await fetchJobs(options, jobId)) as JobView;
      failures = 0;
    } catch (err) {
      failures += 1;
      if (failures >= maxConsecutiveFailures) {
        throw new Error(
          `lost contact with the server while job ${jobId} was in flight (${failures} consecutive failures: ` +
            `${err instanceof Error ? err.message : String(err)}); the job may still be running`,
        );
      }
      await sleep(intervalMs);
      continue;
    }
    options.onStatus?.(job);
    const newCount = Math.max(0, Math.min(job.logTotal - printedTotal, job.log.length));
    if (newCount > 0) options.onLog?.(job.log.slice(job.log.length - newCount));
    printedTotal = Math.max(printedTotal, job.logTotal);
    if (job.status === "completed" || job.status === "failed") return job;
    await sleep(intervalMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shortId(jobId: string): string {
  return jobId.slice(0, 8);
}

function ago(ts: number | null): string {
  if (ts === null) return "-";
  const seconds = Math.round((Date.now() - ts) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

/**
 * `pir jobs list|status|wait|fetch` — always remote; the jobs live in the
 * serve process. Transport flags (--server/--token/--insecure) arrive
 * unparsed because the command is dispatched before remote forwarding.
 */
export async function runJobsCommand(argv: string[], target: RemoteTarget): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  const json = Boolean(flags.get("--json"));
  // Defense in depth for library callers (#43): cli.ts already answers
  // --help before dispatching jobs; nothing past this point may touch the
  // network when help was asked for.
  if (flags.get("--help") === true) {
    process.stdout.write(helpFor("jobs"));
    return 0;
  }
  const sub = positional[1] ?? "list";
  if (!["list", "status", "wait", "fetch"].includes(sub)) {
    throw new UsageError(`unknown jobs subcommand: ${sub} (expected list | status | wait | fetch)`);
  }
  if (!target.url) {
    throw new UsageError("pir jobs needs a remote server — pass --server <url> or configure remote mode (`pir config`)");
  }
  if (target.insecure) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  try {
    return await dispatchJobs(positional, flags, json, sub, target);
  } catch (err) {
    // Transport/server problems print friendly (mirroring the remote relay
    // paths) instead of a stack; usage errors keep their exit-2 contract.
    if (err instanceof UsageError) throw err;
    process.stderr.write(`pir: ${err instanceof Error ? err.message : String(err)}\n`);
    return 3;
  }
}

async function dispatchJobs(
  positional: string[],
  flags: Map<string, string | boolean>,
  json: boolean,
  sub: string,
  target: RemoteTarget,
): Promise<number> {

  if (sub === "list") {
    const jobs = (await fetchJobs(target)) as JobView[];
    if (json) {
      process.stdout.write(`${JSON.stringify({ schemaVersion: 1, command: "jobs.list", data: { jobs } })}\n`);
      return 0;
    }
    if (jobs.length === 0) {
      process.stdout.write("no jobs on this server\n");
      return 0;
    }
    process.stdout.write("job       command    status     created     finished    notes\n");
    for (const job of [...jobs].reverse()) {
      const notes = job.error ? `error: ${job.error.slice(0, 40)}` : job.clientGone ? "client disconnected; result retained" : "";
      process.stdout.write(
        `${shortId(job.jobId).padEnd(10)}${job.command.padEnd(11)}${job.status.padEnd(11)}${ago(job.createdAt).padEnd(12)}${ago(job.finishedAt).padEnd(12)}${notes}\n`,
      );
    }
    return 0;
  }

  const jobIdArg = positional[2];
  if (!jobIdArg) throw new UsageError(`pir jobs ${sub} requires a job id (see \`pir jobs list\`)`);
  // Resolve short id prefixes against the (cheap) summary list, then pull
  // the full record for the one job that needs it (dogfood F-31: never
  // download every job's retained output to look at one).
  const summaries = (await fetchJobs(target)) as JobView[];
  const matches = summaries.filter((job) => job.jobId === jobIdArg || job.jobId.startsWith(jobIdArg));
  if (matches.length === 0) {
    process.stderr.write(`pir: unknown job: ${jobIdArg} (the registry is in-memory; the server may have restarted)\n`);
    return 3;
  }
  if (matches.length > 1) throw new UsageError(`ambiguous job id: ${jobIdArg} matches ${matches.length} jobs`);
  const jobId = matches[0]!.jobId;

  if (sub === "status") {
    const job = (await fetchJobs(target, jobId)) as JobView;
    if (json) {
      process.stdout.write(`${JSON.stringify({ schemaVersion: 1, command: "jobs.status", data: { job } })}\n`);
      return 0;
    }
    process.stdout.write(`job ${job.jobId}\n  command: ${job.argv.join(" ")}\n  status:  ${job.status}\n`);
    process.stdout.write(`  created: ${ago(job.createdAt)}; started: ${ago(job.startedAt)}; finished: ${ago(job.finishedAt)}\n`);
    if (job.error) process.stdout.write(`  error:   ${job.error}\n`);
    if (job.clientGone) process.stdout.write("  note:    client disconnected mid-wait; result retained\n");
    for (const line of job.log.slice(-20)) process.stdout.write(`  | ${line}\n`);
    return 0;
  }

  if (sub === "wait" || sub === "fetch") {
    const wait = sub === "wait" || flags.get("--wait") === true;
    if (wait) {
      process.stderr.write(`pir: waiting for job ${shortId(jobId)} on ${new URL(target.url).origin} (Ctrl-C detaches; re-run later to continue)\n`);
      const job = await pollJobToEnd(jobId, {
        ...target,
        onLog: (lines) => {
          if (!json) for (const line of lines) process.stderr.write(`${line}\n`);
        },
      });
      if (job.status === "failed") {
        process.stderr.write(`pir: job ${shortId(jobId)} failed: ${job.error ?? "unknown error"}\n`);
        return 3;
      }
      return relayJob(job);
    }
    const job = (await fetchJobs(target, jobId)) as JobView;
    if (job.status !== "completed") {
      process.stderr.write(`pir: job ${shortId(jobId)} is ${job.status}; use \`pir jobs wait ${shortId(jobId)}\` to follow it\n`);
      return 3;
    }
    return relayJob(job);
  }

  return 0;
}

function relayJob(job: JobView): number {
  // The job's output is exactly what the sync relay would have printed —
  // stdout verbatim, exit code preserved.
  for (const line of job.result?.log ?? []) process.stderr.write(`${line}\n`);
  if (job.result?.truncated) {
    process.stderr.write("pir: warning: job output was truncated server-side (size cap)\n");
  }
  process.stdout.write(job.result?.output ?? "");
  return job.result?.code ?? 0;
}
