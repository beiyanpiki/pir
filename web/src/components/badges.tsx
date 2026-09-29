export function statusClass(status: string | null | undefined): string {
  switch (status) {
    case "running": return "status-running";
    case "completed": return "status-completed";
    case "incomplete": return "status-incomplete";
    case "failed": return "status-failed";
    case "interrupted": return "status-interrupted";
    default: return "status-unknown";
  }
}

export function StatusBadge({ status }: { status: string | null | undefined }) {
  return <span className={`badge ${statusClass(status)}`}>{status ?? "unknown"}</span>;
}

export function SeverityBadge({ severity }: { severity: string }) {
  return <span className={`badge sev-${severity}`}>{severity}</span>;
}

export function VerdictBadge({ status }: { status: string }) {
  return <span className={`verdict v-${status}`}>{status}</span>;
}

export function ModeBadge({ mode }: { mode: string }) {
  const known = mode === "change" || mode === "audit";
  return <span className={`badge ${known ? `mode-${mode}` : "status-unknown"}`}>{mode}</span>;
}

export function SessionKindBadge({ kind }: { kind: string }) {
  const known = kind === "reviewer" || kind === "verifier";
  return <span className={`badge ${known ? `kind-${kind}` : "status-unknown"}`}>{kind}</span>;
}
