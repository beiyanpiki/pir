#!/usr/bin/env node
/**
 * AACR-Bench M0 — dataset sampling (roadmap T5 sampling contract; T2/T4 input).
 *
 * Pure functions only: no fs, no network, no git. The sample must be
 * reproducible from (dataset, seed, limit) alone, because the materializer,
 * the driver and the results file all have to agree on which comments were
 * scored — a results file whose sample cannot be re-derived is not a result.
 */
import { createHash } from "node:crypto";

/** Deterministic comment id, stable across downloads of the pinned dataset. */
export function commentId(index, record) {
  const material = [record.pr_url, record.path, record.from_line, record.to_line, record.note, record.label].join("\u0000");
  return `c` + String(index).padStart(4, "0") + "-" + createHash("sha256").update(material).digest("hex").slice(0, 8);
}

/** mulberry32: 32-bit seeded PRNG; reproducible across node versions. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Reproducible sample over the dataset: Fisher-Yates with a seeded PRNG.
 * The output carries each record's original index and its comment id, so the
 * materialized JSONL, the run manifest and the results file can name exactly
 * which comments a number came from.
 */
export function sampleRecords(records, { limit, seed = 42 } = {}) {
  if (!Array.isArray(records)) throw new TypeError("records must be an array");
  const n = records.length;
  const size = limit === undefined || limit === null ? n : limit;
  if (!Number.isSafeInteger(size) || size < 1) throw new Error("limit must be a positive integer");
  if (size > n) throw new Error(`limit ` + size + ` exceeds the dataset size ` + n);
  const random = mulberry32(seed);
  const order = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order.slice(0, size).map((index) => ({ index, id: commentId(index, records[index]), record: records[index] }));
}

/** Stable digest of the sampled id list — recorded in every run manifest. */
export function sampleDigest(sampled) {
  return createHash("sha256").update(sampled.map((s) => s.id).join("\n")).digest("hex");
}
