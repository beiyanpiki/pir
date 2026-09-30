import { Binary, FileDiff, Info, Layers3, Plug, Timer } from "lucide-react";
import { fmtCost, fmtCount, fmtTime } from "../format";
import type { RunDetail } from "../types";

export function RunDetails({ detail }: { detail: RunDetail }) {
  const { run, manifest } = detail;

  return (
    <div className="inspector-stack">
      <section className="inspector-section">
        <div className="inspector-section-title"><Info size={14} /> Run</div>
        <dl className="detail-list">
          <div><dt>Status</dt><dd>{run.status}</dd></div>
          <div><dt>Run ID</dt><dd>{run.runId}</dd></div>
          <div><dt>Mode</dt><dd>{run.mode}</dd></div>
          <div><dt>Base</dt><dd>{run.base ?? "Snapshot audit"}</dd></div>
          <div><dt>Head</dt><dd>{run.head}</dd></div>
          <div><dt>Model</dt><dd>{run.model ?? manifest?.model ?? "pi default"}</dd></div>
          <div><dt>Started</dt><dd>{fmtTime(run.startedAt)}</dd></div>
          <div><dt>Finished</dt><dd>{run.finishedAt ? fmtTime(run.finishedAt) : "—"}</dd></div>
          <div><dt>Stop reason</dt><dd>{manifest?.stoppedBecause ?? run.notes ?? "—"}</dd></div>
        </dl>
      </section>

      {manifest?.usage && (
        <section className="inspector-section">
          <div className="inspector-section-title"><Binary size={14} /> Usage</div>
          <div className="compact-metrics">
            <div><span>Input</span><strong>{fmtCount(manifest.usage.inputTokens)}</strong></div>
            <div><span>Output</span><strong>{fmtCount(manifest.usage.outputTokens)}</strong></div>
            <div><span>Cache read</span><strong>{fmtCount(manifest.usage.cacheReadTokens)}</strong></div>
            <div><span>Cache write</span><strong>{fmtCount(manifest.usage.cacheWriteTokens)}</strong></div>
            <div><span>Tool calls</span><strong>{fmtCount(manifest.usage.toolCalls)}</strong></div>
            <div><span>Cost</span><strong>{fmtCost(manifest.usage.cost)}</strong></div>
          </div>
        </section>
      )}

      {manifest?.rounds && manifest.rounds.length > 0 && (
        <section className="inspector-section">
          <div className="inspector-section-title"><Timer size={14} /> Rounds</div>
          <div className="round-list">
            {manifest.rounds.map((round) => (
              <div className="round-row" key={round.round}>
                <div className="round-index">R{round.round}</div>
                <div className="round-body">
                  <div className="round-counts">
                    <span>{round.candidates} candidates</span>
                    <span className="metric-success">{round.confirmed} confirmed</span>
                    <span className="metric-muted">{round.rejected} rejected</span>
                    <span className="metric-warning">{round.uncertain} uncertain</span>
                  </div>
                  <p>{round.summary}</p>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {manifest?.files && manifest.files.length > 0 && (
        <section className="inspector-section">
          <div className="inspector-section-title"><FileDiff size={14} /> Changed files</div>
          <div className="compact-file-list">
            {manifest.files.map((file) => (
              <div key={file.path}>
                <span className="file-status">{file.status.slice(0, 1)}</span>
                <code>{file.path}</code>
                <span className="metric-success">+{file.additions}</span>
                <span className="metric-error">−{file.deletions}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {manifest?.plugins && manifest.plugins.length > 0 && (
        <section className="inspector-section">
          <div className="inspector-section-title"><Plug size={14} /> Guidance packs</div>
          <div className="plugin-list">
            {manifest.plugins.map((plugin) => (
              <div key={plugin.name}>
                <Layers3 size={13} />
                <span>{plugin.name}</span>
                <small>{plugin.version ?? plugin.activation ?? ""}</small>
              </div>
            ))}
          </div>
        </section>
      )}

      <p className="inspector-note">
        Review sessions run without extensions, skills, hooks, or write tools. Captured transcripts include model turns, reasoning blocks, and tool calls.
      </p>
    </div>
  );
}
