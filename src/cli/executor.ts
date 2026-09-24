import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAppContext } from "../app/context.js";
import { runFind, toFindingView } from "../app/find.js";
import {
  feedback,
  feedbackPriority,
  listFindings,
  memoryBootstrap,
  memoryRefresh,
  memoryStatus,
  remember,
  showFinding,
  verifyFix,
} from "../app/services.js";
import { envelope, isReported, renderFindResultText, severityAtLeast } from "../app/output.js";
import { FEEDBACK_DECISIONS } from "../memory/feedback.js";

export const USAGE = `pir — pi-based code review with repository memory

Usage:
  pir find [options]                     run the finding loop over a change range
  pir memory status|bootstrap|refresh    manage repository memory
  pir feedback <id> <decision> [--note]  record user feedback on a finding
  pir feedback <id> priority <P0-P3>     set finding priority
  pir remember <scope> <target> <kind> --text "..."   store code knowledge
  pir findings [list [--status <s>]]     list stored findings
  pir findings show <id>                 show one finding
  pir verify-fix <id>                    verify a reported fix
  pir serve [--host H --port P] [--cert C --key K] [--token T]   HTTPS service
  pir version

Find options:
  --base <ref>        base ref (default: HEAD^)
  --head <ref>        head ref (default: HEAD)
  --max-rounds <n>    reviewer loop rounds (default 2)
  --max-tokens <n>    token budget estimate (default 400000)
  --fail-on <sev>     exit 1 when a finding with severity >= sev is reported
                      (P0|P1|P2|P3|none, default none)
  --model <id>        model override for sub-sessions (default: pi settings)
  --no-sync-index     skip codegraph index sync

Serve options:
  --host <h>          bind address (default 0.0.0.0)
  --port <p>          port (default 8790)
  --cert <p> --key <p>  TLS cert/key (PEM). Falls back to PIR_TLS_CERT /
                      PIR_TLS_KEY; otherwise a self-signed pair is generated
                      with openssl when available.
  --token <t>         require "Authorization: Bearer <t>" (default PIR_SERVER_TOKEN)

Global options:
  --json              machine-readable JSON on stdout (progress goes to stderr)
  --cwd <path>        repository to operate on (default: process cwd)
  --quiet             suppress progress output

Remote mode:
  --server <url>      execute on a remote pir serve instance
  --token <t>         bearer token for the remote
  --insecure          accept self-signed TLS certificates

Feedback decisions: ${FEEDBACK_DECISIONS.join(", ")}

Exit codes: 0 ok | 1 findings at/above --fail-on | 2 usage error | 3 runtime error`;

export class UsageError extends Error {}

export interface ExecResult {
  code: number;
  output: string;
}

export interface ExecOptions {
  /** Progress/log sink (CLI: stderr; server: server log; tests: capture). */
  onLog?: (message: string) => void;
  /** Restrict --cwd to paths under this root (server mode guard). */
  cwdGuard?: string;
  /** Explicit sqlite location override (bundle/worktree server flows). */
  dbPath?: string;
}

interface ParsedArgs {
  positional: string[];
  flags: Map<string, string | boolean>;
}

const VALUE_FLAGS = new Set([
  "--base",
  "--head",
  "--max-rounds",
  "--max-tokens",
  "--fail-on",
  "--model",
  "--cwd",
  "--status",
  "--note",
  "--text",
  "--max-batches",
  "--repo",
  "--branch",
  "--name",
]);

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token.startsWith("--")) {
      if (VALUE_FLAGS.has(token)) {
        const value = argv[i + 1];
        if (value === undefined) throw new UsageError(`missing value for ${token}`);
        flags.set(token, value);
        i += 1;
      } else {
        flags.set(token, true);
      }
    } else {
      positional.push(token);
    }
  }
  return { positional, flags };
}

export function readVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    // dist/cli/executor.js -> package root two levels up
    const pkg = JSON.parse(readFileSync(path.join(here, "..", "..", "package.json"), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * The single command path shared by the local CLI, the HTTPS server and
 * remote relays. Returns captured stdout output plus the exit code instead of
 * writing to the process streams.
 */
export async function executePirCommand(argv: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  const { positional, flags } = parseArgs(argv);
  const command = positional[0];
  const json = Boolean(flags.get("--json"));
  const out: string[] = [];
  const emit = (text: string) => out.push(text);
  const log = (message: string) => opts.onLog?.(message);

  if (command === "repos") {
    return await cmdRepos(positional.slice(1), flags, json, emit, out);
  }

  let cwd = typeof flags.get("--cwd") === "string" ? (flags.get("--cwd") as string) : process.cwd();
  if (opts.cwdGuard) {
    const resolved = path.resolve(cwd);
    const guard = path.resolve(opts.cwdGuard);
    if (resolved !== guard && !resolved.startsWith(guard + path.sep)) {
      throw new UsageError(`--cwd must stay under ${guard}`);
    }
    cwd = resolved;
  }

  // Review the working tree (tracked + untracked) as a virtual commit,
  // without touching the user's index or branches.
  const explicitDbPath = typeof opts.dbPath === "string" ? opts.dbPath : undefined;
  if (flags.get("--uncommitted")) {
    if (command !== "find") throw new UsageError("--uncommitted applies to find only");
    if (flags.get("--repo")) throw new UsageError("--uncommitted and --repo are mutually exclusive");
    const { createWorkingTreeSnapshot } = await import("../changes/git.js");
    const snapshot = await createWorkingTreeSnapshot(cwd);
    flags.delete("--uncommitted");
    flags.set("--head", snapshot);
    log(`• working-tree snapshot ${snapshot.slice(0, 10)}`);
  }

  // Server-side registered repo: fetch the clone, review in a throwaway worktree.
  let materialized: import("../app/repos.js").MaterializedReview | null = null;
  if (typeof flags.get("--repo") === "string") {
    const repoSpec = flags.get("--repo") as string;
    if (!["find", "memory", "findings", "verify-fix"].includes(command ?? "")) {
      throw new UsageError(`--repo applies to find/memory/findings/verify-fix, not ${command}`);
    }
    const { resolveRepo, materializeRegistered, reviewDbPath } = await import("../app/repos.js");
    const resolvedRepo = resolveRepo(repoSpec);
    log(`• repo ${resolvedRepo.entry.name} (${resolvedRepo.entry.projectId.slice(0, 10)}…)`);
    materialized = await materializeRegistered(resolvedRepo.dir, resolvedRepo.entry.projectId, {
      branch: typeof flags.get("--branch") === "string" ? (flags.get("--branch") as string) : undefined,
      noFetch: Boolean(flags.get("--no-fetch")),
    });
    cwd = materialized.worktree;
    const dbPath = explicitDbPath ?? reviewDbPath(materialized.projectId);
    flags.set("--cwd", cwd);
    return await runInContext(cwd, { dbPath }, command ?? "", positional, flags, json, out, emit, log, materialized);
  }

  if (!command || command === "help" || flags.get("--help")) {
    emit(`${USAGE}\n`);
    return { code: 0, output: out.join("") };
  }
  if (command === "version") {
    emit(json ? envelope("version", { version: readVersion() }) : `pir ${readVersion()}\n`);
    return { code: 0, output: out.join("") };
  }
  if (command === "serve") {
    throw new UsageError("serve must run in the local CLI process, not through the executor");
  }

  const knownCommands = new Set(["find", "memory", "feedback", "remember", "findings", "verify-fix"]);
  if (!knownCommands.has(command)) {
    throw new UsageError(`unknown command: ${command}`);
  }

  return await runInContext(cwd, { dbPath: explicitDbPath }, command, positional, flags, json, out, emit, log, null);
}

async function runInContext(
  cwd: string,
  ctxOptions: { dbPath?: string },
  command: string,
  positional: string[],
  flags: Map<string, string | boolean>,
  json: boolean,
  out: string[],
  emit: Emit,
  log: Log,
  materialized: import("../app/repos.js").MaterializedReview | null,
): Promise<ExecResult> {
  const ctx = await createAppContext(cwd, {
    noSyncIndex: Boolean(flags.get("--no-sync-index")),
    dbPath: ctxOptions.dbPath,
  });

  let code: number;
  try {
    switch (command) {
      case "find":
        code = await cmdFind(ctx, positional.slice(1), flags, json, emit, log);
        break;
      case "memory":
        code = await cmdMemory(ctx, positional.slice(1), flags, json, emit, log);
        break;
      case "feedback":
        code = await cmdFeedback(ctx, positional.slice(1), flags, json, emit);
        break;
      case "remember":
        code = await cmdRemember(ctx, positional.slice(1), flags, json, emit);
        break;
      case "findings":
        code = await cmdFindings(ctx, positional.slice(1), flags, json, emit, log);
        break;
      case "verify-fix":
        code = await cmdVerifyFix(ctx, positional.slice(1), flags, json, emit);
        break;
      default:
        throw new UsageError(`unknown command: ${command}`);
    }
  } finally {
    ctx.memory.close();
    await materialized?.cleanup();
  }
  return { code, output: out.join("") };
}

async function cmdRepos(
  args: string[],
  flags: Map<string, string | boolean>,
  json: boolean,
  emit: Emit,
  out: string[],
): Promise<ExecResult> {
  const { addRepo, listRepos, removeRepo } = await import("../app/repos.js");
  const sub = args[0] ?? "list";
  if (sub === "list") {
    const repos = listRepos();
    emit(json ? `${envelope("repos.list", { repos })}\n` : `${JSON.stringify(repos, null, 2)}\n`);
    return { code: 0, output: out.join("") };
  }
  if (sub === "add") {
    const source = args[1];
    if (!source) throw new UsageError("repos add requires a git URL or local path");
    const name = typeof flags.get("--name") === "string" ? (flags.get("--name") as string) : undefined;
    const entry = await addRepo(source, name);
    emit(json ? `${envelope("repos.add", entry)}\n` : `registered ${entry.name} -> ${entry.projectId.slice(0, 12)}…\n`);
    return { code: 0, output: out.join("") };
  }
  if (sub === "remove") {
    const name = args[1];
    if (!name) throw new UsageError("repos remove requires a name");
    const entry = removeRepo(name, Boolean(flags.get("--purge")));
    emit(
      json
        ? `${envelope("repos.remove", entry)}\n`
        : `removed ${entry.name}${flags.get("--purge") ? " (clone purged)" : ""}\n`,
    );
    return { code: 0, output: out.join("") };
  }
  throw new UsageError(`unknown repos subcommand: ${sub}`);
}

type Emit = (text: string) => void;
type Log = (message: string) => void;
type Ctx = Awaited<ReturnType<typeof createAppContext>>;

async function cmdFind(
  ctx: Ctx,
  _args: string[],
  flags: Map<string, string | boolean>,
  json: boolean,
  emit: Emit,
  log: Log,
): Promise<number> {
  const failOn = (flags.get("--fail-on") as string) ?? "none";
  if (!["P0", "P1", "P2", "P3", "none"].includes(failOn)) throw new UsageError(`invalid --fail-on: ${failOn}`);
  const result = await runFind(ctx, {
    base: flags.get("--base") as string | undefined,
    head: flags.get("--head") as string | undefined,
    maxRounds: flags.get("--max-rounds") !== undefined ? Number(flags.get("--max-rounds")) : undefined,
    maxTokens: flags.get("--max-tokens") !== undefined ? Number(flags.get("--max-tokens")) : undefined,
    model: flags.get("--model") as string | undefined,
    onProgress: (event) => log(`• ${event.message}`),
  });
  const findings = result.findings.map((row) => toFindingView(ctx, row));

  if (json) {
    emit(
      envelope(
        "find",
        {
          run: {
            id: result.runId,
            base: result.base,
            head: result.head,
            rounds: result.rounds,
            files: result.changeSet.files.map((f) => ({
              path: f.path,
              status: f.status,
              additions: f.additions,
              deletions: f.deletions,
            })),
          },
          degraded: result.degraded,
          stoppedBecause: result.stoppedBecause,
          estimatedTokens: result.estimatedTokens,
          findings,
        },
        { project: { id: ctx.memory.identity.projectId, cwd: ctx.repoRoot, head: result.head } },
      ),
    );
    emit("\n");
  } else {
    emit(
      `${renderFindResultText({
        degraded: result.degraded,
        rounds: result.rounds,
        findings,
        stoppedBecause: result.stoppedBecause,
      })}\n`,
    );
  }

  if (failOn !== "none" && findings.some((f) => isReported(f) && severityAtLeast(f.severity, failOn))) {
    return 1;
  }
  return 0;
}

async function cmdMemory(
  ctx: Ctx,
  args: string[],
  flags: Map<string, string | boolean>,
  json: boolean,
  emit: Emit,
  log: Log,
): Promise<number> {
  const sub = args[0] ?? "status";
  switch (sub) {
    case "status": {
      const status = await memoryStatus(ctx);
      emit(json ? `${envelope("memory.status", status)}\n` : `${JSON.stringify(status, null, 2)}\n`);
      return 0;
    }
    case "bootstrap": {
      const result = await memoryBootstrap(ctx, {
        model: flags.get("--model") as string | undefined,
        maxBatches: flags.get("--max-batches") !== undefined ? Number(flags.get("--max-batches")) : undefined,
        onProgress: (m) => log(`• ${m}`),
      });
      emit(
        json
          ? `${envelope("memory.bootstrap", result)}\n`
          : `bootstrap done: ${result.modulesSummarized} modules, ${result.featuresCreated} features, ${result.entitiesCreated} entities\n`,
      );
      return 0;
    }
    case "refresh": {
      const result = await memoryRefresh(ctx, {
        model: flags.get("--model") as string | undefined,
        onProgress: (m) => log(`• ${m}`),
      });
      emit(
        json
          ? `${envelope("memory.refresh", result)}\n`
          : `refresh done: ${result.changedFiles.length} changed files, ${result.entitiesRefreshed} entities refreshed\n`,
      );
      return 0;
    }
    default:
      throw new UsageError(`unknown memory subcommand: ${sub}`);
  }
}

async function cmdFeedback(
  ctx: Ctx,
  args: string[],
  flags: Map<string, string | boolean>,
  json: boolean,
  emit: Emit,
): Promise<number> {
  const findingId = args[0];
  const decision = args[1];
  if (!findingId) throw new UsageError("feedback requires a finding id");
  if (decision === "priority") {
    const priority = args[2];
    if (!priority || !["P0", "P1", "P2", "P3"].includes(priority)) {
      throw new UsageError("priority requires P0|P1|P2|P3");
    }
    const result = feedbackPriority(ctx, findingId, priority, flags.get("--note") as string | undefined);
    emit(
      json
        ? `${envelope("feedback", result)}\n`
        : `${result.findingDisplayId} priority set to ${priority}\n`,
    );
    return 0;
  }
  if (!decision || !(FEEDBACK_DECISIONS as readonly string[]).includes(decision)) {
    throw new UsageError(`decision must be one of: ${FEEDBACK_DECISIONS.join(", ")}`);
  }
  const result = await feedback(ctx, {
    findingId,
    decision,
    note: flags.get("--note") as string | undefined,
  });
  emit(
    json
      ? `${envelope("feedback", result)}\n`
      : `${result.findingDisplayId}: ${result.previousStatus} -> ${result.newStatus}${result.issueMemoryId ? " (issue memory recorded)" : ""}${result.resolutionId ? " (resolution recorded)" : ""}\n`,
  );
  return 0;
}

async function cmdRemember(
  ctx: Ctx,
  args: string[],
  flags: Map<string, string | boolean>,
  json: boolean,
  emit: Emit,
): Promise<number> {
  const scope = args[0] as "project" | "feature" | "symbol" | undefined;
  if (!scope || !["project", "feature", "symbol"].includes(scope)) {
    throw new UsageError("remember requires scope: project | feature | symbol");
  }
  const rest = args.slice(1);
  let target: string | undefined;
  let kind: string;
  if (scope === "project") {
    kind = rest[0] ?? "";
  } else {
    target = rest[0];
    kind = rest[1] ?? "";
    if (!target) throw new UsageError(`remember ${scope} requires a target`);
  }
  if (!["invariant", "note", "risk"].includes(kind)) throw new UsageError("kind must be: invariant | note | risk");
  const text = flags.get("--text");
  if (typeof text !== "string" || text.length === 0) throw new UsageError('remember requires --text "..."');

  const result = remember(ctx, { scope, target, kind: kind as "invariant", text });
  emit(
    json
      ? `${envelope("remember", result)}\n`
      : `remembered (${result.scope}${result.target ? ` ${result.target}` : ""}) -> ${result.stored}\n`,
  );
  return 0;
}

async function cmdFindings(
  ctx: Ctx,
  args: string[],
  flags: Map<string, string | boolean>,
  json: boolean,
  emit: Emit,
  log: Log,
): Promise<number> {
  const sub = args[0] ?? "list";
  if (sub === "show") {
    const id = args[1];
    if (!id) throw new UsageError("findings show requires an id");
    const finding = showFinding(ctx, id);
    if (!finding) {
      log(`pir: finding not found: ${id}`);
      return 3;
    }
    emit(json ? `${envelope("findings.show", finding)}\n` : `${JSON.stringify(finding, null, 2)}\n`);
    return 0;
  }
  if (sub === "list") {
    const status = flags.get("--status") as string | undefined;
    const findings = listFindings(ctx, { status });
    emit(json ? `${envelope("findings.list", { findings })}\n` : `${JSON.stringify(findings, null, 2)}\n`);
    return 0;
  }
  throw new UsageError(`unknown findings subcommand: ${sub}`);
}

async function cmdVerifyFix(
  ctx: Ctx,
  args: string[],
  flags: Map<string, string | boolean>,
  json: boolean,
  emit: Emit,
): Promise<number> {
  const id = args[0];
  if (!id) throw new UsageError("verify-fix requires a finding id");
  const result = await verifyFix(ctx, id, { model: flags.get("--model") as string | undefined });
  emit(
    json
      ? `${envelope("verify-fix", result)}\n`
      : `${result.displayId}: ${result.verifiedFixed ? "verified fixed ✅" : result.triggerStillReproduces ? "still reproduces ❌ (reopened)" : "inconclusive"}\n  ${result.rationale.slice(0, 300)}\n`,
  );
  return 0;
}
