import { VALUE_FLAGS } from "./executor.js";

/**
 * Machine-output selection for the layers that decide before the executor runs
 * (ADR 0016 Part III, dogfood F-17): the first-run wizard and the remote `--detach`
 * submission envelope. `--json` is the legacy spelling of `--format json`, so
 * `json` and `sarif` are both machine output — testing the literal `--json`
 * token (as those two pre-existing checks did) missed `--format json|sarif`.
 *
 * A tolerant argv scan rather than parseArgs: this runs before the executor and
 * must not raise its usage errors (a malformed `--format` value is reported
 * later, with usage text), and it must not lose a `--json` just because some
 * unrelated flag is malformed. VALUE_FLAGS keeps a flag value from being read
 * as a flag (the same rule as parseArgs and firstPositional).
 */
export function machineOutputFromArgv(argv: readonly string[]): boolean {
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token === "--json") return true;
    if (token === "--format") {
      const value = argv[i + 1];
      if (value === "json" || value === "sarif") return true;
      if (value !== undefined) i += 1; // the value is not a flag
      continue;
    }
    if (token.startsWith("--format=")) {
      const value = token.slice("--format=".length);
      if (value === "json" || value === "sarif") return true;
      continue;
    }
    if (token.startsWith("--") && VALUE_FLAGS.has(token)) i += 1;
  }
  return false;
}
