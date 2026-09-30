import { Chip } from "@heroui/react";

type ChipColor = "accent" | "danger" | "success" | "warning" | "default";

export function statusColor(status: string | null | undefined): ChipColor {
  switch (status) {
    case "running": return "accent";
    case "completed": return "success";
    case "incomplete": return "warning";
    case "failed":
    case "interrupted": return "danger";
    default: return "default";
  }
}

export function StatusBadge({ status }: { status: string | null | undefined }) {
  return <Chip size="sm" variant="soft" color={statusColor(status)}>{status ?? "unknown"}</Chip>;
}

export function SeverityBadge({ severity }: { severity: string }) {
  const color: ChipColor = severity === "P0" ? "danger" : severity === "P1" ? "warning" : severity === "P2" ? "warning" : "default";
  return <Chip size="sm" variant="soft" color={color}>{severity}</Chip>;
}

export function VerdictBadge({ status }: { status: string }) {
  const color: ChipColor =
    status === "confirmed" ? "success"
    : status === "rejected" ? "danger"
    : status === "uncertain" ? "warning"
    : "default";
  return <Chip size="sm" variant="soft" color={color}>{status}</Chip>;
}

export function ModeBadge({ mode }: { mode: string }) {
  const known = mode === "change" || mode === "audit";
  return <Chip size="sm" variant="soft" color={known ? "accent" : "default"}>{mode}</Chip>;
}

export function SessionKindBadge({ kind }: { kind: string }) {
  const known = kind === "reviewer" || kind === "verifier";
  return <Chip size="sm" variant="soft" color={known ? "accent" : "default"}>{kind}</Chip>;
}

export function LiveBadge({ label = "live" }: { label?: string }) {
  return (
    <span className="pir-live-pill">
      <span className="pir-live-dot" />
      {label}
    </span>
  );
}
