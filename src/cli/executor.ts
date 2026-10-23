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
import { changedFileSummary } from "../changes/change-set.js";
import { runFind, toFindingView } from "../app/find.js";
import {
  ProjectRuleError,
  applyProjectRules,
  checkProjectRules,
  layerLabel,
  loadProjectRules,
  pirConfigDir,
  type ProjectRuleCheck,
  type ProjectRuleSet,
  type RuleLayerCheck,
} from "../rules/project-rules.js";
import { UserBackgroundError, resolveUserBackground, type UserBackground } from "../core/user-background.js";
import { runAudit } from "../app/audit.js";
import { MAX_VERIFY_CONCURRENCY } from "../core/supervisor.js";
import { FINDER_ANGLES } from "../agents/prompts.js";
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
import { renderSarif } from "../app/sarif.js";
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
  pir rules check <path>                 which project rule wins for a repository path
  pir skill [path|install|print]         locate / install the LLM skill for pir
  pir plugins list                      list language packs and what this repo activates
  pir version`,

  find: `Find options:
  --base <ref>        base ref (default: HEAD^)
  --head <ref>        head ref (default: HEAD)
  --max-rounds <n>    discovery/verification loop rounds (default 2)
  --max-tokens <n>    token ceiling for the run. Unset: the find defaults
                      apply — 1.2M reviewer + 0.8M verifier input tokens
                      (ADR 0006); hitting one starts no new reviewer round but
                      still verifies every pending candidate, so a budget stop
                      is a controlled truncation, not a lost run. A positive
                      integer sets one explicit whole-run ceiling instead, and
                      "unlimited" removes every token ceiling (rounds and
                      findings still cap; remote needs a same-version server)
  --max-findings <n>  cap on reported findings (default 10). A ceiling, not
                      a target: fewer findings is correct when evidence runs
                      out — nothing is padded to reach it. "unlimited"
                      removes the cap (#57; remote needs a same-version
                      server)
  --verify-concurrency <n>
                      parallel verifier sessions during each verification
                      drain (1-8, default 1; PIR_VERIFY_CONCURRENCY env
                      applies when the flag is absent)
  --min-confidence <x>
                      bucket confirmed findings whose verifier confidence is
                      below this 0-1 threshold into a separate low-confidence
                      section (default 0 = off; PIR_MIN_CONFIDENCE env applies
                      when the flag is absent). Bucketing only: nothing is
                      deleted or dropped from the findings list
  --fail-on <sev>     exit 1 when a finding with severity >= sev is reported
                      (P0|P1|P2|P3|none, default none)
  --format <fmt>      stdout format: text (default), json (the same choice
                      --json makes) or sarif — a SARIF 2.1.0 log for
                      code-scanning consumers. --json and a non-json --format
                      together are a usage error; exit codes are unchanged
  --model <id>        model override for sub-sessions: <provider>/<model> or
                      fuzzy id (see \`pir models\`; default: PIR_MODEL env,
                      then pi settings)
  --verify-model <id> separate verifier model (Q5): reviewer sessions keep
                      --model, verifier sessions resolve this id
                      (<provider>/<model> or fuzzy; PIR_VERIFIER_MODEL env
                      applies when the flag is absent). An unresolvable id is
                      a hard session error, never a silent fallback
  --angles <list>     experimental (F1): round 1 fans out one specialized
                      reviewer session per angle (default off). Built-ins:
                      correctness, concurrency, security, contracts,
                      performance — or "all". Capped at 4 parallel sessions,
                      budget-guarded; later rounds stay general
  --plugins <list>    language packs injecting language-specific review
                      directions (frontend, golang and typescript ship
                      today; more packs follow): comma-separated names,
                      "none" to disable, or "auto" to detect from marker
                      files at head (default)
  --rule <path>       project rule file (B5/ADR-0010). Three layers, first
                      match wins: --rule > <root>/.pir/rule.json >
                      <config-dir>/rule.json. Each rule pairs a path glob with
                      guidance (inline or a repo-relative .md/.markdown/.txt
                      file, 64 KiB and repo-contained) and optionally
                      mergeBuiltin=false to replace the built-in language
                      guidance for the run. Applied rules and their hash are
                      recorded in run.json; \`pir config show\` prints the
                      layers. Local mode only; find only
  --background <text> user background for this change (S2/ADR-0016): the
                      stated goal, intentional behaviour changes, migration
                      notes. Delimited and labelled as untrusted context in
                      the reviewer prompt — never as instructions, and never
                      for verifier or audit sessions. At most 8,000 characters
                      after sanitisation (longer input is truncated loudly;
                      keep it under ~2,000); control characters stripped,
                      blank lines collapsed, the reserved <user_background>
                      delimiters rejected. The canonical sha256 and sizes are
                      recorded in run.json, never the text
  --background-file <path>
                      read the background from a file instead (UTF-8, at most
                      1 MiB raw, regular file). Wins over --background with a
                      warning; relative paths resolve against the invocation
                      directory. Local path: rejected in remote mode (client
                      and server)
  --no-sync-index     skip codegraph index sync
  --preview           print the file selection a real find of the same range
                      would review (#B1): per-file status and churn, plus
                      selected or excluded with the gate's reason — binary,
                      secret paths, skip patterns, oversized single-file
                      diff. Excluded files stay visible as metadata; their
                      diff bodies never reach a model. No run, no model, no
                      writes; run-shaping flags are rejected
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
                      unlimited unless set — audit has no default ceiling
                      (rounds and findings still cap); "unlimited" removes it
  --max-findings <n>  whole-run cap on reported findings (default 10);
                      "unlimited" removes it (#57)
  --verify-concurrency <n>
                      parallel verifier sessions during each verification
                      drain (1-8, default 1; PIR_VERIFY_CONCURRENCY env
                      applies when the flag is absent)
  --min-confidence <x>
                      bucket confirmed findings whose verifier confidence is
                      below this 0-1 threshold into a separate low-confidence
                      section (default 0 = off; PIR_MIN_CONFIDENCE env applies
                      when the flag is absent). Bucketing only: nothing is
                      deleted or dropped from the findings list
  --verify-model <id> separate verifier model (Q5): reviewer sessions keep
                      --model, verifier sessions resolve this id
                      (<provider>/<model> or fuzzy; PIR_VERIFIER_MODEL env
                      applies when the flag is absent). An unresolvable id is
                      a hard session error, never a silent fallback
  --fail-on <sev>     same gate as find (P0|P1|P2|P3|none, default none)
  --format <fmt>      stdout format: text (default), json or sarif (SARIF 2.1.0
                      with the audit coverage on the invocation); --dry-run and
                      coverage reject sarif, exit codes are unchanged
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
  --format <fmt>      find/audit stdout: text | json | sarif; --json is the
                      same choice as --format json, and --format sarif emits
                      SARIF 2.1.0 (see README "Output contract")
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
  server.timeoutSeconds <s>|""  remote response wait (#54)

  pir config show also prints the effective project-rule layers (repo
  .pir/rule.json + global ~/.pir/rule.json) and their canonical hash`,

  rules: `Rules options (which project rule wins for a path — reads rule files only):
  check <path>        print the winning rule for one repository path: layer,
                      matched glob, mergeBuiltin and the rendered guidance
                      text. <path> is repository-relative; an absolute path
                      inside the repository is accepted and reported relative.
                      A path that does not exist is matched by string and
                      flagged. No review run, no model session, no project db.
  --rule <path>       add the per-invocation layer find also accepts; a missing
                      or invalid file is a usage error
  --json              machine-readable envelope (rules.check), including the
                      rendered PROJECT RULES section for that path`,

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
  USAGE_SECTIONS.rules,
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
  rules: USAGE_SECTIONS.rules,
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
  "--min-confidence",
  "--fail-on",
  "--model",
  "--verify-model",
  "--angles",
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
  "--rule",
  "--background",
  "--background-file",
  "--path",
  "--skip",
  "--task-file",
  "--arm",
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

export type OutputFormat = "text" | "json" | "sarif";

/**
 * `find`/`audit` output selection (ADR 0020). `--format` names the
 * format and the legacy `--json` is the same choice spelled differently, so
 * asking for two different formats at once is a usage error rather than a
 * silent precedence rule. Resolved before any run row or session exists.
 */
export function resolveOutputFormat(flags: Map<string, string | boolean>): OutputFormat {
  const raw = flags.get("--format");
  const json = flags.get("--json") === true;
  if (raw === undefined) return json ? "json" : "text";
  if (raw !== "text" && raw !== "json" && raw !== "sarif") {
    throw new UsageError(`invalid --format: ${String(raw)} (expected text, json or sarif)`);
  }
  if (json && raw !== "json") {
    throw new UsageError(`--json selects json output and contradicts --format ${raw}`);
  }
  return raw;
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
    return await cmdConfig(positional.slice(1), flags, json, emit, out);
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

  // Project-rule introspection (Track B, S7): answers "which rule wins for
  // this path?" from the same layer loader and matcher find uses. Client-side
  // only — it reads the caller's rule files, opens no project database and
  // starts no model session.
  if (command === "rules") {
    if (opts.cwdGuard) throw new UsageError("rules is a client-side command; run it on your machine");
    return await cmdRules(positional.slice(1), flags, json, emit, out, cwd);
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
    if (flags.has("--angles")) throw new UsageError("audit has no finder fan-out in v1; --angles is a find-only flag (experimental)");
    if (flags.has("--rule")) throw new UsageError("--rule applies to find only (audit has no change-mode prompt)");
    if (flags.has("--background") || flags.has("--background-file")) {
      throw new UsageError("audit has no reviewer background; --background/--background-file are find-only flags (S2/ADR-0016)");
    }
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

  const knownCommands = new Set(["find", "audit", "memory", "feedback", "remember", "findings", "verify-fix", "config", "skill", "_verify-comment"]);
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
      // Internal eval command (M0): outside the stable contract, never listed
      // in help and never forwarded to a remote server (see cli.ts LOCAL_ONLY).
      case "_verify-comment":
        code = await cmdVerifyComment(ctx, positional.slice(1), flags, json, emit, log);
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
 * --max-tokens: positive integer, or the literal "unlimited"
 * (case-insensitive) which removes every token ceiling — including find's
 * B3 default ceilings (ADR 0006). Parsed to null so the supervisor can tell
 * "no ceiling" from every numeric ceiling; undefined means the flag was
 * absent (find applies its defaults, audit stays unlimited).
 */
export function maxTokensFlag(flags: Map<string, string | boolean>): number | null | undefined {
  const raw = flags.get("--max-tokens");
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") {
    throw new UsageError('invalid --max-tokens: a value is required (positive integer or "unlimited")');
  }
  if (raw.trim().toLowerCase() === "unlimited") return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new UsageError(`invalid --max-tokens: ${raw} (positive integer or "unlimited" required)`);
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
 * --min-confidence (Q4): bucket confirmed findings whose verifier confidence
 * falls below this 0–1 threshold into a separate low-confidence section.
 * Precedence: flag > PIR_MIN_CONFIDENCE env > undefined (the supervisor
 * applies the default of 0 = off). Bucketing never deletes: reported set,
 * maxFindings accounting, and the exit-code contract are unchanged.
 */
export function minConfidenceFlag(
  flags: Map<string, string | boolean>,
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const raw = flags.get("--min-confidence") ?? env.PIR_MIN_CONFIDENCE;
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new UsageError(`invalid --min-confidence: a value is required (number between 0 and 1)`);
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new UsageError(`invalid --min-confidence: ${raw} (number between 0 and 1 required)`);
  }
  return value;
}

/**
 * --verify-model (Q5): separate model id for verifier sessions; reviewer
 * sessions keep --model. Precedence: flag > PIR_VERIFIER_MODEL env >
 * undefined (the supervisor falls back to the reviewer model). Only
 * non-emptiness is checked here — id resolution reuses the standard
 * model-resolution error path (an unresolvable id is a hard session error,
 * never a silent fallback).
 */
export function verifierModelFlag(
  flags: Map<string, string | boolean>,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const raw = flags.get("--verify-model") ?? env.PIR_VERIFIER_MODEL;
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new UsageError("invalid --verify-model: a value is required (model id, see `pir models`)");
  }
  return raw.trim();
}

/**
 * --angles <a,b|all> (F1, experimental): round 1 fans out one specialized
 * reviewer session per listed angle instead of one general session. "all"
 * expands to every built-in angle; unknown ids fail here with the available
 * list. Default off; find-only.
 */
export function anglesFlag(flags: Map<string, string | boolean>): string[] | undefined {
  const raw = flags.get("--angles");
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new UsageError(`invalid --angles: a value is required (comma-separated ids or "all"; available: ${FINDER_ANGLES.map((a) => a.id).join(", ")})`);
  }
  const ids = raw.split(",").map((id) => id.trim()).filter(Boolean);
  if (ids.length === 0) {
    throw new UsageError(`invalid --angles: ${raw} (comma-separated ids or "all" required)`);
  }
  if (ids.length === 1 && ids[0]!.toLowerCase() === "all") return FINDER_ANGLES.map((a) => a.id);
  const known = new Set(FINDER_ANGLES.map((a) => a.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new UsageError(`invalid --angles: ${unknown.join(", ")} (available: ${FINDER_ANGLES.map((a) => a.id).join(", ")}, or "all")`);
  }
  return [...new Set(ids)];
}

/**
 * S2 (ADR-0016): `--background` / `--background-file` → the prompt-ready
 * record. `--background-file` wins with a warning; every guard failure is a
 * usage error, so a run never starts half-set. Warnings go to the progress
 * channel (stderr): a truncation must never be silent, even under --json.
 */
export function userBackgroundFromFlags(
  flags: Map<string, string | boolean>,
  warn: (message: string) => void,
): UserBackground | undefined {
  const text = flags.get("--background");
  const file = flags.get("--background-file");
  try {
    return resolveUserBackground({
      ...(typeof text === "string" ? { text } : {}),
      ...(typeof file === "string" ? { file } : {}),
      cwd: process.cwd(),
      warn: (message) => warn(`warning: ${message}`),
    });
  } catch (error) {
    if (error instanceof UserBackgroundError) throw new UsageError(error.message);
    throw error;
  }
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
  const format = resolveOutputFormat(flags);
  // --detach is a remote-submission flag (#53): local execution cannot honor
  // it, and a server receiving it unstripped (old client) must not ignore it.
  if (flags.has("--detach")) {
    throw new UsageError("--detach submits to a remote server and returns without waiting; it needs --server <url> or remote mode");
  }
  // File-selection preview (B1/T4): the exact change set and the exact pure
  // filter a real find of the same range would apply — no run row, no model
  // session, no writes. Run-shaping flags cannot affect a selection, so they
  // are rejected instead of silently ignored (the audit --dry-run precedent).
  if (flags.get("--preview") === true) {
    for (const shaping of ["--max-rounds", "--max-tokens", "--max-findings", "--verify-concurrency", "--min-confidence", "--fail-on", "--model", "--verify-model", "--angles", "--plugins", "--rule", "--background", "--background-file"]) {
      if (flags.has(shaping)) {
        throw new UsageError(`find --preview previews the file selection only; ${shaping} shapes a real run`);
      }
    }
    if (format === "sarif") {
      throw new UsageError("find --preview prints the selection; --format sarif applies to a review run");
    }
    return await renderFindPreview(ctx, {
      base: flags.get("--base") as string | undefined,
      head: flags.get("--head") as string | undefined,
      json: format === "json",
      emit,
    });
  }
  const failOn = (flags.get("--fail-on") as string) ?? "none";
  if (!["P0", "P1", "P2", "P3", "none"].includes(failOn)) throw new UsageError(`invalid --fail-on: ${failOn}`);
  const maxFindings = maxFindingsFlag(flags);
  const ruleFile = flags.get("--rule");
  if (ruleFile !== undefined && (typeof ruleFile !== "string" || ruleFile.trim() === "")) {
    throw new UsageError("--rule requires a path to a project rule file");
  }
  // S2 (ADR-0016): resolve the background before any run row or session
  // exists. A missing/oversized file, empty text or a reserved delimiter is a
  // usage error (exit 2) — never a run that silently drops the context.
  const background = userBackgroundFromFlags(flags, log);
  let result: Awaited<ReturnType<typeof runFind>>;
  try {
    result = await runFind(ctx, {
      base: flags.get("--base") as string | undefined,
      head: flags.get("--head") as string | undefined,
      maxRounds: positiveIntFlag(flags, "--max-rounds"),
      maxTokens: maxTokensFlag(flags),
      maxFindings,
      verifyConcurrency: verifyConcurrencyFlag(flags),
      minConfidence: minConfidenceFlag(flags),
      model: flags.get("--model") as string | undefined,
      verifierModel: verifierModelFlag(flags),
      angles: anglesFlag(flags),
      ...(await parsePluginsFlag(flags)),
      ...(typeof ruleFile === "string" ? { ruleFile } : {}),
      ...(background ? { background } : {}),
      onProgress: (event) => log(`• ${event.message}`),
    });
  } catch (error) {
    // B5 (ADR-0010): a broken rule file is a configuration error (exit 2),
    // not a runtime failure, and it never reaches a model session.
    if (error instanceof ProjectRuleError) throw new UsageError(error.message);
    throw error;
  }
  const findings = result.findings.map((row) => toFindingView(ctx, row));
  const lowConfidenceFindings = result.lowConfidenceFindings.map((row) => toFindingView(ctx, row));

  if (format === "sarif") {
    emit(
      renderSarif({
        command: "find",
        version: readVersion(),
        findings,
        incomplete: result.incomplete,
        stoppedBecause: result.stoppedBecause,
        runId: result.runId,
      }),
    );
  } else if (format === "json") {
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
            // Purely additive (B1): every pre-B1 key keeps its value, plus
            // files[].excluded (always present) and excludedReason (filtered only).
            files: result.changeSet.files.map(changedFileSummary),
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
          runVerdict: result.runVerdict,
          minConfidence: result.minConfidence,
          lowConfidenceFindings,
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
        runVerdict: result.runVerdict,
        minConfidence: result.minConfidence,
        lowConfidenceFindings,
      })}\n`,
    );
  }

  return findExitCode(findings, failOn, result.incomplete);
}

/**
 * `_verify-comment` (roadmap M0): internal eval command, OUTSIDE the stable
 * contract — underscore-prefixed, not listed in USAGE/HELP_SECTIONS, local-only,
 * and gated on PIR_EVAL=1. It verifies ONE materialized AACR-Bench comment and
 * prints the verdict, so the offline benchmark measures the shipped verifier.
 * May change or disappear without notice; do not build consumers on it.
 */
async function cmdVerifyComment(
  ctx: Ctx,
  _args: string[],
  flags: Map<string, string | boolean>,
  json: boolean,
  emit: Emit,
  log: Log,
): Promise<number> {
  if (process.env.PIR_EVAL !== "1") {
    throw new UsageError("_verify-comment is an internal evaluation command; set PIR_EVAL=1 to run it");
  }
  const taskFile = flags.get("--task-file");
  if (typeof taskFile !== "string" || taskFile.trim() === "") {
    throw new UsageError("_verify-comment requires --task-file <path>");
  }
  const arm = (flags.get("--arm") as string | undefined) ?? "verifier";
  if (arm !== "verifier" && arm !== "ocr") throw new UsageError(`invalid --arm: ${arm} (verifier|ocr)`);
  const { readTaskFile, runVerifyComment } = await import("../app/verify-comment.js");
  const task = readTaskFile(taskFile);
  const model = flags.get("--model") as string | undefined;
  log(`• _verify-comment ${task.id} arm=${arm}`);
  const result = await runVerifyComment(ctx, task, { arm, ...(model === undefined ? {} : { model }) });
  emit(json ? `${envelope("_verify-comment", result)}\n` : `${JSON.stringify(result, null, 2)}\n`);
  return 0;
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
  const format = resolveOutputFormat(flags);
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
    if (format === "sarif") {
      throw new UsageError("audit coverage prints a recorded ledger; --format sarif applies to an audit run");
    }
    return await cmdAuditCoverage(ctx, _args.slice(1), flags, format === "json", emit, log);
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
    for (const shaping of ["--max-tokens", "--max-findings", "--verify-concurrency", "--min-confidence", "--fail-on"]) {
      if (flags.has(shaping)) {
        throw new UsageError(`audit --dry-run previews the scope only; ${shaping} shapes a real run`);
      }
    }
    if (format === "sarif") {
      throw new UsageError("audit --dry-run prints a scope preview; --format sarif applies to a real audit run");
    }
    return await renderAuditDryRun(ctx, {
      head: flags.get("--head") as string | undefined,
      includePaths,
      skipGlobs,
      listFiles: flags.get("--list-files") === true,
      json: format === "json",
      emit,
    });
  }
  const { AuditScopeError } = await import("../core/supervisor.js");
  const result = await runAudit(ctx, {
    head: flags.get("--head") as string | undefined,
    includePaths,
    skipGlobs,
    maxTokens: maxTokensFlag(flags),
    maxFindings,
    verifyConcurrency: verifyConcurrencyFlag(flags),
    minConfidence: minConfidenceFlag(flags),
    model: flags.get("--model") as string | undefined,
    verifierModel: verifierModelFlag(flags),
    ...(await parsePluginsFlag(flags)),
    onProgress: (event) => log(`• ${event.message}`),
  }).catch((error: unknown) => {
    if (error instanceof AuditScopeError) throw new UsageError(error.message);
    throw error;
  });
  const findings = result.findings.map((row) => toFindingView(ctx, row));
  const lowConfidenceFindings = result.lowConfidenceFindings.map((row) => toFindingView(ctx, row));

  if (format === "sarif") {
    emit(
      renderSarif({
        command: "audit",
        version: readVersion(),
        findings,
        incomplete: result.incomplete,
        stoppedBecause: result.stoppedBecause,
        runId: result.runId,
        coverage: { ...result.coverage },
      }),
    );
  } else if (format === "json") {
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
          runVerdict: result.runVerdict,
          minConfidence: result.minConfidence,
          lowConfidenceFindings,
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
        runVerdict: result.runVerdict,
        minConfidence: result.minConfidence,
        lowConfidenceFindings,
      })}\n`,
    );
  }

  return findExitCode(findings, failOn, result.incomplete);
}

/**
 * `pir find --preview [--json]` (B1/T4): the change set a real find of the
 * same range would review, plus the per-file decision of the shared
 * change-mode filter — the same buildChangeSet + selectChangeFiles calls the
 * run makes, so what is previewed is what gets reviewed by construction.
 * Excluded files are reported with their path/status/churn and the gate's
 * reason: the reviewer's view is "this changed, and you may not read its
 * diff". No run row, no model session, no writes.
 */
async function renderFindPreview(
  ctx: Ctx,
  input: { base: string | undefined; head: string | undefined; json: boolean; emit: Emit },
): Promise<number> {
  const { buildChangeSet } = await import("../changes/change-set.js");
  const { DEFAULT_SKIP_PATTERNS, FILTER_VERSION, MAX_DIFF_FILE_BYTES, SECRET_PATH_PATTERNS, selectChangeFiles } = await import("../changes/filter.js");
  const { getHeadCommit } = await import("../changes/git.js");
  const emit = input.emit;
  // Ref labels stay labels ("HEAD^") in the readout; only the diff is pinned
  // to resolved commits.
  const requestedBase = input.base ?? `${input.head ?? "HEAD"}^`;
  const changeSet = await buildChangeSet(ctx.repoRoot, requestedBase, input.head ?? (await getHeadCommit(ctx.repoRoot)));
  const decisions = selectChangeFiles(changeSet.files);
  const files = changeSet.files.map((file, index) => {
    const decision = decisions[index]!;
    return {
      path: file.path,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      language: file.language,
      excluded: !decision.selected,
      ...(file.oldPath ? { oldPath: file.oldPath } : {}),
      ...(decision.reason ? { excludedReason: decision.reason } : {}),
      ...(decision.gate ? { gate: decision.gate } : {}),
    };
  });
  const byGate: Record<string, number> = {};
  for (const decision of decisions) {
    if (decision.gate) byGate[decision.gate] = (byGate[decision.gate] ?? 0) + 1;
  }
  const selected = decisions.filter((decision) => decision.selected).length;
  const counts = { total: files.length, selected, excluded: files.length - selected, byGate };
  const note = "no run is created and no model is used; this is the same change set and filter a real find would use";
  const gates = ["binary", "secret", "not-included", "skip-pattern", "oversized-diff"];
  if (input.json) {
    emit(
      envelope(
        "find.preview",
        {
          base: changeSet.baseCommit ?? changeSet.base,
          head: changeSet.headCommit ?? changeSet.head,
          requestedBase,
          mergeBase: changeSet.mergeBase,
          churn: changeSet.churn,
          filter: {
            version: FILTER_VERSION,
            gates,
            maxDiffBytes: MAX_DIFF_FILE_BYTES,
            secretPaths: SECRET_PATH_PATTERNS,
            defaultExclusions: DEFAULT_SKIP_PATTERNS,
          },
          counts,
          files,
          note,
        },
        { project: { id: ctx.memory.identity.projectId, cwd: ctx.repoRoot, head: changeSet.headCommit ?? changeSet.head } },
      ),
    );
    emit("\n");
    return 0;
  }
  const gateSummary = gates
    .filter((gate) => (byGate[gate] ?? 0) > 0)
    .map((gate) => `${byGate[gate]} ${gate}`)
    .join(", ");
  const lines = [
    `find preview: merge-base ${changeSet.mergeBase} -> head ${changeSet.headCommit ?? changeSet.head} (${changeSet.files.length} files, ${changeSet.churn} changed lines)`,
    `requested base: ${requestedBase}; filter version ${FILTER_VERSION} (gates: ${gates.join(" -> ")}, ${MAX_DIFF_FILE_BYTES}-byte diff cap)`,
    `files: ${counts.total} total — ${counts.selected} selected, ${counts.excluded} excluded${gateSummary ? ` (${gateSummary})` : ""}`,
    "excluded files keep path/status/churn metadata; their diff bodies never reach a model",
  ];
  for (const file of files) {
    const state = file.excluded ? "excluded" : "selected";
    const rename = file.oldPath ? ` (from ${file.oldPath})` : "";
    const reason = file.excludedReason ? `  (${file.excludedReason})` : "";
    lines.push(`  ${state.padEnd(10)}${file.status.padEnd(10)}+${file.additions}/-${file.deletions}${" ".repeat(Math.max(1, 8 - `+${file.additions}/-${file.deletions}`.length))}${file.path}${rename}${reason}`);
  }
  lines.push(note);
  emit(`${lines.join("\n")}\n`);
  return 0;
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

async function cmdConfig(args: string[], flags: Map<string, string | boolean>, json: boolean, emit: Emit, out: string[]): Promise<ExecResult> {
  const sub = args[0] ?? "show";

  if (sub === "show") {
    const config = loadUserConfig();
    // B5 (ADR-0010): the effective rule layers are part of `config show`; a
    // broken rule file fails here with the same loud usage error find gives.
    // --cwd selects the repository whose `.pir/rule.json` layer is read.
    const rules = loadRulesForConfig(typeof flags.get("--cwd") === "string" ? (flags.get("--cwd") as string) : process.cwd());
    if (json) {
      emit(`${envelope("config.show", { path: configPath(), ...(config ? { config: redactConfig(config) } : { config: null }), rules: projectRulesJson(rules) })}\n`);
    } else if (!config) {
      emit(`no config yet — running with local defaults\npath: ${configPath()}\ncreate one with: pir config\n${renderProjectRulesConfig(rules)}`);
    } else {
      emit(`${renderConfig(config, configPath())}${renderProjectRulesConfig(rules)}`);
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

/** Load the layers `config show` reports; a broken file is a usage error. */
function loadRulesForConfig(repoRoot: string): ProjectRuleSet {
  try {
    return loadProjectRules({ repoRoot });
  } catch (error) {
    if (error instanceof ProjectRuleError) throw new UsageError(error.message);
    throw error;
  }
}

/** Machine-readable rule layers (`config show --json`); full guidance text. */
function projectRulesJson(rules: ProjectRuleSet): Record<string, unknown> {
  return {
    schemaVersion: rules.schemaVersion,
    hash: rules.hash,
    layers: rules.layers.map((layer) => ({
      layer: layer.layer,
      file: layer.file,
      include: layer.include,
      exclude: layer.exclude,
      rules: layer.rules.map((rule) => ({
        path: rule.path,
        mergeBuiltin: rule.mergeBuiltin,
        guidanceSource: rule.guidanceSource,
        ...(rule.guidanceFile ? { guidanceFile: rule.guidanceFile } : {}),
        guidance: rule.guidance,
      })),
    })),
  };
}

/** Human-readable rule layers: source, globs, merge flag and a guidance preview. */
function renderProjectRulesConfig(rules: ProjectRuleSet): string {
  const lines = ["project rules (layers: --rule > repo .pir/rule.json > global rule.json; first matching rule wins)"];
  if (rules.layers.length === 0) {
    lines.push(`  none (searched the repository's .pir/rule.json and ${path.join(pirConfigDir(), "rule.json")}; --rule is per invocation)`);
  } else {
    for (const layer of rules.layers) {
      const scope = `include ${JSON.stringify(layer.include)}${layer.exclude.length > 0 ? `, exclude ${JSON.stringify(layer.exclude)}` : ""}`;
      lines.push(`  ${layer.layer}: ${layer.file} — ${layer.rules.length} rule${layer.rules.length === 1 ? "" : "s"}, ${scope}`);
      for (const rule of layer.rules) {
        const source = rule.guidanceSource === "file" ? `file ${rule.guidanceFile}` : `inline ${rule.guidance.length} chars`;
        const firstLine = rule.guidance.split("\n")[0] ?? "";
        const preview = firstLine.length > 140 ? `${firstLine.slice(0, 140)}…` : firstLine;
        lines.push(`    - "${rule.path}" mergeBuiltin=${rule.mergeBuiltin} (${source})${preview ? `: ${preview}` : ""}`);
      }
    }
  }
  lines.push(`  hash: ${rules.hash}`);
  return `${lines.join("\n")}\n`;
}

/**
 * Rule-layer display labels: the same `layerLabel` the reviewer prompt uses,
 * so the command cannot name a layer differently from the prompt it explains
 * (and neither output carries a host path).
 */
const ruleLayerFile = (set: ProjectRuleSet, index: number): string => layerLabel(set.layers[index]!);

/** Normalize the checked path to the repo-relative POSIX form globs match. */
function ruleCheckPath(repoRoot: string, raw: string): string {
  const given = raw.trim().replace(/\\/g, "/");
  if (given === "") throw new UsageError("rules check requires a non-empty <path>");
  if (path.posix.isAbsolute(given)) {
    const relative = path.relative(repoRoot, path.resolve(given)).split(path.sep).join("/");
    if (relative === "" || relative === ".." || relative.startsWith("../") || path.posix.isAbsolute(relative)) {
      throw new UsageError("rules check path must be a file inside the repository");
    }
    return relative;
  }
  const relative = path.posix.normalize(given).replace(/^\.\//, "");
  if (relative === "" || relative === "." || relative === ".." || relative.startsWith("../") || relative.endsWith("/")) {
    throw new UsageError(`rules check path must name a file inside the repository (got "${raw}")`);
  }
  return relative;
}

/** Why one layer did or did not select a rule, in the command's own words. */
function describeRuleLayer(layer: RuleLayerCheck): string {
  if (layer.includedBy === null) return "path not included by any include glob";
  if (layer.excludedBy !== null) return `path excluded by exclude glob "${layer.excludedBy}"`;
  if (layer.rulePath === null) return "path included, no rule matched";
  return layer.won
    ? `winning rule "${layer.rulePath}"`
    : `matches rule "${layer.rulePath}" (a higher-priority layer wins)`;
}

function renderRuleCheck(check: ProjectRuleCheck, set: ProjectRuleSet, displayPath: string, exists: boolean): string {
  const lines = [`path: ${displayPath}`];
  if (!exists) lines.push("note: path does not exist in this checkout; matched by path only");
  if (check.match) {
    const { layer, rule, layerIndex } = check.match;
    lines.push(`rule: "${rule.path}"`);
    lines.push(`layer: ${layer.layer} (${ruleLayerFile(set, layerIndex)})`);
    lines.push(`mergeBuiltin: ${rule.mergeBuiltin}`);
    const source = rule.guidanceSource === "file" ? `file ${rule.guidanceFile}` : "inline";
    lines.push(`guidance (${source}, ${rule.guidance.length} chars):`);
    lines.push(rule.guidance);
    lines.push("");
  } else {
    lines.push("rule: none");
    lines.push("layers:");
    if (check.layers.length === 0) {
      lines.push("  none loaded (searched .pir/rule.json and ~/.pir/rule.json; --rule is per invocation)");
    } else {
      for (const [index, layer] of check.layers.entries()) {
        const count = `${layer.rules} rule${layer.rules === 1 ? "" : "s"}`;
        lines.push(`  ${layer.layer} (${ruleLayerFile(set, index)}): ${count}, ${describeRuleLayer(layer)}`);
      }
    }
  }
  lines.push(`rules hash: ${set.hash}`);
  return `${lines.join("\n")}\n`;
}

function ruleCheckJson(
  check: ProjectRuleCheck,
  set: ProjectRuleSet,
  displayPath: string,
  exists: boolean,
  renderedSection: string,
): Record<string, unknown> {
  const winner = check.match;
  return {
    path: displayPath,
    exists,
    rulesHash: set.hash,
    matched: winner !== null,
    winner:
      winner === null
        ? null
        : {
            layer: winner.layer.layer,
            file: ruleLayerFile(set, winner.layerIndex),
            rule: winner.rule.path,
            mergeBuiltin: winner.rule.mergeBuiltin,
            guidanceSource: winner.rule.guidanceSource,
            guidanceFile: winner.rule.guidanceFile ?? null,
            guidance: winner.rule.guidance,
          },
    // The exact reviewer-prompt section this path would receive ("" when no
    // rule applies); the same `applyProjectRules` call find makes.
    renderedSection,
    layers: check.layers.map((layer, index) => ({
      layer: layer.layer,
      file: ruleLayerFile(set, index),
      rules: layer.rules,
      include: layer.include,
      exclude: layer.exclude,
      includedBy: layer.includedBy,
      excludedBy: layer.excludedBy,
      rule: layer.rulePath,
      won: layer.won,
    })),
  };
}

/**
 * `pir rules check <path>` (Track B, S7): the winning rule, its layer, the
 * matched glob and the rendered guidance for one repository path. Pure read:
 * no review run row, no project database, no model session, no repo writes.
 */
async function cmdRules(
  args: string[],
  flags: Map<string, string | boolean>,
  json: boolean,
  emit: Emit,
  out: string[],
  cwd: string,
): Promise<{ code: number; output: string }> {
  if (flags.has("--repo")) throw new UsageError("rules check reads this checkout; --repo is not supported");
  if (flags.has("--base") || flags.has("--head") || flags.has("--branch") || flags.has("--uncommitted")) {
    throw new UsageError("rules check matches one path, not a review range; --base/--head/--branch/--uncommitted do not apply");
  }
  const sub = args[0];
  if (sub === undefined) throw new UsageError("rules requires a subcommand: check <path>");
  if (sub !== "check") throw new UsageError(`unknown rules subcommand: ${sub} (expected check <path>)`);
  const raw = args[1];
  if (raw === undefined) throw new UsageError("rules check requires a <path>");
  if (args.length > 2) throw new UsageError("rules check takes one <path>");
  const repoRoot = path.resolve(cwd);
  const displayPath = ruleCheckPath(repoRoot, raw);
  const explicitPath = typeof flags.get("--rule") === "string" ? (flags.get("--rule") as string) : undefined;
  let set: ProjectRuleSet;
  try {
    set = loadProjectRules({ repoRoot, ...(explicitPath === undefined ? {} : { explicitPath }) });
  } catch (error) {
    if (error instanceof ProjectRuleError) throw new UsageError(error.message);
    throw error;
  }
  // Winner and layer explanation share the reviewer prompt's matcher, and the
  // rendered section is the same `applyProjectRules` output find consumes.
  const check = checkProjectRules(set, displayPath);
  const renderedSection = applyProjectRules(set, [{ path: displayPath }]).section;
  const exists = existsSync(path.join(repoRoot, displayPath));
  emit(
    json
      ? `${envelope("rules.check", ruleCheckJson(check, set, displayPath, exists, renderedSection))}\n`
      : renderRuleCheck(check, set, displayPath, exists),
  );
  return { code: 0, output: out.join("") };
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
