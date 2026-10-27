import process from "node:process";
import { chmodSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { UsageError, helpFor, parseArgs } from "./executor.js";
import { configDir } from "./config.js";
import { runUrl } from "./web-client.js";
import { redactUserBackgroundArgv } from "../core/user-background.js";

/**
 * Local submission receipts (#52): when the server accepts a review as an
 * async job, the client drops a small record under ~/.pir/receipts/. After a
 * disconnect, a client reboot or a serve restart (the in-memory job registry
 * is gone), the receipt is the only thing that still names the origin, the
 * project and — once known — the run id, which is everything the recovery
 * commands (#48/#49) need. Receipts never contain credentials.
 */

export interface Receipt {
  schemaVersion: 1;
  /** Review command that was accepted ("audit", "find", ...). */
  kind: string;
  origin: string;
  jobId: string;
  /** Client-computed project identity of the submitted bundle. */
  projectId: string | null;
  base: string | null;
  head: string;
  /**
   * "async" is a submission a server accepted (the historical value);
   * "local" is a detached local run (ADR 0022). A file with no mode at all
   * predates local detach and reads as a remote submission.
   */
  mode: "async" | "local";
  submittedAt: string;
  /** argv as sent (transport flags stripped, credential-looking tokens dropped). */
  argv: string[];
  /** Set from the job's result envelope once the run id is authoritative. */
  runId: string | null;
  settledAt?: string | null;
  /** Local detach only: where the detached child writes its stdout/stderr. */
  logPath?: string;
  /** Local detach only: the child's final exit code, once it settled. */
  exitCode?: number | null;
}

export function receiptsDir(): string {
  return path.join(configDir(), "receipts");
}

function receiptFileName(jobId: string, submittedAt: Date): string {
  const compact = submittedAt.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");
  return `${compact}-${jobId.slice(0, 8)}.json`;
}

/**
 * Belt-and-braces credential scrub (#52): the argv reaching here already had
 * transport flags stripped client-side, but a receipt is written to disk
 * forever — drop any token-looking flag value anyway rather than trust the
 * upstream path.
 */
function sanitizeReceiptArgv(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === "--token" || token === "--viewer-token") {
      i += 1; // skip the flag and its value
      continue;
    }
    if (token.startsWith("--token=") || token.startsWith("--viewer-token=")) continue;
    out.push(token);
  }
  // A receipt lives on disk forever; the inline user background is model
  // input, not receipt metadata, so its value is redacted too (ADR-0016,
  // dogfood F-2).
  return redactUserBackgroundArgv(out);
}

/** POSIX-shell single-quoting for a path printed into a follow-up command. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Atomic, owner-only write: tmp file (0600) + rename. */
function writeReceiptFile(file: string, receipt: Receipt): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* best effort */
  }
  renameSync(tmp, file);
}

/**
 * Record an accepted async submission. Best-effort by design: a receipt
 * failure must never fail the review it describes.
 */
export function writeSubmissionReceipt(input: {
  kind: string;
  origin: string;
  jobId: string;
  projectId: string | null;
  base: string | null;
  head: string;
  argv: string[];
}): string | null {
  try {
    const now = new Date();
    const receipt: Receipt = {
      schemaVersion: 1,
      kind: input.kind,
      origin: input.origin,
      jobId: input.jobId,
      projectId: input.projectId,
      base: input.base,
      head: input.head,
      mode: "async",
      submittedAt: now.toISOString(),
      argv: sanitizeReceiptArgv(input.argv),
      runId: null,
    };
    const file = path.join(receiptsDir(), receiptFileName(input.jobId, now));
    writeReceiptFile(file, receipt);
    return file;
  } catch {
    return null;
  }
}

export interface LocalReceiptInput {
  /** "find" or "audit". */
  kind: string;
  jobId: string;
  head: string;
  /** argv as the detached child will run it (credential-free). */
  argv: string[];
  logPath: string;
}

/**
 * A local detach's receipt (ADR 0022): no server, no project identity and no
 * run id — origin is "local" and the durable facts are the log path and, once
 * the child's exit hook runs, the final exit code. Built before the spawn so
 * the record exists even if the child never starts.
 */
export function buildLocalReceipt(input: LocalReceiptInput): Receipt {
  return {
    schemaVersion: 1,
    kind: input.kind,
    origin: "local",
    jobId: input.jobId,
    projectId: null,
    base: null,
    head: input.head,
    mode: "local",
    submittedAt: new Date().toISOString(),
    argv: sanitizeReceiptArgv(input.argv),
    runId: null,
    logPath: input.logPath,
    exitCode: null,
  };
}

/** Persist a local receipt; null (best effort) when the write fails. */
export function writeLocalReceipt(receipt: Receipt): string | null {
  try {
    const file = path.join(receiptsDir(), receiptFileName(receipt.jobId, new Date(receipt.submittedAt)));
    writeReceiptFile(file, receipt);
    return file;
  } catch {
    return null;
  }
}

/**
 * Settle a detached local run from the child's exit hook: record when it
 * ended and with which code. A missing receipt is a no-op (the parent may
 * have failed to write one, and a signal death runs no exit hook at all, so
 * an unsettled receipt is the honest state of a killed detach).
 */
export function settleLocalReceipt(jobId: string, exitCode: number | null): void {
  try {
    for (const { file, receipt } of findReceipts(jobId)) {
      if (receipt.mode !== "local") continue;
      writeReceiptFile(file, { ...receipt, settledAt: new Date().toISOString(), exitCode });
    }
  } catch {
    // The run's own result is already in the log and the project database;
    // losing the settlement update is not fatal to the review.
  }
}

export interface ReceiptFile {
  file: string;
  receipt: Receipt;
}

/** All receipts, newest first. Unreadable entries are skipped, not fatal. */
export function listReceipts(): ReceiptFile[] {
  const dir = receiptsDir();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: ReceiptFile[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(dir, name);
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Receipt;
      if (parsed?.schemaVersion === 1 && typeof parsed.jobId === "string") out.push({ file, receipt: parsed });
    } catch {
      // A truncated write or hand edit: skip rather than brick `receipts list`.
    }
  }
  out.sort((a, b) => b.receipt.submittedAt.localeCompare(a.receipt.submittedAt));
  return out;
}

/** Receipts whose jobId matches the argument (full id or unambiguous prefix). */
export function findReceipts(jobIdPrefix: string): ReceiptFile[] {
  return listReceipts().filter(({ receipt }) => receipt.jobId === jobIdPrefix || receipt.jobId.startsWith(jobIdPrefix));
}

/**
 * Authoritative run-id update (#52): after the job settles, pull runId (and
 * projectId, when the envelope carries it) out of the RESULT the server
 * produced — never guess by head. JSON envelopes are parsed; text output
 * falls back to the `run id: <id>` line find/audit print (dogfood F-46 —
 * the default non---json invocation must still record its run). Parse
 * failure keeps null.
 */
const RUN_ID_TEXT_LINE = /^run id: ([\w-]+)$/m;

export function updateReceiptFromResult(jobId: string, resultOutput: string): void {
  let runId: unknown;
  let projectId: unknown;
  const trimmed = resultOutput.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { data?: { run?: { id?: unknown } }; project?: { id?: unknown } };
      runId = parsed?.data?.run?.id;
      projectId = parsed?.project?.id;
    } catch {
      return;
    }
  } else {
    runId = RUN_ID_TEXT_LINE.exec(trimmed)?.[1];
  }
  if (typeof runId !== "string" || !runId) return;
  for (const { file, receipt } of findReceipts(jobId)) {
    const next: Receipt = {
      ...receipt,
      runId,
      ...(typeof projectId === "string" && projectId ? { projectId } : {}),
      settledAt: new Date().toISOString(),
    };
    try {
      writeReceiptFile(file, next);
    } catch {
      // The old receipt still names the job; losing the update is not fatal.
    }
  }
}

/**
 * The recovery commands a receipt suggests, most specific first. Printed by
 * `receipts show` and by `jobs` when a job id no longer resolves.
 */
export function receiptRecoveryCommands(receipt: Receipt): string[] {
  const id8 = receipt.jobId.slice(0, 8);
  // A detached local run has no server and no job registry: everything about
  // it is local (ADR 0022). Two concurrent detaches are told apart by these
  // receipts and logs, never by `audit coverage --latest`.
  if (receipt.mode === "local") {
    const local = [
      ...(receipt.logPath ? [`tail -f ${shellQuote(receipt.logPath)}    # the detached run's log`] : []),
      `pir receipts show ${id8}    # the child's exit code, once it settled`,
      ...(receipt.kind === "audit" ? ["pir audit coverage --latest    # that run's status (a local detach records no run id)"] : []),
      "pir findings list    # what the run has written so far",
    ];
    return local;
  }
  const commands = [
    `pir jobs wait ${id8} --server ${receipt.origin}    # follow it again`,
    `pir jobs fetch ${id8} --server ${receipt.origin}   # relay a finished result`,
  ];
  if (receipt.projectId) {
    if (receipt.runId) {
      commands.push(`pir runs status ${runUrl({ origin: receipt.origin, projectId: receipt.projectId, runId: receipt.runId })}`);
      commands.push(`pir findings export --run ${runUrl({ origin: receipt.origin, projectId: receipt.projectId, runId: receipt.runId })} --output findings.json`);
    } else {
      commands.push(`# run id unknown (job not observed to settle) — after \`pir jobs fetch ${id8}\` it is recorded here`);
    }
  }
  return commands;
}

/**
 * `pir receipts list [--json]` / `pir receipts show <jobId-prefix>` — pure
 * client-side reads over the receipts directory.
 */
export async function runReceiptsCommand(argv: string[]): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  const json = Boolean(flags.get("--json"));
  // Defense in depth (#43): the CLI answers --help before dispatching;
  // library callers of the executor reach this branch first.
  if (flags.get("--help") === true) {
    process.stdout.write(helpFor("receipts"));
    return 0;
  }
  const sub = positional[1] ?? "list";
  if (sub !== "list" && sub !== "show") {
    throw new UsageError(`unknown receipts subcommand: ${sub} (expected list | show)`);
  }
  const receipts = listReceipts();

  if (sub === "list") {
    if (json) {
      process.stdout.write(`${JSON.stringify({ schemaVersion: 1, command: "receipts.list", data: { receipts: receipts.map((r) => r.receipt) } })}\n`);
      return 0;
    }
    if (receipts.length === 0) {
      process.stdout.write(`no receipts in ${receiptsDir()} (one is written whenever a server accepts an async review)\n`);
      return 0;
    }
    process.stdout.write("submitted            job       kind    head      run              origin\n");
    for (const { receipt } of receipts) {
      const submitted = receipt.submittedAt.replace("T", " ").slice(0, 19);
      process.stdout.write(
        `${submitted.padEnd(21)}${receipt.jobId.slice(0, 8).padEnd(10)}${receipt.kind.padEnd(8)}${receipt.head.slice(0, 8).padEnd(10)}` +
          `${(receipt.runId ?? "-").slice(0, 16).padEnd(17)}${receipt.origin}\n`,
      );
    }
    return 0;
  }

  const prefix = positional[2];
  if (!prefix) throw new UsageError("receipts show requires a job id (see `pir receipts list`)");
  const matches = findReceipts(prefix);
  if (matches.length === 0) {
    process.stderr.write(`pir: no receipt matches job id: ${prefix}\n`);
    return 3;
  }
  if (matches.length > 1) throw new UsageError(`ambiguous job id: ${prefix} matches ${matches.length} receipts`);
  const { file, receipt } = matches[0]!;
  if (json) {
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, command: "receipts.show", data: receipt })}\n`);
    return 0;
  }
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(`\nreceipt file: ${file}\nrecovery:\n`);
  for (const command of receiptRecoveryCommands(receipt)) process.stdout.write(`  ${command}\n`);
  return 0;
}
