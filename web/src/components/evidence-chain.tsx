import { useState } from "react";
import { Link } from "react-router-dom";
import { CircleCheck, Code2, Copy, ShieldAlert } from "lucide-react";
import { MessageResponse } from "./ai-elements/message";
import { CodeBlock, CodeBlockCopyButton } from "./ai-elements/code-block";
import { codeLanguage } from "./code-lang";
import type { FindingView } from "../types";

function CopyText({ text, label }: { text: string; label: string }) {
  const [message, setMessage] = useState<string | null>(null);
  const copy = async (): Promise<void> => {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else {
        const field = document.createElement("textarea");
        field.value = text; field.style.position = "fixed"; field.style.opacity = "0";
        document.body.append(field); field.select();
        try { if (!document.execCommand("copy")) throw new Error("Copy unavailable"); }
        finally { field.remove(); }
      }
      setMessage("Copied");
    } catch { setMessage("Copy unavailable. Select and copy the text manually."); }
  };
  return <><button type="button" className="icon-button" aria-label={`Copy ${label}`} title={`Copy ${label}`} onClick={() => void copy()}><Copy size={14} /></button>{message && <span role="status">{message}</span>}</>;
}

export function EvidenceChain({ finding }: { finding: FindingView }) {
  const stable = new URL(window.location.href);
  stable.searchParams.set("tab", "findings");
  stable.searchParams.set("finding", finding.displayId);
  return <div className="finding-detail evidence-chain">
    <header><h2>{finding.displayId} · {finding.title}</h2><CopyText text={stable.href} label="finding URL" /></header>
    <p>{finding.severity} · {finding.status} · {finding.confidence === null ? "Confidence not recorded" : `${Math.round(finding.confidence * 100)}% confidence`} · round {finding.round}</p>
    {finding.confidence !== null && finding.confidence < 0.7 && <p className="notice-bar">Low confidence: the verifier could not establish this claim with high certainty.</p>}
    <section><h3 className="detail-label">Claim</h3><MessageResponse>{finding.claim}</MessageResponse></section>
    <section><h3 className="detail-label"><ShieldAlert size={14} /> Trigger</h3><p>{finding.trigger || "Not recorded"}</p></section>
    <section><h3 className="detail-label">Source anchors</h3>{finding.anchors.length === 0 ? <p>Not recorded</p> : finding.anchors.map((anchor, i) => <p key={i}><code>{anchor.path}:{anchor.startLine}{anchor.endLine ? `–${anchor.endLine}` : ""}</code><CopyText text={`${anchor.path}:${anchor.startLine}`} label="source location" /><CopyText text={anchor.path} label="file path" /></p>)}</section>
    <section><h3 className="detail-label"><Code2 size={14} /> Evidence</h3>{finding.evidence.length === 0 ? <p>No evidence recorded.</p> : finding.evidence.map((item, i) => <div className="evidence-item" key={i}><div className="evidence-location"><span>{item.kind}</span>{item.path && <code>{item.path}{item.startLine !== undefined ? `:${item.startLine}` : ""}</code>}<CopyText text={[item.path, item.startLine, item.description, item.excerpt].filter((v) => v !== undefined).join("\n")} label="evidence summary" /></div>{item.description && <p>{item.description}</p>}{item.excerpt && <CodeBlock code={item.excerpt} language={codeLanguage(item.path)}><CodeBlockCopyButton /></CodeBlock>}</div>)}</section>
    <section><h3 className="detail-label"><CircleCheck size={14} /> Verifier rationale</h3>{finding.verifierRationale ? <MessageResponse>{finding.verifierRationale}</MessageResponse> : <p>Not recorded.</p>}</section>
    <section><h3 className="detail-label">Source sessions</h3>{(finding.relatedSessions ?? []).length === 0 ? <p>No explicit session association recorded.</p> : finding.relatedSessions.map((session, i) => <p key={i}><Link to={`?tab=workflow&session=${encodeURIComponent(session.sessionKey)}&finding=${encodeURIComponent(finding.displayId)}`}>{session.relation} · {session.sessionKey}{session.originalDisplayId ? ` · collector ${session.originalDisplayId}` : ""}</Link></p>)}</section>
  </div>;
}
