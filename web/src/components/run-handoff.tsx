import { useEffect, useRef, useState } from "react";
import { apiGet } from "../api";
import { pageAlertMessages } from "../page-alerts";
import type { CoverageView, FindingView, RunDetail, RunEvent } from "../types";

const ALERTS_KEY = "pir-web-page-alerts";
export function RunHandoff({ detail, projectId, events, connection }: { detail: RunDetail; projectId: string; events: RunEvent[] | null; connection: string }) {
  const [enabled, setEnabled] = useState(() => { try { return localStorage.getItem(ALERTS_KEY) === "true"; } catch { return false; } });
  const [alerts, setAlerts] = useState<string[]>([]); const [exporting, setExporting] = useState(false); const [error, setError] = useState<string | null>(null);
  const lastSeq = useRef(0); const observedAt = useRef(Date.now()); const priorConfirmed = useRef(detail.run.confirmed); const priorConnection = useRef(connection); const controller = useRef<AbortController | null>(null);
  const key = `${projectId}/${detail.run.runId}`;
  useEffect(() => { lastSeq.current = 0; observedAt.current = Date.now(); priorConfirmed.current = detail.run.confirmed; priorConnection.current = connection; setAlerts([]); setError(null); return () => controller.current?.abort(); }, [key]);
  useEffect(() => {
    const original = document.title; return () => { document.title = original; };
  }, [key]);
  useEffect(() => { document.title = `${enabled && alerts.length ? `(${alerts.length}) ` : ""}pir · ${detail.run.runId}`; }, [enabled, alerts.length, key]);
  useEffect(() => {
    const source = (events ?? []).filter((event) => event.kind !== "ready" && event.kind !== "unavailable");
    if (!source.length) return;
    const max = Math.max(...source.map((event) => event.seq));
    const messages = pageAlertMessages(source, lastSeq.current, observedAt.current); lastSeq.current = max;
    if (!enabled) return;
    if (messages.length) setAlerts((previous) => [...previous, ...messages].slice(-20));
  }, [events, enabled]);
  useEffect(() => {
    if (enabled && priorConnection.current !== connection) {
      if (connection === "unauthorized") setAlerts((previous) => [...previous, "Observation needs reauthentication."]);
      else if (connection === "open" && ["reconnecting", "closed", "error", "unavailable"].includes(priorConnection.current)) setAlerts((previous) => [...previous, "Observation connection restored."]);
    }
    priorConnection.current = connection;
  }, [connection, enabled]);
  useEffect(() => {
    if (enabled && detail.run.confirmed > priorConfirmed.current) setAlerts((previous) => [...previous, `${detail.run.confirmed - priorConfirmed.current} new confirmed finding(s).`].slice(-20));
    priorConfirmed.current = detail.run.confirmed;
  }, [detail.run.confirmed, enabled]);
  const download = async (format: "json" | "markdown"): Promise<void> => {
    setExporting(true); setError(null); const current = new AbortController(); controller.current?.abort(); controller.current = current;
    try {
      const prefix = `/api/runs/${projectId}/${detail.run.runId}`;
      const coverage = await apiGet<CoverageView>(`${prefix}/coverage`, current.signal);
      const findings: FindingView[] = [];
      // Limit concurrent reads so large exports do not flood the API.
      for (let offset = 0; offset < detail.findings.items.length; offset += 8) findings.push(...await Promise.all(detail.findings.items.slice(offset, offset + 8).map((finding) => apiGet<FindingView>(`${prefix}/findings/${encodeURIComponent(finding.id)}`, current.signal))));
      if (current.signal.aborted) return;
      const sessions = detail.sessions.map((session) => ({ ...session, transcriptLink: new URL(`/runs/${projectId}/${detail.run.runId}?tab=workflow&session=${encodeURIComponent(`persisted:${session.file}`)}`, window.location.origin).href }));
      const data = { schemaVersion: 1, run: detail.run, coverage, findings, sessions };
      const content = format === "json" ? JSON.stringify(data, null, 2) : [`# Review ${detail.run.runId}`, `Mode: ${detail.run.mode} · Execution: ${detail.run.status} · Verdict: ${detail.run.runVerdict ?? "unknown"}`, `Scope: ${detail.run.base ?? "snapshot"} → ${detail.run.head}`, `Stop reason: ${detail.run.stoppedBecause ?? "not recorded"}`, "## Coverage", "```json", JSON.stringify(coverage, null, 2), "```", "## Findings", ...findings.flatMap((f) => [`### ${f.displayId}: ${f.title}`, `${f.severity} · ${f.status} · confidence ${f.confidence ?? "unknown"}`, f.claim, `Trigger: ${f.trigger}`, ...f.anchors.map((a) => `Source: ${a.path}:${a.startLine}`), ...f.evidence.map((e) => `${e.kind}: ${e.path ?? ""}:${e.startLine ?? ""}\n${e.description ?? ""}\n${e.excerpt ?? ""}`), `Verifier: ${f.verifierRationale ?? "not recorded"}`]), "## Sessions", "```json", JSON.stringify(sessions, null, 2), "```"].join("\n\n");
      const url = URL.createObjectURL(new Blob([content], { type: format === "json" ? "application/json" : "text/markdown" })); const anchor = document.createElement("a"); anchor.href = url; anchor.download = `pir-${detail.run.runId}.${format === "json" ? "json" : "md"}`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) { if (!current.signal.aborted) setError(cause instanceof Error ? cause.message : "Export failed"); }
    finally { if (controller.current === current && !current.signal.aborted) setExporting(false); }
  };
  return <section className="run-handoff" aria-label="Handoff and page alerts"><div className="run-toolbar"><button type="button" disabled={exporting} onClick={() => void download("markdown")}>Export Markdown</button><button type="button" disabled={exporting} onClick={() => void download("json")}>Export JSON</button><label><input type="checkbox" checked={enabled} onChange={(e) => { setEnabled(e.target.checked); try { localStorage.setItem(ALERTS_KEY, String(e.target.checked)); } catch { /* optional preference */ } } } /> Page alerts</label>{exporting && <span role="status">Preparing export…</span>}</div>{error && <p role="alert">{error}</p>}{enabled && alerts.length > 0 && <div className="notice-bar page-alert-toast" role="status"><span>{alerts.at(-1)} · {alerts.length} unread events</span><button type="button" onClick={() => setAlerts([])}>Mark read</button></div>}</section>;
}
