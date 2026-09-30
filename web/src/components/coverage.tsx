import { Chip } from "@heroui/react";
import type { RunManifest } from "../types";

const COVERAGE_KEYS: Array<[string, string]> = [
  ["filesInScope", "in scope"],
  ["filesReviewed", "reviewed"],
  ["filesPartial", "partial"],
  ["filesUnreviewed", "unreviewed"],
  ["filesBlocked", "blocked"],
  ["filesFailed", "failed"],
  ["unitsTotal", "units"],
  ["unitsReviewed", "units reviewed"],
];

export function CoverageTab({ manifest }: { manifest: RunManifest }) {
  const coverage = manifest.coverage ?? {};
  const inScope = Number(coverage.filesInScope ?? 0);
  const reviewed = Number(coverage.filesReviewed ?? 0);
  const partial = Number(coverage.filesPartial ?? 0);
  const pct = inScope > 0 ? Math.round(((reviewed + partial) / inScope) * 100) : 0;
  const units = manifest.units ?? [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div className="panel">
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8, alignItems: "baseline" }}>
          <strong>Snapshot coverage</strong>
          <span className="mono" style={{ color: "var(--pir-dim)", fontSize: 12 }}>
            {reviewed + partial} / {inScope} files touched ({pct}%)
          </span>
        </div>
        <div className="progressbar">
          <div style={{ width: `${pct}%` }} />
        </div>
        <div className="stat-row" style={{ marginTop: 10 }}>
          {COVERAGE_KEYS.filter(([key]) => coverage[key] !== undefined).map(([key, label]) => (
            <span key={key} className="stat">{label} <b>{String(coverage[key])}</b></span>
          ))}
        </div>
      </div>

      {units.length > 0 && (
        <div className="panel" style={{ padding: 0, overflowX: "auto" }}>
          <table className="grid">
            <thead>
              <tr>
                <th>Unit</th>
                <th>Module</th>
                <th>State</th>
                <th className="num">Files</th>
                <th className="num">Attempts</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {units.map((unit) => (
                <tr key={unit.id}>
                  <td className="mono">{unit.id}</td>
                  <td className="dim">{unit.module || "—"}</td>
                  <td>
                    <Chip size="sm" variant="soft" color={unit.state === "reviewed" ? "success" : unit.state === "blocked" || unit.state === "failed" ? "danger" : "warning"}>
                      {unit.state}
                    </Chip>
                  </td>
                  <td className="num dim">{unit.files}</td>
                  <td className="num dim">{unit.attempts}</td>
                  <td className="dim" style={{ fontSize: 12 }}>{unit.reason ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
