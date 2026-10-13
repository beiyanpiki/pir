import { CheckCircle2, CircleDashed, Files, Gauge, Layers3 } from "lucide-react";
import type { AuditCoverageSummaryView, CoverageView } from "../types";

const AUDIT_KEYS: Array<[keyof AuditCoverageSummaryView, string]> = [
  ["filesInScope", "In scope"], ["filesReviewed", "Reviewed"], ["filesPartial", "Partial"],
  ["filesUnreviewed", "Unreviewed"], ["filesBlocked", "Blocked"], ["filesFailed", "Failed"],
  ["batchesTotal", "Units"], ["batchesCompleted", "Units reviewed"],
];

export function CoverageTab({ coverage }: { coverage?: CoverageView | null }) {
  if (!coverage || !coverage.available) {
    return <div className="empty-state is-compact"><Gauge size={18} /><strong>Coverage {coverage?.reason === "unavailable" ? "unavailable" : "not recorded"}</strong><p>Older runs may not have persisted a coverage ledger.</p></div>;
  }
  if (coverage.mode === "change") {
    const { summary } = coverage;
    const pct = summary.hunksTotal > 0 ? Math.round(summary.hunksCovered / summary.hunksTotal * 100) : null;
    return <div className="inspector-stack">
      <section className="inspector-section coverage-summary"><div className="inspector-section-title"><Gauge size={14} /> Change coverage</div>
        <div className="coverage-value"><strong>{pct === null ? "—" : `${pct}%`}</strong><span>{summary.hunksCovered} / {summary.hunksTotal} diff hunks read</span></div>
        {pct !== null && <div className="progress-track" aria-label={`${pct}% coverage`}><span style={{ width: `${pct}%` }} /></div>}
        <div className="coverage-grid"><div><span>Files covered</span><strong>{summary.filesCovered} / {summary.filesTotal}</strong></div><div><span>Hunks</span><strong>{summary.hunksCovered} / {summary.hunksTotal}</strong></div></div>
      </section><FileCoverageFiles files={summary.files} /></div>;
  }
  const { summary } = coverage;
  const inScope = summary.filesInScope;
  const reviewed = summary.filesReviewed;
  const pct = inScope > 0 ? Math.round(reviewed / inScope * 100) : null;
  return <div className="inspector-stack">
    <section className="inspector-section coverage-summary"><div className="inspector-section-title"><Gauge size={14} /> Audit coverage</div>
      <div className="coverage-value"><strong>{pct === null ? "—" : `${pct}%`}</strong><span>{reviewed} / {inScope} files reviewed</span></div>
      {pct !== null && <div className="progress-track" aria-label={`${pct}% coverage`}><span style={{ width: `${pct}%` }} /></div>}
      <div className="coverage-grid">{AUDIT_KEYS.map(([key, label]) => <div key={key}><span>{label}</span><strong>{String(summary[key])}</strong></div>)}</div>
    </section>
    {coverage.units.length > 0 && <section className="inspector-section"><div className="inspector-section-title"><Layers3 size={14} /> Review units</div><div className="unit-list">{coverage.units.map((unit) => <div className="unit-row" key={unit.id}><span className={`unit-state is-${unit.state}`} aria-label={unit.state}>{unit.state === "reviewed" ? <CheckCircle2 size={14} /> : <CircleDashed size={14} />}</span><div><strong>{unit.id} · {unit.state}</strong><small>{unit.module || "No module"} · {unit.files} files · {unit.attempts} attempts</small>{unit.reason && <p>{unit.reason}</p>}</div></div>)}</div></section>}
    <section className="inspector-section"><h2 className="inspector-section-title">File coverage</h2>{coverage.files.map((file) => <div className="unit-row" key={file.path}><code>{file.path}</code><span>{file.state} · {file.rangesReviewed}/{file.rangesTotal} ranges</span>{file.reason && <p>{file.reason}</p>}</div>)}</section>
  </div>;
}

function FileCoverageFiles({ files }: { files: Array<{ path: string; covered: number; total: number }> }) {
  if (files.length === 0) return null;
  return <section className="inspector-section"><div className="inspector-section-title"><Files size={14} /> Files</div><div className="compact-file-list">{files.map((file) => <div key={file.path}><span className="file-status">{file.covered === file.total ? "✓" : "·"}</span><code>{file.path}</code><span>{file.covered}/{file.total}</span></div>)}</div></section>;
}
