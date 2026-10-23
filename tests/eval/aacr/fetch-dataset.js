#!/usr/bin/env node
/**
 * AACR-Bench M0 — data acquisition (dataset download, sha256 pin, citation notice).
 *
 * Downloads the pinned Hugging Face `dataset.json` into tests/eval/aacr/dataset/
 * (gitignored), verifies it against the sha256 pin in meta.json, and writes a
 * sidecar with the source URL, license and the arXiv citation notice. The
 * dataset body is never committed: only the pin (URL + sha256) and the scripts
 * that rebuild it are.
 *
 * Opt-in eval surface, same contract as tests/eval/reviewbench/run-rb.js:
 * without PIR_EVAL=1 it exits 0 with a parseable skip notice and touches
 * nothing; importing this module has no side effects; --help is model-free.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL("./", import.meta.url));
export const DEFAULT_META = path.join(HERE, "meta.json");
export const DEFAULT_DATASET_DIR = path.join(HERE, "dataset");
export const DEFAULT_DATASET = path.join(DEFAULT_DATASET_DIR, "dataset.json");

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function loadMeta(metaPath = DEFAULT_META) {
  const meta = JSON.parse(readFileSync(metaPath, "utf8"));
  if (!meta?.dataset?.url || !meta?.dataset?.sha256) throw new Error(`meta.json is missing dataset.url/dataset.sha256: ${metaPath}`);
  if (!/^[0-9a-f]{64}$/.test(meta.dataset.sha256)) throw new Error("meta.json dataset.sha256 must be 64 lowercase hex chars");
  return meta;
}

/** The pin check is the only gate between a download and the benchmark. */
export function verifyPin(bytes, meta) {
  const actual = sha256(bytes);
  return { ok: actual === meta.dataset.sha256, expected: meta.dataset.sha256, actual };
}

export const REQUIRED_FIELDS = ["pr_url", "pr_source_commit", "pr_target_commit", "path", "side", "from_line", "to_line", "note", "category", "context", "is_ai_comment", "source_model", "label"];

/**
 * Shape validation with a loud, counted error instead of a silently short
 * corpus. Field values stay as the upstream artifact wrote them; the mapping
 * layer owns interpretation.
 */
export function validateRecords(records) {
  if (!Array.isArray(records) || records.length === 0) throw new Error("dataset.json must be a non-empty JSON array");
  const missing = new Map();
  records.forEach((row, index) => {
    for (const field of REQUIRED_FIELDS) {
      if (!(field in (row ?? {}))) missing.set(field, (missing.get(field) ?? 0) + 1);
    }
    if (row?.label !== 0 && row?.label !== 1) throw new Error(`record ${index}: label must be 0 or 1`);
    // The mapping layer cannot anchor a LEFT-side comment (old-file lines), so
    // the vocabulary is validated here and the sampler excludes it loudly
    // (dogfood F-187) instead of trusting an unknown value through.
    if (row?.side !== "left" && row?.side !== "right") throw new Error(`record ${index}: side must be "left" or "right"`);
  });
  if (missing.size > 0) throw new Error(`dataset.json records are missing fields: ${[...missing].map(([f, n]) => `${f}×${n}`).join(", ")}`);
  return records;
}

/** Citation notice attached to every generated artifact header (Apache-2.0 obligation). */
export function citationNotice(meta = loadMeta()) {
  return {
    source: meta.dataset.id,
    url: meta.dataset.url,
    license: meta.dataset.license,
    sha256: meta.dataset.sha256,
    citation: meta.citation.arXiv ?? meta.citation.arxiv,
    bibtex: meta.citation.bibtex,
    notice: meta.citation.notice,
  };
}

/** First line of every materialized JSONL: provenance, pin and citation. */
export function datasetHeader(meta, actualSha256, extra = {}) {
  return {
    __meta__: "aacr-bench/m0/v1",
    dataset: { id: meta.dataset.id, url: meta.dataset.url, revision: meta.dataset.hfRevision, sha256: actualSha256, records: meta.dataset.records },
    citation: citationNotice(meta),
    materialization: meta.materialization,
    ...extra,
  };
}

async function download(url) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`download failed: HTTP ${response.status} ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

export function parseOptions(argv = [], env = process.env) {
  const values = {
    meta: env.PIR_AACR_META ?? DEFAULT_META,
    out: env.PIR_AACR_DATASET ?? DEFAULT_DATASET,
    url: env.PIR_AACR_DATASET_URL,
    from: env.PIR_AACR_DATASET_FROM,
    force: false,
    json: env.PIR_EVAL_JSON === "1",
    help: false,
  };
  const flags = { "--meta": "meta", "--out": "out", "--url": "url", "--from": "from" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--force") { values.force = true; continue; }
    if (argv[i] === "--json") { values.json = true; continue; }
    if (argv[i] === "--help") { values.help = true; continue; }
    const key = flags[argv[i]];
    if (!key || !argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error(`invalid option or missing value: ${argv[i]}`);
    values[key] = argv[++i];
  }
  values.meta = path.resolve(values.meta);
  values.out = path.resolve(values.out);
  if (values.from) values.from = path.resolve(values.from);
  return values;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseOptions(argv, env);
  if (options.help) {
    console.log("PIR_EVAL=1 node tests/eval/aacr/fetch-dataset.js [--out dataset/dataset.json] [--meta meta.json] [--url <hf-url>] [--from <local-file>] [--force] [--json]\n" +
      "Downloads the pinned AACR-Bench dataset.json, verifies meta.json's sha256 pin, and writes the dataset plus a citation sidecar.\n" +
      "--from <local-file> copies and verifies an existing download (offline / tests). --force re-downloads even when the cached copy matches the pin.");
    return 0;
  }
  if (env.PIR_EVAL !== "1") {
    console.log(options.json ? JSON.stringify({ skipped: true, reason: "PIR_EVAL=1 required" }) : "skipped: set PIR_EVAL=1 to allow model evaluation");
    return 0;
  }
  const meta = loadMeta(options.meta);
  const url = options.url ?? meta.dataset.url;
  if (!options.force && existsSync(options.out)) {
    const bytes = readFileSync(options.out);
    const pin = verifyPin(bytes, meta);
    if (pin.ok) {
      const summary = { cached: true, file: options.out, sha256: pin.actual, bytes: bytes.length, url };
      console.log(options.json ? JSON.stringify(summary) : `cached ${options.out} sha256=${pin.actual} (${bytes.length} bytes)`);
      return 0;
    }
    console.error(`cached copy fails the pin (expected ${pin.expected}, got ${pin.actual}) — re-downloading`);
  }
  const bytes = options.from ? readFileSync(options.from) : await download(url);
  const pin = verifyPin(bytes, meta);
  if (!pin.ok) throw new Error(`dataset sha256 mismatch: expected ${pin.expected}, got ${pin.actual} (url ${url}); refusing to write`);
  const records = validateRecords(JSON.parse(bytes.toString("utf8")));
  mkdirSync(path.dirname(options.out), { recursive: true });
  writeFileSync(options.out, bytes);
  const sidecar = {
    dataset: { ...meta.dataset, url, bytes: bytes.length, records: records.length, retrievedAt: new Date().toISOString(), sha256Verified: true },
    citation: citationNotice(meta),
  };
  writeFileSync(`${options.out}.meta.json`, `${JSON.stringify(sidecar, null, 2)}\n`);
  writeFileSync(path.join(path.dirname(options.out), "CITATION.txt"), `${citationNotice(meta).bibtex}\n\nSource: ${meta.dataset.id} (${url}), Apache-2.0.\n`);
  const summary = { cached: false, file: options.out, sha256: pin.actual, bytes: bytes.length, records: records.length, url };
  console.log(options.json ? JSON.stringify(summary) : `downloaded ${options.out} sha256=${pin.actual} (${bytes.length} bytes, ${records.length} records)`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((error) => { console.error(error); process.exitCode = 3; });
}
