import { useEffect, useMemo, useState } from "react";
import {
  ChevronRight,
  FileSearch,
  Filter,
  ShieldAlert,
} from "lucide-react";
import { fetchFindingDetail } from "../api";
import { SEVERITY_ORDER } from "../format";
import { SeverityBadge, VerdictBadge } from "./badges";
import { EvidenceChain } from "./evidence-chain";
import { useSearchParams } from "react-router-dom";
import type { FindingSummary, FindingView } from "../types";

const REPORTED = new Set(["confirmed", "uncertain"]);

export function FindingsTab({
  projectId,
  runId,
  findings,
  selectedFinding,
}: {
  projectId: string;
  runId: string;
  findings: { items: FindingSummary[]; total: number };
  selectedFinding?: string | null;
}) {
  const [params, setParams] = useSearchParams();
  const selected = params.get("finding");
  const [showAll, setShowAll] = useState(false);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [visibleLimit, setVisibleLimit] = useState(50);
  const [severity, setSeverity] = useState("all");
  useEffect(() => {
    if (selectedFinding) { setShowAll(true); setSeverity("all"); }
  }, [selectedFinding]);
  const sorted = useMemo(() => [...findings.items].sort((a, b) => {
    const severityDelta = (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9);
    return severityDelta || a.createdAt - b.createdAt;
  }), [findings.items]);
  const visible = useMemo(() => sorted.filter((finding) =>
    (finding.displayId === selected || showAll || REPORTED.has(finding.status)) &&
    (status === "all" || finding.status === status) &&
    (!query || `${finding.title} ${finding.displayId}`.toLowerCase().includes(query.toLowerCase())) &&
    (severity === "all" || finding.severity === severity),
  ), [sorted, showAll, severity, status, query, selected]);
  const reported = useMemo(() => sorted.filter((finding) => REPORTED.has(finding.status)).length, [sorted]);

  if (findings.items.length === 0) {
    return (
      <div className="empty-state is-compact">
        <ShieldAlert size={20} />
        <strong>No findings recorded</strong>
      </div>
    );
  }

  return (
    <div className="findings-panel">
      <div className="findings-toolbar">
        <div className="segmented-control is-compact" role="group" aria-label="Finding visibility">
          <Filter size={13} />
          <button
            type="button"
            aria-pressed={showAll}
            className={showAll ? "is-active" : ""}
            onClick={() => setShowAll(true)}
          >
            All {findings.items.length}
          </button>
          <button
            type="button"
            aria-pressed={!showAll}
            className={!showAll ? "is-active" : ""}
            onClick={() => setShowAll(false)}
          >
            Reported {reported}
          </button>
        </div>
        <input type="search" aria-label="Search findings" placeholder="Search findings" value={query} onChange={(event) => { setQuery(event.target.value); setVisibleLimit(50); }} />
        <select aria-label="Finding status" value={status} onChange={(event) => { setStatus(event.target.value); setShowAll(true); setVisibleLimit(50); }}><option value="all">All statuses</option>{["candidate", "confirmed", "uncertain", "rejected", "expected", "suppressed"].map((value) => <option key={value}>{value}</option>)}</select>
        <select value={severity} onChange={(event) => setSeverity(event.target.value)} aria-label="Filter by severity">
          <option value="all">All severities</option>
          <option value="P0">P0</option>
          <option value="P1">P1</option>
          <option value="P2">P2</option>
          <option value="P3">P3</option>
        </select>
      </div>

      <div className="finding-list">
        {visible.slice(0, visibleLimit).map((finding) => (
          <FindingRow key={`${projectId}/${runId}/${finding.id}`} selected={selected === finding.displayId} onSelect={() => { const next = new URLSearchParams(params); next.set("finding", finding.displayId); setParams(next); }} projectId={projectId} runId={runId} summary={finding} />
        ))}
        {visibleLimit < visible.length && <button type="button" className="text-command" onClick={() => setVisibleLimit((n) => n + 50)}>Show more findings ({visible.length - visibleLimit} remaining)</button>}
        {visible.length === 0 && (
          <div className="empty-state is-compact">
            <FileSearch size={18} />
            <strong>No matching findings</strong>
          </div>
        )}
      </div>
    </div>
  );
}

type DetailState =
  | { phase: "loading" }
  | { phase: "error" }
  | { phase: "ready"; detail: FindingView };

function FindingRow({ projectId, runId, summary, selected, onSelect }: { projectId: string; runId: string; summary: FindingSummary; selected: boolean; onSelect: () => void }) {
  const [open, setOpen] = useState(selected);
  const [detail, setDetail] = useState<DetailState | null>(null);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const detailKey = `${projectId}/${runId}/${summary.id}`;
  const accentClass =
    summary.severity === "P0" ? "is-p0" :
    summary.severity === "P1" ? "is-p1" :
    summary.severity === "P2" ? "is-p2" : "is-p3";
  useEffect(() => {
    if (selected) setOpen(true);
  }, [selected]);

  // The heavy fields (claim prose, evidence excerpts, rationale) load on
  // first expand — 100+ findings stay a few-KB list until a row is opened.
  useEffect(() => {
    if (!open) return;
    // Collapsing and re-expanding the same finding reuses what is already
    // loaded; only a new finding, an explicit retry or a failure refetches.
    if (loadedFor === detailKey) return;
    const controller = new AbortController();
    setDetail({ phase: "loading" });
    fetchFindingDetail(projectId, runId, summary.id, controller.signal)
      .then((full) => {
        setDetail({ phase: "ready", detail: full });
        setLoadedFor(detailKey);
      })
      .catch((cause) => {
        if (!(cause instanceof DOMException && cause.name === "AbortError")) setDetail({ phase: "error" });
      });
    return () => {
      controller.abort();
    };
  }, [open, projectId, runId, summary.id, retry, loadedFor, detailKey]);

  return (
    <article id={`finding-${summary.displayId}`} className={`finding-row ${accentClass} ${open ? "is-open" : ""}`}>
      <button className="finding-summary" type="button" aria-expanded={open} onClick={() => { if (!open) onSelect(); setOpen((value) => !value); }}>
        <ChevronRight size={14} className="finding-chevron" />
        <span className="finding-title">
          <strong>{summary.title}</strong>
          <small>{summary.displayId} · {summary.category} · round {summary.round} · {summary.evidenceCount} evidence · {summary.confidence == null ? "confidence unknown" : `${Math.round(summary.confidence * 100)}% confidence`}</small>
        </span>
        <span className="finding-badges">
          <SeverityBadge severity={summary.severity} />
          <VerdictBadge status={summary.status} />
        </span>
      </button>

      {open && (
        <div className="finding-detail">
          {detail?.phase === "loading" && (
            <div className="py-4 text-center text-muted-foreground"><span className="pir-mini-spinner" /> loading finding…</div>
          )}
          {detail?.phase === "error" && (
            <div className="empty-state is-compact">Could not load finding {summary.displayId}. <button className="text-command" type="button" onClick={() => setRetry((value) => value + 1)}>Retry</button></div>
          )}
          {detail?.phase === "ready" && <EvidenceChain finding={detail.detail} />}
        </div>
      )}
    </article>
  );
}
