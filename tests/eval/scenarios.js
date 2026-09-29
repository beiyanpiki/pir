/** Human-labelled synthetic cases. Labels stay outside the reviewed repository. */
const range = (path, startLine, endLine) => ({ path, startLine, endLine });
const label = (id, claimLike, locations, shouldReport = true, categories = ["correctness", "regression"]) => ({
  id, claimLike, locations, shouldReport, categories, minSeverity: "P2", maxSeverity: "P1",
});
const write = (repo, files) => { for (const [file, text] of Object.entries(files)) repo.write(file, text); };
const contract = (text) => `# API contract\n\n${text}\n`;
const change = (repo, before, after) => {
  write(repo, before); repo.commit("initial implementation");
  write(repo, after); repo.commit("update implementation");
};
const counterBefore = "export function next(c: number): number {\n  return c + 1;\n}\n";
const counterAfter = "export function next(c: number): number {\n  const corrected = c + 1;\n  return corrected + 1;\n}\n";
const guarded = "export function run(key: string | null): number {\n  if (!key) throw new Error('missing idempotency key');\n  return 1;\n}\n";
const unguarded = "export function run(key: string | null): number {\n  return 1;\n}\n";
const idempotencyLabel = (id, shouldReport = true) => label(id, "idempoten|missing.{0,30}key|null.{0,30}key|validat.{0,30}key",
  [range("src/idem.ts", 1, 4)], shouldReport, ["correctness", "regression", "error-handling", "api-misuse"]);

function largeFile(version, position) {
  const rows = Array.from({ length: 1700 }, (_, i) =>
    `  item${String(i).padStart(4, "0")}: "${version}-${String(i).padStart(4, "0")}-${"x".repeat(42)}",`);
  const before = "export function charge(cents: number): number {\n  return cents;\n}\n";
  const after = "export function charge(cents: number): number {\n  return cents * 100;\n}\n";
  const fn = version === "a" ? before : after;
  const data = `export const labels = {\n${rows.join("\n")}\n};\n`;
  return position === "start" ? fn + data : data + fn;
}

export const SCENARIOS = [
  {
    name: "real-bug", description: "A changed counter violates its established contract.",
    build(repo) {
      change(repo, { "API.md": contract("next returns the integer immediately following c."), "src/counter.ts": counterBefore },
        { "src/counter.ts": counterAfter });
    },
    expect: [label("counter-double-increment", "increment|off.by.one|two|twice|\\+\\s*2", [range("src/counter.ts", 2, 3)])],
  },
  {
    name: "preexisting-bug-unchanged", description: "An old defect is outside the changed lines.",
    build(repo) {
      const old = counterAfter + "\nexport const caption = 'Counter';\n";
      change(repo, { "API.md": contract("next returns the integer immediately following c."), "src/counter.ts": old },
        { "src/counter.ts": old.replace("'Counter'", "'Next counter'") });
    },
    expect: [label("old-double-increment", "increment|off.by.one|two|twice", [range("src/counter.ts", 1, 4)], false)],
  },
  {
    name: "guarded-negative", description: "A dominating empty-input guard makes a new division safe.",
    build(repo) {
      change(repo, { "API.md": contract("mean returns zero for an empty list; otherwise its arithmetic mean."),
        "src/mean.ts": "export function mean(values: number[]): number {\n  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;\n}\n" },
        { "src/mean.ts": "export function mean(values: number[]): number {\n  if (values.length === 0) return 0;\n  const total = values.reduce((a, b) => a + b, 0);\n  return total / values.length;\n}\n" });
    },
    expect: [label("guarded-division", "zero|empty|NaN|divis", [range("src/mean.ts", 1, 5)], false)],
  },
  {
    name: "clean-rename-refactor", description: "An internal rename updates every caller without changing behavior.",
    build(repo) {
      change(repo, { "src/price.ts": "function double(n: number): number { return n * 2; }\nexport function price(n: number): number { return double(n); }\n" },
        { "src/price.ts": "function twice(value: number): number { return value + value; }\nexport function price(n: number): number { return twice(n); }\n" });
    },
    expect: [],
  },
  {
    name: "multi-file-contract", description: "A producer changes units while its consumer still expects milliseconds.",
    build(repo) {
      change(repo, { "API.md": contract("ttlMs reports milliseconds. deadline returns an epoch-millisecond deadline."),
        "src/config.ts": "export function ttlMs(): number {\n  return 30_000;\n}\n",
        "src/deadline.ts": "import { ttlMs } from './config';\nexport function deadline(nowMs: number): number {\n  return nowMs + ttlMs();\n}\n" },
        { "src/config.ts": "export function ttlMs(): number {\n  return 30;\n}\n",
          "src/deadline.ts": "import { ttlMs } from './config';\nexport function deadline(nowMs: number): number {\n  const ttl = ttlMs();\n  return nowMs + ttl;\n}\n" });
    },
    expect: [label("ttl-unit-contract", "millisecond|second|unit|expir|1000|1,000", [range("src/config.ts", 1, 3), range("src/deadline.ts", 2, 5)])],
  },
  ...["start", "end"].map((position) => ({
    name: `large-diff-${position}`, description: `A ${position}-located unit error competes with a large old/new replacement hunk.`,
    build(repo) {
      change(repo, { "API.md": contract("charge accepts cents and returns the same amount in cents. labels contains opaque display strings."),
        "src/catalog.ts": largeFile("a", position) }, { "src/catalog.ts": largeFile("b", position) });
    },
    expect: [label(`large-${position}-cents`, "cent|100|hundred|unit|overcharg|multipl",
      [range("src/catalog.ts", position === "start" ? 1 : 1703, position === "start" ? 3 : 1705)])],
  })),
  {
    name: "expected-behavior-suppressed", description: "A relevant prior decision still applies to the unchanged policy.",
    build(repo) {
      write(repo, { "API.md": contract("hit counts every attempt, including unsuccessful remote operations."),
        "src/quota.ts": "export function hit(quota: number): number {\n  return quota - 1;\n}\n" });
      repo.commit("initial implementation");
    },
    seedFinding: { claim: "quota is consumed for unsuccessful attempts", entityKey: "hit", path: "src/quota.ts",
      decision: "expected", note: "Quota intentionally counts all attempts, regardless of success." },
    rebuild(repo) { repo.write("src/quota.ts", "export function hit(quota: number): number {\n  const remaining = quota - 1;\n  return remaining;\n}\n"); repo.commit("update implementation"); },
    expect: [label("quota-expected-policy", "quota|attempt", [range("src/quota.ts", 1, 4)], false)],
  },
  {
    name: "fixed-regression", description: "A verified fix is removed in the reviewed change.",
    build(repo) { write(repo, { "API.md": contract("run rejects null or empty idempotency keys before returning."), "src/idem.ts": guarded }); repo.commit("initial implementation"); },
    seedResolution: { claim: "idempotency key not validated", entityKey: "run", path: "src/idem.ts", verified: true },
    rebuild(repo) { repo.write("src/idem.ts", unguarded); repo.commit("update implementation"); },
    expect: [idempotencyLabel("returned-idempotency-regression")],
  },
  {
    name: "fixed-regression-still-fixed", description: "A refactor preserves the historical fix.",
    build(repo) { write(repo, { "API.md": contract("run rejects null or empty idempotency keys before returning."), "src/idem.ts": guarded }); repo.commit("initial implementation"); },
    seedResolution: { claim: "idempotency key not validated", entityKey: "run", path: "src/idem.ts", verified: true },
    rebuild(repo) { repo.write("src/idem.ts", guarded.replace("!key", "key === null || key.length === 0")); repo.commit("update implementation"); },
    expect: [idempotencyLabel("preserved-idempotency-fix", false)],
  },
  {
    name: "renamed-symbol-memory-survives", description: "Feature memory remains relevant after a symbol rename.",
    build(repo) { repo.write("src/retry.ts", guarded.replace("run(", "oldRetry(")); repo.commit("initial implementation"); },
    seedMemory: { scope: "feature", target: "retry-flow", kind: "invariant", paths: ["src/retry.ts"],
      text: "Every retry rejects null or empty idempotency keys before execution." },
    rebuild(repo) { repo.write("src/retry.ts", unguarded.replace("run(", "executeRetry(")); repo.commit("update implementation"); },
    expect: [label("renamed-retry-validation", "idempoten|key|validat", [range("src/retry.ts", 1, 3)], true, ["correctness", "regression", "error-handling", "api-misuse"])],
  },
  {
    name: "outdated-decision-scope", description: "An internal-tool exception does not authorize a newly added customer call site.",
    build(repo) {
      write(repo, { "API.md": contract("Internal diagnostics may lock after four failures. Customer accounts lock only at ten or more failures."),
        "src/lock.ts": "export function failed(n: number): boolean {\n  return n > 3;\n}\n" }); repo.commit("initial implementation");
    },
    seedFinding: { claim: "failed count threshold is too strict", entityKey: "failed", path: "src/lock.ts",
      decision: "wont-fix", note: "The four-failure threshold is accepted only for internal diagnostics, not customer accounts." },
    rebuild(repo) { repo.write("src/account.ts", "import { failed } from './lock';\nexport function lockAccount(failures: number): boolean {\n  return failed(failures);\n}\n"); repo.commit("add account policy"); },
    expect: [label("customer-lockout-scope", "threshold|lock|account|failur", [range("src/account.ts", 1, 4)], true, ["correctness", "regression", "security"])],
  },
  {
    name: "two-independent-bugs", description: "Two independent reports are needed; one vague finding cannot satisfy both labels.",
    build(repo) {
      change(repo, { "API.md": contract("next advances by one. run rejects missing idempotency keys."), "src/counter.ts": counterBefore, "src/idem.ts": guarded },
        { "src/counter.ts": counterAfter, "src/idem.ts": unguarded });
    },
    expect: [label("two-bugs-counter", "increment|off.by.one|two|twice", [range("src/counter.ts", 2, 3)]), idempotencyLabel("two-bugs-idempotency")],
  },
].map((scenario) => ({ findArgs: ["--base", "HEAD^", "--head", "HEAD"], ...scenario }));
