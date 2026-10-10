import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  UsageError,
  configPath,
  deleteUserConfig,
  isSecretKey,
  loadUserConfig,
  maskSecret,
  redactConfig,
  resolveTransport,
  runWizard,
  saveUserConfig,
  setConfigValue,
  type UserConfig,
} from "./config.js";
import { createAppContext } from "../app/context.js";
import { runFind, toFindingView } from "../app/find.js";
import { runAudit } from "../app/audit.js";
import { MAX_VERIFY_CONCURRENCY } from "../core/supervisor.js";
import {
  feedback,
  feedbackPriority,
  listFindings,
  listFindingsPage,
  memoryBootstrap,
  memoryRefresh,
  memoryStatus,
  memorySync,
  remember,
  showFinding,
  verifyFix,
  type MemorySyncResult,
} from "../app/services.js";
import { envelope, findExitCode, renderAuditResultText, renderFindResultText } from "../app/output.js";
import { FEEDBACK_DECISIONS } from "../memory/feedback.js";
import type { SyncStats, SyncTableName } from "../memory/sync.js";

export { UsageError } from "./config.js";

/**
 * The reference text, split into sections so `--help` can show one command's
 * slice (#43). USAGE re-joins them; the full text stays the single source.
 */
const USAGE_SECTIONS = {
  header: `pir — pi-based code review with repository memory

Usage:
  pir find [options]                     run the finding loop over a change range
  pir audit [options]                    full-repository audit of a pinned snapshot
  pir memory status|bootstrap|refresh    manage repository memory
  pir memory sync [--dry-run]            merge local memory with a pir server's
  pir feedback <id> <decision> [--note]  record user feedback on a finding
  pir feedback <id> priority <P0-P3>     set finding priority
  pir remember <scope> <target> <kind> --text "..."   store code knowledge
  pir findings [list [options]]        list stored findings
  pir findings show <id>                 show one finding
  pir models [search] [--all] [--ids] [--provider <p>]   list pi models
  pir verify-fix <id>                    verify a reported fix
  pir jobs list|status|wait|fetch <id>   inspect async review jobs on a server
  pir runs status <run-url>            inspect a remote run via its web URL
  pir receipts [list|show <id>]        local receipts of submitted async reviews
  pir serve [--host H --port P] [--cert C --key K] [--token T] [--web]   HTTPS service
      --web  also serve the read-only run explorer UI at / (env PIR_WEB_UI=1;
             viewer auth via PIR_WEB_UI_TOKEN; transcripts default on)
  pir config [show|wizard|set|reset]     manage ~/.pir/config.json (client setup)
  pir skill [path|install|print]         locate / install the LLM skill for pir
  pir plugins list                      list language packs and what this repo activates
  pir version`,

  find: `Find options:
  --base <ref>        base ref (default: HEAD^)
  --head <ref>        head ref (default: HEAD)
  --max-rounds <n>    discovery/verification loop rounds (default 2)
  --max-tokens <n>    optional session-boundary token budget; reviews run
                      unbounded by default (rounds and findings still cap)
  --max-findings <n>  cap on reported findings (default 10). A ceiling, not
                      a target: fewer findings is correct when evidence runs
                      out — nothing is padded to reach it. "unlimited"
                      removes the cap (#57; remote needs a same-version
                      server)
  --verify-concurrency <n>
                      parallel verifier sessions during each verification
                      drain (1-8, default 1; PIR_VERIFY_CONCURRENCY env
                      applies when the flag is absent)
  --fail-on <sev>     exit 1 when a finding with severity >= sev is reported
                      (P0|P1|P2|P3|none, default none)
  --model <id>        model override for sub-sessions: <provider>/<model> or
                      fuzzy id (see \`pir models\`; default: PIR_MODEL env,
                      then pi settings)
  --plugins <list>    language packs injecting language-specific review
                      directions (golang and typescript ship today; more
                      packs follow): comma-separated names, "none" to
                      disable, or "auto" to detect from marker files at
                      head (default)
  --no-sync-index     skip codegraph index sync
  --detach            remote only: submit as an async job and return
                      immediately (#53; see Remote mode)`,

  audit: `Audit options (current-state review; no diff, no change attribution):
  --path <p>...       literal file or directory prefix selecting scope;
                      repeatable (union). Default: whole committed tree
  --skip <glob>...    exclude paths from the selection; repeatable. Globs
                      support * ** ?; a plain value acts as a file/dir prefix
  --head <ref>        snapshot commit to audit (default: HEAD). The committed
                      tree only: uncommitted changes are never audited
  --max-tokens <n>    optional whole-run token budget across all units;
                      unlimited unless set (rounds and findings still cap)
  --max-findings <n>  whole-run cap on reported findings (default 10);
                      "unlimited" removes it (#57)
  --verify-concurrency <n>
                      parallel verifier sessions during each verification
                      drain (1-8, default 1; PIR_VERIFY_CONCURRENCY env
                      applies when the flag is absent)
  --fail-on <sev>     same gate as find (P0|P1|P2|P3|none, default none)
  --dry-run           preview the scope a real audit of the same tree and
                      options would take (#56): head/tree ids, selection and
                      classification counts, planned units — no run, no
                      model, no writes. --list-files adds per-file
                      selection/classification/reason
  --detach            remote only: submit as an async job and return
                      immediately (#53; see Remote mode)
  coverage            post-run readout of one recorded audit run (#56):
                      per-file coverage ledger from the local project db.
                      Exactly one of --run <run-id> | --latest
  Coverage is process accounting: "reviewed" means the allotted sessions
  completed. Budget stops leave files unreviewed and exit incomplete.`,

  jobs: `Jobs options:
  list                jobs on the server, oldest first
  status <id>         one job's record: state, timing, last log lines
  wait <id>           poll until it settles, streaming new log lines
                      (Ctrl-C detaches; re-run later to continue). A status
                      line prints on state changes and about once a minute
                      (#55): connection liveness, never review progress
  fetch <id>          relay a completed job's captured result
  <id>                an 8-char prefix is enough; the registry is in-memory
                      and empty after a server restart`,

  findings: `Findings options (stored-findings queries; page size is separate
  from a review's --max-findings cap):
  list [--status <s>]  filter by status (confirmed|rejected|uncertain)
  --limit <n>          page size (default 100)
  --offset <n>         page position, 0-based
  --all                fetch every page up front (no truncation)
  --run <run-url>      query one remote run over the server's read-only web
                      API instead of the local db — works outside any
                      repository, needs no git access (viewer auth via
                      --viewer-token, see Remote mode)
  export --run <url>   full-fidelity export of one run's findings: every
                      page plus every finding's detail, provenance envelope,
                      atomic --output <file>, checkpoint resume on rerun
                      ([--status <s>] [--format json]); a live run exports
                      the current snapshot (complete:false)
  JSON output reports total, returned, hasMore and nextOffset so a
  partial page is never mistaken for the complete set (#47).`,

  runs: `Runs options (recover a run from its web URL; no local git needed):
  status <run-url>     <origin>/runs/<projectId>/<runId> — the URL the web
                      UI shows; or --server <url> --project <id> --run <id>
  --json               runs.status envelope: run metadata, stopReason,
                      coverage summary, finding counts, live state (#48)
  Errors stay distinct: unknown run vs a server without the web tier
  (\`pir serve --web\`) vs missing viewer credentials.`,

  receipts: `Receipts options (local records of accepted async submissions):
  list                 receipts in ~/.pir/receipts, newest first
  show <job-id-prefix> one receipt plus the recovery commands
  A receipt is written whenever a server accepts an async review; it
  survives client disconnects and server restarts (the job registry does
  not) and carries origin/jobId/projectId/runId — enough for
  \`pir runs status\` and \`pir findings export --run\` (#52).`,

  models: `Models options:
  [search]            case-insensitive substring over provider/id/name
  --all               full pi catalog, not just authenticated providers
  --ids               one provider/model per line (script-friendly)
  --provider <p>      restrict the listing to one provider`,

  memorySync: `Memory sync options:
  pir memory sync merges this project's memory DB with a pir serve instance
  (server from --server/PIR_SERVER_URL/config). It always runs locally, even
  in remote mode — both DBs converge; nothing is ever deleted. Conflicts on
  the same record: the newer write wins, and user knowledge (user_explicit /
  verified_fix) always beats agent summaries.
  --dry-run           report what would change without writing either side`,

  serve: `Serve options:
  --host <h>          bind address (default 0.0.0.0)
  --port <p>          port (default 8790)
  --cert <p> --key <p>  TLS cert/key (PEM). Falls back to PIR_TLS_CERT /
                      PIR_TLS_KEY; otherwise a self-signed pair is generated
                      with openssl when available.
  --token <t>         require "Authorization: Bearer <t>" (default PIR_SERVER_TOKEN)
  --web               also serve the read-only run explorer at / (env
                      PIR_WEB_UI=1; viewer token PIR_WEB_UI_TOKEN, required
                      off loopback; transcripts default on)`,

  global: `Global options:
  --json              machine-readable JSON on stdout (progress goes to stderr)
  --cwd <path>        repository to operate on (default: process cwd)
  --quiet             suppress progress output
  --help              print help locally and exit 0 — answered before any
                      config, wizard, transport, git or network work, so it
                      works offline, outside a repository and with a
                      read-only .git (#43)
  --flag=value        value flags (--base, --repo, ...) also accept the
                      --flag=value form`,

  modes: `Modes:
  Local by default. The first interactive run starts a setup wizard and
  writes ~/.pir/config.json (mode local|remote, server url/token, default
  model; re-run with \`pir config\`). In remote mode every command is
  forwarded to a pir serve instance — except serve/config/skill/plugins/
  version/receipts, which always run locally (plugins inspects the local
  checkout; receipts reads ~/.pir). \`runs\` and \`findings --run\` are
  client-side queries against a server's web API, whatever the mode.
  Precedence: --server flag > --local flag >
  PIR_SERVER_URL > PIR_MODE > ~/.pir/config.json.`,

  remote: `Remote mode:
  --server <url>      execute on a remote pir serve instance
  --token <t>         bearer token for the remote (/v1 execution API)
  --viewer-token <t>  bearer token for the server's web tier (/api, the
                      PIR_WEB_UI_TOKEN the operator set) — a separate
                      credential that never falls back to --token or vice
                      versa; env PIR_VIEWER_TOKEN, config server.viewerToken.
                      Env/config viewer tokens are only sent to the server
                      they were configured for — a foreign run URL needs the
                      explicit flag (#50)
  --remote-timeout <s> seconds the client waits for remote response headers
                      and body chunks (0 disables): --remote-timeout >
                      PIR_REMOTE_TIMEOUT > config server.timeoutSeconds >
                      default 1800. Async job polling (5s interval) has no
                      overall deadline by design (#54)
  --insecure          accept self-signed TLS certificates
  --local             force local execution despite remote config
  --detach            submit find/audit as an async job and exit 0 without
                      waiting (#53): implies async, writes the #52 receipt,
                      prints the submission envelope (full jobId, origin,
                      project, head/base, follow-up commands) on stdout.
                      Exit 0 means accepted, not reviewed. Local mode
                      rejects the flag

  Review bundles are packed in a throwaway temporary bare repository that
  reads the checkout's object store (#46): the source repo's refs, index,
  config and objects are never written — a read-only .git works. The one
  exception is find --uncommitted, which records working-tree objects in
  the source repo before packing.

  Audits are submitted as async jobs (hours-to-days runs must not be bound
  to one client's wait): the CLI polls, prints progress, and relays the
  result; Ctrl-C detaches and \`pir jobs fetch <id>\` picks it up later.
  PIR_REMOTE_ASYNC=1 forces async submission for any review command.
  Remote \`findings list|show\` is answered bundle-free and never waits
  behind an in-flight audit.`,

  config: `Config keys (pir config set <key> <value>):
  mode local|remote   model <provider/model>|""
  server.url <url>    server.token <t>|""      server.insecure true|false
  server.viewerToken <t>|""  web-tier credential for runs/findings --run
  server.timeoutSeconds <s>|""  remote response wait (#54)`,

  footer: `Feedback decisions: ${FEEDBACK_DECISIONS.join(", ")}

Exit codes: 0 ok | 1 findings at/above --fail-on | 2 usage error | 3 runtime error`,
};

export const USAGE = [
  USAGE_SECTIONS.header,
  USAGE_SECTIONS.find,
  USAGE_SECTIONS.audit,
  USAGE_SECTIONS.findings,
  USAGE_SECTIONS.jobs,
  USAGE_SECTIONS.runs,
  USAGE_SECTIONS.receipts,
  USAGE_SECTIONS.models,
  USAGE_SECTIONS.memorySync,
  USAGE_SECTIONS.serve,
  USAGE_SECTIONS.global,
  USAGE_SECTIONS.modes,
  USAGE_SECTIONS.remote,
  USAGE_SECTIONS.config,
  USAGE_SECTIONS.footer,
].join("\n\n");

/** Commands that have their own USAGE section for contextual --help. */
const HELP_SECTIONS: Record<string, string> = {
  find: USAGE_SECTIONS.find,
  audit: USAGE_SECTIONS.audit,
  findings: USAGE_SECTIONS.findings,
  jobs: USAGE_SECTIONS.jobs,
  runs: USAGE_SECTIONS.runs,
  receipts: USAGE_SECTIONS.receipts,
  models: USAGE_SECTIONS.models,
  memory: USAGE_SECTIONS.memorySync,
  serve: USAGE_SECTIONS.serve,
  config: USAGE_SECTIONS.config,
};

/**
 * Contextual --help (#43): the command's own section plus the sections every
 * command shares. Unknown or absent commands get the full reference.
 */
export function helpFor(command: string | undefined): string {
  const section = command === undefined ? undefined : HELP_SECTIONS[command];
  if (section === undefined) return `${USAGE}\n`;
  return [USAGE_SECTIONS.header, section, USAGE_SECTIONS.global, USAGE_SECTIONS.footer].join("\n\n") + "\n";
}

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
  /**
   * Server read lane: open the memory db as a WAL reader (no migrations,
   * no project-row insert, no index sync) so pure-read commands can run
   * while a review holds single-writer access. The db file must already
   * exist; callers route first contact through a normal (queued) open.
   */
  readOnlyMemory?: boolean;
  /**
   * Identity for the server's bundle-free read lane: pins the project
   * without a worktree. Only meaningful with dbPath + readOnlyMemory.
   */
  identity?: import("../memory/identity.js").ProjectIdentity;
}

interface ParsedArgs {
  positional: string[];
  flags: Map<string, string | boolean>;
  /** Repeatable value flags (--path/--skip): every occurrence, in order. */
  multi: Map<string, string[]>;
}

export const VALUE_FLAGS = new Set([
  "--base",
  "--head",
  "--max-rounds",
  "--max-tokens",
  "--max-findings",
  "--verify-concurrency",
  "--fail-on",
  "--model",
  "--provider",
  "--cwd",
  "--status",
  "--note",
  "--text",
  "--max-batches",
  "--repo",
  "--branch",
  "--name",
  "--dir",
  "--server",
  "--token",
  "--viewer-token",
  "--remote-timeout",
  "--run",
  "--project",
  "--output",
  "--format",
  "--limit",
  "--offset",
  "--plugins",
  "--path",
  "--skip",
]);

/** Repeatable value flags: the single-slot map keeps the last value for
 *  compatibility; the multi map keeps every occurrence in order. */
const MULTI_VALUE_FLAGS = new Set(["--path", "--skip"]);

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  const multi = new Map<string, string[]>();
  const recordMulti = (name: string, value: string): void => {
    if (!MULTI_VALUE_FLAGS.has(name)) return;
    const list = multi.get(name) ?? [];
    list.push(value);
    multi.set(name, list);
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      const name = eq === -1 ? token : token.slice(0, eq);
      if (eq !== -1 && VALUE_FLAGS.has(name)) {
        flags.set(name, token.slice(eq + 1));
        recordMulti(name, token.slice(eq + 1));
      } else if (VALUE_FLAGS.has(token)) {
        const value = argv[i + 1];
        if (value === undefined) throw new UsageError(`missing value for ${token}`);
        flags.set(token, value);
        recordMulti(token, value);
        i += 1;
      } else {
        flags.set(token, true);
      }
    } else {
      positional.push(token);
    }
  }
  return { positional, flags, multi };
}

/**
 * Replace --base/--head values (two-token and `--flag=value` forms) with
 * resolved SHAs. Bundle-materialized repos have no remote-tracking or user
 * refs — `origin/main` or a branch name would not resolve there, failing
 * the diff — so refs must be pinned to SHAs before the argv is executed
 * against one (client side before shipping, server side for old clients).
 */
export function pinRefsToShas(argv: string[], shas: { base: string | null; head: string }): string[] {
  const pinned = new Map<string, string | null>([
    ["--base", shas.base],
    ["--head", shas.head],
  ]);
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      const name = eq > 0 ? token.slice(0, eq) : token;
      const sha = pinned.get(name);
      if (typeof sha === "string") {
        if (eq > 0) {
          out.push(`${name}=${sha}`);
        } else if (i + 1 < argv.length && !argv[i + 1]!.startsWith("--")) {
          out.push(name, sha);
          i += 1; // drop the raw ref
        } else {
          // Valueless --base/--head: leave it for parseArgs to reject as a
          // usage error — pinning a fabricated SHA would silently turn the
          // invocation into a successful (and wrong) review.
          out.push(token);
        }
        continue;
      }
      if (eq === -1 && VALUE_FLAGS.has(name)) {
        // Another value flag: keep its value verbatim, so a literal "--head"
        // inside a --note/--text is never mistaken for a ref flag.
        out.push(token);
        if (i + 1 < argv.length) out.push(argv[i + 1]!);
        i += 1;
        continue;
      }
    }
    out.push(token);
  }
  return out;
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
  const { positional, flags, multi } = parseArgs(argv);
  const command = positional[0];
  const json = Boolean(flags.get("--json"));
  const out: string[] = [];
  const emit = (text: string) => out.push(text);
  const log = (message: string) => opts.onLog?.(message);

  // Help first (#43): no --repo materialization, no --uncommitted snapshot,
  // no context or db — a forwarded `pir findings list --help` must not make
  // the server touch git before answering with usage text.
  if (!command || command === "help") {
    emit(`${USAGE}\n`);
    return { code: 0, output: out.join("") };
  }
  if (flags.get("--help")) {
    emit(helpFor(command));
    return { code: 0, output: out.join("") };
  }

  if (command === "repos") {
    return await cmdRepos(positional.slice(1), flags, json, emit, out);
  }
  if (command === "models") {
    return await cmdModels(positional.slice(1), flags, json, emit, out, log);
  }
  // Client-side commands: they manage the caller's own ~/.pir or skill
  // installation, so a pir serve instance must never execute them.
  if (command === "config") {
    if (opts.cwdGuard) throw new UsageError("config is a client-side command; run it on your machine");
    return await cmdConfig(positional.slice(1), json, emit, out);
  }
  if (command === "skill") {
    if (opts.cwdGuard) throw new UsageError("skill is a client-side command; run it on your machine");
    return await cmdSkill(positional.slice(1), flags, json, emit, out);
  }
  // Receipts live in the caller's ~/.pir and never touch a repo or server
  // (#52). They stream directly (like the jobs dispatcher); there is no
  // captured output to relay.
  if (command === "receipts") {
    if (opts.cwdGuard) throw new UsageError("receipts is a client-side command; run it on your machine");
    const { runReceiptsCommand } = await import("./receipts.js");
    return { code: await runReceiptsCommand(argv), output: "" };
  }
  // memory sync merges the caller's own DB with a server — a pir serve
  // instance executing it would "sync" with itself.
  if (command === "memory" && positional[1] === "sync") {
    if (opts.cwdGuard) throw new UsageError("memory sync is a client-side command; run it on your machine");
    if (flags.get("--repo")) throw new UsageError("memory sync does not support --repo (it syncs the local DB of the current checkout)");
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
    if (flags.has("--head")) throw new UsageError("--uncommitted and --head are mutually exclusive");
    const { createWorkingTreeSnapshot } = await import("../changes/git.js");
    const snapshot = await createWorkingTreeSnapshot(cwd);
    flags.delete("--uncommitted");
    flags.set("--head", snapshot);
    log(`• working-tree snapshot ${snapshot.slice(0, 10)}`);
  }

  // Audit has no comparison semantics; reject implying flags before any
  // context, index or session is created.
  if (command === "audit") {
    if (flags.has("--base")) throw new UsageError("audit has no comparison base; --base is a find-only flag");
    if (flags.has("--max-rounds")) throw new UsageError("audit has no global round limit; units and budgets bound the run (see --max-tokens)");
    if (flags.has("--branch")) throw new UsageError("audit selects a commit with --head; --branch is not supported");
  }

  // Server-side registered repo: fetch the clone, review in a throwaway worktree.
  let materialized: import("../app/repos.js").MaterializedReview | null = null;
  if (typeof flags.get("--repo") === "string") {
    const repoSpec = flags.get("--repo") as string;
    if (!["find", "audit", "memory", "findings", "verify-fix"].includes(command ?? "")) {
      throw new UsageError(`--repo applies to find/audit/memory/findings/verify-fix, not ${command}`);
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
    return await runInContext(cwd, { dbPath }, command ?? "", positional, flags, multi, json, out, emit, log, materialized);
  }

  if (command === "version") {
    emit(json ? envelope("version", { version: readVersion() }) : `pir ${readVersion()}\n`);
    return { code: 0, output: out.join("") };
  }
  if (command === "plugins") {
    const code = await cmdPlugins(cwd, positional.slice(1), json, emit);
    return { code, output: out.join("") };
  }
  if (command === "serve") {
    throw new UsageError("serve must run in the local CLI process, not through the executor");
  }

  const knownCommands = new Set(["find", "audit", "memory", "feedback", "remember", "findings", "verify-fix", "config", "skill"]);
  if (!knownCommands.has(command)) {
    throw new UsageError(`unknown command: ${command}`);
  }

  return await runInContext(cwd, { dbPath: explicitDbPath, identity: opts.identity }, command, positional, flags, multi, json, out, emit, log, null, Boolean(opts.readOnlyMemory));
}

async function runInContext(
  cwd: string,
  ctxOptions: { dbPath?: string; identity?: import("../memory/identity.js").ProjectIdentity },
  command: string,
  positional: string[],
  flags: Map<string, string | boolean>,
  multi: Map<string, string[]>,
  json: boolean,
  out: string[],
  emit: Emit,
  log: Log,
  materialized: import("../app/repos.js").MaterializedReview | null,
  readOnlyMemory = false,
): Promise<ExecResult> {
  const ctx = await createAppContext(cwd, {
    noSyncIndex: Boolean(flags.get("--no-sync-index")),
    dbPath: ctxOptions.dbPath,
    ...(ctxOptions.identity ? { identity: ctxOptions.identity } : {}),
    ...(readOnlyMemory ? { readOnlyMemory: true } : {}),
  });

  let code: number;
  try {
    switch (command) {
      case "find":
        code = await cmdFind(ctx, positional.slice(1), flags, json, emit, log);
        break;
      case "audit":
        code = await cmdAudit(ctx, positional.slice(1), flags, multi, json, emit, log);
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
    const entry = await removeRepo(name, Boolean(flags.get("--purge")));
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

/** 200000 -> "200K", 1500000 -> "1.5M" (same formatting as pi --list-models). */
function formatTokenCount(count: number): string {
  if (count >= 1_000_000) {
    const millions = count / 1_000_000;
    return millions % 1 === 0 ? `${millions}M` : `${millions.toFixed(1)}M`;
  }
  if (count >= 1_000) {
    const thousands = count / 1_000;
    return thousands % 1 === 0 ? `${thousands}K` : `${thousands.toFixed(1)}K`;
  }
  return String(count);
}

const NO_AUTH_MODELS_GUIDANCE = `No authenticated models — no provider credentials found.

Configure pi auth in ~/.pi/agent/auth.json (chmod 600):
  {"<provider>": {"type": "api_key", "key": "<key>"}}
In Docker, inject per provider instead:
  -e PI_API_KEY__<provider>=<key>     (or PI_AUTH_JSON with the full auth map)
Browse the full catalog with: pir models --all`;

async function cmdModels(
  args: string[],
  flags: Map<string, string | boolean>,
  json: boolean,
  emit: Emit,
  out: string[],
  log: Log,
): Promise<ExecResult> {
  const { listPiModels, currentDefaultModelSpec } = await import("../agents/pi-models.js");
  const all = Boolean(flags.get("--all"));
  const { models, loadError } = await listPiModels({
    all,
    provider: flags.get("--provider") as string | undefined,
    search: args.find((a) => !a.startsWith("--")),
  });
  if (loadError) {
    log(`pir: model catalog warnings:\n${loadError}`);
  }

  if (json) {
    emit(`${envelope("models", { default: currentDefaultModelSpec() ?? null, models })}\n`);
    return { code: 0, output: out.join("") };
  }

  if (flags.get("--ids")) {
    for (const m of models) {
      emit(`${m.provider}/${m.id}\n`);
    }
    if (models.length === 0) {
      log(all ? "pir: no models matched" : "pir: no authenticated models (see `pir models --all`)");
    }
    return { code: 0, output: out.join("") };
  }

  if (models.length === 0) {
    emit(all ? "No models matched.\n" : `${NO_AUTH_MODELS_GUIDANCE}\n`);
    return { code: 0, output: out.join("") };
  }

  const defaultSpec = currentDefaultModelSpec();
  const isDefault = (m: { provider: string; id: string }) =>
    defaultSpec === `${m.provider}/${m.id}` || defaultSpec === m.id;

  const columns: Array<{ header: string; get: (m: (typeof models)[number]) => string }> = [
    { header: "provider", get: (m) => m.provider },
    { header: "model", get: (m) => `${m.id}${isDefault(m) ? " *" : ""}` },
    { header: "context", get: (m) => formatTokenCount(m.contextWindow) },
    { header: "max-out", get: (m) => formatTokenCount(m.maxTokens) },
    { header: "thinking", get: (m) => (m.reasoning ? "yes" : "no") },
    { header: "images", get: (m) => (m.images ? "yes" : "no") },
  ];
  if (all) {
    columns.push({ header: "auth", get: (m) => (m.authenticated ? "yes" : "no") });
  }
  const widths = columns.map((c) => Math.max(c.header.length, ...models.map((m) => c.get(m).length)));

  emit(`${columns.map((c, i) => c.header.padEnd(widths[i]!)).join("  ")}\n`);
  for (const m of models) {
    emit(`${columns.map((c, i) => c.get(m).padEnd(widths[i]!)).join("  ")}\n`);
  }
  if (defaultSpec) {
    emit(`\n* current default (${defaultSpec}); override with --model <provider>/<model>\n`);
  }
  return { code: 0, output: out.join("") };
}

/** Positive-integer flag: same contract for every numeric CLI limit. */
export function positiveIntFlag(flags: Map<string, string | boolean>, name: string): number | undefined {
  const raw = flags.get(name);
  if (raw === undefined) return undefined;
  // A boolean means the flag was parsed without a value; Number(true) === 1
  // would silently accept it.
  if (typeof raw !== "string") {
    throw new UsageError(`invalid ${name}: a value is required (positive integer)`);
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new UsageError(`invalid ${name}: ${raw} (positive integer required)`);
  }
  return value;
}

/** Non-negative-integer flag — same as positiveIntFlag but 0 is a valid page offset. */
export function nonNegativeIntFlag(flags: Map<string, string | boolean>, name: string): number | undefined {
  const raw = flags.get(name);
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") {
    throw new UsageError(`invalid ${name}: a value is required (non-negative integer)`);
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new UsageError(`invalid ${name}: ${raw} (non-negative integer required)`);
  }
  return value;
}

/**
 * --max-findings (#57): positive integer, or the literal "unlimited"
 * (case-insensitive) which removes the cap — parsed to null so the supervisor
 * can distinguish "no cap" from every numeric value. Returns undefined when
 * the flag is absent (the caller applies the default).
 */
export function maxFindingsFlag(flags: Map<string, string | boolean>): number | null | undefined {
  const raw = flags.get("--max-findings");
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") {
    throw new UsageError('invalid --max-findings: a value is required (positive integer or "unlimited")');
  }
  if (raw.trim().toLowerCase() === "unlimited") return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new UsageError(`invalid --max-findings: ${raw} (positive integer or "unlimited" required)`);
  }
  return value;
}

/**
 * --verify-concurrency: parallel verifier sessions during a verification
 * drain. Precedence: flag > PIR_VERIFY_CONCURRENCY env > undefined (the
 * supervisor applies the default of 1). Bounded 1–MAX_VERIFY_CONCURRENCY so
 * a bad value fails as a usage error instead of deep in a run.
 */
export function verifyConcurrencyFlag(
  flags: Map<string, string | boolean>,
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const raw = flags.get("--verify-concurrency") ?? env.PIR_VERIFY_CONCURRENCY;
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new UsageError(`invalid --verify-concurrency: a value is required (integer 1-${MAX_VERIFY_CONCURRENCY})`);
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_VERIFY_CONCURRENCY) {
    throw new UsageError(`invalid --verify-concurrency: ${raw} (integer 1-${MAX_VERIFY_CONCURRENCY} required)`);
  }
  return value;
}

/**
 * --plugins <a,b|none|auto>: unknown names fail as usage errors here, with the
 * available list, instead of a runtime error deep in the finding loop.
 */
async function parsePluginsFlag(
  flags: Map<string, string | boolean>,
): Promise<{ pluginMode?: "auto" | "manual" | "off"; manualPlugins?: string[] }> {
  const raw = flags.get("--plugins");
  if (raw === undefined) return {};
  if (typeof raw !== "string") {
    throw new UsageError(`invalid --plugins: a value is required (comma-separated names, "none", or "auto")`);
  }
  if (raw === "auto") return { pluginMode: "auto" };
  if (raw === "none") return { pluginMode: "off" };
  const names = [...new Set(raw.split(",").map((name) => name.trim()).filter(Boolean))];
  if (names.length === 0) throw new UsageError(`invalid --plugins: ${raw}`);
  const { loadBuiltInPacks } = await import("../plugins/index.js");
  const known = loadBuiltInPacks().map((pack) => pack.name);
  const unknown = names.filter((name) => !known.includes(name));
  if (unknown.length > 0) {
    throw new UsageError(`unknown --plugins pack(s): ${unknown.join(", ")} (available: ${known.join(", ") || "none"})`);
  }
  return { pluginMode: "manual", manualPlugins: names };
}

/** `pir plugins list`: built-in packs plus what the repo at <cwd> activates at HEAD. */
async function cmdPlugins(cwd: string, args: string[], json: boolean, emit: Emit): Promise<number> {
  const sub = args[0] ?? "list";
  if (sub !== "list") throw new UsageError(`unknown plugins subcommand: ${sub} (expected: list)`);
  const { getHeadCommit, isGitRepo } = await import("../changes/git.js");
  const { detectPacks, loadBuiltInPacks } = await import("../plugins/index.js");
  if (!(await isGitRepo(cwd))) throw new UsageError(`not a git repository: ${cwd}`);
  const packs = loadBuiltInPacks();
  const head = await getHeadCommit(cwd);
  const active = await detectPacks(cwd, head, packs);
  const activeByName = new Map(active.map((pack) => [pack.name, pack]));
  const rows = packs.map((pack) => ({
    name: pack.name,
    title: pack.title,
    version: pack.version,
    markerFiles: pack.markerFiles,
    active: activeByName.has(pack.name),
    activation: activeByName.get(pack.name)?.activation ?? null,
  }));
  if (json) {
    emit(envelope("plugins.list", { head, packs: rows }));
    emit("\n");
  } else {
    emit(`head: ${head}\n`);
    for (const row of rows) {
      const mark = row.active ? "*" : " ";
      emit(`${mark} ${row.name}@${row.version} (${row.title}) — markers: ${row.markerFiles.join(", ")}${row.active ? " [active]" : ""}\n`);
    }
  }
  return 0;
}

async function cmdFind(
  ctx: Ctx,
  _args: string[],
  flags: Map<string, string | boolean>,
  json: boolean,
  emit: Emit,
  log: Log,
): Promise<number> {
  // --detach is a remote-submission flag (#53): local execution cannot honor
  // it, and a server receiving it unstripped (old client) must not ignore it.
  if (flags.has("--detach")) {
    throw new UsageError("--detach submits to a remote server and returns without waiting; it needs --server <url> or remote mode");
  }
  const failOn = (flags.get("--fail-on") as string) ?? "none";
  if (!["P0", "P1", "P2", "P3", "none"].includes(failOn)) throw new UsageError(`invalid --fail-on: ${failOn}`);
  const maxFindings = maxFindingsFlag(flags);
  const result = await runFind(ctx, {
    base: flags.get("--base") as string | undefined,
    head: flags.get("--head") as string | undefined,
    maxRounds: positiveIntFlag(flags, "--max-rounds"),
    maxTokens: positiveIntFlag(flags, "--max-tokens"),
    maxFindings,
    verifyConcurrency: verifyConcurrencyFlag(flags),
    model: flags.get("--model") as string | undefined,
    ...(await parsePluginsFlag(flags)),
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
            maxFindings: result.maxFindings,
            maxFindingsMode: result.maxFindings === null ? "unlimited" : "capped",
            transcriptDir: result.transcriptDir ?? null,
            files: result.changeSet.files.map((f) => ({
              path: f.path,
              status: f.status,
              additions: f.additions,
              deletions: f.deletions,
            })),
          },
          degraded: result.degraded,
          plugins: result.plugins,
          stoppedBecause: result.stoppedBecause,
          estimatedTokens: result.estimatedTokens,
          usage: result.usage ?? null,
          usageComplete: result.usageComplete,
          durationMs: result.durationMs,
          incomplete: result.incomplete,
          pendingCandidates: result.pendingCandidates,
          pendingFindings: result.pendingFindings.map((row) => toFindingView(ctx, row)),
          verificationErrors: result.verificationErrors,
          uncertaintyReasons: result.uncertaintyReasons,
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
        plugins: result.plugins,
        rounds: result.rounds,
        findings,
        stoppedBecause: result.stoppedBecause,
        incomplete: result.incomplete,
        pendingCandidates: result.pendingCandidates,
        transcriptDir: result.transcriptDir,
        runId: result.runId,
      })}\n`,
    );
  }

  return findExitCode(findings, failOn, result.incomplete);
}

async function cmdAudit(
  ctx: Ctx,
  _args: string[],
  flags: Map<string, string | boolean>,
  multi: Map<string, string[]>,
  json: boolean,
  emit: Emit,
  log: Log,
): Promise<number> {
  // Audit has no comparison semantics: reject flags that would imply one.
  if (flags.has("--base")) throw new UsageError("audit has no comparison base; --base is a find-only flag");
  if (flags.has("--uncommitted")) throw new UsageError("audit reviews committed snapshots only; --uncommitted is a find-only flag");
  if (flags.has("--max-rounds")) throw new UsageError("audit has no global round limit; units and budgets bound the run (see --max-tokens)");
  // --detach is remote-only (#53): a local run cannot detach, and a server
  // receiving the flag unstripped (old client) must fail instead of ignoring.
  if (flags.has("--detach")) {
    throw new UsageError("--detach submits to a remote server and returns without waiting; it needs --server <url> or remote mode");
  }
  // Post-run coverage readout (#56) answers from the recorded ledger — no
  // snapshot, no model, no run.
  if (_args[0] === "coverage") {
    return await cmdAuditCoverage(ctx, _args.slice(1), flags, json, emit, log);
  }
  const failOn = (flags.get("--fail-on") as string) ?? "none";
  if (!["P0", "P1", "P2", "P3", "none"].includes(failOn)) throw new UsageError(`invalid --fail-on: ${failOn}`);
  const maxFindings = maxFindingsFlag(flags);
  const includePaths = multi.get("--path") ?? [];
  const skipGlobs = multi.get("--skip") ?? [];
  for (const value of [...includePaths, ...skipGlobs]) {
    if (value.includes("\0") || value.includes("\\") || value === "") {
      throw new UsageError(`invalid --path/--skip value: ${JSON.stringify(value)}`);
    }
  }
  // Scope preview (#56): same snapshot + planner as a real audit, but no run,
  // no model, no writes. Run-shaping flags cannot affect a preview, so they
  // are rejected instead of silently ignored.
  if (flags.get("--dry-run") === true) {
    for (const shaping of ["--max-tokens", "--max-findings", "--verify-concurrency", "--fail-on"]) {
      if (flags.has(shaping)) {
        throw new UsageError(`audit --dry-run previews the scope only; ${shaping} shapes a real run`);
      }
    }
    return await renderAuditDryRun(ctx, {
      head: flags.get("--head") as string | undefined,
      includePaths,
      skipGlobs,
      listFiles: flags.get("--list-files") === true,
      json,
      emit,
    });
  }
  const { AuditScopeError } = await import("../core/supervisor.js");
  const result = await runAudit(ctx, {
    head: flags.get("--head") as string | undefined,
    includePaths,
    skipGlobs,
    maxTokens: positiveIntFlag(flags, "--max-tokens"),
    maxFindings,
    verifyConcurrency: verifyConcurrencyFlag(flags),
    model: flags.get("--model") as string | undefined,
    ...(await parsePluginsFlag(flags)),
    onProgress: (event) => log(`• ${event.message}`),
  }).catch((error: unknown) => {
    if (error instanceof AuditScopeError) throw new UsageError(error.message);
    throw error;
  });
  const findings = result.findings.map((row) => toFindingView(ctx, row));

  if (json) {
    emit(
      envelope(
        "audit",
        {
          target: {
            mode: "audit",
            head: result.head,
            snapshot: result.snapshot,
            scope: result.snapshot.scope,
            dirtyWorktree: result.dirtyWorktree,
          },
          run: {
            id: result.runId,
            head: result.head,
            rounds: result.rounds,
            maxFindings: result.maxFindings,
            maxFindingsMode: result.maxFindings === null ? "unlimited" : "capped",
            transcriptDir: result.transcriptDir ?? null,
          },
          coverage: { ...result.coverage, units: result.units },
          degraded: result.degraded,
          plugins: result.plugins,
          stoppedBecause: result.stoppedBecause,
          estimatedTokens: result.estimatedTokens,
          usage: result.usage ?? null,
          usageComplete: result.usageComplete,
          durationMs: result.durationMs,
          incomplete: result.incomplete,
          incompleteReasons: result.incompleteReasons,
          pendingCandidates: result.pendingCandidates,
          pendingFindings: result.pendingFindings.map((row) => toFindingView(ctx, row)),
          suspectedDuplicates: result.suspectedDuplicates,
          verificationErrors: result.verificationErrors,
          uncertaintyReasons: result.uncertaintyReasons,
          findings,
        },
        { project: { id: ctx.memory.identity.projectId, cwd: ctx.repoRoot, head: result.head } },
      ),
    );
    emit("\n");
  } else {
    emit(
      `${renderAuditResultText({
        degraded: result.degraded,
        dirtyWorktree: result.dirtyWorktree,
        plugins: result.plugins,
        coverage: result.coverage,
        findings,
        stoppedBecause: result.stoppedBecause,
        incomplete: result.incomplete,
        incompleteReasons: result.incompleteReasons,
        pendingCandidates: result.pendingCandidates,
        transcriptDir: result.transcriptDir,
        suspectedDuplicates: result.suspectedDuplicates,
        runId: result.runId,
      })}\n`,
    );
  }

  return findExitCode(findings, failOn, result.incomplete);
}

/**
 * `pir audit --dry-run [--list-files] [--json]` (#56): the exact snapshot and
 * unit plan a real audit of the same tree and options would build — counts
 * come from the same buildRepoSnapshot + planAuditUnits calls, so parity is
 * by construction. No run row, no model, no writes.
 */
async function renderAuditDryRun(
  ctx: Ctx,
  input: {
    head: string | undefined;
    includePaths: string[];
    skipGlobs: string[];
    listFiles: boolean;
    json: boolean;
    emit: Emit;
  },
): Promise<number> {
  const { buildRepoSnapshot, DEFAULT_SKIP_PATTERNS } = await import("../changes/snapshot.js");
  const { planAuditUnits } = await import("../core/audit-planner.js");
  const { isDirty } = await import("../changes/git.js");
  const emit = input.emit;
  const snapshot = await buildRepoSnapshot(ctx.repoRoot, input.head ?? "HEAD", {
    includePaths: input.includePaths,
    skipGlobs: input.skipGlobs,
  });
  const plan = await planAuditUnits(snapshot);
  // The same scope guards auditIssues applies right after its identical
  // snapshot+plan calls: a preview that exits 0 where the real audit exits 2
  // is not a preview (dogfood F-51).
  const inScopeFiles = snapshot.entries.filter((entry) => entry.selection === "selected").length;
  if (inScopeFiles === 0) {
    throw new UsageError("audit scope is empty: no committed files selected (check --path/--skip)");
  }
  if (plan.units.length === 0) {
    throw new UsageError(
      `audit scope has ${inScopeFiles} selected file(s) but none are reviewable text (binary/oversized/submodule entries cannot be audited); refine --path/--skip`,
    );
  }
  const dirtyWorktree = await isDirty(ctx.repoRoot);
  const bySelection = { selected: 0, "not-selected": 0, excluded: 0 };
  const byClassification: Record<string, number> = {};
  for (const entry of snapshot.entries) {
    bySelection[entry.selection] += 1;
    if (entry.selection === "selected") {
      byClassification[entry.classification] = (byClassification[entry.classification] ?? 0) + 1;
    }
  }
  const reviewable = byClassification.text ?? 0;
  const files = {
    total: snapshot.entries.length,
    selected: bySelection.selected,
    notSelected: bySelection["not-selected"],
    excluded: bySelection.excluded,
    reviewable,
    byClassification,
  };
  const modules = new Set(plan.units.map((unit) => unit.module));
  const nonText = Object.entries(files.byClassification)
    .filter(([kind, count]) => kind !== "text" && count > 0)
    .map(([kind, count]) => `${count} ${kind}`)
    .join(", ");
  const note =
    "no run is created and no model is used; uncommitted working-tree files are outside a committed audit";
  if (input.json) {
    emit(
      envelope(
        "audit.dry-run",
        {
          head: snapshot.commit,
          treeId: snapshot.treeId,
          scopeVersion: snapshot.scopeVersion,
          plannerVersion: plan.plannerVersion,
          scope: snapshot.scope,
          policy: { defaultExclusions: DEFAULT_SKIP_PATTERNS },
          files,
          units: { total: plan.units.length, modules: modules.size },
          dirtyWorktree,
          note,
          ...(input.listFiles
            ? {
                list: snapshot.entries.map((entry) => ({
                  path: entry.path,
                  selection: entry.selection,
                  classification: entry.classification,
                  ...(entry.exclusionReason ? { reason: entry.exclusionReason } : {}),
                })),
              }
            : {}),
        },
        { project: { id: ctx.memory.identity.projectId, cwd: ctx.repoRoot, head: snapshot.commit } },
      ),
    );
    emit("\n");
    return 0;
  }
  const lines = [
    `audit dry-run: head ${snapshot.commit} (tree ${snapshot.treeId})`,
    `scope: version ${snapshot.scopeVersion}, planner ${plan.plannerVersion}; --path ${JSON.stringify(snapshot.scope.includePaths)} --skip ${JSON.stringify(snapshot.scope.skipGlobs)}`,
    `files: ${files.total} total — ${files.selected} selected (${files.reviewable} reviewable text` +
      `${nonText ? `; ${nonText}` : ""}), ${files.notSelected} not-selected, ${files.excluded} excluded`,
    `units: ${plan.units.length} planned across ${modules.size} module(s)`,
    `worktree: ${dirtyWorktree ? "dirty (uncommitted files are outside this audit)" : "clean"}`,
    note,
  ];
  if (input.listFiles) {
    lines.push("files:");
    for (const entry of snapshot.entries) {
      lines.push(`  ${entry.selection.padEnd(13)}${entry.classification.padEnd(17)}${entry.path}${entry.exclusionReason ? `  (${entry.exclusionReason})` : ""}`);
    }
  }
  emit(`${lines.join("\n")}\n`);
  return 0;
}

/**
 * `pir audit coverage [--run <id>|--latest] [--json]` (#56): per-file coverage
 * of one recorded audit run, read from the audit_file_coverage ledger the run
 * persisted as it went. Local project db only.
 */
async function cmdAuditCoverage(
  ctx: Ctx,
  _args: string[],
  flags: Map<string, string | boolean>,
  json: boolean,
  emit: Emit,
  log: Log,
): Promise<number> {
  const runFlag = flags.get("--run");
  const latest = flags.get("--latest") === true;
  if ((typeof runFlag === "string") === latest) {
    throw new UsageError("audit coverage needs exactly one of --run <run-id> or --latest");
  }
  if (_args.length > 0) {
    throw new UsageError(`unknown audit coverage argument: ${_args[0]}`);
  }
  const run =
    typeof runFlag === "string" ? ctx.memory.findings.runById(runFlag) : ctx.memory.findings.latestRun("audit");
  if (!run) {
    if (typeof runFlag === "string") {
      log(`pir: audit run not found: ${runFlag}`);
      return 3;
    }
    emit("no audit runs recorded in this project\n");
    return 0;
  }
  if (run.mode !== "audit") {
    throw new UsageError(`run ${run.id} is a ${run.mode}-mode run; audit coverage needs an audit run`);
  }
  const files = ctx.memory.audit.fileCoverage(run.id);
  const summary: Record<string, number> = {};
  for (const file of files) summary[file.state] = (summary[file.state] ?? 0) + 1;
  if (json) {
    emit(
      envelope(
        "audit.coverage",
        {
          run: {
            id: run.id,
            head: run.head,
            status: run.status,
            startedAt: run.startedAt,
            finishedAt: run.finishedAt,
            ...(run.notes ? { notes: run.notes } : {}),
          },
          summary,
          files: files.map((file) => ({
            path: file.path,
            state: file.state,
            ...(file.reason ? { reason: file.reason } : {}),
            rangesReviewed: file.rangesReviewed,
            rangesTotal: file.rangesTotal,
          })),
        },
        { project: { id: ctx.memory.identity.projectId, cwd: ctx.repoRoot, head: run.head } },
      ),
    );
    emit("\n");
    return 0;
  }
  const lines = [
    `audit run ${run.id}`,
    `  head ${run.head}; status ${run.status}; started ${new Date(run.startedAt).toISOString()}`,
    `  coverage: ${files.length} file record(s) — ${Object.entries(summary).map(([state, n]) => `${n} ${state}`).join(", ") || "none"}`,
  ];
  if (run.notes) lines.push(`  notes: ${run.notes}`);
  lines.push("files:");
  for (const file of files) {
    lines.push(
      `  ${file.state.padEnd(10)}${file.path} (ranges ${file.rangesReviewed}/${file.rangesTotal})${file.reason ? ` — ${file.reason}` : ""}`,
    );
  }
  emit(`${lines.join("\n")}\n`);
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
        maxBatches: positiveIntFlag(flags, "--max-batches"),
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
    case "sync": {
      // Resolve the server through the standard transport precedence; the
      // flags were already parsed, so rebuild just the tokens resolveTransport
      // looks at (--server/--token/--insecure/--local) plus env/config.
      const argvForTransport = ["memory", "sync"];
      const serverFlag = flags.get("--server");
      if (typeof serverFlag === "string") argvForTransport.push("--server", serverFlag);
      const tokenFlag = flags.get("--token");
      if (typeof tokenFlag === "string") argvForTransport.push("--token", tokenFlag);
      if (flags.get("--insecure") === true) argvForTransport.push("--insecure");
      if (flags.get("--local") === true) argvForTransport.push("--local");
      const transport = resolveTransport({ argv: argvForTransport, env: process.env, config: loadUserConfig() });
      if (transport.mode !== "remote") {
        throw new UsageError(
          "memory sync needs a server — pass --server <url>, set PIR_SERVER_URL, or run `pir config`",
        );
      }
      log(`• merging memory with ${transport.url}`);
      const result = await memorySync(ctx, {
        url: transport.url,
        token: transport.token,
        insecure: transport.insecure,
        dryRun: Boolean(flags.get("--dry-run")),
      });
      emit(json ? `${envelope("memory.sync", result)}\n` : renderSyncResult(result));
      return 0;
    }
    default:
      throw new UsageError(`unknown memory subcommand: ${sub}`);
  }
}

/** Human-readable summary of a memory sync round trip. */
function renderSyncResult(result: MemorySyncResult): string {
  const lines: string[] = [];
  const rowsChanged = (counts: Record<string, number>): string => {
    const parts = (Object.keys(result.stats.tables) as SyncTableName[]).filter((table) => (counts[table] ?? 0) > 0);
    return parts.length > 0 ? parts.map((table) => `${table}=${counts[table]}`).join(" ") : "nothing";
  };
  const pushed: Record<string, number> = {};
  const pulled: Record<string, number> = {};
  let localWon = 0;
  let remoteWon = 0;
  for (const table of Object.keys(result.stats.tables) as SyncTableName[]) {
    const stats = result.stats.tables[table]!;
    pushed[table] = stats.localOnly + stats.conflicts.localWon;
    pulled[table] = result.appliedLocally[table] ?? stats.remoteOnly + stats.conflicts.remoteWon + stats.merged;
    localWon += stats.conflicts.localWon;
    remoteWon += stats.conflicts.remoteWon;
  }
  lines.push(`${result.dryRun ? "sync dry-run" : "memory synced"} with ${result.server} (project ${result.projectId.slice(0, 10)}…)`);
  lines.push(`  pushed to server: ${rowsChanged(pushed)}`);
  lines.push(`  ${result.dryRun ? "would pull:       " : "pulled to local:  "}${rowsChanged(pulled)}`);
  lines.push(`  conflicts resolved: ${localWon + remoteWon} (local ${localWon}, remote ${remoteWon})`);
  return `${lines.join("\n")}\n`;
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
  if (sub === "export") {
    // The web export is dispatched client-side (cli.ts) before this local
    // path can ever see it; landing here means --run was missing.
    throw new UsageError("findings export requires --run <run-url> (a remote web export)");
  }
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
    // Pagination (#47): the store caps pages (default 100) — the CLI reports
    // what it returned against the filtered total instead of silently
    // truncating. This page size is unrelated to a review's --max-findings
    // cap (a limit on what a run reports, set when the run starts).
    const all = flags.get("--all") === true;
    const limit = positiveIntFlag(flags, "--limit");
    const offset = nonNegativeIntFlag(flags, "--offset");
    if (all && (limit !== undefined || offset !== undefined)) {
      throw new UsageError("--all cannot be combined with --limit/--offset (it fetches every page)");
    }
    // Rows and total come from ONE statement (listPage), so an --all page can
    // never report hasMore:false over a stale count while a WAL writer — the
    // mid-audit bundle-free lane — commits between two reads (dogfood F-39).
    const query = all
      ? { status, limit: Number.MAX_SAFE_INTEGER }
      : { status, ...(limit !== undefined ? { limit } : {}), ...(offset !== undefined ? { offset } : {}) };
    const { findings, total } = listFindingsPage(ctx, query);
    const returned = findings.length;
    const pageStart = offset ?? 0;
    const hasMore = all ? false : pageStart + returned < total;
    const page = {
      findings,
      total,
      returned,
      hasMore,
      nextOffset: hasMore ? pageStart + returned : null,
    };
    if (json) {
      emit(`${envelope("findings.list", page)}\n`);
    } else {
      emit(`${JSON.stringify(findings, null, 2)}\n`);
      if (hasMore) {
        log(`pir: showing ${returned} of ${total} findings — pass --all, or --offset ${page.nextOffset} for the next page`);
      }
    }
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

async function cmdConfig(args: string[], json: boolean, emit: Emit, out: string[]): Promise<ExecResult> {
  const sub = args[0] ?? "show";

  if (sub === "show") {
    const config = loadUserConfig();
    if (json) {
      emit(`${envelope("config.show", { path: configPath(), ...(config ? { config: redactConfig(config) } : { config: null }) })}\n`);
    } else if (!config) {
      emit(`no config yet — running with local defaults\npath: ${configPath()}\ncreate one with: pir config\n`);
    } else {
      emit(renderConfig(config, configPath()));
    }
    return { code: 0, output: out.join("") };
  }

  if (sub === "wizard" || sub === "setup") {
    const config = await runWizard();
    emit(json ? `${envelope("config.wizard", { config: redactConfig(config) })}\n` : renderConfig(config, configPath()));
    return { code: 0, output: out.join("") };
  }

  if (sub === "set") {
    const key = args[1];
    const value = args[2];
    if (!key || value === undefined) throw new UsageError("config set requires <key> <value>");
    const config = loadUserConfig() ?? { schemaVersion: 1, mode: "local" };
    const updated = setConfigValue(config, key, value);
    const file = saveUserConfig(updated);
    // #51: JSON output is captured into logs and bug reports just like text
    // — the new value and the stored config are masked on both channels.
    const shown = isSecretKey(key) ? maskSecret(value) : value;
    emit(json ? `${envelope("config.set", { key, value: shown, config: redactConfig(updated) })}\n` : `${key} = ${shown}\nsaved ${file}\n`);
    return { code: 0, output: out.join("") };
  }

  if (sub === "reset") {
    const removed = deleteUserConfig();
    emit(
      json
        ? `${envelope("config.reset", { removed })}\n`
        : removed
          ? `removed ${configPath()} — back to local defaults\n`
          : `nothing to remove (${configPath()} absent)\n`,
    );
    return { code: 0, output: out.join("") };
  }

  throw new UsageError(`unknown config subcommand: ${sub} (expected show | wizard | set | reset)`);
}

function renderConfig(config: UserConfig, file: string): string {
  const lines = [`mode:   ${config.mode}`];
  if (config.server) {
    lines.push(`server: ${config.server.url}`);
    lines.push(`token:  ${maskSecret(config.server.token)}`);
    lines.push(`tls:    ${config.server.insecure ? "self-signed accepted (--insecure)" : "verified"}`);
    if (config.server.timeoutSeconds !== undefined) {
      lines.push(`wait:   ${config.server.timeoutSeconds}s (remote response timeout)`);
    }
  }
  if (config.model) lines.push(`model:  ${config.model}`);
  lines.push(`path:   ${file}`);
  return `${lines.join("\n")}\n`;
}

async function cmdSkill(
  args: string[],
  flags: Map<string, string | boolean>,
  json: boolean,
  emit: Emit,
  out: string[],
): Promise<ExecResult> {
  const sub = args[0] ?? "path";
  const source = skillSourcePath();

  if (sub === "path" || sub === "show") {
    emit(json ? `${envelope("skill.path", { path: source })}\n` : `${source}\n`);
    return { code: 0, output: out.join("") };
  }
  if (sub === "print") {
    emit(readFileSync(source, "utf8"));
    return { code: 0, output: out.join("") };
  }
  if (sub === "install") {
    const root = (flags.get("--dir") as string | undefined) ?? path.join(os.homedir(), ".agents", "skills");
    const target = path.join(root, "pir", "SKILL.md");
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(source, target);
    emit(json ? `${envelope("skill.install", { source, path: target })}\n` : `installed ${target}\n`);
    return { code: 0, output: out.join("") };
  }
  throw new UsageError(`unknown skill subcommand: ${sub} (expected path | install | print)`);
}

/** skills/pir/SKILL.md shipped next to dist/ inside the installed package. */
function skillSourcePath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidate = path.join(here, "..", "..", "skills", "pir", "SKILL.md");
  if (!existsSync(candidate)) {
    throw new UsageError(`skill file missing from this installation: ${candidate}`);
  }
  return candidate;
}
