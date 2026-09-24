#!/usr/bin/env node
import process from "node:process";
import { USAGE, UsageError, VALUE_FLAGS, executePirCommand } from "./executor.js";
import { configPath, isInteractive, loadUserConfig, resolveTransport, runWizard } from "./config.js";

/** Commands that never leave this process, whatever the configured mode is. */
const LOCAL_ONLY = new Set(["serve", "config", "skill", "help", "version"]);

async function main(argv: string[]): Promise<number> {
  const command = firstPositional(argv);
  let config = loadUserConfig();

  if (!config && shouldRunWizard(argv, command)) {
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
    !argv.includes("--quiet") &&
    process.env.PIR_NO_WIZARD !== "1" &&
    !argv.includes("--no-wizard")
  ) {
    process.stderr.write(
      `pir: no config at ${configPath()} — using local defaults (run \`pir config\` for remote mode / default model)\n`,
    );
  }

  const transport = resolveTransport({ argv, env: process.env, config });
  // serve/config/skill/version/help (and a bare `pir`) stay client-side.
  const forwardToServer = command !== undefined && !LOCAL_ONLY.has(command);
  if (transport.mode === "remote" && forwardToServer) {
    const { remoteExec } = await import("./remote.js");
    return remoteExec(transport.url, argv, {
      token: transport.token,
      insecure: transport.insecure,
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

function shouldRunWizard(argv: string[], command: string | undefined): boolean {
  return (
    isInteractive() &&
    !argv.includes("--json") &&
    !argv.includes("--no-wizard") &&
    process.env.PIR_NO_WIZARD !== "1" &&
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

/**
 * Exit only after queued stream writes reach the OS: plain process.exit()
 * truncates large buffered writes on pipes (the `pir models --all` catalog
 * exceeds the synchronous 64KB buffer). The empty-string write's callback
 * fires once everything queued before it has been flushed.
 */
function drainAndExit(code: number): void {
  process.stdout.write("", () => {
    process.stderr.write("", () => process.exit(code));
  });
}
