#!/usr/bin/env node
import process from "node:process";
import { USAGE, UsageError, executePirCommand } from "./executor.js";

async function main(argv: string[]): Promise<number> {
  // Remote mode: forward the whole argv to a pir serve instance.
  const serverFlag = extractFlag(argv, "--server") ?? process.env.PIR_SERVER_URL;
  if (serverFlag) {
    const { remoteExec } = await import("./remote.js");
    return remoteExec(serverFlag, argv, {
      token: extractFlag(argv, "--token") ?? process.env.PIR_SERVER_TOKEN,
      insecure: argv.includes("--insecure") || process.env.PIR_INSECURE === "1",
    });
  }

  if (argv[0] === "serve") {
    const { runServe } = await import("../server/server.js");
    await runServe(argv.slice(1)); // resolves only on shutdown
    return 0;
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

function extractFlag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    if (err instanceof UsageError) {
      process.stderr.write(`pir: ${err.message}\n\n${USAGE}\n`);
      process.exit(2);
    }
    process.stderr.write(`pir: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(3);
  },
);
