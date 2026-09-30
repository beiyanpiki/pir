import { useMemo, useState } from "react";
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
import { fmtTime, SEVERITY_ORDER } from "../format";
import { codeLanguage } from "./code-lang";
import { SeverityBadge, VerdictBadge } from "./badges";
import type { FindingView } from "../types";

const REPORTED = new Set(["confirmed", "uncertain"]);

export function FindingsTab({ findings }: { findings: FindingView[] }) {
  const [showAll, setShowAll] = useState(true);
  const [severity, setSeverity] = useState("all");
  const sorted = useMemo(() => [...findings].sort((a, b) => {
    const severityDelta = (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9);
    return severityDelta || a.createdAt - b.createdAt;
  }), [findings]);
  const visible = sorted.filter((finding) =>
    (showAll || REPORTED.has(finding.status)) &&
    (severity === "all" || finding.severity === severity),
  );
  const hidden = sorted.length - sorted.filter((finding) => REPORTED.has(finding.status)).length;

  if (findings.length === 0) {
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
            All {findings.length}
          </button>
          <button
            type="button"
            aria-pressed={!showAll}
            className={!showAll ? "is-active" : ""}
            onClick={() => setShowAll(false)}
          >
            Reported {findings.length - hidden}
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
        {visible.map((finding) => <FindingRow key={finding.id} finding={finding} />)}
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

function FindingRow({ finding }: { finding: FindingView }) {
  const [open, setOpen] = useState(false);
  const accentClass =
    finding.severity === "P0" ? "is-p0" :
    finding.severity === "P1" ? "is-p1" :
    finding.severity === "P2" ? "is-p2" : "is-p3";

  return (
    <article className={`finding-row ${accentClass} ${open ? "is-open" : ""}`}>
      <button className="finding-summary" type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <ChevronRight size={14} className="finding-chevron" />
        <span className="finding-title">
          <strong>{finding.title}</strong>
          <small>{finding.displayId} · {finding.category} · round {finding.round}</small>
        </span>
        <span className="finding-badges">
          <SeverityBadge severity={finding.severity} />
          <VerdictBadge status={finding.status} />
        </span>
      </button>

      {open && (
        <div className="finding-detail">
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
        </div>
      )}
    </article>
  );
}
