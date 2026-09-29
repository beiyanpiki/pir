#!/usr/bin/env node
/** Opt-in model evaluation. Importing this module never starts a review. */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SCENARIOS } from "./scenarios.js";
import { extractOutcomeMetrics, scoreFindings, summarizeRuns, validateExpectations, USAGE_FIELDS } from "./scoring.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const fixedGitEnv = () => ({ ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_DATE: "2024-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2024-01-01T00:00:00Z",
  GIT_AUTHOR_NAME: "Fixture", GIT_COMMITTER_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@pir.local", GIT_COMMITTER_EMAIL: "fixture@pir.local" });
const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: fixedGitEnv(), maxBuffer: 16 * 1024 * 1024 });

export function parseOptions(argv = [], env = process.env) {
  const values = { repeats: env.PIR_EVAL_REPEATS ?? "1", baselineCli: env.PIR_EVAL_BASELINE_CLI,
    candidateCli: env.PIR_EVAL_CANDIDATE_CLI ?? path.join(ROOT, "dist/cli/cli.js"),
    model: env.PIR_MODEL, maxRounds: env.PIR_EVAL_MAX_ROUNDS ?? "2", maxTokens: env.PIR_EVAL_MAX_TOKENS ?? "400000",
    maxFindings: env.PIR_EVAL_MAX_FINDINGS ?? "10", timeoutMs: env.PIR_EVAL_TIMEOUT_MS ?? "900000",
    output: env.PIR_EVAL_OUTPUT, json: env.PIR_EVAL_JSON === "1" };
  const flags = { "--repeats": "repeats", "--baseline-cli": "baselineCli", "--candidate-cli": "candidateCli",
    "--model": "model", "--max-rounds": "maxRounds", "--max-tokens": "maxTokens", "--max-findings": "maxFindings",
    "--timeout-ms": "timeoutMs", "--output": "output" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--json") { values.json = true; continue; }
    if (argv[i] === "--help") { values.help = true; continue; }
    const key = flags[argv[i]];
    if (!key || !argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error(`invalid option or missing value: ${argv[i]}`);
    values[key] = argv[++i];
  }
  for (const key of ["repeats", "maxRounds", "maxTokens", "maxFindings", "timeoutMs"]) {
    if (!/^\d+$/.test(String(values[key])) || !Number.isSafeInteger(Number(values[key])) || Number(values[key]) < 1) {
      throw new Error(`${key} must be a positive integer`);
    }
    values[key] = Number(values[key]);
  }
  for (const key of ["baselineCli", "candidateCli", "output"]) if (values[key]) values[key] = path.resolve(values[key]);
  return values;
}

export function createFixture(dir) {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  const repo = { dir,
    write(file, text) { const target = path.join(dir, file); mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, text); },
    commit(message = "update implementation") {
      git(dir, ["add", "-A"]); git(dir, ["commit", "-q", "--allow-empty", "-m", message]);
      return git(dir, ["rev-parse", "HEAD"]).trim();
    },
  };
  repo.commit("initial repository");
  return repo;
}

// Copy, never hardlink or git-worktree: repo objects, SQLite, auth/config and
// state all belong to this one run. No previous repeat's mutations are reused.
export function cloneSnapshot(snapshot, destination) {
  if (existsSync(destination)) throw new Error(`run destination already exists: ${destination}`);
  cpSync(snapshot, destination, { recursive: true, dereference: true });
  return { repo: path.join(destination, "repo"), db: path.join(destination, "state/memory.sqlite") };
}

async function seedMemory(repo, dbPath, scenario, seedCli) {
  const dist = path.resolve(path.dirname(seedCli), "..");
  const load = (file) => import(pathToFileURL(path.join(dist, file)).href);
  const { Memory } = await load("memory/index.js");
  const memory = await Memory.open(repo.dir, { dbPath });
  const commit = git(repo.dir, ["rev-parse", "HEAD"]).trim();
  const seedEntity = (symbolKey, file, featureKeys = []) => memory.entities.upsert({
    symbolKey, qualifiedName: symbolKey, kind: "function", path: file, signature: null,
    responsibilities: [], invariants: [], notes: [], featureKeys, source: "user_explicit",
    signatureHash: null, bodyHash: null, lastSeenCommit: commit, stale: false,
  });
  try {
    const seed = scenario.seedFinding ?? scenario.seedResolution;
    if (seed) {
      seedEntity(seed.entityKey, seed.path);
      const { buildIdentity } = await load("findings/identity.js");
      const trigger = "the documented input is supplied";
      const identity = buildIdentity({ entityKey: seed.entityKey, category: "correctness", claim: seed.claim, trigger });
      const run = memory.findings.createRun({ base: commit, head: commit });
      const row = memory.findings.insert({ title: seed.claim, claim: seed.claim, trigger, category: "correctness",
        severity: "P2", entityKey: seed.entityKey, anchors: [{ path: seed.path, startLine: 1, endLine: 3 }],
        evidence: [], round: 1, identity, status: "confirmed", memoryMatches: [] }, run.id);
      if (scenario.seedFinding) {
        const { applyFeedback } = await load("memory/feedback.js");
        await applyFeedback(memory, { findingId: row.displayId, decision: seed.decision, note: seed.note, commit });
      } else {
        memory.findings.updateStatus(row.id, "fixed");
        memory.resolutions.insert({ findingId: row.id, fingerprint: identity.fingerprint, featureKey: null,
          entityKey: seed.entityKey, category: "correctness", originalClaim: seed.claim, originalTrigger: trigger,
          resolution: "fixed", explanation: "The input validation guard is present.", beforeCommit: null, afterCommit: commit,
          beforeCodeHash: null, afterCodeHash: null, fixCommit: commit, fixDiffHash: null, verified: seed.verified === true });
      }
      memory.findings.finishRun(run.id, { rounds: 1, candidates: 1, confirmed: 1, rejected: 0, uncertain: 0 });
    }
    if (scenario.seedMemory) {
      const { rememberKnowledge } = await load("memory/remember.js");
      const { paths, ...knowledge } = scenario.seedMemory;
      rememberKnowledge(memory, { ...knowledge, commit });
      if (knowledge.scope === "feature" && paths) {
        const feature = memory.features.get(knowledge.target);
        memory.features.upsert({ ...feature, entryPoints: paths });
        for (const file of paths) seedEntity(`${file}#oldRetry`, file, [knowledge.target]);
      }
    }
  } finally { memory.close(); }
}

function snapshotConfig(root, env) {
  const agentDir = path.resolve(env.PIR_EVAL_AGENT_DIR ?? env.PI_CODING_AGENT_DIR ?? path.join(homedir(), ".pi/agent"));
  const configDir = path.resolve(env.PIR_CONFIG_DIR ?? path.join(homedir(), ".pir"));
  const publicHashes = {};
  for (const [directory, source, names] of [["agent", agentDir, ["settings.json", "models.json", "models-store.json", "auth.json"]],
    ["config", configDir, ["config.json"]]]) {
    mkdirSync(path.join(root, directory), { recursive: true });
    for (const name of names) if (existsSync(path.join(source, name))) {
      copyFileSync(path.join(source, name), path.join(root, directory, name));
      // Never serialize credentials or their hashes into an evaluation report.
      if (name !== "auth.json" && name !== "config.json") publicHashes[`${directory}/${name}`] = sha256(readFileSync(path.join(root, directory, name)));
    }
  }
  const json = (relative) => existsSync(path.join(root, relative)) ? JSON.parse(readFileSync(path.join(root, relative), "utf8")) : {};
  const settings = json("agent/settings.json");
  const config = json("config/config.json");
  const model = config.model || (settings.defaultModel ? `${settings.defaultProvider ? settings.defaultProvider + "/" : ""}${settings.defaultModel}` : undefined);
  return { model, thinking: settings.defaultThinkingLevel ?? null, hashes: publicHashes };
}

export function runCli(cli, runDir, options, snapshot, env = process.env) {
  const repo = path.join(runDir, "repo");
  const args = ["find", "--base", snapshot.base, "--head", snapshot.head, "--model", options.model,
    "--max-rounds", String(options.maxRounds), "--max-tokens", String(options.maxTokens),
    "--max-findings", String(options.maxFindings), "--json", "--quiet", "--local", "--cwd", repo];
  mkdirSync(path.join(runDir, "home"), { recursive: true });
  const start = performance.now();
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: repo, encoding: "utf8",
    timeout: options.timeoutMs, maxBuffer: 16 * 1024 * 1024,
    env: { ...env, ...fixedGitEnv(), HOME: path.join(runDir, "home"),
      XDG_STATE_HOME: path.join(runDir, "state"), XDG_CACHE_HOME: path.join(runDir, "cache"),
      XDG_CONFIG_HOME: path.join(runDir, "xdg-config"), PIR_STATE_ROOT: path.join(runDir, "state"),
      PIR_MEMORY_DB: path.join(runDir, "state/memory.sqlite"), PIR_CONFIG_DIR: path.join(runDir, "config"),
      PI_CODING_AGENT_DIR: path.join(runDir, "agent"), PIR_NO_WIZARD: "1", PIR_TRANSCRIPTS: "0", PIR_MODE: "local", PIR_MODEL: options.model } });
  const wallTimeMs = performance.now() - start;
  let envelope;
  try {
    if (result.error) throw result.error;
    if (result.status !== 0 && result.status !== 1) throw new Error(`CLI exited ${result.status}, signal ${result.signal ?? "none"}`);
    envelope = JSON.parse(result.stdout);
    if (!envelope?.data || !Array.isArray(envelope.data.findings)) throw new Error("CLI returned no data.findings array");
    const data = envelope.data;
    const score = scoreFindings(data.findings, snapshot.expectations);
    const measurements = extractOutcomeMetrics(data, wallTimeMs);
    const incomplete = measurements.incomplete === true || (measurements.pendingCandidates ?? 0) > 0 || (measurements.verificationErrors ?? 0) > 0 ||
      data.findings.some((f) => f.status === "candidate") || (data.pendingFindings?.length ?? 0) > 0;
    return { pass: score.pass && !incomplete, score, measurements, findings: data.findings,
      pendingFindings: data.pendingFindings ?? null, uncertaintyReasons: data.uncertaintyReasons ?? null,
      stoppedBecause: data.stoppedBecause ?? null, outcome: data, exitCode: result.status, stderr: result.stderr };
  } catch (error) {
    return { pass: false, score: null, error: String(error.message ?? error), exitCode: result.status,
      measurements: extractOutcomeMetrics(envelope?.data ?? {}, wallTimeMs),
      stdout: result.stdout, stderr: result.stderr, outcome: envelope?.data ?? null };
  }
}

function comparePairs(runs) {
  const baseline = runs.filter((r) => r.variant === "baseline");
  return baseline.map((before) => {
    const after = runs.find((r) => r.variant === "candidate" && r.scenario === before.scenario && r.repeat === before.repeat);
    const delta = (a, b) => typeof a === "number" && typeof b === "number" ? b - a : null;
    return { scenario: before.scenario, repeat: before.repeat, baselinePass: before.pass, candidatePass: after.pass,
      countsDelta: Object.fromEntries(["truePositives", "falsePositives", "falseNegatives", "uncertain"].map((k) =>
        [k, delta(before.score?.counts[k], after.score?.counts[k])])),
      wallTimeMsDelta: delta(before.measurements?.wallTimeMs, after.measurements?.wallTimeMs),
      usageDelta: Object.fromEntries(USAGE_FIELDS.map((k) => [k,
        before.measurements?.usageComplete === true && after.measurements?.usageComplete === true
          ? delta(before.measurements.usage?.[k], after.measurements.usage?.[k]) : null])) };
  });
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseOptions(argv, env);
  if (options.help) {
    console.log("PIR_EVAL=1 node tests/eval/run-eval.js [--repeats N] [--baseline-cli dist/cli/cli.js] [--candidate-cli dist/cli/cli.js] [--model provider/model] [--max-rounds N] [--max-tokens N] [--max-findings N] [--timeout-ms N] [--json] [--output new-report.json]\nSee tests/eval/README.md for isolation and metric semantics.");
    return 0;
  }
  if (env.PIR_EVAL !== "1") {
    console.log(options.json ? JSON.stringify({ skipped: true, reason: "PIR_EVAL=1 required" }) : "skipped: set PIR_EVAL=1 to allow model evaluation");
    return 0;
  }
  const variants = [options.baselineCli && { name: "baseline", cli: options.baselineCli }, { name: "candidate", cli: options.candidateCli }].filter(Boolean);
  for (const variant of variants) {
    if (!statSync(variant.cli).isFile()) throw new Error(`CLI is not a file: ${variant.cli}`);
    variant.sha256 = sha256(readFileSync(variant.cli));
  }
  if (options.output && existsSync(options.output)) throw new Error(`refusing to overwrite artifact: ${options.output}`);
  for (const scenario of SCENARIOS) validateExpectations(scenario.expect);
  const root = mkdtempSync(path.join(tmpdir(), "pir-eval-"));
  const runs = [], fixtures = [];
  const startedAt = new Date().toISOString();
  let config;
  try {
    const configRoot = path.join(root, "configuration");
    config = snapshotConfig(configRoot, env);
    options.model ??= config.model;
    if (!options.model) throw new Error("set --model or PIR_MODEL, or configure a default pi model");
    for (const [index, scenario] of SCENARIOS.entries()) {
      const snapshotRoot = path.join(root, `snapshot-${index + 1}`);
      const repo = createFixture(path.join(snapshotRoot, "repo"));
      scenario.build(repo);
      mkdirSync(path.join(snapshotRoot, "state"), { recursive: true });
      await seedMemory(repo, path.join(snapshotRoot, "state/memory.sqlite"), scenario, variants[0].cli);
      scenario.rebuild?.(repo);
      for (const dir of ["agent", "config"]) cpSync(path.join(configRoot, dir), path.join(snapshotRoot, dir), { recursive: true });
      const snapshot = { scenario: scenario.name, description: scenario.description, expectations: scenario.expect,
        base: git(repo.dir, ["rev-parse", "HEAD^"]).trim(), head: git(repo.dir, ["rev-parse", "HEAD"]).trim(),
        tree: git(repo.dir, ["rev-parse", "HEAD^{tree}"]).trim(),
        diffSha256: sha256(git(repo.dir, ["diff", "HEAD^", "HEAD"])),
        seedDbSha256: sha256(readFileSync(path.join(snapshotRoot, "state/memory.sqlite"))) };
      fixtures.push(snapshot);
      for (let repeat = 1; repeat <= options.repeats; repeat++) {
        const order = (repeat + index) % 2 === 0 ? [...variants].reverse() : variants;
        for (const [orderIndex, variant] of order.entries()) {
          const runDir = path.join(root, `run-${index + 1}-${repeat}-${orderIndex}`);
          cloneSnapshot(snapshotRoot, runDir);
          try {
            const result = runCli(variant.cli, runDir, options, snapshot, env);
            runs.push({ scenario: scenario.name, repeat, variant: variant.name, order: orderIndex + 1,
              base: snapshot.base, head: snapshot.head, seedDbSha256: snapshot.seedDbSha256, ...result });
            console.error(`${result.pass ? "PASS" : "FAIL"} ${variant.name} ${scenario.name} repeat ${repeat}${result.error ? `: ${result.error}` : ""}`);
          } finally { rmSync(runDir, { recursive: true, force: true }); }
        }
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
  const report = { schemaVersion: 1, startedAt, finishedAt: new Date().toISOString(), node: process.version,
    model: options.model, config, limits: { maxRounds: options.maxRounds, maxTokens: options.maxTokens, maxFindings: options.maxFindings, timeoutMs: options.timeoutMs },
    repeats: options.repeats, variants, seedCli: variants[0].cli, fixtures, runs,
    summaries: Object.fromEntries(variants.map((v) => [v.name, summarizeRuns(runs.filter((r) => r.variant === v.name))])),
    pairs: comparePairs(runs) };
  const json = JSON.stringify(report, null, 2);
  if (options.output) writeFileSync(options.output, `${json}\n`, { flag: "wx", mode: 0o600 });
  console.log(options.json ? json : JSON.stringify({ summaries: report.summaries, pairs: report.pairs, artifact: options.output ?? null }, null, 2));
  return runs.every((r) => r.pass) ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((error) => { console.error(error); process.exitCode = 3; });
}
