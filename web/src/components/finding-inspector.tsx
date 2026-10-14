import { apiGet } from "../api";
import { useApi } from "../hooks";
import type { FindingView } from "../types";
import { EvidenceChain } from "./evidence-chain";
import { PageError } from "./page-controls";

export function FindingInspector({ projectId, runId, findingId }: { projectId: string; runId: string; findingId: string }) {
  const finding = useApi<FindingView>((signal) => apiGet(`/api/runs/${projectId}/${runId}/findings/${encodeURIComponent(findingId)}`, signal), [projectId, runId, findingId]);
  if (finding.loading && !finding.data) return <p role="status">Loading finding…</p>;
  if (finding.error) return <PageError error={finding.error} retry={finding.reload} />;
  return finding.data ? <EvidenceChain finding={finding.data} /> : <p>No finding recorded.</p>;
}
