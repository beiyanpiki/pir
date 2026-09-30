import { useState } from "react";
import {
  Braces,
  Brain,
  CheckCircle2,
  ChevronRight,
  CircleCheck,
  CircleX,
  Database,
  FileDiff,
  FileText,
  FolderOpen,
  GitBranch,
  LoaderCircle,
  PenLine,
  Scale,
  Search,
  Target,
} from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { MessageResponse } from "@/components/ai-elements/message";
import {
  CodeBlock,
  CodeBlockCopyButton,
} from "@/components/ai-elements/code-block";
import { fmtBytes } from "../../format";
import { codeLanguage } from "../code-lang";
import { DiffView } from "./diff-view";

// ZCode-style activity stream rows: every step is one quiet line —
// "思考 · N chars", "读取 src/web.ts", "查阅 diff" — with the assistant's
// prose flat between them. Rows expand in place for the full details
// (AI Elements Reasoning/Tool panels live inside the collapsed area).

export function UserGoalCard({ text }: { text: string }) {
  const firstLine = text.split("\n").find((line) => line.trim().length > 0) ?? "";
  const summary = firstLine.length > 160 ? `${firstLine.slice(0, 160)}…` : firstLine;
  return (
    <Collapsible className="goal-block">
      <CollapsibleTrigger className="goal-toggle" aria-label="Toggle full review goal">
        <Target size={15} className="goal-icon" />
        <span className="goal-label">目标</span>
        <span className="goal-summary" title={text}>{summary}</span>
        <ChevronRight size={13} className="activity-chevron" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="goal-detail">{text}</pre>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function ThinkingRow({ text, redacted, streaming = false }: { text: string; redacted?: boolean; streaming?: boolean }) {
  return (
    <Collapsible className="activity-thinking" defaultOpen>
      <CollapsibleTrigger className="activity-row">
        <ChevronRight size={13} className="activity-chevron" />
        <Brain size={14} className="activity-icon" />
        <span>{redacted ? "思考 · redacted by provider" : "思考"}</span>
        <span className="activity-meta">{text.length.toLocaleString()} chars</span>
        {streaming && <LoaderCircle size={13} className="spin" />}
      </CollapsibleTrigger>
      <CollapsibleContent className="activity-content">
        <div className="reasoning-content">
          {redacted ? "The provider redacted this reasoning." : text}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function TextBlockView({ text, streaming = false }: { text: string; streaming?: boolean }) {
  if (streaming) {
    return (
      <div className="streaming-text">
        {text}
        <span>▍</span>
      </div>
    );
  }
  if (!text.trim()) return null;
  return (
    <div className="assistant-text">
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

const MAX_PREVIEW_CHARS = 16 * 1024;

function resultSummary(name: string, text: string, isError: boolean): string {
  if (isError) return "failed";
  if (name === "get_change") {
    const files = [...text.matchAll(/^##\s+"[^"]+"\s+\[[^\]]+\]\s+\(\+(\d+)\/-(\d+)\)/gm)];
    const additions = files.reduce((total, match) => total + Number(match[1]), 0);
    const deletions = files.reduce((total, match) => total + Number(match[2]), 0);
    return `${files.length || 1} file${files.length === 1 ? "" : "s"} · +${additions} / −${deletions}`;
  }
  const matches = text.match(/matchingLines:\s*(\d+)/i);
  if (matches) return `${matches[1]} match${matches[1] === "1" ? "" : "es"}`;
  const readLines = name === "read_code" || name === "read"
    ? [...text.matchAll(/^\s*\d+\|/gm)].length
    : 0;
  if (readLines > 0) return `${readLines} line${readLines === 1 ? "" : "s"}`;
  const returned = text.match(/returned:\s*(\d+)/i);
  if (returned && (name === "list_snapshot_files" || name.startsWith("find_"))) {
    return `${returned[1]} result${returned[1] === "1" ? "" : "s"}`;
  }
  const sourceLine = text.match(/^\s*(\d+)\|/);
  if (sourceLine) return `line ${sourceLine[1]}`;
  const candidate = text.match(/Recorded candidate\s+(F-[\w-]+)/);
  if (candidate) return candidate[1];
  if (/^Round complete\./m.test(text)) return "complete";
  const firstMeaningful = text.split("\n").find((line) =>
    line.trim() &&
    !/^(?:snapshot:|totalLines:|matchingLines:|entries:|continuation:|Line previews)/i.test(line),
  );
  return firstMeaningful ? firstMeaningful.trim().slice(0, 62) : "completed";
}

function SearchResults({ text }: { text: string }) {
  const rows = text.split("\n").flatMap((line) => {
    const match = line.match(/^(.+?):(\d+):\s*(.*)$/);
    return match ? [{ path: match[1], line: match[2], text: match[3] }] : [];
  });
  if (rows.length === 0) {
    return <div className="tool-result-note">{text.split("\n").find((line) => line.trim()) ?? "No output"}</div>;
  }
  return (
    <div className="tool-result-list">
      {rows.slice(0, 30).map((row, index) => (
        <div key={`${row.path}:${row.line}:${index}`}>
          <span>{row.path}:{row.line}</span>
          <code>{row.text}</code>
        </div>
      ))}
      {rows.length > 30 && <div className="result-more">+{rows.length - 30} more matches</div>}
    </div>
  );
}

function ResultView({ name, args, text, truncated, isError }: { name: string; args: ToolArgs; text: string; truncated: boolean; isError: boolean }) {
  const [showFull, setShowFull] = useState(false);
  const clipped = text.length > MAX_PREVIEW_CHARS && !showFull;
  const shown = clipped ? text.slice(0, MAX_PREVIEW_CHARS) : text;

  return (
    <div className="result-view">
      {isError ? (
        <pre className="tool-result-error">{shown}</pre>
      ) : name === "get_change" ? (
        <DiffView text={shown} />
      ) : name === "search_text" || name === "grep" ? (
        <SearchResults text={shown} />
      ) : /^(?:Recorded candidate|Round complete\.)/m.test(text) && text.length < 6000 ? (
        <div className="tool-result-note">{text.trim()}</div>
      ) : (
        <div className="tool-code-result">
          <CodeBlock code={shown} language={codeLanguage(typeof args.path === "string" ? args.path : undefined)}>
            <CodeBlockCopyButton />
          </CodeBlock>
        </div>
      )}
      {clipped && (
        <button className="text-command" type="button" onClick={() => setShowFull(true)}>
          Show full output · {fmtBytes(text.length)}
        </button>
      )}
      {truncated && <div className="result-caption">Server truncated this live result.</div>}
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
  const toolArgs = (args ?? {}) as ToolArgs;
  const summary = result ? resultSummary(name, result.text, result.isError) : running ? "running" : "no result";

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        className={`tool-row ${hasDetail ? "is-expandable" : ""}`}
      >
        <ChevronRight size={13} className="activity-chevron" />
        <span className="activity-icon">{icon}</span>
        <span className="tool-verb">{verb}</span>
        {object && <span className="tool-object">{object}</span>}
        <span className="tool-outcome">{summary}</span>
        <span className="tool-result-state">
          {running && <LoaderCircle size={13} className="spin" />}
          {result && !running && (
            <span className={result.isError ? "metric-error" : "metric-success"}>
              {result.isError ? <CircleX size={13} /> : <CircleCheck size={13} />}
            </span>
          )}
          {result && !running && <span className="activity-meta">{fmtBytes(result.text.length)}</span>}
        </span>
      </CollapsibleTrigger>
      {hasDetail && (
        <CollapsibleContent>
          <div className="tool-detail">
            {args !== null && args !== undefined && Object.keys(args as object).length > 0 && (
              <Collapsible className="tool-params">
                <CollapsibleTrigger>
                  <Braces size={12} />
                  <span>Parameters</span>
                  <span>{Object.keys(args as object).length} fields</span>
                  <ChevronRight size={12} className="activity-chevron" />
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <pre>{JSON.stringify(args, null, 2)}</pre>
                </CollapsibleContent>
              </Collapsible>
            )}
            {result && (
              <ResultView
                name={name}
                args={toolArgs}
                text={result.text}
                truncated={result.truncated}
                isError={result.isError}
              />
            )}
            {!result && !running && <div className="text-xs text-muted-foreground">no result recorded</div>}
          </div>
        </CollapsibleContent>
      )}
    </Collapsible>
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
