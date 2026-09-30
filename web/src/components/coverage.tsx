import { Chip } from "./badges";
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
    <div className="flex flex-col gap-4">
      <div className="pir-panel px-4 py-3.5">
        <div className="mb-2 flex items-baseline justify-between">
          <strong className="text-sm">Snapshot coverage</strong>
          <span className="font-mono text-xs text-muted-foreground">
            {reviewed + partial} / {inScope} files touched ({pct}%)
          </span>
        </div>
        <div className="h-2 overflow-hidden rounded-full border border-border bg-muted/50">
          <div className="h-full bg-emerald-500/80" style={{ width: `${pct}%` }} />
        </div>
        <div className="pir-stat-row mt-3">
          {COVERAGE_KEYS.filter(([key]) => coverage[key] !== undefined).map(([key, label]) => (
            <span key={key} className="stat">{label} <b>{String(coverage[key])}</b></span>
          ))}
        </div>
      </div>

      {units.length > 0 && (
        <div className="pir-panel overflow-x-auto">
          <table className="pir-table">
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
                  <td className="font-mono">{unit.id}</td>
                  <td className="dim">{unit.module || "—"}</td>
                  <td>
                    <Chip tone={unit.state === "reviewed" ? "success" : unit.state === "blocked" || unit.state === "failed" ? "destructive" : "warning"}>
                      {unit.state}
                    </Chip>
                  </td>
                  <td className="num dim">{unit.files}</td>
                  <td className="num dim">{unit.attempts}</td>
                  <td className="dim max-w-[380px] text-xs">{unit.reason ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
