#!/usr/bin/env node
/**
 * AACR-Bench M0 — materialization (roadmap T2).
 *
 * Turns sampled dataset comments into intermediate JSONL rows: the per-comment
 * diff (merge-base..capture-time-head, narrowed to the comment's path) and the
 * head file content, both read from a shared clone cache OUTSIDE the worktree
 * (default ~/.cache/pir-aacr, or $PIR_AACR_CACHE).
 *
 * R1 mitigation: every repository is `git init`ed and fetched with
 * `--depth 1 origin <sha>` — no merge-base history and no full clone. The
 * dataset's pr_source_commit/pr_target_commit are a capture-time base/head
 * pair (base-branch drift can be hundreds of commits), so the diff base is the
 * merge base GitHub reports for that pair, fetched at depth 1 as well; a naive
 * two-SHA diff would fold the drift in reverse.
 *
 * R6 mitigation: every failure (unreachable repo, dead sha, missing path)
 * becomes an error row in the JSONL — a materialization run never aborts, and
 * a partial corpus can never masquerade as a complete one.
 *
 * Opt-in eval surface: without PIR_EVAL=1 this exits 0 with a skip notice, no
 * network and no git.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { citationNotice, loadMeta, validateRecords, DEFAULT_META, DEFAULT_DATASET } from "./fetch-dataset.js";
import { commentId, sampleDigest, sampleRecords } from "./sample.js";

const HERE = fileURLToPath(new URL("./", import.meta.url));
export const DEFAULT_CACHE = process.env.PIR_AACR_CACHE ?? path.join(homedir(), ".cache", "pir-aacr");
export const DEFAULT_OUT = path.join(HERE, "dataset", "materialized.jsonl");
export const MAX_DIFF_BYTES = 512 * 1024;
export const MAX_HEAD_FILE_BYTES = 1024 * 1024;
export const DEFAULT_GIT_TIMEOUT_MS = 600_000;
export const DEFAULT_API_TIMEOUT_MS = 30_000;

export const gitEnv = (env = process.env, extra = {}) => ({
  ...env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_LFS_SKIP_SMUDGE: "1",
  GIT_TERMINAL_PROMPT: "0",
  ...extra,
});

export function git(cwd, args, { env = process.env, timeoutMs } = {}) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: gitEnv(env),
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
  });
}

export function initRepo(repoDir, remote) {
  mkdirSync(repoDir, { recursive: true });
  git(repoDir, ["init", "-q", "-b", "main"]);
  git(repoDir, ["remote", "add", "origin", remote]);
  return repoDir;
}

/** owner/name and PR number straight from the dataset's pr_url. */
export function parsePrUrl(prUrl) {
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)$/.exec(String(prUrl ?? ""));
  if (!match) throw new Error(`unrecognized pr_url: ${prUrl}`);
  return { nwo: match[1], prNumber: Number(match[2]) };
}

const repoDirName = (nwo) => nwo.replace("/", "_");

/** Shared per-repo cache: init once, remote idempotent, never inside the worktree. */
export function ensureRepoCache(cacheRoot, nwo, { remote } = {}) {
  const repoDir = path.join(cacheRoot, "repos", repoDirName(nwo));
  const url = remote ?? `https://github.com/${nwo}.git`;
  if (!existsSync(path.join(repoDir, ".git"))) {
    if (existsSync(repoDir)) throw new Error(`cache path exists and is not a git repo: ${repoDir}`);
    initRepo(repoDir, url);
  } else {
    try {
      git(repoDir, ["remote", "set-url", "origin", url]);
    } catch {
      git(repoDir, ["remote", "add", "origin", url]);
    }
  }
  return repoDir;
}

export function hasCommit(repoDir, sha) {
  try {
    git(repoDir, ["cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/** Depth-1 fetch of exactly one commit; the object's tree comes with it. */
export function ensureFetched(repoDir, sha, { timeoutMs } = {}) {
  if (hasCommit(repoDir, sha)) return { fetched: false };
  git(repoDir, ["fetch", "--depth", "1", "--no-tags", "origin", sha], { timeoutMs });
  if (!hasCommit(repoDir, sha)) throw new Error(`fetched but still missing: ${sha}`);
  return { fetched: true };
}

/** Pure parse of `gh api .../compare/A...B --jq .merge_base_commit.sha`. */
export function parseMergeBase(stdout) {
  const sha = String(stdout ?? "").trim();
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

/**
 * GitHub's merge base for the dataset's capture-time pair. `gh` first (the
 * authenticated CLI the rest of the eval tooling already assumes), then an
 * unauthenticated REST call with an optional GITHUB_TOKEN. Returns null when
 * neither works — the caller degrades to the base-tip diff and records it.
 */
export async function resolveMergeBase(nwo, base, head, { env = process.env, timeoutMs = DEFAULT_API_TIMEOUT_MS, exec = execFileSync, fetchImpl = fetch } = {}) {
  try {
    const out = exec("gh", ["api", `repos/${nwo}/compare/${base}...${head}`, "--jq", ".merge_base_commit.sha"], { encoding: "utf8", env, timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"] });
    const sha = parseMergeBase(out);
    if (sha) return { sha, via: "gh" };
  } catch { /* fall through to REST */ }
  try {
    const token = env.GITHUB_TOKEN ?? env.GH_TOKEN;
    const response = await fetchImpl(`https://api.github.com/repos/${nwo}/compare/${base}...${head}`, {
      headers: { accept: "application/vnd.github+json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { sha: null, via: null, error: `HTTP ${response.status}` };
    const sha = parseMergeBase((await response.json())?.merge_base_commit?.sha);
    return sha ? { sha, via: "rest" } : { sha: null, via: null, error: "no merge_base_commit in compare response" };
  } catch (error) {
    return { sha: null, via: null, error: String(error?.message ?? error) };
  }
}

function truncate(text, maxBytes) {
  if (Buffer.byteLength(text) <= maxBytes) return { text, truncated: false };
  return { text: Buffer.from(text).subarray(0, maxBytes).toString("utf8"), truncated: true };
}

/** Changed paths (both sides of renames) of the PR diff, with a count. */
export function changedPaths(repoDir, diffBase, head) {
  const out = git(repoDir, ["diff", "--name-status", "-M", "--diff-filter=ACMRTD", diffBase, head]);
  const paths = new Set();
  for (const line of out.split("\n")) {
    const fields = line.split("\t").filter(Boolean);
    for (const field of fields.slice(1)) paths.add(field);
  }
  return paths;
}

/** The comment's file patch, exactly the hunks GitHub rendered for the PR. */
export function pathDiff(repoDir, diffBase, head, filePath, { maxBytes = MAX_DIFF_BYTES } = {}) {
  const raw = git(repoDir, ["-c", "core.quotepath=false", "diff", "-U3", "-M", diffBase, head, "--", filePath]);
  return truncate(raw, maxBytes);
}

export function headFile(repoDir, head, filePath, { maxBytes = MAX_HEAD_FILE_BYTES } = {}) {
  try {
    const raw = git(repoDir, ["show", `${head}:${filePath}`]);
    return { ...truncate(raw, maxBytes), missing: false };
  } catch {
    return { text: null, truncated: false, missing: true };
  }
}

/**
 * One comment's material row. `repoDir` must already contain `head` and
 * `diffBase`; everything below is pure git reads plus shape assembly, which
 * is what makes the fixture tests possible without touching GitHub.
 */
export function materializeComment({ sampled, repoDir, head, diffBase, diffBaseKind, cacheRoot, gitOptions = {} }) {
  const record = sampled.record;
  const { nwo, prNumber } = parsePrUrl(record.pr_url);
  const paths = changedPaths(repoDir, diffBase, head);
  const inDiff = paths.has(record.path);
  const diff = pathDiff(repoDir, diffBase, head, record.path, gitOptions);
  const file = headFile(repoDir, head, record.path, gitOptions);
  return {
    schemaVersion: 1,
    id: sampled.id,
    index: sampled.index,
    comment: {
      pr_url: record.pr_url, nwo, pr_number: prNumber,
      pr_source_commit: record.pr_source_commit, pr_target_commit: record.pr_target_commit,
      path: record.path, side: record.side, from_line: record.from_line, to_line: record.to_line,
      note: record.note, category: record.category, context: record.context,
      pr_category: record.pr_category ?? null, project_main_language: record.project_main_language ?? null,
      pr_change_line_count: record.pr_change_line_count ?? null,
      is_ai_comment: Boolean(record.is_ai_comment), source_model: record.source_model || null, label: record.label,
    },
    material: {
      head, diffBase, diffBaseKind,
      changedFiles: paths.size, pathInDiff: inDiff,
      diff: diff.text, diffBytes: Buffer.byteLength(diff.text), diffTruncated: diff.truncated,
      headFile: file.text, headFileBytes: file.text === null ? 0 : Buffer.byteLength(file.text),
      headFileTruncated: file.truncated, headFileMissing: file.missing,
      cache: path.relative(cacheRoot, repoDir),
    },
  };
}

export function errorRow(sampled, stage, error, extra = {}) {
  const record = sampled.record ?? {};
  return {
    schemaVersion: 1,
    id: sampled.id,
    index: sampled.index,
    comment: { pr_url: record.pr_url ?? null, path: record.path ?? null, label: record.label ?? null },
    error: { stage, message: String(error?.message ?? error).slice(0, 2000) },
    ...extra,
  };
}

export function directoryBytes(dir) {
  try {
    const out = execFileSync("du", ["-sk", dir], { encoding: "utf8" });
    const kb = Number(String(out).trim().split(/\s+/)[0]);
    if (Number.isSafeInteger(kb)) return kb * 1024;
  } catch { /* du unavailable: fall through to the walk */ }
  let total = 0;
  const walk = (current) => {
    let entries;
    try { entries = readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) { try { total += statSync(full).size; } catch { /* raced away */ } }
    }
  };
  walk(dir);
  return total;
}

export function parseOptions(argv = [], env = process.env) {
  const values = {
    dataset: env.PIR_AACR_DATASET ?? DEFAULT_DATASET,
    meta: env.PIR_AACR_META ?? DEFAULT_META,
    out: env.PIR_AACR_MATERIALIZED ?? DEFAULT_OUT,
    cache: env.PIR_AACR_CACHE ?? DEFAULT_CACHE,
    limit: env.PIR_AACR_LIMIT === undefined ? undefined : Number(env.PIR_AACR_LIMIT),
    seed: Number(env.PIR_AACR_SEED ?? 42),
    only: [],
    resume: true,
    force: false,
    json: env.PIR_EVAL_JSON === "1",
    help: false,
    timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
  };
  const flags = { "--dataset": "dataset", "--meta": "meta", "--out": "out", "--cache": "cache", "--limit": "limit", "--seed": "seed", "--timeout": "timeoutMs" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--resume") { values.resume = true; continue; }
    if (argv[i] === "--no-resume") { values.resume = false; continue; }
    if (argv[i] === "--force") { values.force = true; continue; }
    if (argv[i] === "--json") { values.json = true; continue; }
    if (argv[i] === "--help") { values.help = true; continue; }
    if (argv[i] === "--only") {
      if (!argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error(`invalid option or missing value: ${argv[i]}`);
      values.only.push(argv[++i]);
      continue;
    }
    const key = flags[argv[i]];
    if (!key || !argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error(`invalid option or missing value: ${argv[i]}`);
    values[key] = argv[++i];
  }
  for (const key of ["dataset", "meta", "out", "cache"]) values[key] = path.resolve(values[key]);
  for (const key of ["limit", "seed", "timeoutMs"]) if (typeof values[key] === "string") values[key] = Number(values[key]);
  if (values.limit !== undefined && (!Number.isSafeInteger(values.limit) || values.limit < 1)) throw new Error("limit must be a positive integer");
  if (!Number.isSafeInteger(values.seed) || values.seed < 0) throw new Error("seed must be a non-negative integer");
  return values;
}

export { commentId, sampleRecords, sampleDigest };

export function readMaterialized(file) {
  if (!existsSync(file)) return { header: null, rows: [] };
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  const parsed = lines.map((line) => JSON.parse(line));
  return { header: parsed[0]?.__meta__ ? parsed[0] : null, rows: parsed.filter((row) => !row.__meta__) };
}

export function writeMaterialized(file, header, rows) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, [JSON.stringify(header), ...rows.map((row) => JSON.stringify(row))].join("\n") + "\n");
}

export function headerRow(meta, actualSha256, { seed, limit, sampleDigest: digest, ids }) {
  return {
    __meta__: "aacr-bench/m0-materialized/v1",
    dataset: { id: meta.dataset.id, url: meta.dataset.url, revision: meta.dataset.hfRevision, sha256: actualSha256, records: meta.dataset.records },
    citation: citationNotice(meta),
    sample: { seed, limit: limit ?? null, eligible: ids.length, digest },
    materialization: meta.materialization,
    createdAt: new Date().toISOString(),
  };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseOptions(argv, env);
  if (options.help) {
    console.log("PIR_EVAL=1 node tests/eval/aacr/materialize.js [--dataset dataset/dataset.json] [--out dataset/materialized.jsonl] [--cache ~/.cache/pir-aacr] [--limit N] [--seed 42] [--only <comment-id>]... [--no-resume] [--force] [--json]\n" +
      "Fetches (depth 1) the capture-time head and GitHub-reported merge base of each sampled comment's PR, extracts the per-comment diff and head file content, and writes one JSONL row per comment (error rows on any failure).");
    return 0;
  }
  if (env.PIR_EVAL !== "1") {
    console.log(options.json ? JSON.stringify({ skipped: true, reason: "PIR_EVAL=1 required" }) : "skipped: set PIR_EVAL=1 to allow model evaluation");
    return 0;
  }
  if (!existsSync(options.dataset)) throw new Error(`dataset not found: ${options.dataset} (run fetch-dataset.js first)`);
  const meta = loadMeta(options.meta);
  const datasetBytes = readFileSync(options.dataset);
  const actualSha256 = createHash("sha256").update(datasetBytes).digest("hex");
  if (actualSha256 !== meta.dataset.sha256) throw new Error(`dataset sha256 mismatch: expected ${meta.dataset.sha256}, got ${actualSha256}`);
  const records = validateRecords(JSON.parse(datasetBytes.toString("utf8")));
  let sampled = sampleRecords(records, { limit: options.limit, seed: options.seed });
  if (options.only.length > 0) {
    const wanted = new Set(options.only);
    const known = new Set(sampled.map((s) => s.id));
    for (const id of wanted) if (!known.has(id)) throw new Error(`--only id is outside the sampled set: ${id}`);
    sampled = sampled.filter((s) => wanted.has(s.id));
  }
  const previous = options.resume && !options.force ? readMaterialized(options.out) : { header: null, rows: [] };
  const previousById = new Map(previous.rows.map((row) => [row.id, row]));
  const mergeBaseCache = path.join(options.cache, "merge-bases.json");
  const cache = existsSync(mergeBaseCache) ? JSON.parse(readFileSync(mergeBaseCache, "utf8")) : {};
  const rows = [];
  const stats = { total: sampled.length, fetched: 0, reused: 0, errors: 0, repos: new Set(), mergeBaseFailures: 0 };
  const digest0 = sampleDigest(sampled);
  const header0 = headerRow(meta, actualSha256, { seed: options.seed, limit: options.limit ?? null, sampleDigest: digest0, ids: sampled.map((s) => s.id) });
  // Flush after every row: a multi-hour materialization that is interrupted
  // keeps everything already fetched, and --resume picks up where it stopped.
  const flush = () => writeMaterialized(options.out, header0, rows);
  for (const [position, entry] of sampled.entries()) {
    const label = `[${position + 1}/${sampled.length}] ${entry.id}`;
    const reused = previousById.get(entry.id);
    if (reused && !reused.error) {
      stats.reused += 1;
      if (reused.material?.cache) stats.repos.add(reused.material.cache);
      rows.push(reused);
      continue;
    }
    let repoDir = null;
    let stage = "cache";
    try {
      const { nwo, prNumber } = parsePrUrl(entry.record.pr_url);
      const head = entry.record.pr_target_commit;
      const base = entry.record.pr_source_commit;
      if (!/^[0-9a-f]{40}$/.test(head) || !/^[0-9a-f]{40}$/.test(base)) throw new Error(`invalid commit sha pair: ${base}..${head}`);
      repoDir = ensureRepoCache(options.cache, nwo);
      stats.repos.add(repoDirName(nwo));
      stage = "fetch-head";
      if (ensureFetched(repoDir, head, { timeoutMs: options.timeoutMs }).fetched) stats.fetched += 1;
      const key = `${nwo}|${base}|${head}`;
      stage = "merge-base";
      let diffBase = cache[key] ?? undefined;
      let diffBaseKind = cache[`${key}|kind`];
      if (diffBase === undefined) {
        const resolved = await resolveMergeBase(nwo, base, head, { env });
        diffBase = resolved.sha ?? base;
        diffBaseKind = resolved.sha ? "merge-base" : "base-tip";
        if (!resolved.sha) { stats.mergeBaseFailures += 1; console.error(`${label} WARN merge base unavailable (${resolved.error ?? "unknown"}); using base tip${base}`); }
        cache[key] = diffBase;
        cache[`${key}|kind`] = diffBaseKind;
        mkdirSync(options.cache, { recursive: true });
        writeFileSync(mergeBaseCache, JSON.stringify(cache, null, 2) + "\n");
      }
      stage = "fetch-diff-base";
      ensureFetched(repoDir, diffBase, { timeoutMs: options.timeoutMs });
      stage = "diff";
      const row = materializeComment({ sampled: entry, repoDir, head, diffBase, diffBaseKind: diffBaseKind ?? "merge-base", cacheRoot: options.cache, gitOptions: { maxBytes: MAX_DIFF_BYTES } });
      rows.push(row);
      flush();
      console.error(`${label} ${nwo}#${prNumber} ${entry.record.path} diff=${row.material.diffBytes}B inDiff=${row.material.pathInDiff} headFile=${row.material.headFileBytes}B${row.material.headFileMissing ? " MISSING" : ""}`);
    } catch (error) {
      stats.errors += 1;
      rows.push(errorRow(entry, stage, error, { repoDir: repoDir ? path.relative(options.cache, repoDir) : null }));
      flush();
      console.error(`${label} ERROR ${stage}: ${error?.message ?? error}`);
    }
  }
  const digest = digest0;
  const header = header0;
  writeMaterialized(options.out, header, rows);
  const cacheBytes = directoryBytes(options.cache);
  const summary = {
    out: options.out, cache: options.cache, sample: { seed: options.seed, limit: options.limit ?? null, digest, size: sampled.length },
    rows: rows.length, errorRows: stats.errors, reused: stats.reused, fetchedCommits: stats.fetched, mergeBaseFailures: stats.mergeBaseFailures,
    repos: stats.repos.size, cacheBytes,
  };
  console.log(options.json ? JSON.stringify(summary) : JSON.stringify(summary, null, 2));
  return stats.errors > 0 ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((error) => { console.error(error); process.exitCode = 3; });
}
