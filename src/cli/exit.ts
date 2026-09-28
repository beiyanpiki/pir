import process from "node:process";

/** Give queued writes this long to reach the OS before exiting anyway. */
const DRAIN_TIMEOUT_MS = 2000;

/**
 * Exit only after queued stream writes reach the OS: plain process.exit()
 * truncates large buffered writes on pipes (the `pir models --all` catalog
 * exceeds the synchronous 64KB buffer). The empty-string write's callback
 * fires once everything queued before it has been flushed.
 *
 * A pipe whose reader stays open but never drains would block the callback
 * forever, so a timer forces the exit (truncating, like a bare process.exit)
 * after DRAIN_TIMEOUT_MS.
 */
export function drainAndExit(code: number): void {
  let exited = false;
  const exitOnce = (): void => {
    if (exited) return;
    exited = true;
    clearTimeout(timer);
    process.exit(code);
  };
  const timer = setTimeout(exitOnce, DRAIN_TIMEOUT_MS);
  process.stdout.write("", () => {
    process.stderr.write("", exitOnce);
  });
}
