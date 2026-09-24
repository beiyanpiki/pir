/**
 * Evaluation scenarios for pi-review (Phase 11).
 *
 * Each scenario builds a small git fixture, optionally runs feedback steps to
 * seed repository memory, then runs `pir find` and compares the outcome with
 * expectations. Scenarios run only with a live model (PIR_EVAL=1).
 */

export const SCENARIOS = [
  {
    name: "real-bug",
    description: "A genuine bug is introduced; it must be reported.",
    build(repo) {
      repo.write("src/counter.ts", "export function next(c: number): number {\n  return c + 1;\n}\n");
      repo.commit("baseline");
      repo.write(
        "src/counter.ts",
        [
          "export function next(c: number): number {",
          "  // bug: off-by-one correction applied twice",
          "  const corrected = c + 1;",
          "  return corrected + 1;",
          "}",
          "",
        ].join("\n"),
      );
      repo.commit("introduce double increment");
    },
    findArgs: ["--base", "HEAD^", "--head", "HEAD"],
    expect: [{ claimLike: "increment", shouldReport: true, minSeverity: "P1" }],
  },
  {
    name: "expected-behavior-suppressed",
    description: "User previously marked the behavior expected; the same issue must not be re-reported.",
    build(repo) {
      repo.write("src/quota.ts", "export function hit(quota: number): number {\n  return quota - 1;\n}\n");
      repo.commit("baseline");
      repo.write("src/quota.ts", "export function hit(quota: number): number {\n  return quota - 1; // still counts attempts\n}\n");
      repo.commit("touch quota");
    },
    seedFinding: {
      claim: "quota is consumed without a remote attempt",
      entityKey: "hit",
      decision: "expected",
      note: "quota intentionally counts attempts",
    },
    findArgs: ["--base", "HEAD^", "--head", "HEAD"],
    expect: [{ claimLike: "quota", shouldReport: false }],
  },
  {
    name: "fixed-regression",
    description: "A previously-fixed bug returns; the regression must be caught.",
    build(repo) {
      repo.write("src/idem.ts", "export function run(idem: string | null): number {\n  if (!idem) throw new Error('missing idempotency key');\n  return 1;\n}\n");
      repo.commit("baseline with guard");
      repo.write("src/idem.ts", "export function run(idem: string | null): number {\n  return 1;\n}\n");
      repo.commit("regression: guard removed");
    },
    seedResolution: {
      claim: "idempotency key not validated",
      entityKey: "run",
      verified: true,
    },
    findArgs: ["--base", "HEAD^", "--head", "HEAD"],
    expect: [{ claimLike: "idempotency", shouldReport: true }],
  },
  {
    name: "renamed-symbol-memory-survives",
    description: "Feature-level memory still applies after a symbol rename.",
    build(repo) {
      repo.write("src/retry.ts", "export function oldRetry(n: number): number {\n  return n;\n}\n");
      repo.commit("baseline");
    },
    seedMemory: {
      scope: "feature",
      target: "retry-flow",
      kind: "invariant",
      text: "Every retry attempt must validate the idempotency key before remote execution",
    },
    rebuild(repo) {
      // Rename the symbol and break the invariant in the same change.
      repo.write(
        "src/retry.ts",
        [
          "export function executeRetry(n: number, key: string | null): number {",
          "  // invariant dropped: key is ignored",
          "  void key;",
          "  return n;",
          "}",
          "",
        ].join("\n"),
      );
      repo.commit("rename + break invariant");
    },
    findArgs: ["--base", "HEAD^", "--head", "HEAD"],
    expect: [{ claimLike: "idempotency", shouldReport: true }],
  },
  {
    name: "stale-memory-reopened",
    description: "A wont_fix decision must NOT suppress the issue when the blast radius grows.",
    build(repo) {
      repo.write("src/lock.ts", "export function failed(n: number): boolean {\n  return n > 3;\n}\n");
      repo.commit("baseline");
    },
    seedFinding: {
      claim: "failed count threshold is too strict",
      entityKey: "failed",
      decision: "wont-fix",
      note: "accepted for internal tooling",
    },
    rebuild(repo) {
      repo.write(
        "src/lock.ts",
        [
          "export function failed(n: number): boolean {",
          "  return n > 3;",
          "}",
          "",
          "// NEW: the same counter now also locks customer accounts",
          "export function lockAccount(failures: number): boolean {",
          "  return failed(failures);",
          "}",
          "",
        ].join("\n"),
      );
      repo.commit("blast radius grows to account lockout");
    },
    findArgs: ["--base", "HEAD^", "--head", "HEAD"],
    expect: [{ claimLike: "threshold|lock|account", shouldReport: true }],
  },
];
