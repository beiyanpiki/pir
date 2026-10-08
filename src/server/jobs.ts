import { randomUUID } from "node:crypto";

/**
 * In-memory job registry for /v1/review work (#38). A review request becomes
 * a job the moment it is accepted: the HTTP response (sync wait or async
 * pickup via GET /v1/jobs/<id>) is a delivery mechanism, while the job —
 * materialize, execute, cleanup — keeps running to completion and retains its
 * result. That fixes the delivery contract for runs that outlive any client
 * wait (audits run hours to days) and makes "a disconnected client silently
 * dropped its output" impossible on the sync path.
 *
 * The registry lives for the serve process lifetime; the durable record
 * stays SQLite (review_runs + findings). Retention is bounded: recent log
 * lines and results only, oldest completed jobs evicted first.
 */

export type JobStatus = "queued" | "running" | "completed" | "failed";

export interface JobResult {
  code: number;
  output: string;
  log: string[];
  /** True when the retained output was truncated at the size cap. */
  truncated: boolean;
}

export interface JobRecord {
  jobId: string;
  command: string;
  argv: string[];
  status: JobStatus;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  /** Total progress lines emitted (the retained log is a recent window). */
  logTotal: number;
  log: string[];
  result: JobResult | null;
  error: string | null;
  /** Sync request whose client disconnected mid-wait; result kept for pickup. */
  clientGone: boolean;
}

/** Last N progress lines kept per job (audits: one line per round/unit/finding). */
const MAX_LOG_LINES = 2000;
/** Retained result size cap per job; audit envelopes can be large but bounded. */
const MAX_RESULT_BYTES = 32 * 1024 * 1024;
/** Completed jobs kept for pickup; oldest finishedAt evicts first. */
const MAX_COMPLETED_JOBS = 100;

/** Cut at a UTF-8 codepoint boundary so a capped payload still decodes. */
function truncateUtf8Bytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  let end = Math.min(maxBytes, buf.length);
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf8");
}

/** The list-projection of a job: everything except the heavy log/result payloads. */
export type JobSummary = Omit<JobRecord, "log" | "result">;

export class JobRegistry {
  private readonly jobs = new Map<string, JobRecord>();

  create(input: { command: string; argv: string[] }): JobHandle {
    const jobId = randomUUID();
    const record: JobRecord = {
      jobId,
      command: input.command,
      argv: input.argv,
      status: "queued",
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      logTotal: 0,
      log: [],
      result: null,
      error: null,
      clientGone: false,
    };
    this.jobs.set(jobId, record);
    return new JobHandle(record, () => this.evict());
  }

  get(jobId: string): JobRecord | undefined {
    const record = this.jobs.get(jobId);
    return record ? this.copy(record) : undefined;
  }

  /** Newest first — the natural "what happened lately" order. */
  list(): JobSummary[] {
    return [...this.jobs.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((record) => {
        const { log: _log, result: _result, ...summary } = record;
        return summary;
      });
  }

  private copy(record: JobRecord): JobRecord {
    return { ...record, log: record.log.slice(), result: record.result ? { ...record.result, log: record.result.log.slice() } : null };
  }

  /** Drop oldest settled jobs past the retention cap (never an active one). */
  private evict(): void {
    const settled = [...this.jobs.values()]
      .filter((record) => record.status === "completed" || record.status === "failed")
      .sort((a, b) => (a.finishedAt ?? a.createdAt) - (b.finishedAt ?? b.createdAt));
    const excess = settled.length - MAX_COMPLETED_JOBS;
    for (const record of settled.slice(0, Math.max(0, excess))) {
      this.jobs.delete(record.jobId);
    }
  }
}

export class JobHandle {
  constructor(
    private readonly record: JobRecord,
    private readonly onSettled: () => void = () => {},
  ) {}

  get jobId(): string {
    return this.record.jobId;
  }

  start(): void {
    this.record.status = "running";
    this.record.startedAt = Date.now();
  }

  progress(line: string): void {
    this.record.logTotal += 1;
    this.record.log.push(line);
    if (this.record.log.length > MAX_LOG_LINES) {
      this.record.log.splice(0, this.record.log.length - MAX_LOG_LINES);
    }
  }

  finish(result: { code: number; output: string; log: string[] }): void {
    // The cap is bytes: output.length would count UTF-16 code units and let
    // non-ASCII payloads overshoot it up to 4x (dogfood F-34).
    const truncated = Buffer.byteLength(result.output, "utf8") > MAX_RESULT_BYTES;
    this.record.status = "completed";
    this.record.finishedAt = Date.now();
    this.record.result = {
      code: result.code,
      output: truncated ? truncateUtf8Bytes(result.output, MAX_RESULT_BYTES) : result.output,
      log: result.log.slice(-MAX_LOG_LINES),
      truncated,
    };
    this.onSettled();
  }

  fail(message: string): void {
    this.record.status = "failed";
    this.record.finishedAt = Date.now();
    this.record.error = message;
    this.onSettled();
  }

  markClientGone(): void {
    this.record.clientGone = true;
  }
}
