import { useState } from "react";
import {
  Brain,
  CheckCircle2,
  Database,
  FileDiff,
  FileText,
  FolderOpen,
  GitBranch,
  PenLine,
  Scale,
  Search,
} from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { MessageResponse } from "@/components/ai-elements/message";
import {
  CodeBlock,
  CodeBlockCopyButton,
} from "@/components/ai-elements/code-block";
import { fmtBytes } from "../../format";
import { codeLanguage } from "../code-lang";

// ZCode-style activity stream rows: every step is one quiet line —
// "思考 · N chars", "读取 src/web.ts", "查阅 diff" — with the assistant's
// prose flat between them. Rows expand in place for the full details
// (AI Elements Reasoning/Tool panels live inside the collapsed area).

export function UserGoalCard({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const firstLine = text.split("\n").find((line) => line.trim().length > 0) ?? "";
  const summary = firstLine.length > 160 ? `${firstLine.slice(0, 160)}…` : firstLine;
  const long = text.length > 400;
  return (
    <div className="mx-auto flex w-fit max-w-[85%] items-center gap-2 rounded-xl border border-border bg-card px-4 py-2.5 shadow-sm shadow-black/20">
      <span className="shrink-0 font-mono text-[11px] uppercase tracking-[0.1em] text-primary">goal</span>
      <button
        className="min-w-0 truncate text-left text-[13px] text-foreground/90"
        title={text}
        onClick={() => long && setOpen(!open)}
      >
        {summary}
      </button>
      {open && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-8" onClick={() => setOpen(false)}>
          <div
            className="max-h-[80vh] w-full max-w-3xl overflow-y-auto rounded-xl border border-border bg-card p-5 text-left"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-3 text-[11px] font-mono uppercase tracking-[0.1em] text-primary">goal · full prompt</div>
            <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-foreground/80">{text}</pre>
          </div>
        </div>
      )}
    </div>
  );
}

export function ThinkingRow({ text, redacted, streaming = false }: { text: string; redacted?: boolean; streaming?: boolean }) {
  return (
    <Collapsible className="group/think">
      <CollapsibleTrigger className="flex w-full items-center gap-2 py-0.5 text-left text-[13px] text-muted-foreground/70 transition-colors hover:text-muted-foreground">
        <Brain size={14} className="shrink-0 opacity-70" />
        <span>{redacted ? "思考 · redacted by provider" : "思考"}</span>
        <span className="opacity-50">· {text.length.toLocaleString()} chars</span>
        {streaming && <span className="pir-mini-spinner" style={{ width: 9, height: 9 }} />}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="my-1 ml-6 border-l border-border pl-3 text-[12.5px] leading-relaxed whitespace-pre-wrap text-muted-foreground/90">
          {redacted ? "The provider redacted this reasoning." : text}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function TextBlockView({ text, streaming = false }: { text: string; streaming?: boolean }) {
  if (streaming) {
    return (
      <div className="whitespace-pre-wrap text-sm text-foreground/85">
        {text}
        <span className="animate-pulse text-primary">▍</span>
      </div>
    );
  }
  if (!text.trim()) return null;
  return (
    <div className="text-sm leading-relaxed text-foreground/90 [&_p]:my-1.5">
      <MessageResponse>{text}</MessageResponse>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tool rows: one quiet line per call, expanding to the full AI Elements Tool
// panel (parameters + highlighted result).
// ---------------------------------------------------------------------------

interface ToolArgs {
  path?: string;
  startLine?: number;
  endLine?: number;
  pattern?: string;
  query?: string;
  symbol?: string;
  name?: string;
  title?: string;
  verdict?: string;
  base?: string;
  head?: string;
  summary?: string;
  [key: string]: unknown;
}

interface ToolVerb {
  icon: React.ReactNode;
  verb: string;
  object: React.ReactNode;
}

/** Map a tool call to its activity-row presentation. */
export function toolRow(name: string, args: unknown): ToolVerb {
  const a = (args ?? {}) as ToolArgs;
  const range = a.startLine !== undefined ? `:${a.startLine}${a.endLine !== undefined && a.endLine !== a.startLine ? `-${a.endLine}` : ""}` : "";
  const fileObject = (filePath: string): React.ReactNode => {
    const slash = filePath.lastIndexOf("/");
    const base = slash >= 0 ? filePath.slice(slash + 1) : filePath;
    const dir = slash >= 0 ? filePath.slice(0, slash + 1) : "";
    const lang = codeLanguage(filePath);
    const tag = String(lang).toUpperCase().slice(0, 2);
    return (
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <span className="rounded-[3px] bg-sky-500/15 px-1 font-mono text-[9.5px] font-bold text-sky-400">{tag}</span>
        <span className="truncate text-foreground/80">{base}{range}</span>
        {dir && <span className="truncate text-muted-foreground/50">{dir}</span>}
      </span>
    );
  };
  switch (name) {
    case "read_code":
    case "read":
      return { icon: <FileText size={14} className="shrink-0 opacity-70" />, verb: "读取", object: a.path ? fileObject(a.path) : null };
    case "search_text":
    case "grep":
      return {
        icon: <Search size={14} className="shrink-0 opacity-70" />,
        verb: "查询",
        object: (
          <span className="truncate">
            <span className="text-foreground/80">"{a.pattern ?? a.query ?? ""}"</span>
            {a.path && <span className="text-muted-foreground/50"> in {a.path}</span>}
          </span>
        ),
      };
    case "find_symbol":
      return { icon: <GitBranch size={14} className="shrink-0 opacity-70" />, verb: "检索符号", object: <span className="truncate text-foreground/80">{a.symbol ?? a.name ?? ""}</span> };
    case "find_callers":
      return { icon: <GitBranch size={14} className="shrink-0 opacity-70" />, verb: "查找调用方", object: <span className="truncate text-foreground/80">{a.symbol ?? a.name ?? ""}</span> };
    case "find_callees":
      return { icon: <GitBranch size={14} className="shrink-0 opacity-70" />, verb: "查找被调", object: <span className="truncate text-foreground/80">{a.symbol ?? a.name ?? ""}</span> };
    case "find_references":
      return { icon: <GitBranch size={14} className="shrink-0 opacity-70" />, verb: "查找引用", object: <span className="truncate text-foreground/80">{a.symbol ?? a.name ?? ""}</span> };
    case "get_change":
      return { icon: <FileDiff size={14} className="shrink-0 opacity-70" />, verb: "查阅", object: <span className="truncate text-foreground/80">{a.base ? `${a.base.slice(0, 7)}..${(a.head ?? "").slice(0, 7)} diff` : "change diff"}</span> };
    case "list_snapshot_files":
      return { icon: <FolderOpen size={14} className="shrink-0 opacity-70" />, verb: "列出文件", object: null };
    case "get_project_memory":
    case "get_feature_memory":
    case "get_entity_memory":
    case "get_relevant_issue_memory":
      return { icon: <Database size={14} className="shrink-0 opacity-70" />, verb: "记忆", object: a.name ? <span className="truncate text-foreground/80">{String(a.name)}</span> : null };
    case "record_candidate":
      return { icon: <PenLine size={14} className="shrink-0 opacity-70" />, verb: "记录候选", object: a.title ? <span className="truncate text-foreground/80">{String(a.title).slice(0, 100)}</span> : null };
    case "finish_round":
      return { icon: <CheckCircle2 size={14} className="shrink-0 opacity-70" />, verb: "结束轮次", object: a.summary ? <span className="truncate text-foreground/80">{String(a.summary).slice(0, 100)}</span> : null };
    case "submit_verdict":
      return { icon: <Scale size={14} className="shrink-0 opacity-70" />, verb: "裁定", object: a.verdict ? <span className="truncate text-foreground/80">{a.verdict}</span> : null };
    default: {
      const first = Object.entries(a).find(([, value]) => typeof value === "string" || typeof value === "number");
      return { icon: <FileText size={14} className="shrink-0 opacity-70" />, verb: name, object: first ? <span className="truncate text-foreground/80">{`${first[1]}`.slice(0, 100)}</span> : null };
    }
  }
}

const MAX_RESULT_CHARS = 96 * 1024;

function ResultView({ text, language, truncated, isErrorOnly = false }: { text: string; language?: string; truncated: boolean; isErrorOnly?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const clipped = text.length > MAX_RESULT_CHARS && !expanded;
  const shown = clipped ? `${text.slice(0, MAX_RESULT_CHARS)}\n… [truncated — ${fmtBytes(text.length)} total]` : text;
  if (isErrorOnly) {
    return <pre className="whitespace-pre-wrap break-words text-xs">{shown}</pre>;
  }
  return (
    <div className="flex flex-col gap-2">
      {clipped && (
        <button className="self-start font-mono text-[11px] text-indigo-400 hover:underline" onClick={() => setExpanded(true)}>
          show full result ({fmtBytes(text.length)})
        </button>
      )}
      <div className="overflow-hidden rounded-lg border border-border">
        <CodeBlock code={shown} language={codeLanguage(language)}>
          <CodeBlockCopyButton />
        </CodeBlock>
      </div>
      {truncated && <div className="text-[11px] text-muted-foreground">server truncated this result (live capture limit)</div>}
    </div>
  );
}

export type ToolState = "input-streaming" | "input-available" | "output-available" | "output-error";

/** One activity row; expands to parameters + result. */
export function ToolRow({
  name,
  args,
  result,
  running = false,
}: {
  name: string;
  args: unknown;
  result?: { text: string; isError: boolean; truncated: boolean };
  running?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { icon, verb, object } = toolRow(name, args);
  const hasDetail = Boolean(result) || (args !== null && args !== undefined && Object.keys(args as object).length > 0);
  const resultLanguage: string | undefined =
    name === "get_change" ? "diff" : typeof (args as ToolArgs).path === "string" ? codeLanguage((args as ToolArgs).path) : undefined;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        className={`group/tool flex w-full items-center gap-2 py-[3px] text-left text-[13px] text-muted-foreground transition-colors hover:text-foreground/85 ${
          hasDetail ? "cursor-pointer" : "cursor-default"
        }`}
      >
        {icon}
        <span className="shrink-0">{verb}</span>
        {object && <span className="flex min-w-0 flex-1 items-center gap-1.5">{object}</span>}
        <span className="ml-auto flex shrink-0 items-center gap-2 text-[11px]">
          {running && <span className="pir-mini-spinner" style={{ width: 9, height: 9 }} />}
          {result && !running && (
            <span className={result.isError ? "text-red-400" : "text-emerald-500/80"}>{result.isError ? "✕" : "✓"}</span>
          )}
          {result && !running && <span className="text-muted-foreground/40">{fmtBytes(result.text.length)}</span>}
          {hasDetail && (
            <Chevronish open={open} />
          )}
        </span>
      </CollapsibleTrigger>
      {hasDetail && (
        <CollapsibleContent>
          <div className="my-1.5 ml-6 flex flex-col gap-3 rounded-lg border border-border bg-muted/20 p-3">
            {args !== null && args !== undefined && Object.keys(args as object).length > 0 && (
              <div>
                <div className="mb-1.5 text-[10px] uppercase tracking-[0.08em] text-muted-foreground">parameters</div>
                <div className="overflow-hidden rounded-md border border-border">
                  <CodeBlock code={JSON.stringify(args, null, 2)} language="json">
                    <CodeBlockCopyButton />
                  </CodeBlock>
                </div>
              </div>
            )}
            {result && (
              <div>
                <div className="mb-1.5 text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
                  {result.isError ? "error" : "result"}
                </div>
                {result.isError ? (
                  <pre className="whitespace-pre-wrap break-words rounded-md border border-red-500/30 bg-red-500/10 p-2.5 text-xs text-red-300">
                    {result.text}
                  </pre>
                ) : (
                  <ResultView text={result.text} language={resultLanguage} truncated={result.truncated} />
                )}
              </div>
            )}
            {!result && !running && <div className="text-xs text-muted-foreground">no result recorded</div>}
          </div>
        </CollapsibleContent>
      )}
    </Collapsible>
  );
}

function Chevronish({ open }: { open: boolean }) {
  return (
    <span
      className={`inline-block text-muted-foreground/50 transition-transform ${open ? "rotate-90" : ""}`}
      style={{ fontSize: 9 }}
    >
      ▶
    </span>
  );
}

export function RawBlock({ label, value }: { label: string; value: unknown }) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="flex w-full items-center gap-2 py-[3px] text-left text-[13px] text-muted-foreground/60">
        <FileText size={14} className="shrink-0 opacity-60" />
        <span className="shrink-0">{label}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="my-1.5 ml-6 overflow-hidden rounded-md border border-border">
          <CodeBlock code={JSON.stringify(value, null, 2)} language="json">
            <CodeBlockCopyButton />
          </CodeBlock>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
