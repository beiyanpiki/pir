import { Badge, Tag, Tooltip } from "antd";
import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloseCircleOutlined,
  ExclamationCircleOutlined,
  MinusCircleOutlined,
  SyncOutlined,
} from "@ant-design/icons";
import type { SseStatus } from "../lib/hooks";

const RUN_STATUS: Record<string, { color: string; label: string; icon: React.ReactNode }> = {
  running: { color: "processing", label: "Running", icon: <SyncOutlined spin /> },
  completed: { color: "success", label: "Completed", icon: <CheckCircleOutlined /> },
  incomplete: { color: "warning", label: "Incomplete", icon: <ExclamationCircleOutlined /> },
  failed: { color: "error", label: "Failed", icon: <CloseCircleOutlined /> },
  interrupted: { color: "warning", label: "Interrupted", icon: <MinusCircleOutlined /> },
  unknown: { color: "default", label: "Unknown", icon: <ClockCircleOutlined /> },
};

export function RunStatusTag({ status }: { status: string | null | undefined }) {
  const value = status ?? "unknown";
  const config = RUN_STATUS[value] ?? { color: "default", label: value, icon: undefined };
  return <Tag color={config.color} icon={config.icon}>{config.label}</Tag>;
}

export function ModeTag({ mode }: { mode: string | null | undefined }) {
  return <Tag color={mode === "audit" ? "purple" : "blue"}>{mode === "audit" ? "Audit" : "Change"}</Tag>;
}

const VERDICT: Record<string, { color: string; label: string }> = {
  incorrect: { color: "error", label: "Incorrect" },
  "needs-review": { color: "warning", label: "Needs review" },
  "correct-with-findings": { color: "success", label: "Correct, with findings" },
  correct: { color: "success", label: "Correct" },
  clean: { color: "success", label: "Clean" },
  incomplete: { color: "warning", label: "Incomplete" },
  unknown: { color: "default", label: "Verdict unknown" },
};

export function VerdictTag({ verdict }: { verdict: string | null | undefined }) {
  const value = verdict ?? "unknown";
  const config = VERDICT[value] ?? { color: "default", label: value };
  return <Tag color={config.color}>{config.label}</Tag>;
}

const SEVERITY: Record<string, { color: string; label: string }> = {
  P0: { color: "red", label: "P0" },
  P1: { color: "volcano", label: "P1" },
  P2: { color: "gold", label: "P2" },
  P3: { color: "blue", label: "P3" },
};

export function SeverityTag({ severity }: { severity: string }) {
  const config = SEVERITY[severity] ?? { color: "default", label: severity };
  return <Tag color={config.color}>{config.label}</Tag>;
}

const FINDING_STATUS: Record<string, { color: string; label: string }> = {
  confirmed: { color: "volcano", label: "Confirmed" },
  uncertain: { color: "gold", label: "Uncertain" },
  candidate: { color: "blue", label: "Candidate" },
  rejected: { color: "default", label: "Rejected" },
  expected: { color: "cyan", label: "Expected" },
  suppressed: { color: "default", label: "Suppressed" },
};

export function FindingStatusTag({ status }: { status: string }) {
  const config = FINDING_STATUS[status] ?? { color: "default", label: status };
  return <Tag color={config.color}>{config.label}</Tag>;
}

const CONNECTION: Record<SseStatus, { status: "success" | "processing" | "warning" | "error" | "default"; label: string }> = {
  idle: { status: "default", label: "Not observing" },
  connecting: { status: "processing", label: "Connecting" },
  open: { status: "success", label: "Live" },
  unavailable: { status: "warning", label: "Live unavailable" },
  closed: { status: "warning", label: "Reconnecting" },
  error: { status: "warning", label: "Reconnecting" },
  unauthorized: { status: "error", label: "Sign-in required" },
};

export function ConnectionIndicator({ status }: { status: SseStatus }) {
  const config = CONNECTION[status];
  return (
    <Tooltip title="Observation connection is independent of review execution">
      <Badge status={config.status} text={<span className="pir-muted">{config.label}</span>} />
    </Tooltip>
  );
}
