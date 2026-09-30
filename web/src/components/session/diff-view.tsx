import { useEffect, useMemo, useState } from "react";
import { Columns2, Rows3 } from "lucide-react";
import type { CSSProperties } from "react";
import type { BundledLanguage } from "shiki";
import { highlightCode } from "../ai-elements/code-block";
import { codeLanguage } from "../code-lang";

type DiffLineKind = "context" | "add" | "delete";

interface DiffLine {
  kind: DiffLineKind;
  text: string;
  oldLine?: number;
  newLine?: number;
}

interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

interface DiffFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}

type DiffToken = {
  content: string;
  color?: string;
  fontStyle?: number;
  htmlStyle?: CSSProperties;
};

const FILE_HEADER = /^##\s+"([^"]+)"(?:\s+\[([^\]]+)\])?\s+\(\+(\d+)\/-(\d+)\)/;
const HUNK_HEADER = /^hunkIndex:\s*\d+;\s*(@@.*@@.*)$/;
const DIFF_BOUNDARY = /^(?:get_change:|##\s+"|entries:|continuation:|nextHunk:|truncated:)/;

export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  const lines = text.split("\n");
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  let inBody = false;

  const closeHunk = (): void => {
    if (hunk && file && hunk.lines.length > 0) file.hunks.push(hunk);
    hunk = null;
    inBody = false;
  };

  for (const line of lines) {
    const fileMatch = line.match(FILE_HEADER);
    if (fileMatch) {
      closeHunk();
      file = {
        path: fileMatch[1],
        status: fileMatch[2] ?? "modified",
        additions: Number(fileMatch[3]),
        deletions: Number(fileMatch[4]),
        hunks: [],
      };
      files.push(file);
      continue;
    }

    const hunkMatch = line.match(HUNK_HEADER);
    if (hunkMatch) {
      closeHunk();
      const header = hunkMatch[1];
      const range = header.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      oldLine = Number(range?.[1] ?? 1);
      newLine = Number(range?.[2] ?? 1);
      hunk = { header, lines: [] };
      inBody = true;
      continue;
    }

    if (inBody && hunk) {
      if (DIFF_BOUNDARY.test(line)) {
        closeHunk();
        continue;
      }
      if (/^(?:raw diff lines:|snapshot:|requested base:|hunk bodies omitted)/i.test(line)) continue;

      const marker = line.slice(0, 1);
      const value = line.slice(1);
      if (marker === "+") {
        hunk.lines.push({ kind: "add", text: value, newLine: newLine++ });
      } else if (marker === "-") {
        hunk.lines.push({ kind: "delete", text: value, oldLine: oldLine++ });
      } else if (marker === " " || line === "") {
        hunk.lines.push({ kind: "context", text: value, oldLine: oldLine++, newLine: newLine++ });
      }
      continue;
    }

    // Standalone tool output can contain a hunk without the parsed header.
    if (/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(line)) {
      closeHunk();
      const range = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      oldLine = Number(range?.[1] ?? 1);
      newLine = Number(range?.[2] ?? 1);
      hunk = { header: line, lines: [] };
      file ??= { path: "change", status: "modified", additions: 0, deletions: 0, hunks: [] };
      if (!files.includes(file)) files.push(file);
      inBody = true;
    }
  }
  closeHunk();
  return files.filter((candidate) => candidate.hunks.length > 0);
}

function rawTokens(code: string): DiffToken[][] {
  return code.split("\n").map((line) => (line ? [{ content: line }] : []));
}

function useHighlightedLines(code: string, language: BundledLanguage): DiffToken[][] {
  const initial = useMemo(
    () => highlightCode(code, language)?.tokens ?? rawTokens(code),
    [code, language],
  );
  const [tokens, setTokens] = useState<DiffToken[][]>(initial);

  useEffect(() => {
    setTokens(highlightCode(code, language)?.tokens ?? rawTokens(code));
    const result = highlightCode(code, language, (highlighted) => setTokens(highlighted.tokens));
    if (result) setTokens(result.tokens);
  }, [code, language]);

  return tokens;
}

function TokenLine({ tokens }: { tokens?: DiffToken[] }) {
  return (
    <span className="diff-code">
      {(tokens ?? []).map((token, index) => (
        <span
          key={`${token.content}-${index}`}
          className="dark:!text-[var(--shiki-dark)]"
          style={{
            color: token.color,
            fontStyle: token.fontStyle ? "italic" : undefined,
            ...token.htmlStyle,
          }}
        >
          {token.content}
        </span>
      ))}
      {tokens && tokens.length === 0 && " "}
    </span>
  );
}

function DiffHunkView({
  hunk,
  language,
  mode,
}: {
  hunk: DiffHunk;
  language: BundledLanguage;
  mode: "unified" | "split";
}) {
  const code = hunk.lines.map((line) => line.text).join("\n");
  const tokens = useHighlightedLines(code, language);
  const tokenByLine = (index: number): DiffToken[] | undefined => tokens[index];

  if (mode === "split") {
    const rows: Array<{ left?: { line: DiffLine; index: number }; right?: { line: DiffLine; index: number } }> = [];
    let index = 0;
    while (index < hunk.lines.length) {
      const line = hunk.lines[index];
      if (line.kind === "context") {
        rows.push({ left: { line, index }, right: { line, index } });
        index += 1;
        continue;
      }
      const deleted: Array<{ line: DiffLine; index: number }> = [];
      const added: Array<{ line: DiffLine; index: number }> = [];
      while (index < hunk.lines.length && hunk.lines[index].kind === "delete") {
        deleted.push({ line: hunk.lines[index], index });
        index += 1;
      }
      while (index < hunk.lines.length && hunk.lines[index].kind === "add") {
        added.push({ line: hunk.lines[index], index });
        index += 1;
      }
      for (let row = 0; row < Math.max(deleted.length, added.length); row += 1) {
        rows.push({ left: deleted[row], right: added[row] });
      }
    }

    return (
      <div className="diff-split">
        <div className="diff-split-head"><span>Before</span><span>After</span></div>
        {rows.map((row, rowIndex) => (
          <div className="diff-split-row" key={rowIndex}>
            <div className={`diff-cell is-${row.left?.line.kind ?? "empty"}`}>
              <span className="diff-line-number">{row.left?.line.oldLine ?? ""}</span>
              <span className="diff-marker">{row.left?.line.kind === "delete" ? "−" : row.left ? " " : ""}</span>
              <TokenLine tokens={row.left ? tokenByLine(row.left.index) : undefined} />
            </div>
            <div className={`diff-cell is-${row.right?.line.kind ?? "empty"}`}>
              <span className="diff-line-number">{row.right?.line.newLine ?? ""}</span>
              <span className="diff-marker">{row.right?.line.kind === "add" ? "+" : row.right ? " " : ""}</span>
              <TokenLine tokens={row.right ? tokenByLine(row.right.index) : undefined} />
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="diff-unified">
      {hunk.lines.map((line, index) => (
        <div className={`diff-line is-${line.kind}`} key={index}>
          <span className="diff-line-number">{line.oldLine ?? ""}</span>
          <span className="diff-line-number">{line.newLine ?? ""}</span>
          <span className="diff-marker">{line.kind === "add" ? "+" : line.kind === "delete" ? "−" : " "}</span>
          <TokenLine tokens={tokenByLine(index)} />
        </div>
      ))}
    </div>
  );
}

export function DiffView({ text }: { text: string }) {
  const [mode, setMode] = useState<"unified" | "split">("unified");
  const files = useMemo(() => parseDiff(text), [text]);

  return (
    <div className="diff-view">
      <div className="diff-toolbar">
        <span>{files.reduce((count, file) => count + file.hunks.length, 0)} hunks</span>
        <div className="diff-mode" role="group" aria-label="Diff layout">
          <button type="button" aria-pressed={mode === "unified"} onClick={() => setMode("unified")}>
            <Rows3 size={13} /> Single column
          </button>
          <button type="button" aria-pressed={mode === "split"} onClick={() => setMode("split")}>
            <Columns2 size={13} /> Two columns
          </button>
        </div>
      </div>
      <div className="diff-files">
        {files.length === 0 && (
          <pre className="diff-fallback">{text}</pre>
        )}
        {files.map((file, fileIndex) => (
          <section className="diff-file" key={`${fileIndex}-${file.path}`}>
            <header>
              <span className={`diff-status is-${file.status.toLowerCase().replace(/[^a-z0-9_-]+/g, "-")}`}>{file.status}</span>
              <strong>{file.path}</strong>
              <span className="diff-count is-add">+{file.additions}</span>
              <span className="diff-count is-delete">−{file.deletions}</span>
            </header>
            {file.hunks.map((hunk, index) => (
              <DiffHunkView key={`${hunk.header}-${index}`} hunk={hunk} language={codeLanguage(file.path)} mode={mode} />
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
