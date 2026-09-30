import { useState } from "react";
import { Markdown } from "./Markdown";
import { CodeBlock } from "./CodeBlock";
import { SEVERITY_ORDER, fmtTime, languageForPath } from "../format";
import { SeverityBadge, VerdictBadge } from "./badges";
import type { FindingView } from "../types";

const REPORTED = new Set(["confirmed", "uncertain"]);

export function FindingsTab({ findings }: { findings: FindingView[] }) {
  const [showAll, setShowAll] = useState(false);
  const sorted = [...findings].sort((a, b) => {
    const severity = (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9);
    return severity !== 0 ? severity : a.createdAt - b.createdAt;
  });
  const visible = showAll ? sorted : sorted.filter((finding) => REPORTED.has(finding.status));
  const hidden = sorted.length - visible.length;

  if (findings.length === 0) {
    return <div className="empty-state">No findings recorded for this run.</div>;
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 10, marginBottom: 12, alignItems: "center" }}>
        <button className="copy-btn" onClick={() => setShowAll(!showAll)}>
          {showAll ? "reported only" : `show all verdicts (${hidden} rejected/suppressed/pending)`}
        </button>
        <span style={{ color: "var(--pir-faint)", fontSize: 12 }}>
          {visible.filter((finding) => finding.status === "confirmed").length} confirmed ·{" "}
          {visible.filter((finding) => finding.status === "uncertain").length} uncertain
        </span>
      </div>
      {visible.map((finding) => (
        <FindingCard key={finding.id} finding={finding} />
      ))}
    </div>
  );
}

function FindingCard({ finding }: { finding: FindingView }) {
  return (
    <div className={`finding-card sev-${finding.severity}`}>
      <div className="finding-head">
        <SeverityBadge severity={finding.severity} />
        <span className="id">{finding.displayId}</span>
        <span className="title">{finding.title}</span>
        <VerdictBadge status={finding.status} />
        <span className="meta mono" style={{ color: "var(--pir-faint)", fontSize: 11 }}>
          round {finding.round} · {finding.category} · {fmtTime(finding.createdAt)}
        </span>
      </div>
      <div className="finding-body">
        <div>
          <div className="label">claim</div>
          <Markdown text={finding.claim} />
        </div>
        {finding.trigger && (
          <div>
            <div className="label">trigger</div>
            <span className="mono" style={{ color: "var(--pir-dim)", fontSize: 12.5 }}>{finding.trigger}</span>
          </div>
        )}
        {finding.evidence.length > 0 && (
          <div>
            <div className="label">evidence</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {finding.evidence.map((item, index) => (
                <div key={index} className="evidence-item">
                  <span className="loc">
                    {item.kind}
                    {item.path ? ` · ${item.path}${item.startLine !== undefined ? `:${item.startLine}` : ""}` : ""}
                  </span>
                  {item.description && <span style={{ color: "var(--pir-dim)", fontSize: 12.5 }}>{item.description}</span>}
                  {item.excerpt && (
                    <CodeBlock
                      code={item.excerpt}
                      language={languageForPath(item.path)}
                      title={item.path ?? "excerpt"}
                      lineNumbers={item.startLine !== undefined}
                      collapseOver={8_000}
                    />
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
        {finding.verifierRationale && (
          <div>
            <div className="label">verifier rationale</div>
            <Markdown text={finding.verifierRationale} />
          </div>
        )}
        <div className="stat-row" style={{ marginBottom: 0 }}>
          {finding.anchors.length > 0 && (
            <span className="stat">anchors <b>{finding.anchors.map((anchor) => `${anchor.path}:${anchor.startLine}`).join(", ")}</b></span>
          )}
          {finding.memoryMatches.length > 0 && (
            <span className="stat"><b>{finding.memoryMatches.length}</b> memory matches</span>
          )}
          {finding.featureKey && <span className="stat">feature <b>{finding.featureKey}</b></span>}
          {finding.entityKey && <span className="stat">entity <b>{finding.entityKey}</b></span>}
        </div>
      </div>
    </div>
  );
}
