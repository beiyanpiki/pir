import { useEffect, useMemo, useState } from "react";
import {
  ChevronRight,
  CircleCheck,
  CircleHelp,
  Code2,
  FileSearch,
  Filter,
  Scale,
  ShieldAlert,
} from "lucide-react";
import { MessageResponse } from "@/components/ai-elements/message";
import {
  CodeBlock,
  CodeBlockCopyButton,
} from "@/components/ai-elements/code-block";
import { fetchFindingDetail } from "../api";
import { fmtTime, SEVERITY_ORDER } from "../format";
import { codeLanguage } from "./code-lang";
import { SeverityBadge, VerdictBadge } from "./badges";
import type { FindingSummary, FindingView } from "../types";

const REPORTED = new Set(["confirmed", "uncertain"]);

export function FindingsTab({
  projectId,
  runId,
  findings,
}: {
  projectId: string;
  runId: string;
  findings: { items: FindingSummary[]; total: number };
}) {
  const [showAll, setShowAll] = useState(true);
  const [severity, setSeverity] = useState("all");
  const sorted = useMemo(() => [...findings.items].sort((a, b) => {
    const severityDelta = (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9);
    return severityDelta || a.createdAt - b.createdAt;
  }), [findings.items]);
  const visible = useMemo(() => sorted.filter((finding) =>
    (showAll || REPORTED.has(finding.status)) &&
    (severity === "all" || finding.severity === severity),
  ), [sorted, showAll, severity]);
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
        <select value={severity} onChange={(event) => setSeverity(event.target.value)} aria-label="Filter by severity">
          <option value="all">All severities</option>
          <option value="P0">P0</option>
          <option value="P1">P1</option>
          <option value="P2">P2</option>
          <option value="P3">P3</option>
        </select>
      </div>

      <div className="finding-list">
        {visible.map((finding) => (
          <FindingRow key={finding.id} projectId={projectId} runId={runId} summary={finding} />
        ))}
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

function FindingRow({ projectId, runId, summary }: { projectId: string; runId: string; summary: FindingSummary }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<DetailState | null>(null);
  const accentClass =
    summary.severity === "P0" ? "is-p0" :
    summary.severity === "P1" ? "is-p1" :
    summary.severity === "P2" ? "is-p2" : "is-p3";

  // The heavy fields (claim prose, evidence excerpts, rationale) load on
  // first expand — 100+ findings stay a few-KB list until a row is opened.
  useEffect(() => {
    if (!open || detail !== null) return;
    let cancelled = false;
    setDetail({ phase: "loading" });
    fetchFindingDetail(projectId, runId, summary.id)
      .then((full) => {
        if (!cancelled) setDetail({ phase: "ready", detail: full });
      })
      .catch(() => {
        if (!cancelled) setDetail({ phase: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [open, detail, projectId, runId, summary.id]);

  return (
    <article className={`finding-row ${accentClass} ${open ? "is-open" : ""}`}>
      <button className="finding-summary" type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <ChevronRight size={14} className="finding-chevron" />
        <span className="finding-title">
          <strong>{summary.title}</strong>
          <small>{summary.displayId} · {summary.category} · round {summary.round}</small>
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
            <div className="empty-state is-compact">Could not load finding {summary.displayId}.</div>
          )}
          {detail?.phase === "ready" && <FindingDetail finding={detail.detail} />}
        </div>
      )}
    </article>
  );
}

function FindingDetail({ finding }: { finding: FindingView }) {
  return (
    <>
      <section>
        <div className="detail-label"><Scale size={13} /> Claim</div>
        <MessageResponse>{finding.claim}</MessageResponse>
      </section>

      {finding.trigger && (
        <section>
          <div className="detail-label"><ShieldAlert size={13} /> Trigger</div>
          <code className="finding-trigger">{finding.trigger}</code>
        </section>
      )}

      {finding.evidence.length > 0 && (
        <section>
          <div className="detail-label"><Code2 size={13} /> Evidence</div>
          <div className="evidence-list">
            {finding.evidence.map((item, index) => (
              <div className="evidence-item" key={index}>
                <div className="evidence-location">
                  <span>{item.kind}</span>
                  {item.path && <code>{item.path}{item.startLine !== undefined ? `:${item.startLine}` : ""}</code>}
                </div>
                {item.description && <p>{item.description}</p>}
                {item.excerpt && (
                  <div className="code-frame">
                    <CodeBlock code={item.excerpt} language={codeLanguage(item.path)}>
                      <CodeBlockCopyButton />
                    </CodeBlock>
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {finding.verifierRationale && (
        <section>
          <div className="detail-label"><CircleCheck size={13} /> Verifier rationale</div>
          <MessageResponse>{finding.verifierRationale}</MessageResponse>
        </section>
      )}

      <footer className="finding-meta">
        <span>{fmtTime(finding.createdAt)}</span>
        {finding.anchors.length > 0 && <span>{finding.anchors.map((anchor) => `${anchor.path}:${anchor.startLine}`).join(", ")}</span>}
        {finding.memoryMatches.length > 0 && <span><CircleHelp size={12} /> {finding.memoryMatches.length} memory matches</span>}
      </footer>
    </>
  );
}
