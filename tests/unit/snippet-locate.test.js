import { test } from "node:test";
import assert from "node:assert/strict";
import { locateSnippetExcerpt, normalizeSnippetLine, normalizeSnippetLines } from "../../dist/findings/snippet-locate.js";

// 8 lines, one deliberately blank (line 5) and two repeated "}" lines so the
// ambiguity rule has something real to reject.
const FILE = [
  "export function next(n) {",
  "  if (n < 0) {",
  "    return null;",
  "  }",
  "",
  "  const value = n + 1;",
  "  return value;",
  "}",
].join("\n");

test("normalization trims, drops one diff marker and skips blank lines (B2)", () => {
  assert.equal(normalizeSnippetLine("   const value = 1;  "), "const value = 1;");
  assert.equal(normalizeSnippetLine("\t+  const value = 1;"), "const value = 1;");
  assert.equal(normalizeSnippetLine("-const value = 1;"), "const value = 1;");
  assert.equal(normalizeSnippetLine("  \t  "), "");
  assert.equal(normalizeSnippetLine("+"), "");
  // CRLF and trailing blank padding survive the split.
  assert.deepEqual(normalizeSnippetLines("a\r\n\r\n+b\n\n"), ["a", "b"]);
  assert.deepEqual(normalizeSnippetLines("\n\n"), []);
});

test("locateSnippetExcerpt finds a unique window despite whitespace and marker sloppiness (B2)", () => {
  const sloppy = "  +const value = n + 1;\n\t return value;";
  assert.deepEqual(locateSnippetExcerpt(FILE, sloppy), { kind: "unique", startLine: 6, endLine: 7 });
  // Exact copy is trivially unique.
  assert.deepEqual(locateSnippetExcerpt(FILE, "    return null;"), { kind: "unique", startLine: 3, endLine: 3 });
  // A window spanning a blank file line maps back to the surrounding range.
  assert.deepEqual(locateSnippetExcerpt(FILE, "return null;\n\n  }\n\nconst value = n + 1;"), { kind: "unique", startLine: 3, endLine: 6 });
});

test("locateSnippetExcerpt rejects zero hits and multiple hits (B2)", () => {
  assert.deepEqual(locateSnippetExcerpt(FILE, "const value = n + 1;\nconst missing = true;"), { kind: "none" });
  assert.deepEqual(locateSnippetExcerpt(FILE, "const absent = 1;"), { kind: "none" });
  assert.deepEqual(locateSnippetExcerpt(FILE, "   \n  \n"), { kind: "none" });
  // "}" appears at lines 4 and 8 — the unique-hit rule refuses to guess.
  assert.deepEqual(locateSnippetExcerpt(FILE, "}"), { kind: "ambiguous", occurrences: 2 });
  // The closing-brace window that includes the unique middle lines is fine.
  assert.deepEqual(locateSnippetExcerpt(FILE, "  }\n\n  const value = n + 1;\n  return value;\n}"), { kind: "unique", startLine: 4, endLine: 8 });
  // A repeated multi-line block counts every occurrence, not just the first.
  const repeated = "same\nblock\nx\nsame\nblock\n";
  assert.deepEqual(locateSnippetExcerpt(repeated, "same\nblock"), { kind: "ambiguous", occurrences: 2 });
});

test("locateSnippetExcerpt never matches across the file end (B2)", () => {
  assert.deepEqual(locateSnippetExcerpt("},", "},\nmore"), { kind: "none" });
  assert.deepEqual(locateSnippetExcerpt("", "anything"), { kind: "none" });
});
