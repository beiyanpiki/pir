import { useMemo, useState } from "react";
import hljs from "highlight.js/lib/common";
import { fmtBytes } from "../format";

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * Plain code viewer with optional line numbers, copy button and a soft size
 * cap — long tool outputs collapse behind "show all" instead of freezing the
 * page on megabyte reads.
 */
export function CodeBlock({
  code,
  language,
  title,
  lineNumbers = false,
  wrap = false,
  collapseOver = 40_000,
  startLine = 1,
}: {
  code: string;
  language?: string;
  title?: string;
  lineNumbers?: boolean;
  wrap?: boolean;
  collapseOver?: number;
  /** First line number to display (read_code results start mid-file). */
  startLine?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const truncated = code.length > collapseOver && !expanded;
  const shown = truncated ? `${code.slice(0, collapseOver)}\n… truncated (${fmtBytes(code.length)} total)` : code;

  const html = useMemo(() => {
    if (language && hljs.getLanguage(language)) {
      return hljs.highlight(shown, { language, ignoreIllegals: true }).value;
    }
    return escapeHtml(shown);
  }, [shown, language]);

  const numbered = useMemo(() => {
    if (!lineNumbers) return null;
    const lines = shown.split("\n").length;
    return (
      <span className="line-numbers" aria-hidden="true">
        {Array.from({ length: lines }, (_, index) => startLine + index).join("\n")}
      </span>
    );
  }, [shown, lineNumbers, startLine]);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // Clipboard unavailable (insecure context): ignore.
    }
  };

  return (
    <div className="codeblock">
      <div className="codeblock-head">
        <span>{title ?? language ?? "text"}</span>
        <span style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          {truncated && (
            <button className="copy-btn" onClick={() => setExpanded(true)}>show all</button>
          )}
          <button className="copy-btn" onClick={() => void copy()}>{copied ? "copied" : "copy"}</button>
        </span>
      </div>
      <pre className={wrap ? "wrap" : undefined}>
        {numbered && <code className="line-numbers-col">{numbered}</code>}
        <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </div>
  );
}
