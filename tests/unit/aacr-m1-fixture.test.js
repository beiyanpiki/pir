import { test } from "node:test";
import assert from "assert/strict";

import {
  buildFixtureDocument, convertRecord, fixtureDigest, instanceIdFor, parseRepoFromPrUrl, sha256, validateFixtureRows,
} from "../eval/aacr/fixtures/build-fixture.js";

const comment = (over = {}) => ({
  is_ai_comment: true,
  note: "The counter can race.",
  path: "src/app.ts",
  side: "right",
  source_model: "Gemini-3-Pro",
  from_line: 2,
  to_line: 2,
  category: "Code Defect",
  context: "Diff Level",
  ...over,
});

const record = (over = {}) => ({
  githubPrUrl: "https://github.com/example/repo/pull/7",
  source_commit: "a".repeat(40),
  target_commit: "b".repeat(40),
  change_line_count: 12,
  project_main_language: "TypeScript",
  category: "Bug Fix",
  comments: [comment()],
  ...over,
});

test("instance ids follow the upstream converter convention", () => {
  assert.equal(instanceIdFor("FreeCAD/FreeCAD", "a050e422e23ce3eaee960b75ceff236b34f369b9"), "FreeCAD__FreeCAD@a050e42");
  assert.equal(instanceIdFor("owner/repo.js", "b".repeat(40)), "owner__repo.js@bbbbbbb", "dots survive");
  assert.equal(parseRepoFromPrUrl("https://github.com/FreeCAD/FreeCAD/pull/19411"), "FreeCAD/FreeCAD");
  assert.equal(parseRepoFromPrUrl("https://github.com/a/b/pull/1/"), "a/b");
  assert.throws(() => parseRepoFromPrUrl("https://gitlab.com/a/b/pull/1"), /unrecognized githubPrUrl/);
  assert.throws(() => parseRepoFromPrUrl("https://github.com/a/b/pulls/1"), /unrecognized/);
  assert.throws(() => parseRepoFromPrUrl(undefined), /unrecognized/);
});

test("convertRecord maps fields, skips unusable comments and aligns comment_meta", () => {
  const row = convertRecord(record({
    comments: [
      comment(),
      comment({ path: "src/old.ts", side: "left", from_line: 1, to_line: 1, note: "Deleted side." }),
      comment({ note: "   " }),
      comment({ path: "", from_line: 3 }),
    ],
  }), 0);
  assert.equal(row.instance_id, "example__repo@bbbbbbb");
  assert.equal(row.repo, "example/repo");
  assert.equal(row.base_commit, "a".repeat(40));
  assert.equal(row.head_commit, "b".repeat(40));
  assert.equal(row.clone_url, "https://github.com/example/repo.git");
  assert.equal(row.change_line_count, 12);
  assert.equal(row.project_main_language, "TypeScript");
  assert.equal(row.pr_category, "Bug Fix");
  assert.equal(row.reference_comments.length, 2);
  assert.deepEqual(row.reference_comments[0], {
    path: "src/app.ts", text: "The counter can race.", start_line: 2, end_line: 2, side: "right",
  });
  assert.equal(row.reference_comments[1].side, "left");
  assert.equal(row.comment_meta.length, 2);
  assert.deepEqual(row.comment_meta[0], {
    category: "Code Defect", context: "Diff Level", is_ai_comment: true, source_model: "Gemini-3-Pro",
  });
  assert.equal(row.skipped_comments, 2);
  // A human comment without a source model keeps null rather than inventing one.
  const human = convertRecord(record({ comments: [comment({ is_ai_comment: false, source_model: "" })] }));
  assert.equal(human.comment_meta[0].is_ai_comment, false);
  assert.equal(human.comment_meta[0].source_model, null);
});

test("convertRecord fails closed instead of silently dropping a bad record", () => {
  assert.throws(() => convertRecord(record({ source_commit: "nope" })), /source_commit must be a 40-char hex sha/);
  assert.throws(() => convertRecord(record({ target_commit: "" })), /target_commit must be a 40-char hex sha/);
  assert.throws(() => convertRecord(record({ comments: [comment({ side: "middle" })] })), /side must be "left" or "right"/);
  assert.throws(() => convertRecord(record({ comments: [comment({ from_line: 0 })] })), /line must be a positive integer or null/);
  assert.throws(() => convertRecord(record({ comments: [] })), /no usable reference comments/);
  assert.throws(() => convertRecord(record({ comments: [comment({ note: " " })] })), /no usable reference comments/);
});

test("validateFixtureRows enforces unique ids, anchors and aligned metadata", () => {
  const row = convertRecord(record());
  assert.deepEqual(validateFixtureRows([row]), [row]);
  assert.throws(() => validateFixtureRows([row, { ...row }]), /duplicate instance_id/);
  assert.throws(() => validateFixtureRows([{ ...row, reference_comments: [] }]), /reference_comments must be non-empty/);
  assert.throws(() => validateFixtureRows([{ ...row, comment_meta: [] }]), /index-aligned/);
  assert.throws(() => validateFixtureRows([{ ...row, instance_id: "wrong@bbbbbbb" }]), /does not follow/);
  assert.throws(() => validateFixtureRows([{ ...row, repo: "not-a-repo" }]), /repo must be owner\/name/);
  assert.throws(() => validateFixtureRows([]), /non-empty array/);
  const badSide = structuredClone(row);
  badSide.reference_comments[0].side = "middle";
  assert.throws(() => validateFixtureRows([badSide]), /side must be "left" or "right"/);
  const badLine = structuredClone(row);
  badLine.reference_comments[0].start_line = 0;
  assert.throws(() => validateFixtureRows([badLine]), /start_line must be a positive integer or null/);
});

test("fixtureDigest is a stable order-sensitive instance-id digest", () => {
  const a = convertRecord(record());
  const b = convertRecord(record({ target_commit: "c".repeat(40) }));
  assert.match(fixtureDigest([a, b]), /^[0-9a-f]{64}$/);
  assert.equal(fixtureDigest([a, b]), fixtureDigest([a, b]));
  assert.notEqual(fixtureDigest([a, b]), fixtureDigest([b, a]));
  assert.equal(fixtureDigest([]), sha256(""));
});

test("buildFixtureDocument pins sha256, size, record and comment counts", () => {
  const records = [record()];
  const bytes = Buffer.from(JSON.stringify(records));
  const meta = {
    dataset: { id: "Alibaba-Aone/aacr-bench" },
    citation: { arxiv: "2601.19494", bibtex: "@misc{test}", notice: "cite" },
    fixtures: {
      repo: "https://github.com/alibaba/aacr-bench", commit: "e".repeat(40), file: "dataset/positive_samples.json",
      url: "https://example.invalid/positive_samples.json", sha256: sha256(bytes), bytes: bytes.length,
      records: 1, comments: 1, commentSides: { right: 1, left: 0 }, instanceId: "x", baseCommit: "y", headCommit: "z",
      cloneUrl: "https://github.com/<owner>/<name>.git", license: "Apache-2.0",
    },
  };
  const doc = buildFixtureDocument(records, meta, bytes);
  assert.equal(doc.__meta__, "aacr-bench/m1-fixture/v1");
  assert.equal(doc.dataset.sha256, meta.fixtures.sha256);
  assert.equal(doc.dataset.bytes, bytes.length);
  assert.equal(doc.dataset.records, 1);
  assert.equal(doc.dataset.comments, 1);
  assert.deepEqual(doc.dataset.commentSides, { right: 1, left: 0 });
  assert.equal(doc.rows.length, 1);
  assert.match(doc.convention.label, /label=1/);

  assert.throws(() => buildFixtureDocument(records, meta, Buffer.from("tampered")), /sha256 mismatch/);
  const wrongRecords = { ...meta, fixtures: { ...meta.fixtures, records: 2 } };
  assert.throws(() => buildFixtureDocument(records, wrongRecords, bytes), /record count mismatch/);
  const wrongComments = { ...meta, fixtures: { ...meta.fixtures, comments: 2 } };
  assert.throws(() => buildFixtureDocument(records, wrongComments, bytes), /comment count mismatch/);
  const wrongBytes = { ...meta, fixtures: { ...meta.fixtures, bytes: bytes.length + 1 } };
  assert.throws(() => buildFixtureDocument(records, wrongBytes, bytes), /byte size mismatch/);
});
