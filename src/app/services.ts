import process from "node:process";
import { getHeadCommit } from "../changes/git.js";
import { bootstrapProjectMemory, refreshMemory, type BootstrapOptions, type BootstrapResult, type RefreshResult } from "../memory/bootstrap.js";
import { applyFeedback, applyPriority, type FeedbackResult } from "../memory/feedback.js";
import { rememberKnowledge, type RememberResult, type RememberScope, type RememberKind } from "../memory/remember.js";
import { applySnapshot, exportSnapshot, type MemorySnapshot, type SyncStats } from "../memory/sync.js";
import { describeTransportError } from "../cli/remote-fetch.js";
import { toFindingView, type FindingView } from "./find.js";
import type { AppContext } from "./context.js";
import { runVerifier } from "../agents/verifier.js";
import { verifyFixPrompt } from "../agents/prompts.js";
import { createSubmitVerdictTool, type VerdictCollector } from "../tools/collector-tools.js";
import { createFindSymbolTool, createReadCodeTool, createSearchTextTool } from "../tools/review-tools.js";
import { READONLY_BUILTIN_TOOLS } from "../agents/types.js";
import type { ToolContext } from "../tools/context.js";

// ---------------------------------------------------------------------------
// memory service
// ---------------------------------------------------------------------------

export interface MemoryStatus {
  projectId: string;
  remote: string | null;
  dbPath: string;
  lastIndexedCommit: string | null;
  headCommit: string;
  codeMap: { kind: string; initialized: boolean; nodeCount: number; edgeCount: number; fileCount: number };
  counts: ReturnType<AppContext["memory"]["stats"]>;
}

export async function memoryStatus(ctx: AppContext): Promise<MemoryStatus> {
  const head = await getHeadCommit(ctx.repoRoot);
  const index = await ctx.codeMap.status();
  return {
    projectId: ctx.memory.identity.projectId,
    remote: ctx.memory.identity.remote,
    dbPath: ctx.memory.store.dbPath,
    lastIndexedCommit: ctx.memory.getLastIndexedCommit(),
    headCommit: head,
    codeMap: {
      kind: ctx.codeMap.kind,
      initialized: index.initialized,
      nodeCount: index.nodeCount,
      edgeCount: index.edgeCount,
      fileCount: index.fileCount,
    },
    counts: ctx.memory.stats(),
  };
}

export async function memoryBootstrap(
  ctx: AppContext,
  options: BootstrapOptions & { onProgress?: (message: string) => void } = {},
): Promise<BootstrapResult> {
  return bootstrapProjectMemory({
    repoRoot: ctx.repoRoot,
    memory: ctx.memory,
    codeMap: ctx.codeMap,
    factory: ctx.factory,
    options,
    onProgress: options.onProgress,
  });
}

export async function memoryRefresh(
  ctx: AppContext,
  options: { model?: string; onProgress?: (message: string) => void } = {},
): Promise<RefreshResult> {
  return refreshMemory({
    repoRoot: ctx.repoRoot,
    memory: ctx.memory,
    factory: ctx.factory,
    model: options.model,
    onProgress: options.onProgress,
  });
}

// ---------------------------------------------------------------------------
// memory sync service (remote <-> local merge)
// ---------------------------------------------------------------------------

export interface MemorySyncResult {
  server: string;
  projectId: string;
  dryRun: boolean;
  stats: SyncStats;
  /** Rows written into the local DB by applying the merged snapshot (empty on --dry-run). */
  appliedLocally: Record<string, number>;
}

/** Snapshots can be large, but a server that accepts and never answers must not hang the CLI. */
const SYNC_TIMEOUT_MS = 120_000;

/**
 * Merge this project's local memory DB with a pir serve instance: ship the
 * local snapshot to POST /v1/memory/sync, let the server merge (the same
 * deterministic function runs on both sides) and apply the returned merged
 * snapshot locally. Both DBs converge without deleting anything.
 */
export async function memorySync(
  ctx: AppContext,
  input: { url: string; token?: string; insecure?: boolean; dryRun?: boolean },
): Promise<MemorySyncResult> {
  if (input.insecure) {
    // Per-process opt-out for self-signed certificates, as in remote.ts —
    // the pir CLI is short-lived so the blast radius is this invocation only.
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  }
  const identity = ctx.memory.identity;
  const snapshot = exportSnapshot(ctx.memory.store, identity.projectId);
  let response: Response;
  try {
    response = await fetch(new URL("/v1/memory/sync", input.url), {
      method: "POST",
      signal: AbortSignal.timeout(SYNC_TIMEOUT_MS),
      headers: {
        "content-type": "application/json",
        ...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
      },
      body: JSON.stringify({
        projectId: identity.projectId,
        remoteUrl: identity.remote,
        normalizedRemote: identity.normalizedRemote,
        rootCommit: identity.rootCommit,
        snapshot,
        dryRun: Boolean(input.dryRun),
      }),
    });
  } catch (err) {
    // Undici failures say only "fetch failed"; keep the real cause (#32).
    throw new Error(`cannot reach ${input.url}: ${describeTransportError(err)}`);
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error(`server rejected the request (${response.status}); check --token`);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`server error ${response.status}: ${text.slice(0, 400)}`);
  }
  const { merged, stats } = (await response.json()) as { merged: MemorySnapshot; stats: SyncStats };
  const appliedLocally = input.dryRun ? {} : applySnapshot(ctx.memory.store, identity.projectId, merged);
  return { server: input.url, projectId: identity.projectId, dryRun: Boolean(input.dryRun), stats, appliedLocally };
}

// ---------------------------------------------------------------------------
// feedback service
// ---------------------------------------------------------------------------

export async function feedback(
  ctx: AppContext,
  input: { findingId: string; decision: string; note?: string; priority?: string },
): Promise<FeedbackResult> {
  const head = await getHeadCommit(ctx.repoRoot);
  return applyFeedback(ctx.memory, {
    findingId: input.findingId,
    decision: input.decision as never,
    note: input.note,
    priority: input.priority,
    commit: head,
  });
}

export function feedbackPriority(ctx: AppContext, findingId: string, priority: string, note?: string): FeedbackResult {
  return applyPriority(ctx.memory, findingId, priority, note);
}

export function remember(
  ctx: AppContext,
  input: { scope: RememberScope; target?: string; kind: RememberKind; text: string },
): RememberResult {
  const head = ctx.memory.getLastIndexedCommit() ?? "HEAD";
  return rememberKnowledge(ctx.memory, { ...input, commit: head });
}

// ---------------------------------------------------------------------------
// findings service
// ---------------------------------------------------------------------------

export function listFindings(
  ctx: AppContext,
  opts: { status?: string; limit?: number; offset?: number } = {},
): FindingView[] {
  return ctx.memory.findings.list(opts).map((row) => toFindingView(ctx, row));
}

/** Page plus filtered total from one snapshot — the completeness half of #47. */
export function listFindingsPage(
  ctx: AppContext,
  opts: { status?: string; limit?: number; offset?: number } = {},
): { findings: FindingView[]; total: number } {
  const page = ctx.memory.findings.listPage(opts);
  return { findings: page.rows.map((row) => toFindingView(ctx, row)), total: page.total };
}

export function showFinding(ctx: AppContext, idOrDisplayId: string): FindingView | null {
  const row = ctx.memory.findings.get(idOrDisplayId);
  return row ? toFindingView(ctx, row) : null;
}

// ---------------------------------------------------------------------------
// verify-fix service (Phase 9)
// ---------------------------------------------------------------------------

export interface VerifyFixResult {
  findingId: string;
  displayId: string;
  verifiedFixed: boolean;
  triggerStillReproduces: boolean;
  rationale: string;
  resolutionId: string | null;
}

/**
 * Re-check the original trigger of a finding the user marked fixed. Only a
 * verifier confirming the trigger is gone upgrades the resolution to
 * verified_fixed — real Fix Memory, not just a claim.
 */
export async function verifyFix(
  ctx: AppContext,
  findingId: string,
  options: { model?: string } = {},
): Promise<VerifyFixResult> {
  const finding = ctx.memory.findings.get(findingId);
  if (!finding) throw new Error(`finding not found: ${findingId}`);
  const resolution = ctx.memory.resolutions.byFindingId(finding.id)[0] ?? null;
  if (finding.status !== "fixed" && !resolution) {
    throw new Error(`finding ${finding.displayId} is not marked fixed; use feedback <id> fixed first`);
  }

  const head = await getHeadCommit(ctx.repoRoot);
  // No synthetic changeSet: fix verification reads current code at head.
  // Aliasing base/merge-base to head would silently serve post-fix content
  // to revision="base" requests instead of failing explicitly.
  const toolCtx: ToolContext = {
    repoRoot: ctx.repoRoot,
    headCommit: head,
    codeMap: ctx.codeMap,
    memory: ctx.memory,
  };

  const collector: VerdictCollector = {};
  const session = await ctx.factory.createSession({
    cwd: ctx.repoRoot,
    systemRole: "fix verifier",
    tools: [
      createReadCodeTool(toolCtx),
      createSearchTextTool(toolCtx),
      createFindSymbolTool(toolCtx),
      createSubmitVerdictTool(collector),
    ],
    builtinTools: [...READONLY_BUILTIN_TOOLS],
    model: options.model,
  });
  let assistantText = "";
  try {
    await session.prompt(
      verifyFixPrompt({
        claim: finding.claim,
        trigger: finding.trigger,
        anchors: ctx.memory.findings.anchors(finding),
        fixedAtCommit: resolution?.afterCommit ?? null,
      }),
    );
    assistantText = session.getLastAssistantText() ?? "";
  } finally {
    session.dispose();
  }

  const verdict = collector.verdict ?? {
    verdict: "uncertain" as const,
    rationale: assistantText.slice(0, 400) || "no verdict submitted",
    confidence: 0.2,
  };
  const verifiedFixed = verdict.verdict === "rejected"; // trigger no longer reproduces
  if (verifiedFixed && resolution) {
    ctx.memory.resolutions.markVerified(resolution.id, head, head);
  }
  if (verdict.verdict === "confirmed") {
    // Reported fixed but the trigger still reproduces: reopen.
    ctx.memory.findings.updateStatus(finding.id, "confirmed");
  }

  return {
    findingId: finding.id,
    displayId: finding.displayId,
    verifiedFixed,
    triggerStillReproduces: verdict.verdict === "confirmed",
    rationale: verdict.rationale,
    resolutionId: resolution?.id ?? null,
  };
}
