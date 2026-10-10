export { Memory } from "./memory/index.js";
export { computeProjectIdentity, memoryDbPath, projectStateDir } from "./memory/identity.js";
export { applyFeedback, FEEDBACK_DECISIONS } from "./memory/feedback.js";
export { rememberKnowledge } from "./memory/remember.js";
export {
  MEMORY_SCHEMA_VERSION,
  MEMORY_WIRE_SCHEMA_VERSION,
  applySnapshot,
  emptySnapshot,
  exportSnapshot,
  mergeSnapshots,
  openSyncTargetStore,
  syncTargetDbPath,
  type MemorySnapshot,
  type SyncStats,
  type SyncResult,
} from "./memory/sync.js";
export { buildChangeSet } from "./changes/change-set.js";
export { parseUnifiedDiff, addedLineNumbers } from "./changes/diff.js";
export { createCodeMap, DegradedCodeMap, CodeGraphCliAdapter } from "./codemap/provider.js";
export type { CodeMapProvider, CodeSymbol, IndexStatus } from "./codemap/types.js";
export { detectPacks, loadBuiltInPacks, renderGuidance, resolveLanguagePacks } from "./plugins/index.js";
export type { ActivePack, LanguagePack, PluginSelection } from "./plugins/index.js";
export { findIssues, auditIssues, AuditScopeError } from "./core/supervisor.js";
export type { FindOptions, FindOutcome, AuditOptions, AuditOutcome } from "./core/supervisor.js";
export { computeRunVerdict } from "./core/review-state.js";
export type { RunVerdict } from "./core/review-state.js";
export type { ReviewTarget } from "./core/review-target.js";
export { buildRepoSnapshot, pathMatchesGlob, MAX_AUDIT_FILE_BYTES } from "./changes/snapshot.js";
export type { RepoSnapshot, AuditScope, ScopedEntry, TreeEntry } from "./changes/snapshot.js";
export { planAuditUnits, PLANNER_VERSION } from "./core/audit-planner.js";
export type { ReviewWorkUnit, OwnedRange } from "./core/audit-planner.js";
export { CoverageLedger } from "./core/coverage.js";
export type { CoverageFileState, CoverageSummary, FileCoverageRecord } from "./core/coverage.js";
export { runReviewerRound } from "./agents/reviewer.js";
export { runVerifier } from "./agents/verifier.js";
export { PiSessionFactory } from "./agents/session-factory.js";
export type { AgentSessionFactory, ReviewTool } from "./agents/types.js";
export { buildIdentity, normalizeClaimText, claimSimilarity } from "./findings/identity.js";
export { deduplicateCandidates } from "./findings/dedup.js";
export type { CandidateFinding, VerifiedFinding, FindingIdentity, Severity } from "./findings/types.js";
export { createAppContext } from "./app/context.js";
export { runFind, toFindingView } from "./app/find.js";
export { runAudit } from "./app/audit.js";
export { envelope, renderFindResultText, renderAuditResultText } from "./app/output.js";
