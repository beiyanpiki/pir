#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
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

const USAGE = `pir — pi-based code review with repository memory

Usage:
  pir find [options]                     run the finding loop over a change range
  pir memory status|bootstrap|refresh    manage repository memory
  pir feedback <id> <decision> [--note]  record user feedback on a finding
  pir feedback <id> priority <P0-P3>     set finding priority
  pir remember <scope> <target> <kind> --text "..."   store code knowledge
  pir findings [list [--status <s>]]     list stored findings
  pir findings show <id>                 show one finding
  pir verify-fix <id>                    verify a reported fix
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

Global options:
  --json              machine-readable JSON on stdout (progress goes to stderr)
  --cwd <path>        repository to operate on (default: process cwd)
  --quiet             suppress progress output

Feedback decisions: ${FEEDBACK_DECISIONS.join(", ")}

Exit codes: 0 ok | 1 findings at/above --fail-on | 2 usage error | 3 runtime error`;

interface ParsedArgs {
  positional: string[];
  flags: Map<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  const valueFlags = new Set([
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
  ]);
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token.startsWith("--")) {
      if (valueFlags.has(token)) {
        const value = argv[i + 1];
        if (value === undefined) usageError(`missing value for ${token}`);
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

function usageError(message: string): never {
  process.stderr.write(`pir: ${message}\n\n${USAGE}\n`);
  process.exit(2);
}

function log(flags: Map<string, string | boolean>, message: string): void {
  if (!flags.get("--json") && !flags.get("--quiet")) {
    process.stderr.write(`${message}\n`);
  }
}

function readVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(path.join(here, "..", "..", "package.json"), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function main(argv: string[]): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  const command = positional[0];
  const cwd = typeof flags.get("--cwd") === "string" ? (flags.get("--cwd") as string) : process.cwd();
  const json = Boolean(flags.get("--json"));

  if (!command || command === "help" || flags.get("--help")) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (command === "version") {
    process.stdout.write(json ? envelope("version", { version: readVersion() }) : `pir ${readVersion()}\n`);
    return 0;
  }

  const knownCommands = new Set(["find", "memory", "feedback", "remember", "findings", "verify-fix"]);
  if (!knownCommands.has(command)) {
    usageError(`unknown command: ${command}`);
  }

  const ctx = await createAppContext(cwd, {
    noSyncIndex: Boolean(flags.get("--no-sync-index")),
  });

  try {
    switch (command) {
      case "find":
        return await cmdFind(ctx, positional.slice(1), flags, json);
      case "memory":
        return await cmdMemory(ctx, positional.slice(1), flags, json);
      case "feedback":
        return await cmdFeedback(ctx, positional.slice(1), flags, json);
      case "remember":
        return await cmdRemember(ctx, positional.slice(1), flags, json);
      case "findings":
        return await cmdFindings(ctx, positional.slice(1), flags, json);
      case "verify-fix":
        return await cmdVerifyFix(ctx, positional.slice(1), flags, json);
      default:
        usageError(`unknown command: ${command}`);
    }
  } finally {
    ctx.memory.close();
  }
}

async function cmdFind(
  ctx: Awaited<ReturnType<typeof createAppContext>>,
  _args: string[],
  flags: Map<string, string | boolean>,
  json: boolean,
): Promise<number> {
  const failOn = (flags.get("--fail-on") as string) ?? "none";
  if (!["P0", "P1", "P2", "P3", "none"].includes(failOn)) usageError(`invalid --fail-on: ${failOn}`);
  const result = await runFind(ctx, {
    base: flags.get("--base") as string | undefined,
    head: flags.get("--head") as string | undefined,
    maxRounds: flags.get("--max-rounds") !== undefined ? Number(flags.get("--max-rounds")) : undefined,
    maxTokens: flags.get("--max-tokens") !== undefined ? Number(flags.get("--max-tokens")) : undefined,
    model: flags.get("--model") as string | undefined,
    onProgress: (event) => log(flags, `• ${event.message}`),
  });
  const findings = result.findings.map((row) => toFindingView(ctx, row));

  if (json) {
    process.stdout.write(
      envelope(
        "find",
        {
          run: {
            id: result.runId,
            base: result.base,
            head: result.head,
            rounds: result.rounds,
            files: result.changeSet.files.map((f) => ({ path: f.path, status: f.status, additions: f.additions, deletions: f.deletions })),
          },
          degraded: result.degraded,
          stoppedBecause: result.stoppedBecause,
          estimatedTokens: result.estimatedTokens,
          findings,
        },
        { project: { id: ctx.memory.identity.projectId, cwd: ctx.repoRoot, head: result.head } },
      ),
    );
    process.stdout.write("\n");
  } else {
    process.stdout.write(`${renderFindResultText({ degraded: result.degraded, rounds: result.rounds, findings, stoppedBecause: result.stoppedBecause })}\n`);
  }

  if (failOn !== "none" && findings.some((f) => isReported(f) && severityAtLeast(f.severity, failOn))) {
    return 1;
  }
  return 0;
}

async function cmdMemory(
  ctx: Awaited<ReturnType<typeof createAppContext>>,
  args: string[],
  flags: Map<string, string | boolean>,
  json: boolean,
): Promise<number> {
  const sub = args[0] ?? "status";
  switch (sub) {
    case "status": {
      const status = await memoryStatus(ctx);
      process.stdout.write(json ? `${envelope("memory.status", status)}\n` : `${JSON.stringify(status, null, 2)}\n`);
      return 0;
    }
    case "bootstrap": {
      const result = await memoryBootstrap(ctx, {
        model: flags.get("--model") as string | undefined,
        maxBatches: flags.get("--max-batches") !== undefined ? Number(flags.get("--max-batches")) : undefined,
        onProgress: (m) => log(flags, `• ${m}`),
      });
      process.stdout.write(json ? `${envelope("memory.bootstrap", result)}\n` : `bootstrap done: ${result.modulesSummarized} modules, ${result.featuresCreated} features, ${result.entitiesCreated} entities\n`);
      return 0;
    }
    case "refresh": {
      const result = await memoryRefresh(ctx, {
        model: flags.get("--model") as string | undefined,
        onProgress: (m) => log(flags, `• ${m}`),
      });
      process.stdout.write(json ? `${envelope("memory.refresh", result)}\n` : `refresh done: ${result.changedFiles.length} changed files, ${result.entitiesRefreshed} entities refreshed\n`);
      return 0;
    }
    default:
      usageError(`unknown memory subcommand: ${sub}`);
  }
}

async function cmdFeedback(
  ctx: Awaited<ReturnType<typeof createAppContext>>,
  args: string[],
  flags: Map<string, string | boolean>,
  json: boolean,
): Promise<number> {
  const findingId = args[0];
  const decision = args[1];
  if (!findingId) usageError("feedback requires a finding id");
  if (decision === "priority") {
    const priority = args[2];
    if (!priority || !["P0", "P1", "P2", "P3"].includes(priority)) usageError("priority requires P0|P1|P2|P3");
    const result = feedbackPriority(ctx, findingId, priority, flags.get("--note") as string | undefined);
    process.stdout.write(json ? `${envelope("feedback", result)}\n` : `${result.findingDisplayId} priority set to ${priority}\n`);
    return 0;
  }
  if (!decision || !(FEEDBACK_DECISIONS as readonly string[]).includes(decision)) {
    usageError(`decision must be one of: ${FEEDBACK_DECISIONS.join(", ")}`);
  }
  const result = await feedback(ctx, {
    findingId,
    decision,
    note: flags.get("--note") as string | undefined,
  });
  process.stdout.write(
    json
      ? `${envelope("feedback", result)}\n`
      : `${result.findingDisplayId}: ${result.previousStatus} -> ${result.newStatus}${result.issueMemoryId ? " (issue memory recorded)" : ""}${result.resolutionId ? " (resolution recorded)" : ""}\n`,
  );
  return 0;
}

async function cmdRemember(
  ctx: Awaited<ReturnType<typeof createAppContext>>,
  args: string[],
  flags: Map<string, string | boolean>,
  json: boolean,
): Promise<number> {
  const scope = args[0] as "project" | "feature" | "symbol" | undefined;
  if (!scope || !["project", "feature", "symbol"].includes(scope)) {
    usageError("remember requires scope: project | feature | symbol");
  }
  const rest = args.slice(1);
  let target: string | undefined;
  let kind: string;
  if (scope === "project") {
    kind = rest[0] ?? "";
  } else {
    target = rest[0];
    kind = rest[1] ?? "";
    if (!target) usageError(`remember ${scope} requires a target`);
  }
  if (!["invariant", "note", "risk"].includes(kind)) usageError("kind must be: invariant | note | risk");
  const text = flags.get("--text");
  if (typeof text !== "string" || text.length === 0) usageError("remember requires --text \"...\"");

  const result = remember(ctx, { scope, target, kind: kind as "invariant" | "note" | "risk", text });
  process.stdout.write(
    json ? `${envelope("remember", result)}\n` : `remembered (${result.scope}${result.target ? ` ${result.target}` : ""}) -> ${result.stored}\n`,
  );
  return 0;
}

async function cmdFindings(
  ctx: Awaited<ReturnType<typeof createAppContext>>,
  args: string[],
  flags: Map<string, string | boolean>,
  json: boolean,
): Promise<number> {
  const sub = args[0] ?? "list";
  if (sub === "show") {
    const id = args[1];
    if (!id) usageError("findings show requires an id");
    const finding = showFinding(ctx, id);
    if (!finding) {
      process.stderr.write(`pir: finding not found: ${id}\n`);
      return 3;
    }
    process.stdout.write(json ? `${envelope("findings.show", finding)}\n` : `${JSON.stringify(finding, null, 2)}\n`);
    return 0;
  }
  if (sub === "list") {
    const status = flags.get("--status") as string | undefined;
    const findings = listFindings(ctx, { status });
    process.stdout.write(json ? `${envelope("findings.list", { findings })}\n` : `${JSON.stringify(findings, null, 2)}\n`);
    return 0;
  }
  usageError(`unknown findings subcommand: ${sub}`);
}

async function cmdVerifyFix(
  ctx: Awaited<ReturnType<typeof createAppContext>>,
  args: string[],
  flags: Map<string, string | boolean>,
  json: boolean,
): Promise<number> {
  const id = args[0];
  if (!id) usageError("verify-fix requires a finding id");
  const result = await verifyFix(ctx, id, { model: flags.get("--model") as string | undefined });
  process.stdout.write(
    json ? `${envelope("verify-fix", result)}\n` : `${result.displayId}: ${result.verifiedFixed ? "verified fixed ✅" : result.triggerStillReproduces ? "still reproduces ❌ (reopened)" : "inconclusive"}\n  ${result.rationale.slice(0, 300)}\n`,
  );
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`pir: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(3);
  },
);
