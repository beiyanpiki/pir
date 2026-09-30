import { CheckCircle2, CircleDashed, Files, Gauge, Layers3 } from "lucide-react";
import type { RunManifest } from "../types";

const COVERAGE_KEYS: Array<[string, string]> = [
  ["filesInScope", "In scope"],
  ["filesReviewed", "Reviewed"],
  ["filesPartial", "Partial"],
  ["filesUnreviewed", "Unreviewed"],
  ["filesBlocked", "Blocked"],
  ["filesFailed", "Failed"],
  ["unitsTotal", "Units"],
  ["unitsReviewed", "Units reviewed"],
];

export function CoverageTab({ manifest }: { manifest: RunManifest }) {
  const coverage = manifest.coverage ?? {};
  const inScope = Number(coverage.filesInScope ?? 0);
  const reviewed = Number(coverage.filesReviewed ?? 0);
  const partial = Number(coverage.filesPartial ?? 0);
  const pct = inScope > 0 ? Math.round(((reviewed + partial) / inScope) * 100) : 0;
  const units = manifest.units ?? [];

  return (
    <div className="inspector-stack">
      <section className="inspector-section coverage-summary">
        <div className="inspector-section-title"><Gauge size={14} /> Snapshot coverage</div>
        <div className="coverage-value">
          <strong>{pct}%</strong>
          <span>{reviewed + partial} / {inScope} files touched</span>
        </div>
        <div className="progress-track" aria-label={`${pct}% coverage`}>
          <span style={{ width: `${pct}%` }} />
        </div>
        <div className="coverage-grid">
          {COVERAGE_KEYS.filter(([key]) => coverage[key] !== undefined).map(([key, label]) => (
            <div key={key}><span>{label}</span><strong>{String(coverage[key])}</strong></div>
          ))}
        </div>
      </section>

      {units.length > 0 && (
        <section className="inspector-section">
          <div className="inspector-section-title"><Layers3 size={14} /> Review units</div>
          <div className="unit-list">
            {units.map((unit) => (
              <div className="unit-row" key={unit.id}>
                <span className={`unit-state is-${unit.state}`}>
                  {unit.state === "reviewed" ? <CheckCircle2 size={14} /> : <CircleDashed size={14} />}
                </span>
                <div>
                  <strong>{unit.id}</strong>
                  <small>{unit.module || "No module"} · {unit.files} files · {unit.attempts} attempts</small>
                  {unit.reason && <p>{unit.reason}</p>}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {manifest.files && manifest.files.length > 0 && (
        <section className="inspector-section">
          <div className="inspector-section-title"><Files size={14} /> Files in change</div>
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
    </div>
  );
}
