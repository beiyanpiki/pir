import { useState } from "react";
import { Markdown } from "../Markdown";
import { CodeBlock } from "../CodeBlock";
import { languageForPath } from "../../format";

function Chevron({ open }: { open: boolean }) {
  return <span className={`chevron${open ? " open" : ""}`}>▶</span>;
}

export function UserPromptBlock({ prompt }: { prompt: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="user-prompt">
      <div className="block-head" onClick={() => setOpen(!open)}>
        <Chevron open={open} /> prompt · {prompt.length.toLocaleString()} chars
      </div>
      {open && <div className="block-body">{prompt}</div>}
    </div>
  );
}

export function ThinkingBlock({ text, redacted, streaming = false }: { text: string; redacted?: boolean; streaming?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="chat-block thinking">
      <div className="block-head" onClick={() => setOpen(!open)}>
        <Chevron open={open} />
        {redacted ? "thinking (redacted by provider)" : "thinking"}
        <span style={{ color: "var(--text-faint)" }}>· {text.length.toLocaleString()} chars</span>
        {streaming && <span className="spinner" style={{ width: 10, height: 10 }} />}
      </div>
      {open && <div className="block-body">{redacted ? "The provider redacted this reasoning." : text}</div>}
    </div>
  );
}

export function TextBlockView({ text, streaming = false }: { text: string; streaming?: boolean }) {
  if (streaming) return <div className="stream-text">{text}</div>;
  return <div className="assistant-text"><Markdown text={text} /></div>;
}

/** Compact one-line argument preview for a tool-call header. */
export function toolArgsPreview(args: unknown): string {
  if (args === null || args === undefined) return "";
  if (typeof args !== "object") return String(args);
  const record = args as Record<string, unknown>;
  for (const key of ["path", "query", "pattern", "symbol", "name", "id", "action"]) {
    if (typeof record[key] === "string") return String(record[key]);
  }
  const first = Object.keys(record)[0];
  return first ? `${first}: ${JSON.stringify(record[first]).slice(0, 80)}` : "";
}

export function ToolCallView({
  call,
  result,
  open: initialOpen = false,
  running = false,
}: {
  call: { id: string; name: string; arguments: unknown };
  result?: { text: string; isError: boolean; truncated: boolean };
  open?: boolean;
  running?: boolean;
}) {
  const [open, setOpen] = useState(initialOpen);
  const argsText = JSON.stringify(call.arguments, null, 2) ?? "{}";
  const resultLanguage = guessResultLanguage(call.name, call.arguments);

  return (
    <div className={`chat-block toolcall${result?.isError ? " error" : ""}`}>
      <div className="block-head" onClick={() => setOpen(!open)}>
        <Chevron open={open} />
        <span className="tool-name">{call.name}</span>
        <span className="tool-args">{toolArgsPreview(call.arguments)}</span>
        <span className="spacer" />
        {running && <span className="spinner" style={{ width: 10, height: 10 }} />}
        {result && (
          <span style={{ color: result.isError ? "var(--err)" : "var(--text-faint)" }}>
            {result.isError ? "error" : `${result.text.length.toLocaleString()} chars`}
            {result.truncated ? " (truncated)" : ""}
          </span>
        )}
      </div>
      {open && (
        <div className="block-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <CodeBlock code={argsText} language="json" title={`${call.name} · arguments`} wrap />
          {result && (
            <CodeBlock
              code={result.text}
              language={resultLanguage}
              title={`${call.name} · result${result.isError ? " (error)" : ""}`}
              lineNumbers={resultLanguage !== undefined}
            />
          )}
        </div>
      )}
    </div>
  );
}

function guessResultLanguage(name: string, args: unknown): string | undefined {
  if (typeof args === "object" && args !== null) {
    const record = args as Record<string, unknown>;
    if (typeof record.path === "string") {
      if (name === "get_change") return "diff";
      return languageForPath(record.path);
    }
    if (name === "get_change") return "diff";
  }
  return undefined;
}

export function RawBlock({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="chat-block">
      <div className="block-head">{label}</div>
      <div className="block-body">
        <CodeBlock code={JSON.stringify(value, null, 2)} language="json" wrap />
      </div>
    </div>
  );
}
