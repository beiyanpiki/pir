import { Link } from "react-router-dom";
import { Activity, Gauge, Info, ShieldAlert } from "lucide-react";
import { fmtCost, fmtCount, fmtDuration, fmtTime } from "../format";
import type { CoverageView, RunDetail, RunEvent } from "../types";

export function RunOverview({ detail, coverage, events, execution, connection }: {
  detail: RunDetail; coverage: CoverageView | null; events: RunEvent[] | null;
  execution: string; connection: string;
}) {
  const { run, manifest } = detail;
  const latest = (events ?? []).filter((e) => e.kind === "progress" || e.kind === "run-end").slice(-5).reverse();
  const ended = new Set((events ?? []).filter((e) => e.kind === "session-end").map((e) => e.kind === "session-end" ? e.sessionId : ""));
  const current = (events ?? []).filter((e) => e.kind === "session-start" && !ended.has(e.sessionId)).at(-1);
  const pending = manifest?.rounds?.at(-1)?.pending;
  const verdict = run.runVerdict ?? "unknown";
  return <div className="run-overview inspector-stack">
    <section className="inspector-section"><h2 className="inspector-section-title"><Info size={16} /> Review scope</h2><dl className="detail-list">
      <div><dt>Mode</dt><dd>{run.mode === "audit" ? "Repository snapshot audit" : "Change review"}</dd></div>
      <div><dt>Base / head</dt><dd><code>{run.base ?? "Snapshot"} / {run.head}</code></dd></div>
      <div><dt>Updated</dt><dd>{run.lastUpdatedAt ? fmtTime(run.lastUpdatedAt) : "Unknown"}</dd></div>
    </dl></section>
    <section className="inspector-section"><h2 className="inspector-section-title"><Activity size={16} /> Execution and observation</h2><dl className="detail-list">
      <div><dt>Execution</dt><dd>{execution}</dd></div><div><dt>Connection</dt><dd>{connection}</dd></div>
      <div><dt>Current phase</dt><dd>{latest[0] && latest[0].kind === "progress" ? `${latest[0].phase}: ${latest[0].message}` : execution === "running" ? "Awaiting progress" : "Execution ended"}</dd></div>
      <div><dt>Current session</dt><dd>{current?.kind === "session-start" ? `${current.sessionKind} · round ${current.round ?? "unknown"}${current.unitId ? ` · unit ${current.unitId}` : ""}` : "None recorded"}</dd></div>
    </dl></section>
    <section className="inspector-section"><h2 className="inspector-section-title"><ShieldAlert size={16} /> Conclusion</h2><p className={`verdict-description is-${verdict}`}>{verdict === "clean" ? "No reported defects in the recorded review." : verdict === "incorrect" ? "Confirmed high severity defects make this change incorrect." : verdict === "incomplete" ? "Review incomplete: some checks or verifications remain unfinished." : "No conclusive run verdict was recorded."}</p>
      <p>Execution completion only means the review stopped. It does not establish that the code is free of defects.</p>
      <div className="coverage-grid"><div><span>Confirmed</span><strong>{run.confirmed}</strong></div><div><span>Uncertain</span><strong>{run.uncertain}</strong></div><div><span>Pending</span><strong>{pending ?? "Unknown"}</strong></div></div>
      <p><strong>Completeness:</strong> {run.incomplete ? "Incomplete" : manifest?.incomplete === false ? "Complete" : "Unknown"}</p><p><strong>Stop reason:</strong> {run.stoppedBecause ?? "Not recorded"}</p>
    </section>
    <section className="inspector-section"><h2 className="inspector-section-title"><Gauge size={16} /> Coverage</h2>{!coverage?.available ? <p>Coverage not recorded.</p> : coverage.mode === "change" ? <p>{coverage.summary.hunksCovered} / {coverage.summary.hunksTotal} diff hunks read · {coverage.summary.filesCovered} / {coverage.summary.filesTotal} files covered</p> : <p>{coverage.summary.filesReviewed} reviewed · {coverage.summary.filesPartial} partial · {coverage.summary.filesUnreviewed} unreviewed · {coverage.summary.filesBlocked} blocked · {coverage.summary.filesFailed} failed</p>}</section>
    <section className="inspector-section"><h2 className="inspector-section-title">Usage and models</h2><p>{fmtDuration(run.durationMs)} · {run.totalTokens === null ? "Unknown tokens" : `${fmtCount(run.totalTokens)} tokens`} · {fmtCost(run.cost)}</p><p>Reviewer: {run.model ?? "Unknown"} · Verifier: {run.verifierModel ?? run.model ?? "Unknown"}</p></section>
    <section className="inspector-section"><h2 className="inspector-section-title">Recent activity</h2>{latest.length === 0 ? <p>No live events recorded.</p> : <ul>{latest.map((e, i) => <li key={i}>{e.kind === "progress" ? e.message : `Event: ${e.kind}`}</li>)}</ul>}
      {detail.findings.items.filter((f) => ["confirmed", "uncertain"].includes(f.status)).slice(0, 5).map((f) => <p key={f.id}><Link to={`?tab=findings&finding=${encodeURIComponent(f.displayId)}`}>{f.displayId} · {f.title}</Link></p>)}
    </section>
  </div>;
}
