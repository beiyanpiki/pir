import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempGitRepo } from "../fixtures/helpers.js";
import { buildRepoSnapshot } from "../../dist/changes/snapshot.js";
import { planAuditUnits, PLANNER_VERSION } from "../../dist/core/audit-planner.js";
import { CoverageLedger } from "../../dist/core/coverage.js";

test("planner partitions every selected text file into disjoint owned ranges", async () => {
  const repo = createTempGitRepo("pir-plan-");
  try {
    for (let i = 1; i <= 25; i++) repo.write(`src/big/mod${String(i).padStart(2, "0")}.ts`, `export const m${i} = ${i};\n`);
    for (let i = 1; i <= 5; i++) repo.write(`lib/util${i}.ts`, `export const u${i} = ${i};\n`);
    repo.commit("many");
    const snap = await buildRepoSnapshot(repo.dir, "HEAD", { includePaths: [], skipGlobs: [] });
    const plan = await planAuditUnits(snap);
    assert.equal(plan.plannerVersion, PLANNER_VERSION);
    assert.ok(plan.units.length >= 2, "25 files exceed MAX_FILES_PER_UNIT=20 -> split");

    // No range overlap within a file; every selected text file owned at least once.
    const rangesByFile = new Map();
    for (const unit of plan.units) {
      for (const range of unit.owned) {
        const list = rangesByFile.get(range.path) ?? [];
        list.push(range);
        rangesByFile.set(range.path, list);
      }
    }
    for (const [file, ranges] of rangesByFile) {
      const sorted = [...ranges].sort((a, b) => a.startLine - b.startLine);
      for (let i = 1; i < sorted.length; i++) {
        const previous = sorted[i - 1];
        const previousEnd = previous.endLine ?? Number.MAX_SAFE_INTEGER;
        assert.ok(sorted[i].startLine > previousEnd, `${file} ranges overlap`);
      }
    }
    const textFiles = snap.entries.filter((entry) => entry.selection === "selected" && entry.classification === "text").map((entry) => entry.path);
    assert.deepEqual([...rangesByFile.keys()].sort(), [...textFiles].sort());

    // Unit ids are deterministic and sequential.
    assert.deepEqual(plan.units.map((unit) => unit.id), plan.units.map((_, index) => `U-${String(index + 1).padStart(3, "0")}`));
  } finally {
    repo.cleanup();
  }
});

test("planner splits oversized files into sequential line-range chunks", async () => {
  const repo = createTempGitRepo("pir-plan-big-");
  try {
    // >100KB so the exact line count is used; 1300 lines -> chunks of 800 + 500.
    const lines = Array.from({ length: 1300 }, (_, i) => `export const line${i} = "${"x".repeat(85)}${i}"; // padding to cross the exact-count threshold`);
    repo.write("src/huge/generated.ts", `${lines.join("\n")}\n`);
    repo.commit("big");
    const snap = await buildRepoSnapshot(repo.dir, "HEAD", { includePaths: [], skipGlobs: [] });
    const plan = await planAuditUnits(snap);
    const owned = plan.units.flatMap((unit) => unit.owned.filter((range) => range.path === "src/huge/generated.ts"));
    assert.ok(owned.length >= 2, "large file is chunked");
    assert.equal(owned[0].startLine, 1);
    assert.equal(owned[0].endLine, 800);
    assert.equal(owned[1].startLine, 801);
    assert.equal(owned[1].endLine, null);
  } finally {
    repo.cleanup();
  }
});

test("coverage ledger keeps the identity equation exact through unit transitions", async () => {
  const repo = createTempGitRepo("pir-cov-");
  try {
    repo.write("src/a/x.ts", "const x = 1;\n");
    repo.write("src/a/y.ts", "const y = 1;\n");
    repo.write("assets/icon.png", "binary-ish\n");
    repo.write("docs/note.md", "note\n");
    repo.commit("cov");
    const snap = await buildRepoSnapshot(repo.dir, "HEAD", { includePaths: ["src", "assets"], skipGlobs: [] });
    const plan = await planAuditUnits(snap);
    const ledger = new CoverageLedger(snap, plan.rangesByFile, plan.units);

    const equation = (summary) =>
      summary.filesTotal ===
      summary.filesNotSelected + summary.filesExcluded + summary.filesReviewed +
      summary.filesPartial + summary.filesUnreviewed + summary.filesBlocked + summary.filesFailed;

    let summary = ledger.summary();
    assert.ok(equation(summary), "identity holds initially");
    assert.equal(summary.filesNotSelected, 1); // docs/note.md
    assert.equal(summary.filesUnreviewed, 2);  // src/a/x.ts, src/a/y.ts
    assert.equal(summary.filesBlocked, 1);     // assets/icon.png (selected, non-text)
    assert.equal(ledger.scopeFullyReviewed(), false);
    assert.equal(ledger.allUnitsTerminal(), false);

    for (const unit of plan.units) ledger.markUnit(unit.id, "reviewed");
    summary = ledger.summary();
    assert.ok(equation(summary), "identity holds after review");
    assert.equal(summary.filesReviewed, 2);
    assert.equal(summary.batchesCompleted, plan.units.length);
    assert.equal(ledger.scopeFullyReviewed(), false, "blocked binary file keeps scope incomplete");
    assert.equal(ledger.allUnitsTerminal(), true);

    const records = ledger.fileRecords();
    assert.equal(records.find((record) => record.path === "assets/icon.png").state, "blocked");
    assert.equal(records.find((record) => record.path === "assets/icon.png").reason, "binary-extension");
  } finally {
    repo.cleanup();
  }
});

test("coverage marks a file partial while only some owning units are reviewed", async () => {
  const repo = createTempGitRepo("pir-cov-part-");
  try {
    // 7000 exact-count lines: chunked into 800-line ranges, and the 3000-line
    // unit cap spreads consecutive ranges across several owning units.
    const lines = Array.from({ length: 7000 }, (_, i) => `export const l${i} = ${i}; ${"pad".repeat(12)}`);
    repo.write("src/huge/one.ts", `${lines.join("\n")}\n`);
    repo.write("src/small/two.ts", "const two = 2;\n");
    repo.commit("part");
    const snap = await buildRepoSnapshot(repo.dir, "HEAD", { includePaths: [], skipGlobs: [] });
    const plan = await planAuditUnits(snap);
    const oneOwners = plan.units.filter((unit) => unit.owned.some((range) => range.path === "src/huge/one.ts"));
    assert.ok(oneOwners.length >= 2, "chunked file has multiple owning units");

    const ledger = new CoverageLedger(snap, plan.rangesByFile, plan.units);
    ledger.markUnit(oneOwners[0].id, "reviewed");
    const record = ledger.fileRecords().find((entry) => entry.path === "src/huge/one.ts");
    assert.equal(record.state, "partial");
    assert.match(record.reason, /owning units reviewed/);
    for (const unit of oneOwners.slice(1)) ledger.markUnit(unit.id, "reviewed");
    assert.equal(ledger.fileRecords().find((entry) => entry.path === "src/huge/one.ts").state, "reviewed");
  } finally {
    repo.cleanup();
  }
});
