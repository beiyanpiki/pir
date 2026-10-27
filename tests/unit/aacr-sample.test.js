import { test } from "node:test";
import assert from "assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { commentId, isHeadAnchorable, mulberry32, sampleDigest, sampleRecords, sideExclusionCount } from "../eval/aacr/sample.js";
import { citationNotice, datasetHeader, loadMeta, parseOptions as fetchOptions, verifyPin, validateRecords } from "../eval/aacr/fetch-dataset.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AACR = path.join(HERE, "..", "eval", "aacr");
const DATASET = path.join(AACR, "dataset", "dataset.json");

const record = (over = {}) => ({
  pr_url: "https://github.com/owner/repo/pull/7",
  pr_source_commit: "a".repeat(40), pr_target_commit: "b".repeat(40),
  path: "src/app.ts", side: "right", from_line: 10, to_line: 12,
  note: "This check is missing.", category: "Code Defect", context: "Diff Level",
  is_ai_comment: true, source_model: "GPT-5.2", label: 1, ...over,
});

function temporary(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "pir-aacr-unit-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("commentId is stable, distinct per comment, and index-prefixed", () => {
  const first = record();
  const id = commentId(3, first);
  assert.match(id, /^c0003-[0-9a-f]{8}$/);
  assert.equal(commentId(3, { ...first }), id);
  assert.notEqual(commentId(4, first), id);
  assert.notEqual(commentId(3, { ...first, note: "different" }), id);
  assert.notEqual(commentId(3, { ...first, path: "other.ts" }), id);
  assert.notEqual(commentId(3, { ...first, label: 0 }), id);
});

test("verifier-benchmark dogfood F-187: sampleRecords skips LEFT-side comments and keeps dataset indices", () => {
  const records = [
    record({ side: "left", path: "src/old.ts" }),
    record({ path: "src/a.ts" }), record({ path: "src/b.ts" }), record({ path: "src/c.ts" }),
  ];
  const sample = sampleRecords(records, { limit: 3, seed: 7 });
  assert.equal(sample.length, 3);
  assert.ok(sample.every((entry) => entry.record.side === "right"));
  assert.deepEqual(sample.map((entry) => entry.index).sort((a, b) => a - b), [1, 2, 3]);
  // Ids keep the dataset's own index, so a LEFT row never shifts another row's id.
  assert.equal(sample.find((entry) => entry.record.path === "src/a.ts").id, commentId(1, records[1]));
  assert.equal(sideExclusionCount(records), 1);
  assert.equal(isHeadAnchorable(records[0]), false);
  assert.equal(isHeadAnchorable(records[1]), true);
  assert.throws(() => sampleRecords(records, { limit: 4, seed: 7 }), /head-anchorable dataset size/);
});

test("verifier-benchmark dogfood F-187: validateRecords rejects an unknown side value", () => {
  assert.throws(() => validateRecords([record({ side: "middle" })]), /side must be "left" or "right"/);
  assert.doesNotThrow(() => validateRecords([record({ side: "left" })]));
});

test("sampleRecords is reproducible from (dataset, seed, limit) and never repeats", () => {
  const records = Array.from({ length: 50 }, (_, i) => record({ path: "src/f" + i + ".ts" }));
  const a = sampleRecords(records, { limit: 10, seed: 42 });
  const b = sampleRecords(records, { limit: 10, seed: 42 });
  assert.deepEqual(a.map((entry) => entry.id), b.map((entry) => entry.id));
  assert.equal(new Set(a.map((entry) => entry.id)).size, 10);
  assert.equal(a.length, 10);
  for (const entry of a) assert.equal(entry.record, records[entry.index]);
  const otherSeed = sampleRecords(records, { limit: 10, seed: 43 });
  assert.notDeepEqual(a.map((entry) => entry.id), otherSeed.map((entry) => entry.id));
  // Full sample: every record exactly once.
  const all = sampleRecords(records, { seed: 7 });
  assert.equal(all.length, 50);
  assert.equal(new Set(all.map((entry) => entry.index)).size, 50);
});

test("verifier-benchmark iteration 2: a no-limit sample is the whole head-anchorable corpus, not records.length", () => {
  // The full-corpus round omits --limit; with LEFT rows present the dataset
  // size (3) and the anchorable size (2) disagree, so sizing the full sample by
  // records.length used to throw "limit 3 exceeds the head-anchorable dataset
  // size 2" on the real 2,145/2,134 corpus.
  const records = [record({ path: "src/a.ts" }), record({ side: "left", path: "src/old.ts" }), record({ path: "src/b.ts" })];
  const all = sampleRecords(records, { seed: 5 });
  assert.equal(all.length, 2);
  assert.deepEqual(all.map((entry) => entry.index).sort((a, b) => a - b), [0, 2]);
  assert.deepEqual(all.map((entry) => entry.id), sampleRecords(records, { limit: 2, seed: 5 }).map((entry) => entry.id));
  assert.throws(() => sampleRecords([record({ side: "left" })], { seed: 5 }), /no head-anchorable records/);
});

test("sampleRecords rejects nonsense limits", () => {
  const records = [record(), record({ path: "b.ts" })];
  assert.throws(() => sampleRecords(records, { limit: 0 }), /positive integer/);
  assert.throws(() => sampleRecords(records, { limit: 3 }), /exceeds the dataset size/);
  assert.throws(() => sampleRecords(records, { limit: 1.5 }), /positive integer/);
  assert.throws(() => sampleRecords("nope"), /must be an array/);
});

test("mulberry32 is deterministic and stays in [0,1)", () => {
  const next = mulberry32(11);
  const values = Array.from({ length: 5 }, () => next());
  assert.deepEqual(values, Array.from({ length: 5 }, mulberry32(11)));
  for (const value of values) assert.ok(value >= 0 && value < 1);
});

test("sampleDigest depends only on the id list", () => {
  const digest = sampleDigest([{ id: "a" }, { id: "b" }]);
  assert.equal(digest, sampleDigest([{ id: "a" }, { id: "b" }]));
  assert.notEqual(digest, sampleDigest([{ id: "b" }, { id: "a" }]));
  assert.match(digest, /^[0-9a-f]{64}$/);
});

test("verifyPin accepts the pinned bytes and rejects anything else", () => {
  const meta = loadMeta(path.join(AACR, "meta.json"));
  assert.equal(meta.dataset.license, "Apache-2.0");
  assert.match(meta.citation.bibtex, /2601\.19494/);
  assert.equal(verifyPin(Buffer.from("not the dataset"), meta).ok, false);
  const bytes = Buffer.from(JSON.stringify([record()]));
  assert.equal(verifyPin(bytes, { dataset: { sha256: "0".repeat(64) } }).ok, false);
});

test("validateRecords counts missing fields and rejects bad labels", () => {
  assert.throws(() => validateRecords([]), /non-empty JSON array/);
  assert.throws(() => validateRecords([{ ...record(), label: 2 }]), /label must be 0 or 1/);
  const missing = { ...record() };
  delete missing.note;
  assert.throws(() => validateRecords([missing]), /missing fields: note×1/);
  assert.equal(validateRecords([record()]).length, 1);
});

test("datasetHeader carries the pin, license and citation into the JSONL head", () => {
  const meta = loadMeta(path.join(AACR, "meta.json"));
  const header = datasetHeader(meta, meta.dataset.sha256, { extra: 1 });
  assert.equal(header.__meta__, "aacr-bench/m0/v1");
  assert.equal(header.dataset.sha256, meta.dataset.sha256);
  assert.equal(header.citation.license, "Apache-2.0");
  assert.match(header.citation.bibtex, /AACR-Bench/);
  assert.equal(header.extra, 1);
  assert.equal(citationNotice(meta).citation, "2601.19494");
});

test("fetch-dataset parseOptions resolves paths and validates flags", () => {
  const options = fetchOptions(["--out", "dataset/x.json", "--from", "/tmp/d.json", "--force"], {});
  assert.ok(path.isAbsolute(options.out));
  assert.ok(path.isAbsolute(options.from));
  assert.equal(options.force, true);
  assert.throws(() => fetchOptions(["--out"], {}), /missing value/);
  assert.throws(() => fetchOptions(["--nope", "x"], {}), /invalid option/);
});

test("PIR_EVAL gate: fetch-dataset exits 0 with a skip notice and no writes", () => {
  temporary((dir) => {
    const out = path.join(dir, "dataset.json");
    const result = spawnSyncNode([path.join(AACR, "fetch-dataset.js"), "--out", out, "--json"], { PIR_EVAL: "0" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { skipped: true, reason: "PIR_EVAL=1 required" });
    assert.equal(existsSync(out), false);
  });
});

test("fetch-dataset --from copies, verifies the pin, and writes the citation sidecar", () => {
  temporary((dir) => {
    const meta = loadMeta(path.join(AACR, "meta.json"));
    const out = path.join(dir, "dataset.json");
    // Build a fixture dataset whose sha256 matches a temporary meta pin.
    const fixture = Buffer.from(JSON.stringify([record()]));
    const metaPath = path.join(dir, "meta.json");
    writeFileSync(metaPath, JSON.stringify({ ...meta, dataset: { ...meta.dataset, sha256: createHash("sha256").update(fixture).digest("hex"), records: 1 } }));
    const from = path.join(dir, "from.json");
    writeFileSync(from, fixture);
    const result = spawnSyncNode([path.join(AACR, "fetch-dataset.js"), "--meta", metaPath, "--out", out, "--from", from, "--json"], { PIR_EVAL: "1" });
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.records, 1);
    assert.equal(summary.cached, false);
    assert.ok(existsSync(out + ".meta.json"));
    assert.match(readFileSync(path.join(dir, "CITATION.txt"), "utf8"), /2601\.19494/);
    // Second run reuses the cached copy without touching the source.
    const cached = spawnSyncNode([path.join(AACR, "fetch-dataset.js"), "--meta", metaPath, "--out", out, "--from", path.join(dir, "missing.json"), "--json"], { PIR_EVAL: "1" });
    assert.equal(cached.status, 0, cached.stderr);
    assert.equal(JSON.parse(cached.stdout).cached, true);
    // A pin mismatch must refuse to write.
    writeFileSync(from, Buffer.from("tampered"));
    const bad = spawnSyncNode([path.join(AACR, "fetch-dataset.js"), "--meta", metaPath, "--out", path.join(dir, "other.json"), "--from", from, "--json"], { PIR_EVAL: "1" });
    assert.equal(bad.status, 3);
    assert.match(bad.stderr, /sha256 mismatch/);
    assert.equal(existsSync(path.join(dir, "other.json")), false);
  });
});

function spawnSyncNode(args, env) {
  return spawnSync(process.execPath, args, { encoding: "utf8", env: { ...process.env, ...env } });
}

test("the pinned dataset is present in this checkout when the live run has fetched it", () => {
  if (!existsSync(DATASET)) return; // gitignored body; only the pin is committed
  const meta = loadMeta(path.join(AACR, "meta.json"));
  assert.equal(verifyPin(readFileSync(DATASET), meta).ok, true);
});
