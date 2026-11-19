import type { FileDiff } from "../changes/diff.js";
import type { FindingView } from "../app/find.js";

/**
 * Finding → inline-comment mapping for the Gitea review, with reviewdog's
 * explicit-filter semantics: a finding becomes an inline comment only when
 * one of its anchors points at a line the diff actually touches (added or
 * context on the new side); everything else is demoted to the overview
 * table instead of silently dropped. Pure — the caller feeds the parsed
 * diff and the reported findings, nothing here touches the API.
 */

/** One finding pinned to a new-side line of the PR head (Gitea: `new_position`). */
export interface GiteaInlineComment {
  finding: FindingView;
  path: string;
  new_position: number;
}

export interface InlineMapping {
  inline: GiteaInlineComment[];
  demoted: FindingView[];
}

/**
 * Map findings to inline comments. Each finding's anchors are walked IN
 * ORDER; the first anchor whose path names a file in the diff and whose
 * 1-based new-side startLine falls inside a hunk's new-side span
 * `[newStart, newStart + newLineCount)` wins (`new_position = startLine`).
 * Deleted files have no new side, so they never match; renames match only
 * under their new path (that is what `FileDiff.path` carries).
 */
export function mapFindingsToInlineComments(findings: FindingView[], files: FileDiff[]): InlineMapping {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const inline: GiteaInlineComment[] = [];
  const demoted: FindingView[] = [];
  for (const finding of findings) {
    let mapped: GiteaInlineComment | null = null;
    for (const anchor of finding.anchors) {
      const file = byPath.get(anchor.path);
      if (file === undefined || file.status === "deleted") continue;
      // Span membership is the whole test: the new-side span covers exactly
      // the added+context lines, deleted lines never get a new-side number.
      const inHunk = file.hunks.some(
        (hunk) => anchor.startLine >= hunk.newStart && anchor.startLine < hunk.newStart + hunk.newLineCount,
      );
      if (!inHunk) continue;
      mapped = { finding, path: anchor.path, new_position: anchor.startLine };
      break;
    }
    if (mapped === null) demoted.push(finding);
    else inline.push(mapped);
  }
  return { inline, demoted };
}
