import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * Doc lint (dogfood F-1): a first-series roadmap label may survive in a source
 * or test file only when it names the record that governs the behaviour, i.e.
 * an ADR. The repository retired the series' tracking file, so a bare label
 * parenthetical that names an id with no ADR is a dangling reference and this
 * test fails until the comment carries an ADR reference instead.
 *
 * Scope is `src/**\/*.ts` and `tests/**\/*.js` only. `docs/adr/**` cites
 * series ids legitimately — the ADRs are the surviving record — and is not
 * scanned. The report renderers' emitted prose is data, not documentation: it
 * reproduces committed result documents under `tests/eval/aacr/results/`, so
 * the exact historical sentences are allowlisted rather than rewritten.
 *
 * This file is itself scanned, so the banned phrase and the fixtures below are
 * assembled at runtime instead of appearing literally in the source.
 */

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const SCOPES = [
  { dir: "src", suffix: ".ts" },
  { dir: "tests", suffix: ".js" },
];
const LABEL = "(" + "roadmap";
const LABEL_RE = new RegExp("\\(" + "roadmap" + "\\b[^)]*\\)", "g");
const ADR_RE = /\bADR[-\s]?\d{3,4}\b/;

// Emitted prose that is reproduced verbatim in committed results. The
// renderers are still scanned; only these historically frozen sentences are
// exempt, matched by content so the exemption survives edits above them.
const EMITTED_PROSE = new Map([
  ["tests/eval/aacr/report.js", ["The three are read together", "- Caliber (", "Ground truth is "]],
  // The end-to-end report renderer emits no such sentence today; it is listed so a future one
  // is treated the same way instead of failing the lint silently.
  ["tests/eval/aacr/m1/report-m1.js", []],
]);

function isEmittedProse(file, line) {
  const markers = EMITTED_PROSE.get(file);
  return markers !== undefined && markers.some((marker) => line.includes(marker));
}

/** Every label parenthetical in `text` that does not name an ADR. */
function scanText(file, text) {
  const violations = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    LABEL_RE.lastIndex = 0;
    let match;
    while ((match = LABEL_RE.exec(line)) !== null) {
      if (isEmittedProse(file, line)) continue;
      if (ADR_RE.test(match[0])) continue;
      violations.push({ file, line: index + 1, text: line.trim() });
    }
  }
  return violations;
}

function filesUnder(dir, suffix) {
  const found = [];
  for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const relative = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...filesUnder(relative, suffix));
    else if (entry.isFile() && entry.name.endsWith(suffix)) found.push(relative);
  }
  return found;
}

function scanRepository() {
  return SCOPES.flatMap(({ dir, suffix }) =>
    filesUnder(dir, suffix).flatMap((file) => scanText(file, readFileSync(path.join(ROOT, file), "utf8"))));
}

test("every roadmap label left in source and test files names an ADR", () => {
  const violations = scanRepository();
  const report = violations.map((violation) => `${violation.file}:${violation.line}: ${violation.text}`).join("\n");
  assert.deepEqual(violations, [], `bare roadmap label(s) with no ADR reference:\n${report}`);
});

test("the detector rejects a bare label and accepts an ADR reference", () => {
  const bare = LABEL + " T3)";
  const qualified = LABEL + " B1, ADR 0004)";
  assert.equal(scanText("src/example.ts", `// ${bare}`).length, 1, "a line comment is scanned");
  assert.equal(scanText("src/example.ts", ` * ${bare}`).length, 1, "a block comment is scanned");
  assert.equal(scanText("src/example.ts", `// ${qualified}`).length, 0, "an ADR-qualified id passes");
  assert.equal(scanText("src/example.ts", "// (ADR 0004)").length, 0, "a plain ADR reference passes");
});

test("the report renderers' emitted prose is exempt but their comments are not", () => {
  const bare = LABEL + " R9)";
  const prose = `lines.push("The three are read together ${bare});`;
  assert.equal(scanText("tests/eval/aacr/report.js", prose).length, 0);
  assert.equal(scanText("tests/eval/aacr/report.js", ` * see ${bare}`).length, 1);
  assert.equal(scanText("tests/eval/aacr/m1/report-m1.js", prose).length, 1);
});

test("the scan covers src/**\/*.ts and tests/**\/*.js, never docs/adr", () => {
  const files = SCOPES.flatMap(({ dir, suffix }) => filesUnder(dir, suffix));
  assert.ok(files.includes("src/changes/filter.ts"));
  assert.ok(files.includes("tests/eval/aacr/report.js"));
  assert.ok(!files.some((file) => file.startsWith("docs/")), "docs/adr/** is not scanned");
  assert.ok(!files.some((file) => file.startsWith("dist/")), "built output is not scanned");
});
