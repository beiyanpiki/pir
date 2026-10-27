import { chmodSync, closeSync, mkdirSync, openSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { UsageError, parseArgs, resolveOutputFormat } from "./executor.js";
import { configDir } from "./config.js";
import { buildLocalReceipt, receiptRecoveryCommands, writeLocalReceipt } from "./receipts.js";
import { getHeadCommit } from "../changes/git.js";

/**
 * Local detached execution (ADR 0016 Part IV): `find`/`audit --detach` in local mode
 * re-executes this CLI as a background process with an owner-only log, writes
 * a receipt before the spawn and returns as soon as the child is accepted.
 * The child settles its own receipt from its exit hook (`PIR_LOCAL_JOB_ID`),
 * so the final exit code survives the terminal.
 *
 * Deliberately absent: resume, a daemon, a local job registry, auto-detach.
 */

const DETACH_FLAG = "--detach";

export type DetachCommand = "find" | "audit";

export interface DetachInvocation {
  command: DetachCommand;
  /** --json (or --format json): print the machine envelope instead of text. */
  json: boolean;
  /** The repository the run acts on: --cwd anchored at the invocation dir. */
  repoDir: string;
}

export interface LocalDetachOptions {
  /** argv as the user passed it (no node/script prefix), --detach included. */
  argv: string[];
  /** Invocation directory; the child is pinned to it. */
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** stdout sink for the submission envelope. */
  emit: (text: string) => void;
  /** stderr sink for diagnostics (never silenced: errors must stay visible). */
  log: (message: string) => void;
  /** Test seams; production uses this process. */
  execPath?: string;
  scriptPath?: string;
  spawnFn?: typeof spawn;
  jobId?: string;
}

/**
 * The child argv: the caller's argv with exactly one --detach token removed.
 * The flag never reaches the child, so it cannot re-detach and cannot trip
 * the executor's server-lane rejection.
 */
export function detachChildArgv(argv: string[]): string[] {
  const index = argv.indexOf(DETACH_FLAG);
  if (index === -1) return [...argv];
  return [...argv.slice(0, index), ...argv.slice(index + 1)];
}

/**
 * Validate a local detach invocation before any file is created. Lanes that
 * produce no run — a preview, a dry run, a coverage readout — and commands
 * that are not review commands are usage errors (exit 2), never silently
 * ignored (ADR 0016 Part IV decision 9).
 */
export function resolveDetachInvocation(argv: string[], cwd: string): DetachInvocation {
  const { positional, flags } = parseArgs(argv);
  const command = positional[0];
  if (command !== "find" && command !== "audit") {
    throw new UsageError("--detach applies to `pir find` / `pir audit`; this command has no run to detach");
  }
  if (argv.filter((token) => token === DETACH_FLAG).length > 1) {
    throw new UsageError("--detach was given more than once; pass it once");
  }
  if (command === "find" && flags.get("--preview") === true) {
    throw new UsageError("find --preview previews the file selection and takes no run to detach; drop --detach");
  }
  if (command === "audit" && flags.get("--dry-run") === true) {
    throw new UsageError("audit --dry-run previews the scope and takes no run to detach; drop --detach");
  }
  if (command === "audit" && positional[1] === "coverage") {
    throw new UsageError("audit coverage reads a recorded run; it takes no run to detach");
  }
  const cwdFlag = flags.get("--cwd");
  const repoDir = typeof cwdFlag === "string" ? path.resolve(cwd, cwdFlag) : cwd;
  return { command, json: resolveOutputFormat(flags) === "json", repoDir };
}

/** HEAD of the repository the run will review, or an empty string outside one. */
async function headCommitOrEmpty(repoDir: string): Promise<string> {
  try {
    return await getHeadCommit(repoDir);
  } catch {
    return "";
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function closeQuietly(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    /* the child holds its own descriptor; nothing to recover */
  }
}

/**
 * Handle one local `--detach` invocation. Returns the CLI exit code: 0 once
 * the detached child is accepted, 3 when the log cannot be created or the
 * child cannot be started (in both cases no receipt is left behind).
 */
export async function localDetach(options: LocalDetachOptions): Promise<number> {
  const { argv, cwd, env, emit, log } = options;
  const invocation = resolveDetachInvocation(argv, cwd);
  const jobId = options.jobId ?? randomUUID();
  const logDir = path.join(configDir(), "logs");
  const logPath = path.join(logDir, `${jobId}.log`);
  const childArgv = detachChildArgv(argv);

  // 1. The log is the child's stdout/stderr. Create it before anything is
  //    spawned: if this fails there is no run to detach (exit 3, no receipt).
  let fd: number;
  try {
    mkdirSync(logDir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(logDir, 0o700);
    } catch {
      /* best effort (umask/exotic filesystem) */
    }
    fd = openSync(logPath, "a", 0o600);
    try {
      chmodSync(logPath, 0o600);
    } catch {
      /* best effort */
    }
  } catch (err) {
    log(`pir: cannot create the detached run's log at ${logPath}: ${errorMessage(err)}`);
    return 3;
  }

  // 2. The receipt names the run before it exists; the child settles it.
  const head = await headCommitOrEmpty(invocation.repoDir);
  const receipt = buildLocalReceipt({ kind: invocation.command, jobId, head, argv: childArgv, logPath });
  const receiptPath = writeLocalReceipt(receipt);

  // 3. Detach: own session, no terminal fds, no wizard, and the job id that
  //    makes the child settle the receipt instead of detaching again.
  const spawnFn = options.spawnFn ?? spawn;
  const spawnOptions: SpawnOptions = {
    cwd,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", fd, fd],
    env: { ...env, PIR_LOCAL_JOB_ID: jobId, PIR_NO_WIZARD: "1" },
  };
  let child: ChildProcess;
  try {
    child = spawnFn(options.execPath ?? process.execPath, [options.scriptPath ?? path.resolve(process.argv[1] ?? "dist/cli/cli.js"), ...childArgv], spawnOptions);
  } catch (err) {
    closeQuietly(fd);
    removeReceipt(receiptPath);
    log(`pir: could not start the detached ${invocation.command} run: ${errorMessage(err)}`);
    return 3;
  }

  // 4. Exit 0 must mean the child actually started: a spawn failure (ENOENT,
  //    EACCES) arrives asynchronously as an 'error' event.
  const failure = await new Promise<string | null>((resolve) => {
    child.once("spawn", () => resolve(null));
    child.once("error", (err) => resolve(errorMessage(err)));
  });
  closeQuietly(fd);
  if (failure !== null) {
    removeReceipt(receiptPath);
    log(`pir: could not start the detached ${invocation.command} run: ${failure}`);
    return 3;
  }
  child.unref();

  // 5. Submission envelope: exit 0 attests acceptance, never review success.
  const followUp = receiptRecoveryCommands(receipt);
  if (invocation.json) {
    emit(
      `${JSON.stringify({
        schemaVersion: 1,
        command: `${invocation.command}.detach`,
        data: {
          jobId,
          mode: "local",
          logPath,
          receiptPath,
          head,
          base: null,
          followUp,
        },
      })}\n`,
    );
  } else {
    emit(
      `${[
        `detached ${invocation.command} as local job ${jobId}`,
        `log: ${logPath}`,
        ...(receiptPath !== null ? [`receipt: ${receiptPath}`] : ["receipt: not written"]),
        "follow up:",
        ...followUp.map((line) => `  ${line}`),
        "exit 0 means accepted, not reviewed — the run continues after this terminal closes",
      ].join("\n")}\n`,
    );
  }
  return 0;
}

/** A failed spawn leaves no receipt: there is no run for it to describe. */
function removeReceipt(receiptPath: string | null): void {
  if (receiptPath === null) return;
  try {
    rmSync(receiptPath, { force: true });
  } catch {
    /* best effort */
  }
}
