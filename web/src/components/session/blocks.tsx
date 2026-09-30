import { useState } from "react";
import { Markdown } from "../Markdown";
import { CodeBlock } from "../CodeBlock";
import { fmtBytes, languageForPath } from "../../format";

// dsh-style chat primitives: a right user bubble for the prompt, a collapsed
// deep-thinking strip, plain markdown answers, and — the centerpiece —
// compact one-line tool strips with humanized arguments that expand into
// argument/result detail panels.

export function UserBubble({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 1500;
  return (
    <div className="user-turn">
      <div className={`user-bubble${long && !open ? " clamped" : ""}`}>
        <div className="user-bubble-text">{text}</div>
      </div>
      {long && (
        <button className="link-btn" onClick={() => setOpen(!open)}>
          {open ? "collapse prompt" : `show full prompt · ${text.length.toLocaleString()} chars`}
        </button>
      )}
    </div>
  );
}

export function ThinkingBlock({ text, redacted, streaming = false }: { text: string; redacted?: boolean; streaming?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <button className="thinking-strip" onClick={() => setOpen(!open)}>
        <span className={`chevron${open ? " open" : ""}`}>▶</span>
        {redacted ? "thinking · redacted by provider" : "深度思考"}
        <span style={{ color: "var(--pir-faint)" }}>· {text.length.toLocaleString()} chars</span>
        {streaming && <span className="pir-mini-spinner" />}
      </button>
      {open && <div className="thinking-body">{redacted ? "The provider redacted this reasoning." : text}</div>}
    </div>
  );
}

export function TextBlockView({ text, streaming = false }: { text: string; streaming?: boolean }) {
  if (streaming) return <div className="stream-text">{text}</div>;
  return <div className="answer-text"><Markdown text={text} /></div>;
}

// ---------------------------------------------------------------------------
// Tool calls: collapsed = one readable line; expanded = args + result.
// ---------------------------------------------------------------------------

interface ToolArgs {
  path?: string;
  startLine?: number;
  endLine?: number;
  pattern?: string;
  query?: string;
  symbol?: string;
  name?: string;
  id?: string;
  title?: string;
  summary?: string;
  verdict?: string;
  base?: string;
  head?: string;
  [key: string]: unknown;
}

const TOOL_ICONS: Record<string, string> = {
  read_code: "📄",
  read: "📄",
  ls: "📁",
  find: "📁",
  search_text: "🔎",
  grep: "🔎",
  find_symbol: "◈",
  find_callers: "←◈",
  find_callees: "◈→",
  find_references: "⇄",
  get_change: "±",
  list_snapshot_files: "🗂",
  get_project_memory: "🧠",
  get_feature_memory: "🧠",
  get_entity_memory: "🧠",
  get_relevant_issue_memory: "🧠",
  record_candidate: "✚",
  finish_round: "✓",
  submit_verdict: "⚖",
};

/** One human-readable summary of the call, e.g. `src/web.ts:80-120` or `"decode" in src/`. */
export function humanizeToolCall(name: string, args: unknown): { icon: string; arg: string } {
  const a = (args ?? {}) as ToolArgs;
  const icon = TOOL_ICONS[name] ?? "🛠";
  const range = a.startLine !== undefined ? `:${a.startLine}${a.endLine !== undefined && a.endLine !== a.startLine ? `-${a.endLine}` : ""}` : "";
  switch (name) {
    case "read_code":
    case "read":
      return { icon, arg: `${a.path ?? ""}${range}` };
    case "search_text":
    case "grep":
      return { icon, arg: `"${a.pattern ?? a.query ?? ""}"${a.path ? ` in ${a.path}` : ""}` };
    case "find_symbol":
      return { icon, arg: `symbol ${a.symbol ?? a.name ?? ""}` };
    case "find_callers":
      return { icon, arg: `callers of ${a.symbol ?? a.name ?? ""}` };
    case "find_callees":
      return { icon, arg: `callees of ${a.symbol ?? a.name ?? ""}` };
    case "find_references":
      return { icon, arg: `references of ${a.symbol ?? a.name ?? ""}` };
    case "get_change":
      return { icon, arg: a.base ? `${short(a.base)}..${short(a.head ?? "head")} diff` : "change diff" };
    case "record_candidate":
      return { icon, arg: a.title ? String(a.title).slice(0, 90) : "candidate" };
    case "finish_round":
      return { icon, arg: a.summary ? String(a.summary).slice(0, 90) : "end round" };
    case "submit_verdict":
      return { icon, arg: a.verdict ? `verdict: ${a.verdict}` : "verdict" };
    default: {
      const first = Object.entries(a).find(([, value]) => typeof value === "string" || typeof value === "number");
      return { icon, arg: first ? `${first[1]}`.slice(0, 90) : name };
    }
  }
}

function short(value: string): string {
  return value.slice(0, 7);
}

export function ToolCallView({
  call,
  result,
  running = false,
}: {
  call: { id: string; name: string; arguments: unknown };
  result?: { text: string; isError: boolean; truncated: boolean };
  running?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { icon, arg } = humanizeToolCall(call.name, call.arguments);
  const args = (call.arguments ?? {}) as ToolArgs;
  const resultLanguage = guessResultLanguage(call.name, args);
  const startLine = typeof args.startLine === "number" && resultLanguage !== "diff" ? args.startLine : undefined;
  const status = running ? "running" : result?.isError ? "error" : result ? "ok" : "pending";

  return (
    <div>
      <div
        className={`tool-strip${status === "running" ? " running" : ""}${status === "error" ? " error" : ""}`}
        onClick={() => setOpen(!open)}
      >
        <span className="tool-icon">{icon}</span>
        <span className="tool-name">{call.name}</span>
        <span className="tool-arg">{arg}</span>
        <span className="tool-tail">
          {status === "running" && <span className="pir-mini-spinner" aria-label="running" />}
          {status === "ok" && <span className="tool-status-ok" title="success">✓</span>}
          {status === "error" && <span className="tool-status-err" title="error">✕</span>}
          {result && !running && <span>{fmtBytes(result.text.length)}</span>}
          <span className={`chevron${open ? " open" : ""}`}>▶</span>
        </span>
      </div>
      {open && (
        <div className="tool-detail">
          {Object.keys(args).length > 0 && (
            <div>
              <div className="tool-detail-label">arguments</div>
              <CodeBlock code={JSON.stringify(call.arguments, null, 2)} language="json" wrap collapseOver={4_000} />
            </div>
          )}
          {result && (
            <div>
              <div className="tool-detail-label">{result.isError ? "result · error" : "result"}{result.truncated ? " · truncated" : ""}</div>
              <CodeBlock
                code={result.text}
                language={resultLanguage}
                title={undefined}
                lineNumbers={resultLanguage !== undefined && resultLanguage !== "diff"}
                startLine={startLine}
              />
            </div>
          )}
          {!result && !running && <div style={{ color: "var(--pir-faint)", fontSize: 12 }}>no result recorded</div>}
        </div>
      )}
    </div>
  );
}

function guessResultLanguage(name: string, args: ToolArgs): string | undefined {
  if (name === "get_change") return "diff";
  if (typeof args.path === "string") return languageForPath(args.path);
  return undefined;
}

export function RawBlock({ label, value }: { label: string; value: unknown }) {
  return (
    <div>
      <div className="tool-strip" style={{ cursor: "default" }}>
        <span className="tool-icon">?</span>
        <span className="tool-name">{label}</span>
      </div>
      <div className="tool-detail">
        <CodeBlock code={JSON.stringify(value, null, 2)} language="json" wrap collapseOver={4_000} />
      </div>
    </div>
  );
}
