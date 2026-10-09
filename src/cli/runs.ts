import process from "node:process";
import { mkdirSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { UsageError, helpFor, parseArgs, positiveIntFlag, nonNegativeIntFlag } from "./executor.js";
import type { UserConfig } from "./config.js";
import {
  fetchWebApi,
  resolveInsecure,
  resolveRunRef,
  resolveViewerToken,
  runUrl,
  WebApiError,
  type RunRef,
  type WebFetchContext,
} from "./web-client.js";

/**
 * Recovery commands keyed on a run URL (#48/#49): `pir runs status`,
 * `pir findings list|show --run`, `pir findings export`. They talk to the
 * server's read-only web API and never touch local git, so they work from
 * any directory, on an unconfigured machine, after the auditing client is
 * long gone — the exact posture a 27-hour audit's aftermath needs.
 */

export interface WebCommandInput {
  env: Record<string, string | undefined>;
  config: UserConfig | null;
}

// ---------------------------------------------------------------------------
// Web payload mirrors (they cross HTTP; the server's internal types may
// evolve independently of these reads).
// ---------------------------------------------------------------------------

interface WebRunSummary {
  runId: string;
  mode: string;
  base: string | null;
  head: string;
  startedAt: number;
  finishedAt: number | null;
  status: string;
  rounds: number;
  candidates: number;
  confirmed: number;
  rejected: number;
  uncertain: number;
  notes: string | null;
  model: string | null;
  durationMs: number | null;
  totalTokens: number | null;
  cost: number | null;
}

interface WebRunDetail {
  run: WebRunSummary;
  findings: { items: WebFindingSummary[]; total: number };
  manifest: {
    status?: string;
    stoppedBecause?: string;
    incomplete?: boolean;
    maxFindings?: number | null;
    maxFindingsMode?: "capped" | "unlimited";
    coverage?: Record<string, number> | null;
  } | null;
  sessions: unknown[];
  transcriptsAvailable: boolean;
  live?: Record<string, unknown> | null;
}

interface WebFindingSummary {
  id: string;
  displayId: string;
  title: string;
  category: string;
  severity: string;
  status: string;
  round: number;
  createdAt: number;
  evidenceCount: number;
}

type WebFindingDetail = Record<string, unknown> & { id: string };

/** Credential + one-time origin-mismatch note shared by every web command. */
function webContext(ref: RunRef, argv: string[], input: WebCommandInput): WebFetchContext {
  const { token, originMatchesConfig } = resolveViewerToken(ref.origin, { argv, env: input.env, config: input.config });
  if (!token && !originMatchesConfig) {
    process.stderr.write(
      `pir: ${ref.origin} is not the configured server — sending no viewer token; pass --viewer-token <t> if it asks for one\n`,
    );
  }
  return token ? { viewerToken: token } : {};
}

/**
 * TLS opt-out for the web commands (dogfood F-41): the /v1 transport's three
 * switches, with the config one bound to the origin it belongs to.
 */
function webInsecure(ref: RunRef, argv: string[], input: WebCommandInput): boolean {
  return resolveInsecure(ref.origin, { argv, env: input.env, config: input.config });
}

/** Uniform error surface for web commands: friendly message, exit 3. */
function reportWebError(err: unknown): number {
  if (err instanceof WebApiError) {
    process.stderr.write(`pir: ${err.message}\n`);
    return 3;
  }
  process.stderr.write(`pir: ${err instanceof Error ? err.message : String(err)}\n`);
  return 3;
}

// ---------------------------------------------------------------------------
// pir runs status (#48)
// ---------------------------------------------------------------------------

/**
 * `pir runs status <run-url> [--json]` (or `--server/--project/--run`).
 * Always remote by nature, but independent of the configured mode: the URL
 * carries the server, so an unconfigured machine can still inspect a run.
 */
export async function runRunsCommand(argv: string[], input: WebCommandInput): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  const json = Boolean(flags.get("--json"));
  if (flags.get("--help") === true) {
    process.stdout.write(helpFor("runs"));
    return 0;
  }
  const sub = positional[1] ?? "status";
  if (sub !== "status") {
    throw new UsageError(`unknown runs subcommand: ${sub} (expected status)`);
  }
  const ref = resolveRunRef(positional, flags);
  if (!ref) {
    throw new UsageError(
      "pir runs status needs a run URL (`<origin>/runs/<projectId>/<runId>`) or all of --server <url> --project <id> --run <id>",
    );
  }
  if (webInsecure(ref, argv, input)) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  const ctx = webContext(ref, argv, input);
  try {
    const detail = await fetchWebApi<WebRunDetail>(ref.origin, `/api/runs/${ref.projectId}/${ref.runId}`, ctx);
    const run = detail.run;
    const stopReason = detail.manifest?.stoppedBecause ?? null;
    const data = {
      run: {
        runId: run.runId,
        mode: run.mode,
        status: run.status,
        base: run.base,
        head: run.head,
        model: run.model,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        rounds: run.rounds,
        durationMs: run.durationMs,
        totalTokens: run.totalTokens,
        cost: run.cost,
        notes: run.notes,
      },
      stopReason,
      incomplete: detail.manifest?.incomplete ?? null,
      maxFindings: detail.manifest?.maxFindings ?? null,
      maxFindingsMode: detail.manifest?.maxFindingsMode ?? (detail.manifest?.maxFindings == null ? null : "capped"),
      coverage: detail.manifest?.coverage ?? null,
      findingsTotal: detail.findings.total,
      candidates: run.candidates,
      confirmed: run.confirmed,
      rejected: run.rejected,
      uncertain: run.uncertain,
      sessions: detail.sessions.length,
      transcriptsAvailable: detail.transcriptsAvailable,
      live: detail.live ?? null,
      url: runUrl(ref),
    };
    if (json) {
      process.stdout.write(`${JSON.stringify({ schemaVersion: 1, command: "runs.status", data })}\n`);
      return 0;
    }
    renderRunStatus(data);
    return 0;
  } catch (err) {
    return reportWebError(err);
  }
}

interface RunStatusView {
  run: {
    runId: string;
    mode: string;
    status: string;
    base: string | null;
    head: string;
    model: string | null;
    startedAt: number;
    finishedAt: number | null;
    rounds: number;
    durationMs: number | null;
    totalTokens: number | null;
    cost: number | null;
    notes: string | null;
  };
  stopReason: string | null;
  coverage: Record<string, number> | null;
  findingsTotal: number;
  candidates: number;
  confirmed: number;
  rejected: number;
  uncertain: number;
  url: string;
}

function renderRunStatus(data: RunStatusView): void {
  const { run } = data;
  const out = process.stdout;
  out.write(`run ${run.runId} (${run.mode}) — ${run.status}\n`);
  out.write(`  url:      ${data.url}\n`);
  out.write(`  head:     ${run.head.slice(0, 12)}${run.base ? ` (base ${run.base.slice(0, 12)})` : ""}\n`);
  if (run.model) out.write(`  model:    ${run.model}\n`);
  out.write(`  started:  ${new Date(run.startedAt).toISOString()}`);
  out.write(run.finishedAt === null ? " (still running)\n" : `; finished: ${new Date(run.finishedAt).toISOString()}\n`);
  out.write(
    `  findings: ${data.findingsTotal} stored — ${data.confirmed} confirmed · ${data.rejected} rejected · ${data.uncertain} uncertain · ${data.candidates} candidates\n`,
  );
  if (data.stopReason) out.write(`  stopped:  ${data.stopReason}\n`);
  if (run.notes) out.write(`  notes:    ${run.notes}\n`);
  const coverage = data.coverage;
  if (coverage && typeof coverage.filesInScope === "number") {
    out.write(
      `  coverage: ${coverage.filesReviewed}/${coverage.filesInScope} reviewed · ${coverage.filesPartial} partial · ${coverage.filesUnreviewed} unreviewed` +
        `${coverage.filesBlocked ? ` · ${coverage.filesBlocked} blocked` : ""}${coverage.filesFailed ? ` · ${coverage.filesFailed} failed` : ""}\n`,
    );
  } else {
    out.write("  coverage: unavailable (no run manifest)\n");
  }
}

// ---------------------------------------------------------------------------
// pir findings list|show --run <url> (#48)
// ---------------------------------------------------------------------------

/** `pir findings list|show --run` — dispatched before any local/remote routing. */
export async function runWebFindingsCommand(argv: string[], input: WebCommandInput): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  const json = Boolean(flags.get("--json"));
  const ref = resolveRunRef(positional, flags);
  if (!ref) {
    throw new UsageError("findings --run needs a run URL (`<origin>/runs/<projectId>/<runId>`) or --server/--project/--run");
  }
  if (flags.has("--status")) {
    // The web tier has no server-side status filter; pretending to apply one
    // would silently return unfiltered rows. Export implements it honestly.
    throw new UsageError("--status with --run is only supported by `pir findings export --run` (it filters the fetched set)");
  }
  if (webInsecure(ref, argv, input)) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  const ctx = webContext(ref, argv, input);
  const sub = positional[1] ?? "list";
  try {
    if (sub === "show") return await webFindingsShow(ref, positional[2], ctx, json);
    if (sub === "list") return await webFindingsList(ref, flags, ctx, json, argv);
    throw new UsageError(`unknown findings subcommand: ${sub}`);
  } catch (err) {
    return reportWebError(err);
  }
}

async function webFindingsList(
  ref: RunRef,
  flags: Map<string, string | boolean>,
  ctx: WebFetchContext,
  json: boolean,
  argv: string[],
): Promise<number> {
  const all = flags.get("--all") === true;
  const limit = positiveIntFlag(flags, "--limit");
  const offset = nonNegativeIntFlag(flags, "--offset");
  if (all && (limit !== undefined || offset !== undefined)) {
    throw new UsageError("--all cannot be combined with --limit/--offset (it fetches every page)");
  }
  const quiet = argv.includes("--quiet") || json;
  if (!quiet) process.stderr.write(`pir: asking ${ref.origin} for the run's findings\n`);
  const { findings, total } = await fetchAllSummaries(ref, ctx, {
    ...(all ? {} : { limit: limit ?? 100 }),
    ...(all ? {} : offset !== undefined ? { offset } : {}),
  });
  const returned = findings.length;
  const pageStart = offset ?? 0;
  const hasMore = all ? false : pageStart + returned < total;
  const page = { findings, total, returned, hasMore, nextOffset: hasMore ? pageStart + returned : null };
  if (json) {
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, command: "findings.list", data: page })}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(findings, null, 2)}\n`);
    if (hasMore) {
      process.stderr.write(`pir: showing ${returned} of ${total} findings — pass --all, or --offset ${page.nextOffset} for the next page\n`);
    }
  }
  return 0;
}

interface SummaryQuery {
  limit?: number;
  offset?: number;
}

/**
 * One page of the run's findings, straight from the web API. The server caps
 * pages at 500 rows regardless of the requested limit.
 */
async function fetchFindingsPage(
  ref: RunRef,
  ctx: WebFetchContext,
  limit: number,
  offset: number,
): Promise<{ findings: WebFindingSummary[]; total: number }> {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) }).toString();
  return fetchWebApi<{ findings: WebFindingSummary[]; total: number }>(
    ref.origin,
    `/api/runs/${ref.projectId}/${ref.runId}/findings?${params}`,
    ctx,
  );
}

/**
 * Bounded queries (a limit and/or offset) get exactly one page; unbounded
 * callers (--all, show's id resolution, export) walk offset forward until
 * the collected count reaches the reported total.
 *
 * The server orders rows by severity, created_at with no unique tie-break,
 * so offset paging over a LIVE run (rows inserting ahead of the cursor) can
 * hand back a row twice. Duplicates collapse here (dogfood F-43); the walk
 * still terminates because the offset advances by the raw page length.
 */
async function fetchAllSummaries(
  ref: RunRef,
  ctx: WebFetchContext,
  query: SummaryQuery = {},
): Promise<{ findings: WebFindingSummary[]; total: number }> {
  if (query.limit !== undefined || query.offset !== undefined) {
    return fetchFindingsPage(ref, ctx, query.limit ?? 500, query.offset ?? 0);
  }
  const first = await fetchFindingsPage(ref, ctx, 500, 0);
  const total = first.total;
  const byId = new Map<string, WebFindingSummary>(first.findings.map((f) => [f.id, f]));
  let fetched = first.findings.length;
  while (fetched < total) {
    const next = await fetchFindingsPage(ref, ctx, 500, fetched);
    if (next.findings.length === 0) break; // total moved under us (live run)
    for (const finding of next.findings) byId.set(finding.id, finding);
    fetched += next.findings.length;
  }
  return { findings: [...byId.values()], total };
}

async function webFindingsShow(ref: RunRef, idArg: string | undefined, ctx: WebFetchContext, json: boolean): Promise<number> {
  if (!idArg) throw new UsageError("findings show requires an id");
  // The web API addresses findings by internal id; users know display ids
  // (F-12). Resolve through the summaries — a run's findings are bounded, so
  // the walk is a few cheap paged reads at most.
  const { findings } = await fetchAllSummaries(ref, ctx);
  const match = findings.find((f) => f.displayId === idArg || f.id === idArg);
  if (!match) {
    process.stderr.write(`pir: finding not found in this run: ${idArg}\n`);
    return 3;
  }
  const detail = await fetchWebApi<WebFindingDetail>(
    ref.origin,
    `/api/runs/${ref.projectId}/${ref.runId}/findings/${match.id}`,
    ctx,
  );
  if (json) {
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, command: "findings.show", data: detail })}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(detail, null, 2)}\n`);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// pir findings export --run <url> (#49)
// ---------------------------------------------------------------------------

/** Backoff between per-finding retries: 250ms, 1s, 2s. */
const EXPORT_RETRY_DELAYS_MS = [250, 1000, 2000];
const EXPORT_CONCURRENCY = 4;
const EXPORT_STATUS_VALUES = ["confirmed", "rejected", "uncertain"];
/** How many detail fetches land before the checkpoint is rewritten. */
const CHECKPOINT_EVERY = 20;

interface CheckpointFile {
  schemaVersion: 1;
  origin: string;
  projectId: string;
  runId: string;
  fetchedAt: string;
  /** Whether the run was still live when the checkpoint was captured. */
  complete: boolean;
  findings: WebFindingDetail[];
}

/**
 * Full-fidelity export of one run's findings over the web API: every page of
 * summaries, every finding's detail, provenance envelope, atomic output,
 * checkpoint resume. Exit 3 on any incomplete fetch — a partial file that
 * pretends to be complete is the one failure this command exists to prevent.
 */
export async function runFindingsExportCommand(argv: string[], input: WebCommandInput): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  const ref = resolveRunRef(positional, flags);
  if (!ref) {
    throw new UsageError("findings export requires --run <run-url> (or --server/--project/--run)");
  }
  const status = typeof flags.get("--status") === "string" ? (flags.get("--status") as string) : undefined;
  if (status !== undefined && !EXPORT_STATUS_VALUES.includes(status)) {
    throw new UsageError(`--status must be one of ${EXPORT_STATUS_VALUES.join("|")}, got: ${status}`);
  }
  const format = typeof flags.get("--format") === "string" ? (flags.get("--format") as string) : "json";
  if (format !== "json") throw new UsageError(`--format supports json only, got: ${format}`);
  const output = typeof flags.get("--output") === "string" ? (flags.get("--output") as string) : undefined;
  const quiet = argv.includes("--quiet");
  if (webInsecure(ref, argv, input)) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  const ctx = webContext(ref, argv, input);
  const progress = (message: string): void => {
    if (!quiet) process.stderr.write(`pir: ${message}\n`);
  };

  try {
    const detail = await fetchWebApi<WebRunDetail>(ref.origin, `/api/runs/${ref.projectId}/${ref.runId}`, ctx);
    const live = detail.run.finishedAt === null || detail.run.status === "running";
    progress(`run ${ref.runId} is ${detail.run.status}${live ? " — exporting the current snapshot" : ""}`);

    progress(`fetching finding summaries (total ${detail.findings.total})`);
    const { findings: summaries, total } = await fetchAllSummaries(ref, ctx);
    const scoped = status === undefined ? summaries : summaries.filter((f) => f.status === status);
    const scopedTotal = status === undefined ? total : scoped.length;
    progress(`${summaries.length} summaries fetched${status !== undefined ? `, ${scoped.length} with status ${status}` : ""}`);

    // Checkpoint resume: findings already fetched in an earlier interrupted
    // run of this exact command are reused instead of re-requested. A
    // checkpoint from a DIFFERENT origin, or one captured while the run was
    // live and reused after it settled (statuses move candidate →
    // confirmed/rejected mid-run), is discarded (dogfood F-47).
    const checkpointPath = output !== undefined ? `${output}.checkpoint.json` : null;
    let done = new Map<string, WebFindingDetail>();
    if (checkpointPath !== null && existsSync(checkpointPath)) {
      try {
        const parsed = JSON.parse(readFileSync(checkpointPath, "utf8")) as CheckpointFile;
        const sameTarget =
          parsed.schemaVersion === 1 && parsed.origin === ref.origin && parsed.projectId === ref.projectId && parsed.runId === ref.runId;
        const samePhase = parsed.complete === !live;
        if (sameTarget && samePhase && Array.isArray(parsed.findings)) {
          done = new Map(parsed.findings.map((f) => [f.id, f]));
          progress(`resuming: ${done.size} findings already fetched (checkpoint ${path.basename(checkpointPath)})`);
        } else {
          progress(
            sameTarget
              ? "checkpoint captured while the run was live and it has since settled — refetching everything"
              : "checkpoint belongs to a different run/origin — refetching everything",
          );
        }
      } catch {
        progress("checkpoint file unreadable — refetching everything");
      }
    }

    const pending = scoped.filter((f) => !done.has(f.id));
    let fetched = 0;
    const failures: Array<{ id: string; reason: string }> = [];
    let cursor = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = cursor++;
        if (index >= pending.length) return;
        const summary = pending[index]!;
        try {
          done.set(summary.id, await fetchDetailWithRetry(ref, summary.id, ctx));
        } catch (err) {
          failures.push({ id: summary.displayId, reason: err instanceof Error ? err.message : String(err) });
        }
        fetched += 1;
        progress(`finding details ${fetched}/${pending.length}`);
        // Incremental persistence (dogfood F-44): an interrupted export —
        // Ctrl-C, network drop, machine sleep — must not restart from zero.
        // Every CHECKPOINT_EVERY completions land on disk; the exhaustion
        // path below always writes a final one.
        if (checkpointPath !== null && fetched % CHECKPOINT_EVERY === 0) {
          writeCheckpoint(checkpointPath, ref, !live, [...done.values()]);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(EXPORT_CONCURRENCY, Math.max(pending.length, 1)) }, worker));

    if (failures.length > 0) {
      // Persist what succeeded so a rerun resumes instead of restarting.
      if (checkpointPath !== null) writeCheckpoint(checkpointPath, ref, !live, [...done.values()]);
      process.stderr.write(
        `pir: ${failures.length} finding(s) could not be fetched after ${EXPORT_RETRY_DELAYS_MS.length} retries: ` +
          `${failures.map((f) => f.id).join(", ")} — no output written` +
          (checkpointPath !== null ? "; rerun to resume from the checkpoint\n" : " (no checkpoint without --output)\n"),
      );
      return 3;
    }

    // Summaries were deduped by id (live runs can hand a row back twice,
    // dogfood F-43), so the scoped list is unique by construction.
    const findings = scoped.map((f) => done.get(f.id)!).filter((f) => f !== undefined);
    if (!live && findings.length !== scopedTotal) {
      throw new Error(`expected ${scopedTotal} findings, collected ${findings.length}`);
    }

    const snapshotAt = live ? new Date().toISOString() : null;
    const envelopeOut = JSON.stringify({
      schemaVersion: 1,
      command: "findings.export",
      data: {
        provenance: {
          origin: ref.origin,
          projectId: ref.projectId,
          runId: ref.runId,
          head: detail.run.head,
          model: detail.run.model,
          runStatus: detail.run.status,
          fetchedAt: new Date().toISOString(),
          complete: !live,
          ...(snapshotAt !== null ? { snapshotAt } : {}),
        },
        filters: { ...(status !== undefined ? { status } : {}) },
        total: scopedTotal,
        returned: findings.length,
        findings,
      },
    });

    if (output === undefined) {
      process.stdout.write(`${envelopeOut}\n`);
    } else {
      const tmp = `${output}.tmp`;
      mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
      writeFileSync(tmp, `${envelopeOut}\n`);
      renameSync(tmp, output);
      if (checkpointPath !== null && existsSync(checkpointPath)) rmSync(checkpointPath);
      progress(`wrote ${output} (${findings.length} findings, complete: ${!live})`);
    }
    return 0;
  } catch (err) {
    return reportWebError(err);
  }
}

async function fetchDetailWithRetry(ref: RunRef, id: string, ctx: WebFetchContext): Promise<WebFindingDetail> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= EXPORT_RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await sleep(EXPORT_RETRY_DELAYS_MS[attempt - 1]!);
    try {
      return await fetchWebApi<WebFindingDetail>(ref.origin, `/api/runs/${ref.projectId}/${ref.runId}/findings/${id}`, ctx);
    } catch (err) {
      // Auth is never fixed by a retry, and a vanished finding (a live run's
      // row deleted server-side) is data, not contention.
      if (err instanceof WebApiError && (err.kind === "auth" || err.kind === "unknown-run")) throw err;
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function writeCheckpoint(checkpointPath: string, ref: RunRef, complete: boolean, findings: WebFindingDetail[]): void {
  const file: CheckpointFile = {
    schemaVersion: 1,
    origin: ref.origin,
    projectId: ref.projectId,
    runId: ref.runId,
    fetchedAt: new Date().toISOString(),
    complete,
    findings,
  };
  const tmp = `${checkpointPath}.tmp`;
  try {
    mkdirSync(path.dirname(path.resolve(checkpointPath)), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(file)}\n`);
    renameSync(tmp, checkpointPath);
  } catch (err) {
    process.stderr.write(`pir: could not write the resume checkpoint: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
