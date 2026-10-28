import { Tag, Typography } from "antd";
import type { DiffFile } from "../lib/diff-parse";

/** Render parsed get_change output as readable hunks, never as a JSON wall. */
export function DiffView({ files }: { files: DiffFile[] }) {
  return (
    <div style={{ marginTop: 8 }}>
      {files.map((file) => (
        <div className="pir-diff-file" key={file.path}>
          <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap", marginBottom: 6 }}>
            <Tag color={file.status === "added" ? "green" : file.status === "deleted" ? "red" : "default"}>{file.status}</Tag>
            <Typography.Text code>{file.path}</Typography.Text>
            <span className="pir-muted" style={{ fontSize: 12 }}>+{file.additions} −{file.deletions} · {file.hunks.length} hunks</span>
          </div>
          <div style={{ border: "1px solid var(--pir-border)", borderRadius: 8, overflow: "hidden" }}>
            {file.hunks.map((hunk, hunkIndex) => (
              <div key={`${file.path}-${hunkIndex}`}>
                <div style={{ padding: "4px 10px", background: "var(--pir-surface-raised)", color: "var(--pir-text-muted)", fontSize: 12 }}>{hunk.header}</div>
                {hunk.lines.map((line, lineIndex) => (
                  <div className={`pir-diff-line ${line.kind === "add" ? "is-add" : line.kind === "delete" ? "is-delete" : ""}`} key={lineIndex}>
                    <span className="pir-line-no">{line.kind === "add" ? "+" : line.kind === "delete" ? "−" : " "}{(line.newLine ?? line.oldLine ?? "")}</span>
                    <span>{line.text || " "}</span>
                  </div>
                ))}
              </div>
            ))}
            {file.hunks.length === 0 && <div style={{ padding: 10 }} className="pir-muted">No inline hunks in this tool response.</div>}
          </div>
        </div>
      ))}
    </div>
  );
}
