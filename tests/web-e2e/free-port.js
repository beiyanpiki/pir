import { execFileSync } from "node:child_process";

// Ask the kernel for a free loopback port in a separate process: bind(0) is the
// only portable way to get one, and net's listen() is asynchronous, while a
// Playwright config file must resolve synchronously (the loader takes the
// module's default export as-is and never awaits it).
const PROBE = `
import { createServer } from "node:net";
const server = createServer();
server.unref();
server.on("error", () => process.exit(1));
server.listen(0, "127.0.0.1", () => {
  process.stdout.write(String(server.address().port));
  server.close();
});
`;

/**
 * A free TCP port on 127.0.0.1, chosen by the OS.
 *
 * The web e2e suite used to pin 5174. A run killed hard (job cancelled, runner
 * restarted, SIGKILL on the wrapper) can strand its vite dev server, and the
 * next run then died before a single test with "http://127.0.0.1:5174/ is
 * already used". Letting the kernel hand the port out per run makes a stranded
 * server harmless instead of fatal.
 *
 * The probe closes its socket before returning, so the port is free but not
 * reserved. A process that races us into it is rare and loud: vite runs with
 * --strictPort, so the suite fails on that port rather than silently testing a
 * different server.
 */
export function freePort() {
  const stdout = execFileSync(process.execPath, ["--input-type=module", "-e", PROBE], {
    encoding: "utf8",
    timeout: 10_000,
  }).trim();
  const port = Number(stdout);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`could not resolve a free port (probe returned ${JSON.stringify(stdout)})`);
  }
  return port;
}
