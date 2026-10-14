// API DTOs mirroring src/server/web-store.ts and the run-event wire types
// from src/observability/run-events.ts, plus the SDK transcript shapes.

export interface ProjectSummary {
  projectId: string;
  name: string;
  remote: string | null;
  runsTotal: number;
  lastRunAt: number | null;
  lastRunStatus: string | null;
  openFindings: number;
  namedInRegistry: boolean;
}

export interface ActiveRunView {
  runId: string;
  projectId: string;
  mode: "change" | "audit";
  head: string;
  model: string | null;
  startedAt: number;
  sessions: number;
}

export interface RunSummary {
  runId: string;
  mode: string;
  base: string | null;
  head: string;
  startedAt: number;
  finishedAt: number | null;
  status: string;
  rounds: number;
  candidates: number;
  confirmed: number;
  rejected: number;
  uncertain: number;
  notes: string | null;
  model: string | null;
  durationMs: number | null;
  totalTokens: number | null;
  cost: number | null;
  transcriptsAvailable: boolean;
  verifierModel: string | null;
  runVerdict: string | null;
  incomplete: boolean;
  stoppedBecause: string | null;
  lastUpdatedAt: number | null;
}

export interface FindingEvidence {
  kind: string;
  path?: string;
  startLine?: number;
  excerpt?: string;
  description?: string;
}

export interface FindingSummary {
  /** Collapsed-row fields; claim/evidence/rationale load on demand. */
  id: string;
  displayId: string;
  title: string;
  category: string;
  severity: string;
  status: string;
  round: number;
  createdAt: number;
  evidenceCount: number;
  confidence: number | null;
}

export interface FindingView {
  id: string;
  displayId: string;
  title: string;
  claim: string;
  trigger: string;
  category: string;
  severity: string;
  status: string;
  featureKey: string | null;
  entityKey: string | null;
  anchors: Array<{ path: string; startLine: number; endLine?: number }>;
  evidence: FindingEvidence[];
  memoryMatches: unknown[];
  verifierRationale: string | null;
  round: number;
  createdAt: number;
  confidence: number | null;
  relatedSessions: Array<{ sessionKey: string; relation: "candidate" | "verification"; originalDisplayId?: string }>;
}

export interface SessionRef {
  file: string;
  transcriptFile?: string;
  /** Stable live identity when available in newer manifests. */
  sessionId?: string;
  sessionKind: "reviewer" | "verifier" | "unknown";
  round?: number;
  unitId?: string;
  attempt?: number;
  displayId?: string;
  /** F1: the specialized finder angle this reviewer session ran as. */
  angle?: string;
  /** F1: collector-id → supervisor-reassigned runtime id, for parallel angle sessions. */
  idMap?: Array<{ from: string; to: string }>;
  findingIdMap?: Array<{ from: string; to: string }>;
}

export interface RoundInfo {
  round: number;
  candidates: number;
  fresh: number;
  confirmed: number;
  rejected: number;
  uncertain: number;
  suppressed?: number;
  pending?: number;
  reviewerRan?: boolean;
  summary: string;
}

export interface SessionUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  cost?: number;
  durationMs?: number;
  toolCalls?: number;
  repeatedToolCalls?: number;
}

export interface RunManifest {
  schemaVersion: 1;
  runId: string;
  projectId: string;
  mode: "change" | "audit";
  status: string;
  base: string | null;
  head: string;
  model: string | null;
  verifierModel?: string | null;
  runVerdict?: string | null;
  startedAt: number;
  finishedAt: number;
  stoppedBecause: string;
  incomplete: boolean;
  maxFindings: number | null;
  rounds: RoundInfo[];
  plugins: Array<{ name: string; version?: string; activation?: string }>;
  sessions: SessionRef[];
  usage?: SessionUsage;
  durationMs: number;
  estimatedTokens: number;
  files?: Array<{ path: string; status: string; additions: number; deletions: number }>;
  changeCoverage?: ChangeCoverageSummaryView;
  coverage?: AuditCoverageSummaryView;
  units?: Array<{ id: string; module: string; state: string; reason?: string; files: number; attempts: number }>;
}

export interface FeedbackEventView {
  id: number;
  ts: number;
  findingId: string | null;
  action: string;
  decision: string | null;
  priority: string | null;
  note: string | null;
  scope: string | null;
  target: string | null;
}

export interface LiveSessionState {
  sessionId: string;
  sessionKind: "reviewer" | "verifier";
  role: string;
  model: string | null;
  round?: number;
  unitId?: string;
  attempt?: number;
  displayId?: string;
  angle?: string;
  transcriptFile?: string;
  prompt: string;
  startedAt: number;
  endedAt: number | null;
  error?: string;
  usage?: SessionUsage;
}

export interface LiveRunEnd {
  status: string;
  stoppedBecause: string;
  durationMs: number;
  usage?: SessionUsage;
  counts: { rounds: number; candidates: number; confirmed: number; rejected: number; uncertain: number; pending: number };
  findings: Array<{ displayId: string | null; title: string; severity: string; status: string }>;
  ts: number;
}

export interface LiveRunState {
  runId: string;
  projectId: string;
  mode: "change" | "audit";
  base: string | null;
  head: string;
  model: string | null;
  startedAt: number;
  lastEventAt: number;
  sessions: LiveSessionState[];
  events: RunEvent[];
  end: LiveRunEnd | null;
}

/** The REST run detail embeds live metadata only — event replay rides SSE. */
export type LiveRunMeta = Omit<LiveRunState, "events">;

export interface RunDetail {
  run: RunSummary;
  /** Row summaries; the full findings load per row on demand. */
  findings: { items: FindingSummary[]; total: number };
  manifest: RunManifest | null;
  sessions: SessionRef[];
  transcriptsAvailable: boolean;
  live?: LiveRunMeta;
}

// ---------------------------------------------------------------------------
// Run events (SSE wire) — mirrors src/observability/run-events.ts.
// ---------------------------------------------------------------------------

export type SessionBlock =
  | { type: "thinking"; text: string; redacted?: boolean }
  | { type: "text"; text: string }
  | { type: "toolCall"; id: string; name: string; arguments: unknown };

interface RunEventCommon {
  runId: string;
  projectId: string;
  seq: number;
  ts: number;
}

export type RunEvent =
  | (RunEventCommon & { kind: "run-start"; mode: "change" | "audit"; base: string | null; head: string; model: string | null })
  | (RunEventCommon & { kind: "progress"; phase: string; round?: number; message: string; roundInfo?: RoundInfo })
  | (RunEventCommon & {
      kind: "session-start";
      sessionId: string;
      sessionKind: "reviewer" | "verifier";
      role: string;
      model: string | null;
      round?: number;
      unitId?: string;
      attempt?: number;
      displayId?: string;
      angle?: string;
      transcriptFile?: string;
      prompt: string;
    })
  | (RunEventCommon & { kind: "session-delta"; sessionId: string; deltaType: "thinking" | "text"; text: string; /** Coalesced by the server: text spans the streak from its start, seq is the newest. */ cumulative?: boolean })
  | (RunEventCommon & { kind: "session-block"; sessionId: string; block: SessionBlock })
  | (RunEventCommon & { kind: "session-tool-result"; sessionId: string; toolCallId: string; name: string; isError: boolean; result: string; truncated: boolean })
  | (RunEventCommon & { kind: "session-end"; sessionId: string; error?: string; usage?: SessionUsage })
  | (RunEventCommon & {
      kind: "run-end";
      status: string;
      stoppedBecause: string;
      durationMs: number;
      usage?: SessionUsage;
      counts: { rounds: number; candidates: number; confirmed: number; rejected: number; uncertain: number; pending: number };
      findings: Array<{ displayId: string | null; title: string; severity: string; status: string }>;
    })
  | { kind: "ready"; runId: string | null }
  | { kind: "unavailable"; runId: string | null };

// ---------------------------------------------------------------------------
// Session transcripts — SDK message shapes as persisted by transcripts.ts.
// ---------------------------------------------------------------------------

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  redacted?: boolean;
}

export interface ToolCallBlock {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type AssistantBlock = TextBlock | ThinkingBlock | ToolCallBlock | { type: string; [key: string]: unknown };

export interface UserMessage {
  role: "user";
  content: string | TextBlock[];
  timestamp: number;
}

export interface AssistantMessage {
  role: "assistant";
  content: AssistantBlock[];
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  timestamp: number;
}

export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: Array<{ type: "text"; text: string } | { type: string }>;
  isError: boolean;
  timestamp: number;
}

export type SessionMessage = UserMessage | AssistantMessage | ToolResultMessage | { role: string; [key: string]: unknown };

export interface SessionTranscript {
  role: string;
  model: string;
  startedAt: string;
  endedAt: string;
  error?: string;
  prompt: string;
  messages: SessionMessage[];
  sessionStartedAt?: string;
  usage?: SessionUsage;
  usageAvailable?: boolean;
  effectiveConfig?: {
    model: string;
    thinkingLevel: string;
    builtinTools: string[];
    customTools: string[];
  };
}

export interface ChangeCoverageFileView { path: string; covered: number; total: number }
export interface ChangeCoverageSummaryView { hunksTotal: number; hunksCovered: number; filesTotal: number; filesCovered: number; files: ChangeCoverageFileView[] }
export interface AuditUnitView { id: string; module: string; state: string; reason?: string; files: number; attempts: number }
export interface AuditFileCoverageView { path: string; blobId: string; state: string; reason?: string; rangesTotal: number; rangesReviewed: number }
export interface AuditCoverageSummaryView {
  filesTotal: number; filesNotSelected: number; filesExcluded: number; filesInScope: number;
  filesReviewed: number; filesPartial: number; filesUnreviewed: number; filesBlocked: number; filesFailed: number;
  batchesTotal: number; batchesCompleted: number; batchesBlocked: number; batchesFailed: number;
}
export type CoverageView =
  | { mode: "change"; available: true; summary: ChangeCoverageSummaryView; files: ChangeCoverageFileView[] }
  | { mode: "audit"; available: true; summary: AuditCoverageSummaryView; units: AuditUnitView[]; files: AuditFileCoverageView[]; target: unknown }
  | { mode: "change" | "audit"; available: false; reason: "not-recorded" | "unavailable" };
