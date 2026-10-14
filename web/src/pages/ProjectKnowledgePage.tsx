import { useEffect } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { apiGet } from "../api";
import { useApi } from "../hooks";
import { PageError } from "../components/page-controls";
import { fmtTime } from "../format";
import type { FeedbackEventView, FindingSummary } from "../types";

type MemoryRow = { id: string; kind: string; claim?: string; decision?: string; rationale?: string; scope?: string; featureKey?: string; entityKey?: string; validUntilCommit?: string; stale: boolean; relatedFinding?: { runId: string; displayId: string } | null; [key: string]: unknown };
type ProjectFinding = FindingSummary & { runId: string; fingerprint: string; updatedAt: number };
type Knowledge = { findings?: ProjectFinding[]; items?: MemoryRow[]; events?: FeedbackEventView[]; total: number };
const LIMIT = 50;

export function ProjectKnowledgePage({ kind }: { kind: "findings" | "memory" | "feedback" }) {
  const { projectId = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const rawOffset = Number(params.get("offset") ?? 0);
  const offset = Number.isSafeInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
  const query = new URLSearchParams(params); query.set("limit", String(LIMIT)); query.set("offset", String(offset));
  const data = useApi<Knowledge>((signal) => apiGet(`/api/projects/${projectId}/${kind}?${query}`, signal), [projectId, kind, query.toString()]);
  const feedback = useApi<{ events: FeedbackEventView[] }>((signal) => kind === "memory" ? apiGet(`/api/projects/${projectId}/feedback?limit=5`, signal) : Promise.resolve({ events: [] }), [projectId, kind]);
  const total = data.data?.total ?? 0;
  const update = (key: string, value: string): void => { const next = new URLSearchParams(params); value ? next.set(key, value) : next.delete(key); next.delete("offset"); setParams(next); };
  useEffect(() => { if (data.data && offset > 0 && offset >= total) { const next = new URLSearchParams(params); next.set("offset", String(total ? Math.floor((total - 1) / LIMIT) * LIMIT : 0)); setParams(next, { replace: true }); } }, [data.data, total, offset]);
  return <div className="page-shell">
    <header className="page-header"><div><Link to={`/projects/${projectId}`}>Project runs</Link><h1>Project {kind === "memory" ? "Memory" : kind === "feedback" ? "Feedback" : "Findings"}</h1></div></header>
    <nav className="run-toolbar" aria-label="Project views">{["findings", "memory", "feedback", "compare"].map((view) => <Link key={view} to={`/projects/${projectId}/${view}`} aria-current={kind === view ? "page" : undefined}>{view}</Link>)}</nav>
    <div className="run-toolbar"><input type="search" aria-label={`Search project ${kind}`} placeholder={`Search project ${kind}`} value={q} onChange={(e) => update("q", e.target.value)} />
      {kind === "findings" && <><select aria-label="Finding status" value={params.get("status") ?? ""} onChange={(e) => update("status", e.target.value)}><option value="">All statuses</option>{["confirmed", "uncertain", "candidate", "rejected", "expected", "suppressed"].map((v) => <option key={v}>{v}</option>)}</select><select aria-label="Severity" value={params.get("severity") ?? ""} onChange={(e) => update("severity", e.target.value)}><option value="">All severities</option>{["P0", "P1", "P2", "P3"].map((v) => <option key={v}>{v}</option>)}</select><input aria-label="Run ID filter" placeholder="Run ID" value={params.get("runId") ?? ""} onChange={(e) => update("runId", e.target.value)} /></>}
    </div>
    {data.loading && !data.data && <p role="status">Loading {kind}…</p>}
    {data.error && <PageError error={data.error} retry={data.reload} />}
    {data.data && !data.error && <section className="data-section">
      <p role="status">{total} matching {kind}</p>
      {kind === "findings" && data.data.findings?.map((f) => <article className="finding-row" key={f.id}><div className="finding-detail"><Link to={`/runs/${projectId}/${f.runId}?tab=findings&finding=${encodeURIComponent(f.displayId)}`}><strong>{f.displayId} · {f.title}</strong></Link><p>{f.severity} · {f.status} · {f.confidence === null ? "Confidence unknown" : `${Math.round(f.confidence * 100)}% confidence`} · {f.evidenceCount} evidence</p><p>Run <code>{f.runId}</code> · updated {fmtTime(f.updatedAt)}</p><small>Fingerprint <code>{f.fingerprint}</code></small></div></article>)}
      {kind === "memory" && data.data.items?.map((m) => <article key={`${m.kind}/${m.id}`} className="finding-row"><div className="finding-detail"><h2>{m.claim ?? `${m.kind}: ${m.id}`}</h2><p>{m.decision ?? m.kind} · {m.stale ? "Stale" : "Current"} · scope {m.scope ?? "unknown"}</p><p>{m.rationale ?? "No rationale recorded"}</p><p>Feature: {m.featureKey ?? "—"} · Entity: {m.entityKey ?? "—"} · Valid until: <code>{m.validUntilCommit ?? "Not recorded"}</code></p>{m.relatedFinding && <Link to={`/runs/${projectId}/${m.relatedFinding.runId}?tab=findings&finding=${encodeURIComponent(m.relatedFinding.displayId)}`}>Related finding {m.relatedFinding.displayId}</Link>}<details><summary>Recorded metadata</summary><pre>{JSON.stringify(m, null, 2)}</pre></details></div></article>)}
      {kind === "feedback" && data.data.events?.map((e) => <article key={e.id} className="finding-row"><div className="finding-detail"><h2>{e.action} · {e.decision ?? "No decision"}</h2><p>{e.note ?? "No note recorded"}</p><small>{fmtTime(e.ts)} · finding {e.findingId ?? "project"} · {e.scope ?? "unknown scope"}</small></div></article>)}
      {total === 0 && <div className="empty-state"><strong>No matching {kind} in this project</strong></div>}
      <div className="pagination"><button type="button" disabled={offset === 0 || data.loading} onClick={() => { const next = new URLSearchParams(params); next.set("offset", String(Math.max(0, offset - LIMIT))); setParams(next); }}>Previous</button><span>{total === 0 ? 0 : offset + 1}–{Math.min(offset + LIMIT, total)} of {total}</span><button type="button" disabled={offset + LIMIT >= total || data.loading} onClick={() => { const next = new URLSearchParams(params); next.set("offset", String(offset + LIMIT)); setParams(next); }}>Next</button></div>
    </section>}
    {kind === "memory" && <section className="data-section"><h2>Recent feedback</h2>{feedback.data?.events.map((e) => <p key={e.id}>{e.action} · {e.note ?? e.decision} · {fmtTime(e.ts)}</p>)}<p>Use the CLI to update memory or submit feedback.</p></section>}
  </div>;
}
