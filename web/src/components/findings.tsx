import { useState } from "react";
import { MessageResponse } from "@/components/ai-elements/message";
import {
  CodeBlock,
  CodeBlockCopyButton,
} from "@/components/ai-elements/code-block";
import { fmtTime } from "../format";
import { codeLanguage } from "./code-lang";
import { SeverityBadge, VerdictBadge } from "./badges";
import type { FindingView } from "../types";

const REPORTED = new Set(["confirmed", "uncertain"]);

export function FindingsTab({ findings }: { findings: FindingView[] }) {
  const [showAll, setShowAll] = useState(false);
  const sorted = [...findings].sort((a, b) => a.createdAt - b.createdAt);
  const visible = showAll ? sorted : sorted.filter((finding) => REPORTED.has(finding.status));
  const hidden = sorted.length - visible.length;

  if (findings.length === 0) {
    return <div className="pir-empty">No findings recorded for this run.</div>;
  }

  return (
    <div>
      <div className="mb-3 flex items-center gap-3">
        <button
          className="rounded-md border border-border px-2.5 py-1 font-mono text-[11.5px] text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
          onClick={() => setShowAll(!showAll)}
        >
          {showAll ? "reported only" : `show all verdicts (${hidden} rejected/pending)`}
        </button>
        <span className="text-xs text-muted-foreground">
          {visible.filter((f) => f.status === "confirmed").length} confirmed ·{" "}
          {visible.filter((f) => f.status === "uncertain").length} uncertain
        </span>
      </div>
      {visible.map((finding) => (
        <FindingCard key={finding.id} finding={finding} />
      ))}
    </div>
  );
}

function FindingCard({ finding }: { finding: FindingView }) {
  const sevBorder =
    finding.severity === "P0" ? "border-l-red-500"
    : finding.severity === "P1" ? "border-l-orange-500"
    : finding.severity === "P2" ? "border-l-amber-500"
    : "border-l-border";
  return (
    <div className={`pir-panel mb-3 overflow-hidden border-l-[3px] ${sevBorder}`}>
      <div className="flex flex-wrap items-center gap-2.5 px-4 py-3">
        <SeverityBadge severity={finding.severity} />
        <span className="font-mono text-xs text-muted-foreground">{finding.displayId}</span>
        <span className="min-w-48 flex-1 text-sm font-semibold">{finding.title}</span>
        <VerdictBadge status={finding.status} />
        <span className="font-mono text-[11px] text-muted-foreground">
          round {finding.round} · {finding.category} · {fmtTime(finding.createdAt)}
        </span>
      </div>
      <div className="flex flex-col gap-4 border-t border-border px-4 py-3">
        <div>
          <div className="mb-1.5 text-[10.5px] uppercase tracking-[0.08em] text-muted-foreground">claim</div>
          <MessageResponse>{finding.claim}</MessageResponse>
        </div>
        {finding.trigger && (
          <div>
            <div className="mb-1.5 text-[10.5px] uppercase tracking-[0.08em] text-muted-foreground">trigger</div>
            <div className="rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-xs text-muted-foreground">
              {finding.trigger}
            </div>
          </div>
        )}
        {finding.evidence.length > 0 && (
          <div>
            <div className="mb-1.5 text-[10.5px] uppercase tracking-[0.08em] text-muted-foreground">evidence</div>
            <div className="flex flex-col gap-3">
              {finding.evidence.map((item, index) => (
                <div key={index} className="flex flex-col gap-1.5">
                  <span className="font-mono text-[11.5px] text-sky-400">
                    {item.kind}
                    {item.path ? ` · ${item.path}${item.startLine !== undefined ? `:${item.startLine}` : ""}` : ""}
                  </span>
                  {item.description && <span className="text-xs text-muted-foreground">{item.description}</span>}
                  {item.excerpt && (
                    <div className="overflow-hidden rounded-lg border border-border">
                      <CodeBlock code={item.excerpt} language={codeLanguage(item.path)}>
                        <CodeBlockCopyButton />
                      </CodeBlock>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
        {finding.verifierRationale && (
          <div>
            <div className="mb-1.5 text-[10.5px] uppercase tracking-[0.08em] text-muted-foreground">verifier rationale</div>
            <MessageResponse>{finding.verifierRationale}</MessageResponse>
          </div>
        )}
        <div className="pir-stat-row">
          {finding.anchors.length > 0 && (
            <span className="stat">anchors <b>{finding.anchors.map((a) => `${a.path}:${a.startLine}`).join(", ")}</b></span>
          )}
          {finding.memoryMatches.length > 0 && <span className="stat"><b>{finding.memoryMatches.length}</b> memory matches</span>}
          {finding.featureKey && <span className="stat">feature <b>{finding.featureKey}</b></span>}
          {finding.entityKey && <span className="stat">entity <b>{finding.entityKey}</b></span>}
        </div>
      </div>
    </div>
  );
}
