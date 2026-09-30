import { useState } from "react";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "@/components/ai-elements/tool";
import { MessageResponse } from "@/components/ai-elements/message";
import {
  CodeBlock,
  CodeBlockCopyButton,
} from "@/components/ai-elements/code-block";
import { fmtBytes } from "../../format";
import { codeLanguage } from "../code-lang";

// Chat building blocks on AI Elements primitives: the user prompt as a right
// bubble, thinking via Reasoning, markdown answers via MessageResponse
// (Streamdown), and every tool call as a collapsible Tool with a humanized
// title and a syntax-highlighted result.

export function UserBubble({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 1500;
  return (
    <div className="flex flex-col items-end gap-1">
      <div className={`pir-user-bubble${long && !open ? " clamped" : ""}`}>
        <div className="text">{text}</div>
      </div>
      {long && (
        <button
          className="text-[11px] font-mono text-indigo-400 hover:underline px-1.5"
          onClick={() => setOpen(!open)}
        >
          {open ? "collapse prompt" : `show full prompt · ${text.length.toLocaleString()} chars`}
        </button>
      )}
    </div>
  );
}

export function ThinkingBlock({ text, redacted, streaming = false }: { text: string; redacted?: boolean; streaming?: boolean }) {
  return (
    <Reasoning isStreaming={streaming} defaultOpen={false} className="w-full">
      <ReasoningTrigger
        getThinkingMessage={(isStreamingValue) =>
          redacted ? "thinking · redacted by provider" : isStreamingValue ? "thinking…" : "thinking"
        }
      />
      <ReasoningContent>{redacted ? "The provider redacted this reasoning." : text}</ReasoningContent>
    </Reasoning>
  );
}

export function TextBlockView({ text, streaming = false }: { text: string; streaming?: boolean }) {
  if (streaming) {
    return <div className="whitespace-pre-wrap text-sm text-muted-foreground">{text}<span className="text-primary animate-pulse">▍</span></div>;
  }
  return <MessageResponse>{text}</MessageResponse>;
}

// ---------------------------------------------------------------------------
// Tool calls: AI Elements Tool with a humanized one-line title
// (`read_code · src/server/web.ts:81`) and a highlighted result view.
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

/** Human-readable one-liner, e.g. `src/web.ts:80-120` or `"decode" in src/`. */
export function humanizeToolArgs(name: string, args: unknown): string {
  const a = (args ?? {}) as ToolArgs;
  const range = a.startLine !== undefined ? `:${a.startLine}${a.endLine !== undefined && a.endLine !== a.startLine ? `-${a.endLine}` : ""}` : "";
  switch (name) {
    case "read_code":
    case "read":
      return `${a.path ?? ""}${range}`;
    case "search_text":
    case "grep":
      return `"${a.pattern ?? a.query ?? ""}"${a.path ? ` in ${a.path}` : ""}`;
    case "find_symbol":
      return `symbol ${a.symbol ?? a.name ?? ""}`;
    case "find_callers":
      return `callers of ${a.symbol ?? a.name ?? ""}`;
    case "find_callees":
      return `callees of ${a.symbol ?? a.name ?? ""}`;
    case "find_references":
      return `references of ${a.symbol ?? a.name ?? ""}`;
    case "get_change":
      return a.base ? `${a.base.slice(0, 7)}..${(a.head ?? "").slice(0, 7)} diff` : "change diff";
    case "record_candidate":
      return a.title ? String(a.title).slice(0, 90) : "candidate";
    case "finish_round":
      return a.summary ? String(a.summary).slice(0, 90) : "end round";
    case "submit_verdict":
      return a.verdict ? `verdict: ${a.verdict}` : "verdict";
    default: {
      const first = Object.entries(a).find(([, value]) => typeof value === "string" || typeof value === "number");
      return first ? `${first[1]}`.slice(0, 90) : "";
    }
  }
}

/** Long tool results would freeze the page — cap and offer expand. */
const MAX_RESULT_CHARS = 96 * 1024;

function ResultView({ text, language, truncated, isErrorOnly = false }: { text: string; language?: string; truncated: boolean; isErrorOnly?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const clipped = text.length > MAX_RESULT_CHARS && !expanded;
  const shown = clipped ? `${text.slice(0, MAX_RESULT_CHARS)}\n… [truncated — ${fmtBytes(text.length)} total]` : text;
  if (isErrorOnly) {
    // Error results render inline in the ToolOutput's destructive panel.
    return <pre className="whitespace-pre-wrap break-words text-xs">{shown}</pre>;
  }
  return (
    <div className="flex flex-col gap-2">
      {clipped && (
        <button className="self-start text-[11px] font-mono text-indigo-400 hover:underline" onClick={() => setExpanded(true)}>
          show full result ({fmtBytes(text.length)})
        </button>
      )}
      <div className="rounded-lg border border-border overflow-hidden">
        <CodeBlock code={shown} language={codeLanguage(language)}>
          <CodeBlockCopyButton />
        </CodeBlock>
      </div>
      {truncated && <div className="text-[11px] text-muted-foreground">server truncated this result (live capture limit)</div>}
    </div>
  );
}

export type ToolState = "input-streaming" | "input-available" | "output-available" | "output-error";

export function ToolCallView({
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
  const summary = humanizeToolArgs(name, args);
  const state: ToolState = running
    ? "input-available"
    : result?.isError
      ? "output-error"
      : result
        ? "output-available"
        : "input-available";
  const resultLanguage: string | undefined =
    name === "get_change" ? "diff" : typeof (args as ToolArgs).path === "string" ? codeLanguage((args as ToolArgs).path) : undefined;

  return (
    <Tool defaultOpen={false}>
      <ToolHeader type={`tool-${name}` as `tool-${string}`} state={state} title={summary ? `${name} · ${summary}` : name} />
      <ToolContent>
        {args !== null && args !== undefined && Object.keys(args as object).length > 0 && <ToolInput input={args} />}
        {result && (
          <ToolOutput
            errorText={result.isError ? "tool execution failed" : undefined}
            output={
              result.isError
                ? <ResultView text={result.text} language={resultLanguage} truncated={result.truncated} isErrorOnly />
                : <ResultView text={result.text} language={resultLanguage} truncated={result.truncated} />
            }
          />
        )}
        {!result && !running && (
          <ToolOutput output={<div className="text-xs text-muted-foreground">no result recorded</div>} errorText={undefined} />
        )}
      </ToolContent>
    </Tool>
  );
}

export function RawBlock({ label, value }: { label: string; value: unknown }) {
  return (
    <Tool defaultOpen={false}>
      <ToolHeader type={`tool-${label}` as `tool-${string}`} state="output-available" title={label} />
      <ToolContent>
        <ToolInput input={value} />
      </ToolContent>
    </Tool>
  );
}
