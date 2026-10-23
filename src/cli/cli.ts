#!/usr/bin/env node
import process from "node:process";
import { USAGE, UsageError, VALUE_FLAGS, executePirCommand, helpFor, parseArgs, resolveOutputFormat } from "./executor.js";
import { drainAndExit } from "./exit.js";
import { resolveRemoteTimeoutSeconds } from "./remote-fetch.js";
import { configPath, isInteractive, loadUserConfig, resolveTransport, runWizard, type UserConfig } from "./config.js";

/** Commands that never leave this process, whatever the configured mode is. */
const LOCAL_ONLY = new Set(["serve", "config", "skill", "rules", "plugins", "help", "version", "runs", "receipts", "_verify-comment"]);

/**
 * `memory sync` merges the LOCAL db with a server, so it also always runs in
 * this process — forwarding it would sync the server's workspace project
 * instead. The executor resolves the server URL itself.
 */
function isLocalSync(argv: string[]): boolean {
  const positional = parseArgs(argv).positional;
  return positional[0] === "memory" && positional[1] === "sync";
}

async function main(argv: string[]): Promise<number> {
  // --help is answered locally before anything else (#43): no config load,
  // no wizard, no transport resolution, no git, no network — so help works
  // offline, outside a repository, with a read-only .git and with a missing
  // or corrupt config.json. A parse error falls through to the normal path,
  // which reports it with full context.
  const localHelp = helpOnly(argv);
  if (localHelp !== null) {
    process.stdout.write(localHelp);
    return 0;
  }

  const command = firstPositional(argv);
  // find/audit output selection is validated before any transport or bundle
  // work — and therefore before a remote forward — so a typo or a
  // contradictory --json/--format pair fails fast with exit 2 (S6).
  if (command === "find" || command === "audit") resolveOutputFormat(parseArgs(argv).flags);
  let config: UserConfig | null = null;
  const webRoute = webFindingsRoute(argv);
  try {
    config = loadUserConfig();
  } catch (err) {
    // A corrupt config.json must not brick the whole CLI — least of all
    // `pir config`, the documented way out. The URL-keyed recovery commands
    // (#48/#49/#52) tolerate it too: they carry their own server address
    // and must keep working when the config is the broken part.
    if (
      command === "config" ||
      command === "rules" ||
      command === "help" ||
      command === undefined ||
      command === "version" ||
      command === "runs" ||
      command === "receipts" ||
      webRoute !== null
    ) {
      process.stderr.write(`pir: ${err instanceof Error ? err.message : String(err)} (continuing; 'pir config reset' removes the file)\n`);
    } else {
      throw err;
    }
  }

  if (!config && shouldRunWizard(argv, command, webRoute)) {
    config = await runWizard();
    if (command === undefined) {
      process.stdout.write(
        `\nNext steps:\n  pir find --json            review HEAD^..HEAD\n  pir find --uncommitted     review the working tree\n  pir --help                 full reference\n`,
      );
      return 0;
    }
  } else if (
    !config &&
    command !== undefined &&
    !LOCAL_ONLY.has(command) &&
    // The URL-keyed findings lane talks to the URL's server, not local
    // defaults — the hint (and its `pir config` advice) would be wrong.
    webRoute === null &&
    !argv.includes("--quiet") &&
    process.env.PIR_NO_WIZARD !== "1" &&
    !argv.includes("--no-wizard")
  ) {
    process.stderr.write(
      `pir: no config at ${configPath()} — using local defaults (run \`pir config\` for remote mode / default model)\n`,
    );
  }

  const transport = resolveTransport({ argv, env: process.env, config });
  // #54: resolve the remote-response timeout once (flag > env > config >
  // default) and normalize it into the environment variable every consumer
  // already reads (review submission, job polling, web-tier queries) — one
  // dispatcher, one precedence, invalid values fail fast with exit 2.
  const remoteTimeout = resolveRemoteTimeoutSeconds({ argv, env: process.env, config });
  if (remoteTimeout.source === "flag" || remoteTimeout.source === "config") {
    process.env.PIR_REMOTE_TIMEOUT = String(remoteTimeout.seconds);
  }
  // serve/config/skill/plugins/version/help (and a bare `pir`) stay
  // client-side; plugins list inspects the caller's own checkout.
  // memory sync needs the local repo + local db even in remote mode.
  const forwardToServer = command !== undefined && !LOCAL_ONLY.has(command) && !isLocalSync(argv);
  // B5 (ADR-0010): --rule names a file on the caller's machine. Forwarding the
  // path would read a server-side file (or fail there) under the same spelling;
  // the repository and global layers still apply on the server, so reject the
  // flag rather than resolve it somewhere the user did not mean.
  if (transport.mode === "remote" && forwardToServer && argv.some((arg) => arg === "--rule" || arg.startsWith("--rule="))) {
    throw new UsageError("--rule is a local file path and is not forwarded to a server; commit .pir/rule.json, use the server's global rule.json, or run with --local");
  }
  // S2 (ADR-0016): `--background` is inline text and may be forwarded (a server
  // running an older build drops it, so remote needs a same-version server),
  // but `--background-file` names a file on the caller's machine — forwarding
  // the path would read a server-side file (or fail there) under the same
  // spelling. Reject it rather than resolve it somewhere the user did not mean.
  if (transport.mode === "remote" && forwardToServer && argv.some((arg) => arg === "--background-file" || arg.startsWith("--background-file="))) {
    throw new UsageError("--background-file is a local file path and is not forwarded to a server; pass the text inline with --background, or run with --local");
  }
  if (command === "jobs") {
    // jobs talks to the server's job registry directly (GET /v1/jobs) —
    // there is nothing to forward through the executor.
    if (transport.mode !== "remote") {
      throw new UsageError("pir jobs needs a remote server — pass --server <url> or configure remote mode (`pir config`)");
    }
    const { runJobsCommand } = await import("./jobs.js");
    const { stripClientFlags } = await import("./remote.js");
    return runJobsCommand(stripClientFlags(argv), {
      url: transport.url,
      ...(transport.token ? { token: transport.token } : {}),
      ...(transport.insecure ? { insecure: true } : {}),
    });
  }
  if (command === "runs") {
    // The run URL (or --server/--project/--run) names the server itself, so
    // this works regardless of the configured mode — including on a fresh
    // machine that only has a pasted URL (#48).
    const { runRunsCommand } = await import("./runs.js");
    return runRunsCommand(argv, { env: process.env, config });
  }
  if (webRoute !== null) {
    // findings routed at one remote run: intercepted before local execution
    // AND before remote forwarding, so it never needs a repository, a
    // readable .git, or a registered project (#48/#49).
    const runs = await import("./runs.js");
    return webRoute === "export"
      ? runs.runFindingsExportCommand(argv, { env: process.env, config })
      : runs.runWebFindingsCommand(argv, { env: process.env, config });
  }
  if (transport.mode === "remote" && forwardToServer) {
    const { remoteExec } = await import("./remote.js");
    return remoteExec(transport.url, argv, {
      token: transport.token,
      insecure: transport.insecure,
    });
  }

  // ADR 0022: local --detach re-executes this CLI as a detached background
  // process with a log and a receipt, then returns once the child is accepted.
  // Handled AFTER the remote-forward branch so remote detach keeps its
  // semantics, and the executor's server-lane rejections stay untouched. The
  // child (PIR_LOCAL_JOB_ID) never re-detaches; anything that is not a
  // find/audit run has nothing to detach and is a usage error.
  if (argv.includes("--detach") && !process.env.PIR_LOCAL_JOB_ID) {
    if (command !== "find" && command !== "audit") {
      throw new UsageError("--detach applies to `pir find` / `pir audit`; this command has no run to detach");
    }
    const { localDetach } = await import("./detach.js");
    return await localDetach({
      argv,
      cwd: process.cwd(),
      env: process.env,
      emit: (text) => process.stdout.write(text),
      log: (message) => process.stderr.write(`${message}\n`),
    });
  }

  if (command === "serve") {
    const { runServe } = await import("../server/server.js");
    await runServe(argv.slice(1)); // resolves only on shutdown
    return 0;
  }

  // User-level default model slots in under the existing precedence:
  // --model flag > PIR_MODEL env > config.model > pi settings.
  if (config?.model && !argv.includes("--model") && !process.env.PIR_MODEL) {
    process.env.PIR_MODEL = config.model;
  }

  const result = await executePirCommand(argv, {
    onLog: (message) => {
      if (!argv.includes("--json") && !argv.includes("--quiet")) {
        process.stderr.write(`${message}\n`);
      }
    },
  });
  process.stdout.write(result.output);
  return result.code;
}

/**
 * The help text to print when argv asks for --help, or null when it does not.
 * parseArgs is the authority: a --help directly after a value flag
 * (`pir findings list --status --help`) is that flag's value, not a request.
 */
function helpOnly(argv: string[]): string | null {
  let positional: string[];
  let wantsHelp: boolean;
  try {
    const parsed = parseArgs(argv);
    positional = parsed.positional;
    wantsHelp = parsed.flags.get("--help") === true;
  } catch {
    return null;
  }
  return wantsHelp ? helpFor(positional[0]) : null;
}

/**
 * findings commands that route at one remote run (#48/#49): `--run` anywhere,
 * or the export subcommand (which requires --run and fails fast without it).
 * Null for every other argv.
 */
function webFindingsRoute(argv: string[]): "list" | "export" | null {
  let positional: string[];
  let flags: Map<string, string | boolean>;
  try {
    ({ positional, flags } = parseArgs(argv));
  } catch {
    return null;
  }
  if (positional[0] !== "findings") return null;
  if (positional[1] === "export") return "export";
  return flags.has("--run") ? "list" : null;
}

/**
 * The URL-keyed findings recovery lane carries its own server address, so it
 * must work on an unconfigured machine (#48/#49) — like `runs`/`receipts`
 * (LOCAL_ONLY), it never triggers first-run setup. The wizard otherwise runs
 * before the webRoute dispatch and contradicts that contract (dogfood F-55).
 */
function shouldRunWizard(
  argv: string[],
  command: string | undefined,
  webRoute: "list" | "export" | null,
): boolean {
  return (
    isInteractive() &&
    !argv.includes("--json") &&
    !argv.includes("--no-wizard") &&
    process.env.PIR_NO_WIZARD !== "1" &&
    webRoute === null &&
    (command === undefined || !LOCAL_ONLY.has(command))
  );
}

/** First non-flag token, skipping the value of value-flags like --server <url>. */
function firstPositional(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === "--") return undefined;
    if (token.startsWith("--")) {
      if (VALUE_FLAGS.has(token) || token === "--server" || token === "--token") i += 1;
      continue;
    }
    return token;
  }
  return undefined;
}

main(process.argv.slice(2)).then(
  (code) => drainAndExit(code),
  (err) => {
    if (err instanceof UsageError) {
      process.stderr.write(`pir: ${err.message}\n\n${USAGE}\n`);
      drainAndExit(2);
    } else {
      process.stderr.write(`pir: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
      drainAndExit(3);
    }
  },
);
