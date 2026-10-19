/**
 * OCR's tier-1 comment-positioning algorithm, adapted to pir's
 * record_candidate anchors (roadmap B2; open-code-review
 * \`internal/diff/resolver.go\`, \`ResolveComment\` :62).
 *
 * A reviewer excerpt is text the model copied out of a rendered diff, so the
 * normalization has to forgive the mechanics of that copy: indentation and
 * trailing whitespace differ, added/removed lines still carry their \`+\`/\`-\`
 * markers, and blank padding lines appear. The code text itself is expected
 * verbatim — loosening beyond OCR's tier 1 buys matches that the unique-hit
 * rule would then have to disambiguate.
 */

/**
 * Normalized line text: surround-trimmed, then one leading unified-diff
 * marker dropped, then trimmed again (a marker may be followed by padding).
 */
export function normalizeSnippetLine(raw: string): string {
  const trimmed = raw.trim();
  const unmarked = trimmed.startsWith("+") || trimmed.startsWith("-") ? trimmed.slice(1) : trimmed;
  return unmarked.trim();
}

/** The non-blank normalized lines of a snippet or file body, in order. */
export function normalizeSnippetLines(text: string): string[] {
  return text.split("\n").map(normalizeSnippetLine).filter((line) => line.length > 0);
}

export type SnippetLocation =
  | { kind: "unique"; startLine: number; endLine: number }
  | { kind: "none" }
  | { kind: "ambiguous"; occurrences: number };

/**
 * Locate \`excerpt\` in \`fileContent\` as a contiguous window over the normalized
 * file lines, returning the 1-based line range of the unique hit. Zero hits
 * and multiple hits are both failures: a wrong line is worse than no line
 * (OCR's rule — relocate only on a unique match).
 */
export function locateSnippetExcerpt(fileContent: string, excerpt: string): SnippetLocation {
  const needle = normalizeSnippetLines(excerpt);
  if (needle.length === 0) return { kind: "none" };
  const haystack: Array<{ line: number; text: string }> = [];
  const rawLines = fileContent.split("\n");
  for (let index = 0; index < rawLines.length; index += 1) {
    const text = normalizeSnippetLine(rawLines[index]!);
    if (text.length > 0) haystack.push({ line: index + 1, text });
  }
  const hits: number[] = [];
  for (let start = 0; start + needle.length <= haystack.length; start += 1) {
    let matched = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[start + offset]!.text !== needle[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) hits.push(start);
  }
  if (hits.length === 0) return { kind: "none" };
  if (hits.length > 1) return { kind: "ambiguous", occurrences: hits.length };
  const first = hits[0]!;
  return {
    kind: "unique",
    startLine: haystack[first]!.line,
    endLine: haystack[first + needle.length - 1]!.line,
  };
}
