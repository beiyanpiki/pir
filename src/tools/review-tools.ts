import { readFileSync, existsSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { Type } from "typebox";
import { readFileAtCommit } from "../changes/git.js";
import { addedLineNumbers } from "../changes/diff.js";
import type { ReviewTool } from "../agents/types.js";
import { safeResolve, toolError, type ToolContext } from "./context.js";
import type { CodeSymbol } from "../codemap/types.js";

const MAX_FILE_LINES = 800;
const MAX_WINDOW = 240;
const MAX_SEARCH_MATCHES = 50;

// ---------------------------------------------------------------------------
// read_code
// ---------------------------------------------------------------------------

export function createReadCodeTool(ctx: ToolContext): ReviewTool {
  return {
    name: "read_code",
    description:
      "Read source code at the reviewed commit. Returns numbered lines. Use windowed reads for large files.",
    promptSnippet: "read_code: read repository files at the reviewed commit (windowed)",
    parameters: Type.Object({
      path: Type.String({ description: "Repository-relative file path" }),
      startLine: Type.Optional(Type.Number({ description: "1-based first line" })),
      endLine: Type.Optional(Type.Number({ description: "1-based last line (window capped at 240 lines)" })),
    }),
    async execute(params) {
      const rel = String(params.path);
      const abs = safeResolve(ctx.repoRoot, rel);
      if (!abs) return { text: `ERROR: invalid path: ${rel}` };
      let content: string | null = null;
      if (existsSync(abs) && !statIsDir(abs)) {
        content = readFileSync(abs, "utf8");
      } else {
        content = await readFileAtCommit(ctx.repoRoot, ctx.headCommit, rel);
      }
      if (content === null) return { text: `ERROR: file not found: ${rel}` };
      const lines = content.split("\n");
      const start = Math.max(1, Number(params.startLine ?? 1));
      const end = Math.min(lines.length, Number(params.endLine ?? lines.length));
      if (end < start) return { text: `ERROR: empty window` };
      const windowStart = start;
      const windowEnd = Math.min(end, start + MAX_WINDOW - 1, start + MAX_FILE_LINES - 1);
      const rendered: string[] = [];
      for (let i = windowStart; i <= windowEnd; i++) {
        rendered.push(`${String(i).padStart(5)}| ${lines[i - 1] ?? ""}`);
      }
      const note =
        lines.length > windowEnd
          ? `\n(... ${lines.length - windowEnd} more lines; request a narrower window)`
          : "";
      return { text: rendered.join("\n") + note };
    },
  };
}

function statIsDir(abs: string): boolean {
  try {
    return statSync(abs).isDirectory();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// search_text
// ---------------------------------------------------------------------------

export function createSearchTextTool(ctx: ToolContext): ReviewTool {
  return {
    name: "search_text",
    description: "Search file contents for a literal or regular expression. Returns path:line matches.",
    promptSnippet: "search_text: ripgrep-style text search across the repository",
    parameters: Type.Object({
      pattern: Type.String({ description: "Text or regex pattern" }),
      isRegex: Type.Optional(Type.Boolean({ description: "Treat pattern as regex (default false)" })),
      glob: Type.Optional(Type.String({ description: 'File glob filter, e.g. "*.ts"' })),
      limit: Type.Optional(Type.Number({ description: "Max matches (default 50)" })),
    }),
    async execute(params) {
      const pattern = String(params.pattern);
      const isRegex = Boolean(params.isRegex);
      const glob = params.glob ? String(params.glob) : undefined;
      const limit = Math.min(Number(params.limit ?? MAX_SEARCH_MATCHES), MAX_SEARCH_MATCHES);
      const matches = await rgSearch(ctx.repoRoot, pattern, { isRegex, glob, limit });
      if (matches.length === 0) return { text: "No matches." };
      const summary = matches.slice(0, limit).map((m) => `${m.path}:${m.line}: ${m.text.slice(0, 200)}`);
      return { text: summary.join("\n") };
    },
  };
}

interface TextMatch {
  path: string;
  line: number;
  text: string;
}

async function rgSearch(
  repoRoot: string,
  pattern: string,
  opts: { isRegex: boolean; glob?: string; limit: number },
): Promise<TextMatch[]> {
  const args = ["-n", "--no-heading", "-S"];
  if (!opts.isRegex) args.push("-F");
  if (opts.glob) args.push("-g", opts.glob);
  args.push("--", pattern, repoRoot);
  const out = await new Promise<string | null>((resolve) => {
    const child = spawn("rg", args, { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.on("error", () => resolve(null));
    child.on("close", () => resolve(stdout));
  });
  if (out === null) return jsSearch(repoRoot, pattern, opts);
  const matches: TextMatch[] = [];
  for (const line of out.split("\n")) {
    if (!line) continue;
    const rest = line.startsWith(repoRoot + "/") ? line.slice(repoRoot.length + 1) : line;
    const m = /^([^:]+):(\d+):(.*)$/.exec(rest);
    if (m) matches.push({ path: m[1]!, line: Number(m[2]), text: m[3]! });
    if (matches.length >= opts.limit) break;
  }
  return matches;
}

async function jsSearch(
  repoRoot: string,
  pattern: string,
  opts: { isRegex: boolean; glob?: string; limit: number },
): Promise<TextMatch[]> {
  const { DegradedCodeMap } = await import("../codemap/provider.js");
  const files = await new DegradedCodeMap(repoRoot, "search fallback").fileOverview();
  const matcher = opts.isRegex ? new RegExp(pattern) : null;
  const matches: TextMatch[] = [];
  for (const file of files) {
    if (opts.glob && !simpleGlob(opts.glob, file.path)) continue;
    let content: string;
    try {
      content = readFileSync(`${repoRoot}/${file.path}`, "utf8");
    } catch {
      continue;
    }
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const hit = matcher ? matcher.test(lines[i]!) : lines[i]!.includes(pattern);
      if (hit) {
        matches.push({ path: file.path, line: i + 1, text: lines[i]! });
        if (matches.length >= opts.limit) return matches;
      }
    }
  }
  return matches;
}

function simpleGlob(glob: string, path: string): boolean {
  const re = new RegExp("^" + glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
  return re.test(path);
}

// ---------------------------------------------------------------------------
// get_change
// ---------------------------------------------------------------------------

export function createGetChangeTool(ctx: ToolContext): ReviewTool {
  return {
    name: "get_change",
    description: "Get the change under review: per-file diffs with hunk headers and added line numbers.",
    promptSnippet: "get_change: the diff under review (base..head)",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "Filter to one file" })),
    }),
    async execute(params) {
      const filter = params.path ? String(params.path) : undefined;
      const files = ctx.changeSet.files.filter((f) => !filter || f.path === filter);
      if (files.length === 0) return { text: filter ? `No changes for ${filter}` : "No changes in this changeset." };
      const parts: string[] = [
        `base ${ctx.changeSet.base} -> head ${ctx.changeSet.head} (${ctx.changeSet.churn} changed lines, ${ctx.changeSet.files.length} files)`,
      ];
      for (const file of files) {
        parts.push(`\n## ${file.path} [${file.status}] (+${file.additions}/-${file.deletions})`);
        if (file.oldPath) parts.push(`renamed from ${file.oldPath}`);
        const added = addedLineNumbers(file);
        if (added.length > 0) parts.push(`new lines touched: ${added.slice(0, 40).join(", ")}${added.length > 40 ? " ..." : ""}`);
        const body = file.hunks
          .map((h) => `${h.header}\n${h.lines.slice(0, 120).join("\n")}${h.lines.length > 120 ? "\n(...)" : ""}`)
          .join("\n");
        if (body) parts.push(body);
      }
      return { text: parts.join("\n") };
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

export function createFindSymbolTool(ctx: ToolContext): ReviewTool {
  return {
    name: "find_symbol",
    description: "Search the code index for symbols by name. Returns qualified names, kinds and locations.",
    promptSnippet: "find_symbol: symbol search over the structural index",
    parameters: Type.Object({
      query: Type.String({ description: "Symbol name or fragment" }),
      kind: Type.Optional(Type.String({ description: "Filter by kind, e.g. function/class/method" })),
    }),
    async execute(params) {
      try {
        const symbols = await ctx.codeMap.searchSymbols(String(params.query), {
          kind: params.kind ? String(params.kind) : undefined,
        });
        return { text: renderSymbols(symbols) };
      } catch (err) {
        return { text: toolError("find_symbol", err) };
      }
    },
  };
}

export function createFindCallersTool(ctx: ToolContext): ReviewTool {
  return {
    name: "find_callers",
    description: "Who calls this symbol? Requires a qualified symbol name from find_symbol.",
    parameters: Type.Object({ symbol: Type.String({ description: "Qualified symbol name" }) }),
    async execute(params) {
      try {
        return { text: renderSymbols(await ctx.codeMap.callers(String(params.symbol))) };
      } catch (err) {
        return { text: toolError("find_callers", err) };
      }
    },
  };
}

export function createFindCalleesTool(ctx: ToolContext): ReviewTool {
  return {
    name: "find_callees",
    description: "What does this symbol call? Requires a qualified symbol name from find_symbol.",
    parameters: Type.Object({ symbol: Type.String({ description: "Qualified symbol name" }) }),
    async execute(params) {
      try {
        return { text: renderSymbols(await ctx.codeMap.callees(String(params.symbol))) };
      } catch (err) {
        return { text: toolError("find_callees", err) };
      }
    },
  };
}

export function createFindReferencesTool(ctx: ToolContext): ReviewTool {
  return {
    name: "find_references",
    description: "Approximate references for a symbol: callers plus dependents (impact set).",
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
        return { text: renderSymbols([...seen.values()]) };
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
