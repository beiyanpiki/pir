import { spawn } from "node:child_process";
import { Type } from "typebox";
import type { ReviewTool } from "../agents/types.js";
import { readReviewFile, resolveReviewRevision, safeResolve, toolError, type ReviewRevision, type ToolContext } from "./context.js";
import type { CodeSymbol } from "../codemap/types.js";
import type { RepoSnapshot } from "../changes/snapshot.js";

const MAX_WINDOW = 240;
const MAX_SEARCH_MATCHES = 50;
const MAX_BODY_CHARS = 16_000;
const MAX_OUTPUT_CHARS = 24_000;
const revisionSchema = Type.Optional(Type.Union([Type.Literal("head"), Type.Literal("base"), Type.Literal("merge-base")], {
  description: "Snapshot: head (default), requested base, or merge-base (old side of diff)",
}));

function integer(value: unknown, fallback: number, name: string, minimum = 0): number {
  const n = value === undefined ? fallback : value;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < minimum) {
    throw new Error(`${name} must be a safe integer >= ${minimum}`);
  }
  return n;
}

function revisionOf(value: unknown): ReviewRevision {
  if (value === undefined) return "head";
  if (value !== "head" && value !== "base" && value !== "merge-base") {
    throw new Error("revision must be head, base, or merge-base");
  }
  return value;
}

function bounded(text: string): { text: string } {
  return { text: text.length <= MAX_OUTPUT_CHARS ? text : text.slice(0, MAX_OUTPUT_CHARS - 40) + "\n(output character limit reached)" };
}

/** Page complete lines where possible; even a single huge line is recoverable. */
function pageLines(lines: string[], offset: number, limit: number, charOffset = 0, prefix = (_i: number) => ""): {
  lines: string[]; nextOffset: number; charOffset: number;
} {
  if (offset > lines.length) throw new Error("offset is beyond the available lines");
  if (charOffset > (lines[offset]?.length ?? 0)) throw new Error("charOffset is beyond the selected line");
  const output: string[] = [];
  let used = 0;
  let i = offset;
  for (; i < Math.min(lines.length, offset + limit); i++) {
    const label = prefix(i);
    const text = lines[i]!.slice(i === offset ? charOffset : 0);
    const available = MAX_BODY_CHARS - used - label.length - 1;
    if (text.length > available) {
      if (output.length > 0) break;
      output.push(label + text.slice(0, available));
      return { lines: output, nextOffset: i, charOffset: charOffset + available };
    }
    output.push(label + text);
    used += label.length + text.length + 1;
  }
  return { lines: output, nextOffset: i, charOffset: 0 };
}

// ---------------------------------------------------------------------------
// read_code
// ---------------------------------------------------------------------------

export function createReadCodeTool(ctx: ToolContext): ReviewTool {
  return {
    name: "read_code",
    description: "Read an explicit path at an immutable review snapshot, never the working tree. For deletes/renames use the old path with revision=merge-base (or base). Returns numbered, bounded pages and provenance.",
    promptSnippet: "read_code: pinned head/base/merge-base source, with window continuation",
    parameters: Type.Object({
      path: Type.String({ description: "Repository-relative path at the selected revision; no automatic rename mapping" }),
      revision: revisionSchema,
      startLine: Type.Optional(Type.Integer({ minimum: 1, description: "1-based first line" })),
      endLine: Type.Optional(Type.Integer({ minimum: 1, description: "1-based last line; each page capped at 240 lines and 24,000 characters" })),
      charOffset: Type.Optional(Type.Integer({ minimum: 0, description: "Character offset in first line, for oversized-line continuation" })),
    }),
    async execute(params) {
      try {
        if (typeof params.path !== "string") throw new Error("path must be a repository-relative string");
        const revision = revisionOf(params.revision);
        const start = integer(params.startLine, 1, "startLine", 1);
        const requestedEnd = integer(params.endLine, Number.MAX_SAFE_INTEGER, "endLine", 1);
        const charOffset = integer(params.charOffset, 0, "charOffset");
        if (requestedEnd < start) throw new Error("endLine must not precede startLine");
        const file = await readReviewFile(ctx, params.path, revision);
        const provenance = `snapshot: revision=${revision} commit=${file.commit} path=${JSON.stringify(file.path)}`;
        if (file.content === null) return bounded(`${provenance}\nERROR: file not found at this snapshot; request the actual old/new path explicitly for deletes or renames.`);
        const lines = file.content === "" ? [] : file.content.split("\n");
        if (file.content.endsWith("\n")) lines.pop();
        if (start > Math.max(1, lines.length)) throw new Error("startLine is beyond the file");
        const end = Math.min(requestedEnd, lines.length);
        const page = pageLines(lines, start - 1, Math.min(MAX_WINDOW, Math.max(0, end - start + 1)), charOffset, (i) => `${String(i + 1).padStart(5)}| `);
        const more = page.nextOffset < end;
        const continuation = more ? { path: file.path, revision, startLine: page.nextOffset + 1, endLine: end, ...(page.charOffset ? { charOffset: page.charOffset } : {}) } : null;
        return bounded([provenance, `totalLines: ${lines.length}; startLine: ${start}; charOffset: ${charOffset}`, ...page.lines,
          `truncated: ${more}; continuation: ${JSON.stringify(continuation)}`,
          end < lines.length ? `Additional file lines after requested endLine: ${lines.length - end}` : "",
        ].filter(Boolean).join("\n"));
      } catch (err) {
        return bounded(toolError("read_code", err));
      }
    },
  };
}

// ---------------------------------------------------------------------------
// search_text
// ---------------------------------------------------------------------------

export function createSearchTextTool(ctx: ToolContext): ReviewTool {
  return {
    name: "search_text",
    description: "Case-sensitive search of tracked text at one immutable review commit, not the working tree. Counts matching lines (not occurrences); bounded results have offset continuation. Regex uses Git extended regular expressions.",
    promptSnippet: "search_text: bounded literal/ERE search of pinned head/base/merge-base",
    parameters: Type.Object({
      pattern: Type.String({ minLength: 1, maxLength: 4096, description: "Single-line literal or extended regex" }),
      revision: revisionSchema,
      isRegex: Type.Optional(Type.Boolean({ description: "Treat pattern as extended regex (default false)" })),
      glob: Type.Optional(Type.String({ description: "Git wildmatch glob: *.ts matches any depth, src/*.ts one level, ** recursive, ? and [] supported; leading ! excludes" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, description: "Max matching lines (default/cap 50; also character-bounded)" })),
      offset: Type.Optional(Type.Integer({ minimum: 0, description: "Matching lines to skip, from continuation (default 0)" })),
    }),
    async execute(params) {
      try {
        if (typeof params.pattern !== "string" || !params.pattern || params.pattern.length > 4096 || /[\0\r\n]/.test(params.pattern)) {
          throw new Error("pattern must be a nonempty single-line string of at most 4096 characters, without NUL");
        }
        if (params.isRegex !== undefined && typeof params.isRegex !== "boolean") throw new Error("isRegex must be a boolean");
        const revision = revisionOf(params.revision);
        const isRegex = params.isRegex === true;
        const limit = Math.min(integer(params.limit, MAX_SEARCH_MATCHES, "limit", 1), MAX_SEARCH_MATCHES);
        const offset = integer(params.offset, 0, "offset");
        const pathspec = searchPathspec(ctx.repoRoot, params.glob);
        const commit = await resolveReviewRevision(ctx, revision);
        const result = await searchCommit(ctx.repoRoot, commit, params.pattern, { isRegex, pathspec, limit, offset });
        const continuation = result.hasMore ? { pattern: params.pattern, revision, isRegex, ...(params.glob === undefined ? {} : { glob: params.glob }), limit, offset: offset + result.matches.length } : null;
        return bounded([`snapshot: revision=${revision} commit=${commit}`,
          `matchingLines: ${result.hasMore ? ">=" : ""}${result.seen}; returned: ${result.matches.length}; offset: ${offset}; truncated: ${result.hasMore}`,
          result.matches.length ? result.matches.join("\n") : "No matches.",
          "Line previews are capped at 240 characters; use read_code for complete lines.",
          `continuation: ${JSON.stringify(continuation)}`,
        ].join("\n"));
      } catch (err) {
        return bounded(toolError("search_text", err));
      }
    },
  };
}

function searchPathspec(repoRoot: string, value: unknown): string[] {
  if (value === undefined) return [];
  if (typeof value !== "string" || value.length > 1024) throw new Error("glob must be a string of at most 1024 characters");
  const exclude = value.startsWith("!");
  let glob = exclude ? value.slice(1) : value;
  if (!safeResolve(repoRoot, glob)) throw new Error("invalid repository-relative glob");
  glob = glob.replace(/^(?:\.\/)+/, "");
  if (!glob.includes("/")) glob = `**/${glob}`;
  return exclude ? [":(top,glob)**", `:(top,glob,exclude)${glob}`] : [`:(top,glob)${glob}`];
}

/** Stream grep records; keep only one bounded preview and stop after one extra hit. */
async function searchCommit(repoRoot: string, commit: string, pattern: string, opts: {
  isRegex: boolean; pathspec: string[]; limit: number; offset: number;
}): Promise<{ matches: string[]; hasMore: boolean; seen: number }> {
  const args = ["-C", repoRoot, "--no-pager", "grep", "--no-color", "--full-name", "--no-textconv",
    "--no-column", "--no-heading", "--no-break", "--no-show-function", "--no-function-context",
    "--no-recurse-submodules", "--threads=1", "-n", "-z", "-I", opts.isRegex ? "-E" : "-F", "-e", pattern, commit, "--", ...opts.pathspec];
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { stdio: ["ignore", "pipe", "pipe"] });
    const matches: string[] = [];
    let seen = 0, used = 0, field = 0;
    let token = "", file = "", line = "", stderr = "";
    let hasMore = false;
    let failure: string | undefined;
    const timer = setTimeout(() => {
      failure = "search timed out; narrow the glob or pattern";
      child.kill();
    }, 30_000);
    const stop = (message?: string) => {
      failure = message;
      child.stdout.pause();
      child.kill();
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(0, 2000); });
    child.stdout.on("data", (chunk: string) => {
      if (hasMore || failure) return;
      let pos = 0;
      while (pos < chunk.length) {
        const delimiter = field === 2 ? "\n" : "\0";
        const end = chunk.indexOf(delimiter, pos);
        const part = chunk.slice(pos, end < 0 ? chunk.length : end);
        token += part.slice(0, Math.max(0, (field === 2 ? 240 : 8192) - token.length));
        if (field !== 2 && token.length >= 8192) { stop("git grep returned an oversized path record"); return; }
        if (end < 0) break;
        pos = end + 1;
        if (field === 0) { file = token.slice(commit.length + 1); field = 1; }
        else if (field === 1) { line = token; field = 2; }
        else {
          seen++;
          if (seen > opts.offset) {
            const displayPath = /[\r\n\t]/.test(file) ? JSON.stringify(file) : file;
            const match = `${displayPath}:${line}: ${token}`;
            if (matches.length >= opts.limit || used + match.length + 1 > MAX_BODY_CHARS) {
              hasMore = true; stop(); return;
            }
            matches.push(match);
            used += match.length + 1;
          }
          field = 0;
        }
        token = "";
      }
    });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failure) reject(new Error(failure));
      else if (!hasMore && code !== 0 && code !== 1) reject(new Error(`git grep failed: ${stderr.trim() || code}`));
      else resolve({ matches, hasMore, seen });
    });
  });
}


// ---------------------------------------------------------------------------
// get_change
// ---------------------------------------------------------------------------

export function createGetChangeTool(ctx: ToolContext): ReviewTool {
  return {
    name: "get_change",
    description: "Get the merge-base -> head diff. Defaults to a concise file overview (small diffs include full hunks). Select path+hunkIndex for raw diff lines, including removed code; follow offset/limit and charOffset continuation to recover all content.",
    promptSnippet: "get_change: merge-base -> head overview; path+hunkIndex+offset pages recover both sides",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "Filter by current or old repository-relative path" })),
      hunkIndex: Type.Optional(Type.Integer({ minimum: 0, description: "0-based hunk index; requires path. If omitted with path, pages the hunk index." })),
      offset: Type.Optional(Type.Integer({ minimum: 0, description: "0-based page offset: files in overview, hunks with path, raw diff lines with path+hunkIndex" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, description: "Page size: default/cap 20/50 files or hunks, 120/240 raw diff lines" })),
      charOffset: Type.Optional(Type.Integer({ minimum: 0, description: "Character offset within the first diff line (requires path+hunkIndex)" })),
    }),
    async execute(params) {
      try {
        if (!ctx.changeSet) throw new Error("get_change is unavailable in this review mode (no diff to inspect)");
        const filter = params.path;
        if (filter !== undefined && (typeof filter !== "string" || !safeResolve(ctx.repoRoot, filter))) {
          throw new Error("invalid repository-relative path");
        }
        if (params.hunkIndex !== undefined && filter === undefined) throw new Error("hunkIndex requires path");
        if (params.charOffset !== undefined && params.hunkIndex === undefined) throw new Error("charOffset requires path and hunkIndex");
        const offset = integer(params.offset, 0, "offset");
        const hunkIndex = params.hunkIndex === undefined ? undefined : integer(params.hunkIndex, 0, "hunkIndex");
        const limit = Math.min(integer(params.limit, hunkIndex === undefined ? 20 : 120, "limit", 1), hunkIndex === undefined ? 50 : MAX_WINDOW);
        const charOffset = integer(params.charOffset, 0, "charOffset");
        const [head, base, mergeBase] = await Promise.all([resolveReviewRevision(ctx), resolveReviewRevision(ctx, "base"), resolveReviewRevision(ctx, "merge-base")]);
        const header = `merge-base ${mergeBase} -> head ${head} (${ctx.changeSet.churn} changed lines, ${ctx.changeSet.files.length} files)\nrequested base: ${base}`;
        const files = ctx.changeSet.files.filter((f) => filter === undefined ||
          safeResolve(ctx.repoRoot, f.path) === safeResolve(ctx.repoRoot, filter as string) ||
          (f.oldPath !== undefined && safeResolve(ctx.repoRoot, f.oldPath) === safeResolve(ctx.repoRoot, filter as string)));
        if (files.length === 0) return bounded(`${header}\n${filter === undefined ? "No changes in this changeset." : `No changes for ${JSON.stringify(filter)}`}`);
        if (filter !== undefined && files.length > 1) {
          throw new Error("path identifies multiple changed files; use an unambiguous current path");
        }
        const file = files[0]!;
        const fileLabel = (f: typeof file) => `## ${JSON.stringify(f.path)} [${f.status}] (+${f.additions}/-${f.deletions}); hunks: ${f.hunks.length}${f.oldPath ? `; renamed from ${JSON.stringify(f.oldPath)}` : ""}`;
        if (hunkIndex !== undefined) {
          const hunk = file.hunks[hunkIndex];
          if (!hunk) throw new Error("hunkIndex is beyond the available hunks");
          const page = pageLines(hunk.lines, offset, limit, charOffset);
          const more = page.nextOffset < hunk.lines.length;
          const continuation = more ? { path: file.path, hunkIndex, offset: page.nextOffset, limit, ...(page.charOffset ? { charOffset: page.charOffset } : {}) } : null;
          const nextHunk = hunkIndex + 1 < file.hunks.length ? { path: file.path, hunkIndex: hunkIndex + 1, offset: 0, limit } : null;
          return bounded([header, fileLabel(file), `hunkIndex: ${hunkIndex}; ${hunk.header}`,
            `raw diff lines: ${hunk.lines.length}; offset: ${offset}; charOffset: ${charOffset}`,
            ...page.lines, `truncated: ${more}; continuation: ${JSON.stringify(continuation)}`,
            `nextHunk: ${JSON.stringify(nextHunk)}`,
          ].join("\n"));
        }
        const items = filter === undefined ? files : file.hunks;
        if (offset > items.length) throw new Error("offset is beyond the available entries");
        const parts = [header];
        if (filter !== undefined) parts.push(fileLabel(file));
        let used = parts.join("\n").length;
        let nextOffset = offset;
        let omittedHunks = false;
        // Inline complete small diffs, but never let a large body crowd out navigation.
        let inlineLines = 80;
        for (; nextOffset < Math.min(items.length, offset + limit); nextOffset++) {
          let entry: string;
          if (filter === undefined) {
            const current = files[nextOffset]!;
            entry = `${fileLabel(current)}\nget_change: ${JSON.stringify({ path: current.path })}`;
            const lineCount = current.hunks.reduce((sum, h) => sum + h.lines.length, 0);
            if (lineCount <= inlineLines && current.hunks.length <= 10) {
              const bodies = current.hunks.map((h, index) => `hunkIndex: ${index}; ${h.header}\n${h.lines.join("\n")}`).join("\n");
              if (bodies.length <= 4000 && used + entry.length + bodies.length < MAX_BODY_CHARS) {
                entry += bodies ? `\n${bodies}` : "";
                inlineLines -= lineCount;
              } else omittedHunks ||= current.hunks.length > 0;
            } else omittedHunks ||= current.hunks.length > 0;
          } else {
            const hunk = file.hunks[nextOffset]!;
            entry = `hunkIndex: ${nextOffset}; ${hunk.header}; raw diff lines: ${hunk.lines.length}\nget_change: ${JSON.stringify({ path: file.path, hunkIndex: nextOffset, offset: 0, limit: 120 })}`;
            if (hunk.lines.length <= inlineLines) {
              const body = hunk.lines.join("\n");
              if (body.length <= 4000 && used + entry.length + body.length < MAX_BODY_CHARS) {
                entry += body ? `\n${body}` : "";
                inlineLines -= hunk.lines.length;
              } else omittedHunks = true;
            } else omittedHunks = true;
          }
          if (used + entry.length + 1 > MAX_BODY_CHARS && nextOffset > offset) break;
          parts.push(entry);
          used += entry.length + 1;
        }
        const more = nextOffset < items.length;
        const continuation = more ? { ...(filter === undefined ? {} : { path: file.path }), offset: nextOffset, limit } : null;
        parts.push(`entries: ${items.length}; returned: ${nextOffset - offset}; offset: ${offset}; truncated: ${more || omittedHunks}`);
        parts.push(`continuation: ${JSON.stringify(continuation)}`);
        if (omittedHunks) parts.push("Hunk bodies omitted in overview; use the get_change requests above, then follow continuation for both -removed and +added lines.");
        return bounded(parts.join("\n"));
      } catch (err) {
        return bounded(toolError("get_change", err));
      }
    },
  };
}

// ---------------------------------------------------------------------------
// list_snapshot_files (audit mode)
// ---------------------------------------------------------------------------

/**
 * Paginated inventory of the pinned audit snapshot: the coverage denominator.
 * Entries carry their selection/classification so exclusions are visible, not
 * silent. Navigation-grade only — file content still comes from read_code.
 */
export function createListSnapshotFilesTool(ctx: ToolContext, snapshot: RepoSnapshot): ReviewTool {
  return {
    name: "list_snapshot_files",
    description: "List committed files of the pinned audit snapshot with selection/classification and provenance. Paginated; use read_code for content.",
    promptSnippet: "list_snapshot_files: pinned inventory of auditable files (audit mode)",
    parameters: Type.Object({
      prefix: Type.Optional(Type.String({ description: "Optional repository-relative directory prefix filter" })),
      offset: Type.Optional(Type.Integer({ minimum: 0, description: "0-based page offset (default 0)" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, description: "Page size (default/cap 100)" })),
    }),
    async execute(params) {
      try {
        const prefix = params.prefix === undefined ? "" : String(params.prefix).replace(/^\.\//, "").replace(/\/+$/, "");
        if (prefix && (prefix.startsWith("/") || prefix.split("/").includes("..") || prefix.includes("\0"))) {
          throw new Error("invalid repository-relative prefix");
        }
        const offset = integer(params.offset, 0, "offset");
        const limit = Math.min(integer(params.limit, 100, "limit", 1), 200);
        const entries = snapshot.entries.filter((entry) => !prefix || entry.path.startsWith(`${prefix}/`) || entry.path === prefix);
        if (offset > entries.length) throw new Error("offset is beyond the available entries");
        const page = entries.slice(offset, offset + limit);
        const lines = page.map((entry) => {
          const note = entry.selection === "selected"
            ? entry.classification === "text" ? "in scope" : `in scope, not reviewable (${entry.classification})`
            : `${entry.selection}${entry.exclusionReason ? ` (${entry.exclusionReason})` : ""}`;
          const size = entry.size === null ? "" : `, ${entry.size}B`;
          return `${JSON.stringify(entry.path)} [${note}]${size}`;
        });
        const more = offset + limit < entries.length;
        return bounded([
          `snapshot: commit=${snapshot.commit} tree=${snapshot.treeId} (immutable audit inventory)`,
          `entries: ${entries.length}; returned: ${page.length}; offset: ${offset}; truncated: ${more}`,
          ...lines,
          `continuation: ${JSON.stringify(more ? { offset: offset + limit, limit, ...(prefix ? { prefix } : {}) } : null)}`,
        ].join("\n"));
      } catch (err) {
        return bounded(toolError("list_snapshot_files", err));
      }
    },
  };
}

// ---------------------------------------------------------------------------
// code map tools: find_symbol / find_callers / find_callees / find_references / code_map
// ---------------------------------------------------------------------------

function renderSymbols(symbols: CodeSymbol[], cap = 20): string {
  if (symbols.length === 0) return "No results.";
  return symbols
    .slice(0, cap)
    .map((s) => `${s.qualifiedName} [${s.kind}] ${s.filePath}:${s.startLine}${s.signature ? ` — ${s.signature.slice(0, 120)}` : ""}`)
    .join("\n") + (symbols.length > cap ? `\n(... ${symbols.length - cap} more)` : "");
}

function navigationResult(ctx: ToolContext, symbols: CodeSymbol[]): { text: string } {
  return bounded(`provenance: unpinned ${ctx.codeMap.kind} structural index; navigation only, not evidence of the reviewed snapshot. Verify paths and lines with read_code at head/base/merge-base.\n${renderSymbols(symbols)}`);
}

export function createFindSymbolTool(ctx: ToolContext): ReviewTool {
  return {
    name: "find_symbol",
    description: "Locate a symbol's qualified name, kind and definition site across the repository — the entry point for structural queries. Results come from an unpinned structural index: navigation only; verify paths/lines with read_code at the selected review revision.",
    promptSnippet: "find_symbol: locate a symbol's qualified name via the structural index; entry point for find_callers/find_callees/find_references",
    parameters: Type.Object({
      query: Type.String({ description: "Symbol name or fragment" }),
      kind: Type.Optional(Type.String({ description: "Filter by kind, e.g. function/class/method" })),
    }),
    async execute(params) {
      try {
        const symbols = await ctx.codeMap.searchSymbols(String(params.query), {
          kind: params.kind ? String(params.kind) : undefined,
        });
        return navigationResult(ctx, symbols);
      } catch (err) {
        return { text: toolError("find_symbol", err) };
      }
    },
  };
}

export function createFindCallersTool(ctx: ToolContext): ReviewTool {
  return {
    name: "find_callers",
    description: "Enumerate a symbol's approximate call sites — the fastest way to answer who-calls-this, typically cheaper and more complete than repeated search_text. Requires a qualified symbol name from find_symbol. Results come from an unpinned structural index: navigation only; verify each candidate with pinned read_code.",
    promptSnippet: "find_callers: enumerate approximate call sites of a qualified symbol (unpinned; confirm with read_code)",
    parameters: Type.Object({ symbol: Type.String({ description: "Qualified symbol name" }) }),
    async execute(params) {
      try {
        return navigationResult(ctx, await ctx.codeMap.callers(String(params.symbol)));
      } catch (err) {
        return { text: toolError("find_callers", err) };
      }
    },
  };
}

export function createFindCalleesTool(ctx: ToolContext): ReviewTool {
  return {
    name: "find_callees",
    description: "Enumerate a symbol's approximate callees — what it calls. Requires a qualified symbol name from find_symbol. Results come from an unpinned structural index: navigation only; verify each candidate with pinned read_code.",
    promptSnippet: "find_callees: enumerate approximate callees of a qualified symbol (unpinned; confirm with read_code)",
    parameters: Type.Object({ symbol: Type.String({ description: "Qualified symbol name" }) }),
    async execute(params) {
      try {
        return navigationResult(ctx, await ctx.codeMap.callees(String(params.symbol)));
      } catch (err) {
        return { text: toolError("find_callees", err) };
      }
    },
  };
}

export function createFindReferencesTool(ctx: ToolContext): ReviewTool {
  return {
    name: "find_references",
    description: "Enumerate a symbol's approximate references — callers and dependents — for blast-radius and impact questions. Requires a qualified symbol name from find_symbol. Results come from an unpinned structural index: navigation only, not snapshot evidence; verify each candidate with pinned read_code.",
    promptSnippet: "find_references: enumerate approximate callers and dependents of a qualified symbol (unpinned; confirm with read_code)",
    parameters: Type.Object({ symbol: Type.String({ description: "Qualified symbol name" }) }),
    async execute(params) {
      try {
        const symbol = String(params.symbol);
        const [callers, dependents] = await Promise.all([
          ctx.codeMap.callers(symbol),
          ctx.codeMap.dependents(symbol, { depth: 1 }),
        ]);
        const seen = new Map<string, CodeSymbol>();
        for (const s of [...callers, ...dependents]) seen.set(s.qualifiedName, s);
        return navigationResult(ctx, [...seen.values()]);
      } catch (err) {
        return { text: toolError("find_references", err) };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// memory tools
// ---------------------------------------------------------------------------

export function createMemoryTools(ctx: ToolContext): ReviewTool[] {
  const none = (what: string): ReviewTool => ({
    name: what,
    description: "Repository memory lookup.",
    parameters: Type.Object({}),
    async execute() {
      return { text: "No repository memory available for this project." };
    },
  });

  if (!ctx.memory) {
    return [none("get_project_memory"), none("get_feature_memory"), none("get_entity_memory")];
  }

  const getProjectMemory: ReviewTool = {
    name: "get_project_memory",
    description: "Project-level memory: architecture, responsibilities, invariants, conventions, risks.",
    parameters: Type.Object({}),
    async execute() {
      const mem = ctx.memory!.projectMemory.get();
      if (!mem) return { text: "No project memory. Consider `pir memory bootstrap`." };
      return {
        text: [
          `architecture: ${mem.architectureSummary || "(none)"}`,
          `responsibilities:\n${mem.responsibilities.map((r) => `- ${r}`).join("\n") || "(none)"}`,
          `invariants:\n${mem.invariants.map((r) => `- ${r}`).join("\n") || "(none)"}`,
          `conventions:\n${mem.conventions.map((r) => `- ${r}`).join("\n") || "(none)"}`,
          `risk areas:\n${mem.riskAreas.map((r) => `- ${r}`).join("\n") || "(none)"}`,
          mem.stale ? "(project memory is marked stale — revalidate against code)" : "",
        ]
          .filter(Boolean)
          .join("\n"),
      };
    },
  };

  const getFeatureMemory: ReviewTool = {
    name: "get_feature_memory",
    description: "Feature-level memory: summary, invariants, entry points. Feature keys come from entity memory or project memory.",
    parameters: Type.Object({ key: Type.String({ description: "Feature key, e.g. payment-retry" }) }),
    async execute(params) {
      const feature = ctx.memory!.features.get(String(params.key));
      if (!feature) return { text: `No memory for feature "${params.key}".` };
      return {
        text: [
          `${feature.name}: ${feature.summary || "(no summary)"}`,
          `invariants:\n${feature.invariants.map((i) => `- ${i}`).join("\n") || "(none)"}`,
          `entry points: ${feature.entryPoints.join(", ") || "(none)"}`,
          feature.stale ? "(possibly stale — revalidate)" : "",
        ]
          .filter(Boolean)
          .join("\n"),
      };
    },
  };

  const getEntityMemory: ReviewTool = {
    name: "get_entity_memory",
    description: "Symbol-level memory: responsibilities, invariants, notes.",
    parameters: Type.Object({ symbolKey: Type.String({ description: "Symbol key, e.g. PaymentService.retry" }) }),
    async execute(params) {
      const entity = ctx.memory!.entities.get(String(params.symbolKey));
      if (!entity) return { text: `No memory for symbol "${params.symbolKey}".` };
      return {
        text: [
          `${entity.qualifiedName} [${entity.kind}] ${entity.path}`,
          `responsibilities:\n${entity.responsibilities.map((i) => `- ${i}`).join("\n") || "(none)"}`,
          `invariants:\n${entity.invariants.map((i) => `- ${i}`).join("\n") || "(none)"}`,
          `notes:\n${entity.notes.map((i) => `- ${i}`).join("\n") || "(none)"}`,
          entity.stale ? "(possibly stale — revalidate)" : "",
        ]
          .filter(Boolean)
          .join("\n"),
      };
    },
  };

  return [getProjectMemory, getFeatureMemory, getEntityMemory];
}
