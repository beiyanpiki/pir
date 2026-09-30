import { Badge } from "@/components/ui/badge";

type BadgeColor = "default" | "success" | "warning" | "destructive" | "accent" | "muted";

export function statusColor(status: string | null | undefined): BadgeColor {
  switch (status) {
    case "running": return "accent";
    case "completed": return "success";
    case "incomplete": return "warning";
    case "failed":
    case "interrupted": return "destructive";
    default: return "muted";
  }
}

function toneClass(tone: BadgeColor): string {
  switch (tone) {
    case "success": return "border-emerald-500/40 bg-emerald-500/10 text-emerald-400";
    case "warning": return "border-amber-500/40 bg-amber-500/10 text-amber-400";
    case "destructive": return "border-red-500/40 bg-red-500/10 text-red-400";
    case "accent": return "border-indigo-500/40 bg-indigo-500/10 text-indigo-300";
    case "muted": return "border-border bg-muted/60 text-muted-foreground";
    default: return "border-border bg-muted/60 text-foreground";
  }
}

export function Chip({ tone = "default", children, className }: { tone?: BadgeColor; children: React.ReactNode; className?: string }) {
  return (
    <Badge variant="outline" className={`${toneClass(tone)} font-mono text-[11px] font-medium px-2 py-0 gap-1 ${className ?? ""}`}>
      {children}
    </Badge>
  );
}

export function StatusBadge({ status }: { status: string | null | undefined }) {
  return <Chip tone={statusColor(status)}>{status ?? "unknown"}</Chip>;
}

export function SeverityBadge({ severity }: { severity: string }) {
  const tone: BadgeColor = severity === "P0" ? "destructive" : severity === "P1" ? "warning" : severity === "P2" ? "warning" : "muted";
  return <Chip tone={tone}>{severity}</Chip>;
}

export function VerdictBadge({ status }: { status: string }) {
  const tone: BadgeColor =
    status === "confirmed" ? "success"
    : status === "rejected" ? "destructive"
    : status === "uncertain" ? "warning"
    : "muted";
  return <Chip tone={tone}>{status}</Chip>;
}

export function ModeBadge({ mode }: { mode: string }) {
  return <Chip tone={mode === "change" || mode === "audit" ? "accent" : "muted"}>{mode}</Chip>;
}

export function SessionKindBadge({ kind }: { kind: string }) {
  return <Chip tone={kind === "reviewer" || kind === "verifier" ? "accent" : "muted"}>{kind}</Chip>;
}

export function LiveBadge({ label = "live" }: { label?: string }) {
  return (
    <span className="pir-live">
      <span className="dot" />
      {label}
    </span>
  );
}
