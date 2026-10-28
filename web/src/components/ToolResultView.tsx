import { Alert, Tag, Typography } from "antd";
import { parseDiff } from "../lib/diff-parse";
import { DiffView } from "./DiffView";

function prettyArgs(args: unknown): string {
  if (args === null || args === undefined) return "";
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

function summarizeArgs(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const record = args as Record<string, unknown>;
  for (const key of ["path", "file", "pattern", "query", "command", "unitId"]) {
    const value = record[key];
    if (typeof value === "string") return value.length > 120 ? `${value.slice(0, 117)}…` : value;
  }
  return undefined;
}

export function ToolResultView({ name, args, result, running = false }: {
  name: string;
  args: unknown;
  result?: { text: string; isError: boolean; truncated?: boolean };
  running?: boolean;
}) {
  const argText = prettyArgs(args);
  const diffFiles = result && !result.isError ? parseDiff(result.text) : [];
  const isDiff = diffFiles.length > 0 && /change|diff/i.test(name);
  return (
    <div>
      {argText && (
        <details style={{ marginBottom: 8 }}>
          <summary className="pir-muted" style={{ cursor: "pointer", fontSize: 12 }}>Tool arguments</summary>
          <pre className="pir-code-block" style={{ marginTop: 6 }}>{argText}</pre>
        </details>
      )}
      {!result && <Typography.Text type="secondary">{running ? "Running…" : "No result recorded for this tool call."}</Typography.Text>}
      {result?.isError && <Alert type="error" showIcon title="Tool call failed" description={<pre className="pir-code-block" style={{ marginTop: 8 }}>{result.text}</pre>} />}
      {result && !result.isError && isDiff && <DiffView files={diffFiles} />}
      {result && !result.isError && !isDiff && (
        <pre className="pir-code-block">{result.text.length > 40_000 ? `${result.text.slice(0, 40_000)}\n… truncated by the interface` : result.text}</pre>
      )}
      {result?.truncated && <div className="pir-muted" style={{ marginTop: 4, fontSize: 12 }}><Tag>truncated</Tag> The server truncated this tool result.</div>}
    </div>
  );
}

export { summarizeArgs };