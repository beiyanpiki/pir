import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { apiGet } from "../api";
import { useApi } from "../hooks";
import { PageError } from "../components/page-controls";
import type { RunSummary } from "../types";

type Finding = { displayId: string; runId: string; title: string; severity: string; status: string; confidence: number | null; anchors: unknown[] };
type CompareRow = { fingerprint: string; before: Finding | null; after: Finding | null };
type Comparison = { leftRun: RunSummary & { coverage?: unknown }; rightRun: RunSummary & { coverage?: unknown }; added: CompareRow[]; removed: CompareRow[]; changed: CompareRow[]; unchanged: CompareRow[] };
export function RunComparePage() {
  const { projectId = "" } = useParams(); const [params, setParams] = useSearchParams();
  const left = params.get("leftRunId") ?? ""; const right = params.get("rightRunId") ?? "";
  const [leftInput, setLeft] = useState(left); const [rightInput, setRight] = useState(right);
  useEffect(() => { setLeft(left); setRight(right); }, [projectId, left, right]);
  const comparison = useApi<Comparison | null>((signal) => left && right ? apiGet(`/api/projects/${projectId}/run-compare?${new URLSearchParams({ leftRunId: left, rightRunId: right })}`, signal) : Promise.resolve(null), [projectId, left, right]);
  return <div className="page-shell"><Link to={`/projects/${projectId}`}>Project runs</Link><h1>Compare review runs</h1><form className="run-toolbar" onSubmit={(e) => { e.preventDefault(); setParams({ leftRunId: leftInput.trim(), rightRunId: rightInput.trim() }); }}><label>Earlier run<input aria-label="Earlier run ID" value={leftInput} onChange={(e) => setLeft(e.target.value)} required /></label><label>Later run<input aria-label="Later run ID" value={rightInput} onChange={(e) => setRight(e.target.value)} required /></label><button type="submit">Compare</button></form>
    {comparison.loading && <p role="status">Loading comparison…</p>}{comparison.error && <PageError error={comparison.error} retry={comparison.reload} />}
    {comparison.data && <><table className="data-table"><thead><tr><th>Run</th><th>Execution</th><th>Stop reason</th><th>Coverage</th></tr></thead><tbody>{[comparison.data.leftRun, comparison.data.rightRun].map((run) => <tr key={run.runId}><td><Link to={`/runs/${projectId}/${run.runId}`}>{run.runId}</Link></td><td>{run.status}</td><td>{run.stoppedBecause ?? "Not recorded"}</td><td><details><summary>{run.coverage ? "Recorded summary" : "Not recorded"}</summary><pre>{JSON.stringify(run.coverage, null, 2)}</pre></details></td></tr>)}</tbody></table>
    {(["added", "removed", "changed", "unchanged"] as const).map((group) => <section className="data-section" key={group}><h2>{group} ({comparison.data![group].length})</h2>{comparison.data![group].map((row) => <article className="finding-row" key={row.fingerprint}><div className="finding-detail"><strong>{(row.after ?? row.before)?.title}</strong><p>{[row.before, row.after].map((f, i) => f ? <span key={i}><Link to={`/runs/${projectId}/${f.runId}?tab=findings&finding=${encodeURIComponent(f.displayId)}`}>{f.displayId}</Link> {f.severity} · {f.status} · {f.confidence === null ? "unknown confidence" : `${Math.round(f.confidence * 100)}%`}{i === 0 ? " → " : ""}</span> : <span key={i}>Absent {i === 0 ? " → " : ""}</span>)}</p><details><summary>Source anchors and fingerprint</summary><code>{row.fingerprint}</code><pre>{JSON.stringify({ before: row.before?.anchors, after: row.after?.anchors }, null, 2)}</pre></details></div></article>)}</section>)}</>}
  </div>;
}
