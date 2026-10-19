#!/usr/bin/env node
/**
 * AACR-Bench M1 — fixture builder (roadmap T1).
 *
 * Downloads (or accepts `--from <file>`) the pinned upstream
 * `dataset/positive_samples.json`, verifies the sha256 pin in meta.json's
 * `fixtures` block, and converts it into the M1 task set: one row per PR with
 * the upstream converter's mapping
 *
 *   repo         = owner/name parsed from githubPrUrl
 *   base_commit  = source_commit
 *   head_commit  = target_commit
 *   instance_id  = owner__name@<target_commit[:7]>   (dots preserved)
 *   comments[]   -> reference_comments[] {path, text, start_line: from_line,
 *                    end_line: to_line, side}
 *   comments[]   -> comment_meta[] {category, context, is_ai_comment,
 *                    source_model}   (index-aligned with reference_comments)
 *
 * positive_samples is the upstream label=1 split: every reference comment is
 * a known-correct review comment. That is deliberate — M1 measures an
 * end-to-end reviewer against known-positive feedback, judged by the pinned
 * upstream judge; it is not M0's binary verifier question.
 *
 * The fixture BODY is derived upstream data and is not redistributed: only
 * the builder, the pin (URL + sha256 + size + record count) and the citation
 * are committed. The generated `test-set.json` is gitignored and rebuildable
 * from the pin at any time (ADR-0007 §10, ADR-0009).
 *
 * Opt-in eval surface, same contract as the other AACR scripts: without
 * PIR_EVAL=1 this exits 0 with a parseable skip notice and touches nothing;
 * importing the module has no side effects; --help is model-free.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL("./", import.meta.url));
const AACR_DIR = path.join(HERE, "..");
export const DEFAULT_META = path.join(AACR_DIR, "meta.json");
export const DEFAULT_OUT = path.join(HERE, "test-set.json");
export const DEFAULT_SOURCE_CACHE = path.join(HERE, "positive_samples.json");
export const FIXTURE_META = "aacr-bench/m1-fixture/v1";
export const REQUIRED_PIN_FIELDS = ["repo", "commit", "file", "url", "sha256", "bytes", "records"];

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** The pinned upstream fixtures block from meta.json (throws loudly when absent). */
export function loadFixturePin(metaPath = DEFAULT_META) {
  const meta = JSON.parse(readFileSync(metaPath, "utf8"));
  const pin = meta?.fixtures;
  if (!pin) throw new Error(`meta.json has no fixtures pin: ${metaPath} (M1 needs the pinned positive_samples.json)`);
  for (const field of REQUIRED_PIN_FIELDS) {
    if (pin[field] === undefined || pin[field] === null || pin[field] === "") {
      throw new Error(`meta.json fixtures pin is missing ${field}: ${metaPath}`);
    }
  }
  if (!/^[0-9a-f]{64}$/.test(String(pin.sha256))) throw new Error("meta.json fixtures.sha256 must be 64 lowercase hex chars");
  if (!/^[0-9a-f]{40}$/.test(String(pin.commit))) throw new Error("meta.json fixtures.commit must be a 40-char hex sha");
  if (!Number.isSafeInteger(pin.bytes) || pin.bytes < 1) throw new Error("meta.json fixtures.bytes must be a positive integer");
  if (!Number.isSafeInteger(pin.records) || pin.records < 1) throw new Error("meta.json fixtures.records must be a positive integer");
  return { meta, pin };
}

/** https://github.com/<owner>/<name>/pull/<n> -> "<owner>/<name>". */
export function parseRepoFromPrUrl(prUrl) {
  const match = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/\d+\/?$/.exec(String(prUrl ?? "").trim());
  if (!match) throw new Error(`unrecognized githubPrUrl: ${prUrl}`);
  return `${match[1]}/${match[2]}`;
}

/** Upstream converter convention: "/" -> "__", head shortened to 7 chars; dots survive. */
export function instanceIdFor(repo, headCommit) {
  const ownerRepo = repo.replace("/", "__");
  return `${ownerRepo}@${String(headCommit).slice(0, 7)}`;
}

function optionalLine(value, where) {
  if (value === undefined || value === null) return null;
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${where}: line must be a positive integer or null, got ${value}`);
  return number;
}

function optionalString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** One upstream PR record -> one M1 fixture row. Throws instead of silently skipping. */
export function convertRecord(record, index = 0) {
  const where = `positive_samples[${index}]`;
  if (!record || typeof record !== "object") throw new Error(`${where}: record must be an object`);
  const repo = parseRepoFromPrUrl(record.githubPrUrl);
  const base = optionalString(record.source_commit);
  const head = optionalString(record.target_commit);
  if (!base || !/^[0-9a-f]{40}$/.test(base)) throw new Error(`${where}: source_commit must be a 40-char hex sha`);
  if (!head || !/^[0-9a-f]{40}$/.test(head)) throw new Error(`${where}: target_commit must be a 40-char hex sha`);

  const changeLineCount = record.change_line_count;
  if (changeLineCount !== undefined && changeLineCount !== null &&
      (!Number.isSafeInteger(changeLineCount) || changeLineCount < 0)) {
    throw new Error(`${where}: change_line_count must be a non-negative integer`);
  }

  const reference_comments = [];
  const comment_meta = [];
  let skipped = 0;
  const comments = Array.isArray(record.comments) ? record.comments : [];
  for (const [commentIndex, raw] of comments.entries()) {
    if (!raw || typeof raw !== "object") throw new Error(`${where}.comments[${commentIndex}]: comment must be an object`);
    const filePath = optionalString(raw.path);
    const text = optionalString(raw.note);
    // Mirrors upstream converters/aacr_bench.py: a comment without a path or
    // a body cannot be reference material and is skipped. Skipped comments
    // never enter either aligned array.
    if (!filePath || !text) { skipped += 1; continue; }
    const side = optionalString(raw.side);
    if (side !== "left" && side !== "right") {
      throw new Error(`${where}.comments[${commentIndex}]: side must be "left" or "right", got ${raw.side}`);
    }
    reference_comments.push({
      path: filePath,
      text,
      start_line: optionalLine(raw.from_line, `${where}.comments[${commentIndex}]`),
      end_line: optionalLine(raw.to_line, `${where}.comments[${commentIndex}]`),
      side,
    });
    comment_meta.push({
      category: optionalString(raw.category),
      context: optionalString(raw.context),
      is_ai_comment: Boolean(raw.is_ai_comment),
      source_model: optionalString(raw.source_model),
    });
  }
  if (reference_comments.length === 0) throw new Error(`${where}: no usable reference comments (${skipped} skipped)`);

  return {
    instance_id: instanceIdFor(repo, head),
    repo,
    base_commit: base,
    head_commit: head,
    clone_url: `https://github.com/${repo}.git`,
    change_line_count: changeLineCount ?? null,
    project_main_language: optionalString(record.project_main_language),
    // PR-level bucket provenance for the later A1 report (comment-level
    // category lives in comment_meta).
    pr_category: optionalString(record.category),
    reference_comments,
    comment_meta,
    skipped_comments: skipped,
  };
}

/**
 * Validate structural invariants the rest of M1 relies on: unique instance
 * ids, non-empty reference comments, valid sides, aligned comment_meta.
 */
export function validateFixtureRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error("fixture rows must be a non-empty array");
  const seen = new Set();
  rows.forEach((row, index) => {
    const where = `fixture row ${index}`;
    if (!row || typeof row !== "object") throw new Error(`${where}: row must be an object`);
    for (const field of ["instance_id", "repo", "base_commit", "head_commit", "clone_url"]) {
      if (typeof row[field] !== "string" || row[field].trim() === "") throw new Error(`${where}: ${field} must be a non-empty string`);
    }
    if (!/^[^\s/]+\/[^\s/]+$/.test(row.repo)) throw new Error(`${where}: repo must be owner/name`);
    for (const field of ["base_commit", "head_commit"]) {
      if (!/^[0-9a-f]{40}$/.test(row[field])) throw new Error(`${where}: ${field} must be a 40-char hex sha`);
    }
    if (seen.has(row.instance_id)) throw new Error(`${where}: duplicate instance_id ${row.instance_id}`);
    seen.add(row.instance_id);
    const expectedId = instanceIdFor(row.repo, row.head_commit);
    if (row.instance_id !== expectedId) throw new Error(`${where}: instance_id ${row.instance_id} does not follow ${expectedId}`);
    if (!Array.isArray(row.reference_comments) || row.reference_comments.length === 0) {
      throw new Error(`${where}: reference_comments must be non-empty`);
    }
    if (!Array.isArray(row.comment_meta) || row.comment_meta.length !== row.reference_comments.length) {
      throw new Error(`${where}: comment_meta must be index-aligned with reference_comments`);
    }
    row.reference_comments.forEach((comment, commentIndex) => {
      if (!comment || typeof comment !== "object") throw new Error(`${where}.reference_comments[${commentIndex}]: comment must be an object`);
      if (typeof comment.path !== "string" || comment.path.trim() === "") throw new Error(`${where}.reference_comments[${commentIndex}]: path must be non-empty`);
      if (typeof comment.text !== "string" || comment.text.trim() === "") throw new Error(`${where}.reference_comments[${commentIndex}]: text must be non-empty`);
      if (comment.side !== "left" && comment.side !== "right") {
        throw new Error(`${where}.reference_comments[${commentIndex}]: side must be "left" or "right"`);
      }
      for (const field of ["start_line", "end_line"]) {
        const value = comment[field];
        if (value !== null && (!Number.isSafeInteger(value) || value < 1)) {
          throw new Error(`${where}.reference_comments[${commentIndex}]: ${field} must be a positive integer or null`);
        }
      }
    });
    row.comment_meta.forEach((meta, metaIndex) => {
      if (!meta || typeof meta !== "object") throw new Error(`${where}.comment_meta[${metaIndex}]: meta must be an object`);
      if (typeof meta.is_ai_comment !== "boolean") throw new Error(`${where}.comment_meta[${metaIndex}]: is_ai_comment must be a boolean`);
    });
  });
  return rows;
}

/** Stable digest of the instance-id list, recorded by the driver and its summaries. */
export function fixtureDigest(rows) {
  return createHash("sha256").update(rows.map((row) => row.instance_id).join("\n")).digest("hex");
}

function totalComments(records) {
  return records.reduce((sum, record) => sum + (Array.isArray(record?.comments) ? record.comments.length : 0), 0);
}

/**
 * Full fixture document: provenance header (pin + citation) plus rows.
 * `bytes` is the verified upstream file content, so the header's size/sha
 * are the bytes the rows were actually converted from.
 */
export function buildFixtureDocument(records, meta, bytes) {
  if (!Array.isArray(records) || records.length === 0) throw new Error("positive_samples.json must be a non-empty JSON array");
  const { pin } = loadFixturePinFromMeta(meta);
  const actualSha = sha256(bytes);
  if (actualSha !== pin.sha256) throw new Error(`positive_samples sha256 mismatch: expected ${pin.sha256}, got ${actualSha}`);
  if (bytes.length !== pin.bytes) throw new Error(`positive_samples byte size mismatch: expected ${pin.bytes}, got ${bytes.length}`);
  if (records.length !== pin.records) throw new Error(`positive_samples record count mismatch: expected ${pin.records}, got ${records.length}`);
  const observedComments = totalComments(records);
  if (pin.comments !== undefined && observedComments !== pin.comments) {
    throw new Error(`positive_samples comment count mismatch: expected ${pin.comments}, got ${observedComments}`);
  }
  const rows = validateFixtureRows(records.map((record, index) => convertRecord(record, index)));
  const commentSides = { left: 0, right: 0 };
  for (const row of rows) for (const comment of row.reference_comments) commentSides[comment.side] += 1;
  if (pin.commentSides) {
    for (const side of ["left", "right"]) {
      if (pin.commentSides[side] !== undefined && pin.commentSides[side] !== commentSides[side]) {
        throw new Error(`positive_samples ${side}-side comment count mismatch: expected ${pin.commentSides[side]}, got ${commentSides[side]}`);
      }
    }
  }
  return {
    __meta__: FIXTURE_META,
    dataset: {
      id: meta.dataset?.id ?? "Alibaba-Aone/aacr-bench",
      repo: pin.repo,
      commit: pin.commit,
      file: pin.file,
      url: pin.url,
      sha256: actualSha,
      bytes: bytes.length,
      records: rows.length,
      comments: observedComments,
      commentSides,
      license: pin.license ?? "Apache-2.0",
    },
    convention: {
      instanceId: pin.instanceId,
      baseCommit: pin.baseCommit,
      headCommit: pin.headCommit,
      cloneUrl: pin.cloneUrl,
      referenceComments: "comments[] -> {path, text, start_line: from_line, end_line: to_line, side}",
      commentMeta: "comments[] -> {category, context, is_ai_comment, source_model}, index-aligned with reference_comments",
      label: "positive_samples only: every reference comment is label=1 (known-correct) by construction",
    },
    citation: meta.citation ?? null,
    rows,
  };
}

function loadFixturePinFromMeta(meta) {
  const pin = meta?.fixtures;
  if (!pin) throw new Error("meta.json has no fixtures pin");
  for (const field of REQUIRED_PIN_FIELDS) if (pin[field] === undefined) throw new Error(`meta.json fixtures pin is missing ${field}`);
  return { meta, pin };
}

/** Read + validate a generated fixture body. */
export function loadFixture(file = DEFAULT_OUT) {
  if (!existsSync(file)) throw new Error(`fixture not found: ${file} (run PIR_EVAL=1 node tests/eval/aacr/fixtures/build-fixture.js)`);
  const doc = JSON.parse(readFileSync(file, "utf8"));
  if (doc?.__meta__ !== FIXTURE_META) throw new Error(`fixture has an unknown header: ${doc?.__meta__ ?? "(none)"} (expected ${FIXTURE_META})`);
  if (!doc.dataset?.sha256 || !/^[0-9a-f]{64}$/.test(String(doc.dataset.sha256))) throw new Error("fixture header is missing the upstream sha256 pin");
  validateFixtureRows(doc.rows);
  if (doc.dataset.records !== undefined && doc.dataset.records !== doc.rows.length) {
    throw new Error(`fixture header says ${doc.dataset.records} records but contains ${doc.rows.length} rows`);
  }
  return { header: doc, rows: doc.rows };
}

/** Summary printed by the CLI (also the --json payload). */
export function fixtureSummary(doc, { out, cached = false, source = null } = {}) {
  const sides = { left: 0, right: 0 };
  const languages = {};
  const repos = new Set();
  let comments = 0;
  for (const row of doc.rows) {
    repos.add(row.repo);
    languages[row.project_main_language ?? "unknown"] = (languages[row.project_main_language ?? "unknown"] ?? 0) + 1;
    for (const comment of row.reference_comments) {
      comments += 1;
      sides[comment.side] += 1;
    }
  }
  return {
    out,
    cached,
    source,
    sha256: doc.dataset.sha256,
    bytes: doc.dataset.bytes,
    records: doc.dataset.records,
    rows: doc.rows.length,
    comments,
    sides,
    repos: repos.size,
    languages,
    digest: fixtureDigest(doc.rows),
  };
}

export function parseOptions(argv = [], env = process.env) {
  const values = {
    meta: env.PIR_AACR_META ?? DEFAULT_META,
    out: env.PIR_AACR_FIXTURE ?? DEFAULT_OUT,
    from: env.PIR_AACR_FIXTURE_FROM,
    url: env.PIR_AACR_FIXTURE_URL,
    cache: env.PIR_AACR_FIXTURE_SOURCE ?? DEFAULT_SOURCE_CACHE,
    force: false,
    json: env.PIR_EVAL_JSON === "1",
    help: false,
  };
  const flags = { "--meta": "meta", "--out": "out", "--from": "from", "--url": "url", "--cache": "cache" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--force") { values.force = true; continue; }
    if (argv[i] === "--json") { values.json = true; continue; }
    if (argv[i] === "--help") { values.help = true; continue; }
    const key = flags[argv[i]];
    if (!key || !argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error(`invalid option or missing value: ${argv[i]}`);
    values[key] = argv[++i];
  }
  for (const key of ["meta", "out", "cache"]) values[key] = path.resolve(values[key]);
  if (values.from) values.from = path.resolve(values.from);
  return values;
}

async function download(url) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`download failed: HTTP ${response.status} ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

export function verifyFixturePin(bytes, pin) {
  const actual = sha256(bytes);
  return { ok: actual === pin.sha256, expected: pin.sha256, actual };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseOptions(argv, env);
  if (options.help) {
    console.log("PIR_EVAL=1 node tests/eval/aacr/fixtures/build-fixture.js [--meta meta.json] [--out fixtures/test-set.json] [--from <positive_samples.json>] [--url <pinned raw url>] [--cache fixtures/positive_samples.json] [--force] [--json]\n" +
      "Downloads the pinned upstream dataset/positive_samples.json, verifies meta.json's fixtures sha256/size/record pin, and writes the gitignored M1 fixture body (one row per PR; header carries the pin and the arXiv citation).\n" +
      "--from <file> converts an existing download (offline / tests). --force re-downloads even when the cached copy matches the pin.");
    return 0;
  }
  if (env.PIR_EVAL !== "1") {
    console.log(options.json ? JSON.stringify({ skipped: true, reason: "PIR_EVAL=1 required" }) : "skipped: set PIR_EVAL=1 to allow model evaluation");
    return 0;
  }
  const { meta, pin } = loadFixturePin(options.meta);
  const url = options.url ?? pin.url;
  let bytes;
  let source = null;
  let cached = false;
  if (options.from) {
    bytes = readFileSync(options.from);
    source = options.from;
  } else if (!options.force && existsSync(options.cache)) {
    bytes = readFileSync(options.cache);
    source = options.cache;
    cached = true;
    const pinCheck = verifyFixturePin(bytes, pin);
    if (!pinCheck.ok) {
      console.error(`cached positive_samples fails the pin (expected ${pinCheck.expected}, got ${pinCheck.actual}) — re-downloading`);
      bytes = undefined;
      cached = false;
    }
  }
  if (bytes === undefined) {
    try {
      bytes = await download(url);
    } catch (error) {
      throw new Error(`${error.message}\nNo network? Download the pinned file manually and pass --from <positive_samples.json>.`);
    }
    source = url;
  }
  const pinCheck = verifyFixturePin(bytes, pin);
  if (!pinCheck.ok) {
    throw new Error(`positive_samples sha256 mismatch: expected ${pinCheck.expected}, got ${pinCheck.actual} (source ${source}); refusing to write`);
  }
  const records = JSON.parse(bytes.toString("utf8"));
  const doc = buildFixtureDocument(records, meta, bytes);
  mkdirSync(path.dirname(options.out), { recursive: true });
  writeFileSync(options.out, `${JSON.stringify(doc, null, 2)}\n`);
  // Cache the verified upstream body (never a tampered one): a later run can
  // rebuild the fixture without touching the network.
  if (!options.from && path.resolve(options.cache) !== path.resolve(options.out)) {
    mkdirSync(path.dirname(options.cache), { recursive: true });
    writeFileSync(options.cache, bytes);
  }
  const summary = fixtureSummary(doc, { out: options.out, cached, source });
  if (options.json) console.log(JSON.stringify(summary));
  else {
    console.log(`wrote ${options.out}`);
    console.log(`  upstream: ${pin.repo}@${pin.commit.slice(0, 7)} ${pin.file} sha256=${summary.sha256} (${summary.bytes} bytes, ${summary.records} records)`);
    console.log(`  fixture:  ${summary.rows} tasks, ${summary.comments} reference comments (left=${summary.sides.left}, right=${summary.sides.right}), ${summary.repos} repos, ${Object.keys(summary.languages).length} languages`);
    console.log(`  citation: ${meta.citation?.arxiv ?? "2601.19494"} — ${meta.citation?.notice ?? "Apache-2.0"}`);
    console.log(`  body is gitignored; commit only the builder and the pin in meta.json`);
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((error) => { console.error(error); process.exitCode = 3; });
}
