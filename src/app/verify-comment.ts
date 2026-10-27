/**
 * `pir _verify-comment` — internal AACR-Bench M0 evaluation command.
 *
 * NOT part of the stable contract: underscore-prefixed, absent from help,
 * skills and docs, local-only (a remote server must never execute it), and
 * refused unless PIR_EVAL=1. It exists so the AACR-Bench verifier benchmark
 * measures the SHIPPED runVerifier and the SHIPPED prompt/verdict machinery
 * instead of a re-implementation: the eval driver supplies one materialized
 * comment (per-comment diff + head commit), this module maps it onto a
 * CandidateFinding with a fixed, model-free mapping, and runs the production
 * verifier against the task checkout.
 *
 * Two arms share the command:
 *   --arm verifier  production runVerifier over the real repository checkout
 *   --arm ocr       the ported open-code-review reflection prompt with no
 *                   tools at all (the OCR arm's native material is the diff)
 *
 * Pure helpers (mapping, excerpt selection, task parsing) are exported for
 * model-free unit tests; runVerifyComment is the only IO-performing entry.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AgentHandle } from "../agents/types.js";
import { buildOcrReflectionPrompt, parseOcrDecision } from "../agents/ocr-reflection-prompt.js";
import { runVerifier } from "../agents/verifier.js";
import type { ChangeSet, ChangedFile } from "../changes/change-set.js";
import { parseUnifiedDiff, type DiffHunk } from "../changes/diff.js";
import { buildIdentity } from "../findings/identity.js";
import type { CandidateFinding, FindingCategory, VerifierResult } from "../findings/types.js";
import type { ToolContext } from "../tools/context.js";
import type { AppContext } from "./context.js";

/** Dataset category -> FINDING_CATEGORIES. Deterministic, total, documented in ADR-0007. */
export const COMMENT_CATEGORY_MAP: Record<string, FindingCategory> = {
  "Code Defect": "correctness",
  "Maintainability and Readability": "maintainability",
  "Performance": "performance",
  "Security Vulnerability": "security",
};

export const DEFAULT_EXCERPT_BYTES = 16 * 1024;
export const MAX_TITLE_LENGTH = 200;

export interface VerifyCommentComment {
  pr_url?: string | null;
  nwo?: string | null;
  pr_number?: number | null;
  path: string;
  side?: string;
  from_line: number;
  to_line: number;
  note: string;
  category?: string;
  context?: string;
  is_ai_comment?: boolean;
  source_model?: string | null;
  label?: number | null;
}

export interface VerifyCommentMaterial {
  head: string;
  diffBase: string;
  diffBaseKind?: string;
  pathInDiff?: boolean;
  diff: string;
  headFile?: string | null;
}

export interface VerifyCommentTask {
  id: string;
  index?: number;
  comment: VerifyCommentComment;
  material: VerifyCommentMaterial;
}

export interface VerifyCommentOptions {
  arm?: "verifier" | "ocr";
  model?: string;
}

export interface VerifyCommentResult {
  id: string;
  arm: "verifier" | "ocr";
  model: string | null;
  head: string;
  diffBase: string;
  diffBaseKind: string;
  pathInDiff: boolean;
  /** Normalized for scoring: keep = the comment survives, kill = it is rejected. */
  decision: "keep" | "kill" | "invalid";
  verdict?: VerifierResult["verdict"];
  confidence?: number | null;
  uncertaintyReason?: string | null;
  /** B4: the ground a rejected verdict named (change-mode only). */
  rejectionGround?: string | null;
  rationale?: string | null;
  ocrDecision?: string;
  ocrReason?: string | null;
  usage: Record<string, number> | null;
  durationMs: number;
}

function fail(message: string): never {
  throw new Error("_verify-comment task: " + message);
}

/** Validate a materialized row into a task; anything malformed fails loudly. */
export function parseTask(json: unknown): VerifyCommentTask {
  if (!json || typeof json !== "object") fail("payload must be an object");
  const task = json as Partial<VerifyCommentTask>;
  if (typeof task.id !== "string" || task.id === "") fail("id is required");
  const comment = task.comment;
  if (!comment || typeof comment !== "object") fail("comment is required");
  if (typeof comment.path !== "string" || comment.path === "") fail("comment.path is required");
  if (!Number.isInteger(comment.from_line) || comment.from_line < 1) fail("comment.from_line must be a positive integer");
  if (!Number.isInteger(comment.to_line) || comment.to_line < comment.from_line) fail("comment.to_line must be an integer >= from_line");
  if (typeof comment.note !== "string" || comment.note.trim() === "") fail("comment.note is required");
  // F-187: anchors are head-file lines. A LEFT-side comment's numbers refer to
  // the old file, so the sampler never emits one; refuse it loudly if it
  // arrives anyway rather than scoring a mis-anchored row.
  if (comment.side !== "right") fail('comment.side must be "right" (LEFT-side comments anchor to old-file lines and are excluded from M0)');
  const material = task.material;
  if (!material || typeof material !== "object") fail("material is required");
  if (!/^[0-9a-f]{40}$/.test(String(material.head ?? ""))) fail("material.head must be a 40-char hex sha");
  if (!/^[0-9a-f]{40}$/.test(String(material.diffBase ?? ""))) fail("material.diffBase must be a 40-char hex sha");
  if (typeof material.diff !== "string") fail("material.diff must be a string (may be empty)");
  return {
    id: task.id,
    ...(task.index === undefined ? {} : { index: task.index }),
    comment,
    material: { ...material, diffBaseKind: material.diffBaseKind ?? "unknown" },
  };
}

export function readTaskFile(file: string): VerifyCommentTask {
  return parseTask(JSON.parse(readFileSync(file, "utf8")));
}

/** Title = first sentence of the note; the full note stays the claim. */
export function firstSentence(note: string, maxLength = MAX_TITLE_LENGTH): string {
  const text = note.trim().replace(/\s+/g, " ");
  const match = /^(.+?[.!?])(?:\s|$)/.exec(text);
  const sentence = (match?.[1] ?? text).trim();
  if (sentence.length <= maxLength) return sentence;
  return sentence.slice(0, maxLength - 1).trimEnd() + "…";
}

export function mapCommentCategory(category: string | undefined): FindingCategory {
  return COMMENT_CATEGORY_MAP[category ?? ""] ?? "other";
}

function hunkText(hunk: DiffHunk): string {
  return [hunk.header, ...hunk.lines].join("\n");
}

/**
 * Evidence excerpt: the file hunks overlapping the comment's line range, or
 * every hunk of that file when none overlap (a Repo/File-Level comment), or
 * the leading bytes of the raw patch when the path is not parseable at all.
 * Byte-capped: the prompt is untrusted context, not a data dump.
 */
export function selectDiffExcerpt(
  diff: string,
  anchor: { path: string; startLine: number; endLine: number },
  maxBytes = DEFAULT_EXCERPT_BYTES,
): string {
  if (!diff) return "";
  let excerpt = diff;
  const parsed = parseUnifiedDiff(diff);
  const file = parsed.files.find((entry) => entry.path === anchor.path || entry.oldPath === anchor.path);
  if (file) {
    const overlapping = file.hunks.filter((hunk) => {
      if (hunk.newLineCount === 0) return false;
      const first = hunk.newStart;
      const last = hunk.newStart + hunk.newLineCount - 1;
      return first <= anchor.endLine && last >= anchor.startLine;
    });
    const hunks = overlapping.length > 0 ? overlapping : file.hunks;
    excerpt = hunks.map(hunkText).join("\n");
  } else {
    excerpt = diff;
  }
  if (Buffer.byteLength(excerpt) <= maxBytes) return excerpt;
  return Buffer.from(excerpt).subarray(0, maxBytes).toString("utf8") + "\n[excerpt truncated]";
}

export function commentToCandidate(task: VerifyCommentTask): CandidateFinding {
  const note = task.comment.note;
  return {
    title: firstSentence(note),
    claim: note,
    trigger: "",
    category: mapCommentCategory(task.comment.category),
    severity: "P2",
    anchors: [{ path: task.comment.path, startLine: task.comment.from_line, endLine: task.comment.to_line }],
    evidence: [
      {
        kind: "diff",
        path: task.comment.path,
        excerpt: selectDiffExcerpt(task.material.diff, {
          path: task.comment.path,
          startLine: task.comment.from_line,
          endLine: task.comment.to_line,
        }),
        description:
          "AACR-Bench comment " + task.id + " (" + (task.comment.category ?? "unknown") + ", " + (task.comment.context ?? "unknown") + ")" +
          " on " + task.comment.pr_url + "; diff shown is merge-base..capture-time-head, narrowed to this path.",
      },
    ],
    round: 1,
    identity: buildIdentity({
      featureKey: task.comment.path,
      entityKey: task.comment.path + ":" + task.comment.from_line,
      category: mapCommentCategory(task.comment.category),
      claim: note,
      trigger: "",
    }),
  };
}

function languageOf(filePath: string): string {
  const dot = filePath.lastIndexOf(".");
  return dot <= 0 || dot === filePath.length - 1 ? "" : filePath.slice(dot + 1).toLowerCase();
}

/**
 * Synthetic change set: the dataset's capture-time head with the GitHub
 * merge base as both base and merge base (that is the pair the diff was taken
 * from). An empty diff still yields a change set so revision resolution and
 * get_change keep working — the material is "this file is not in the diff".
 */
export function buildChangeSet(repoRoot: string, task: VerifyCommentTask): ChangeSet {
  const parsed = parseUnifiedDiff(task.material.diff);
  const files: ChangedFile[] = parsed.files.map((file) => ({ ...file, language: languageOf(file.path) }));
  const churn = files.reduce((sum, file) => sum + file.additions + file.deletions, 0);
  return {
    repoRoot,
    base: task.material.diffBase,
    head: task.material.head,
    baseCommit: task.material.diffBase,
    headCommit: task.material.head,
    mergeBase: task.material.diffBase,
    files,
    patch: task.material.diff,
    churn,
  };
}

export function buildVerificationContext(ctx: AppContext, task: VerifyCommentTask): ToolContext {
  return {
    repoRoot: ctx.repoRoot,
    headCommit: task.material.head,
    changeSet: buildChangeSet(ctx.repoRoot, task),
    codeMap: ctx.codeMap,
    memory: ctx.memory,
  };
}

function summarizeUsage(usage: { totalTokens: number; inputTokens: number; outputTokens: number; cost: number; durationMs?: number; toolCalls?: number } | undefined): Record<string, number> | null {
  if (!usage) return null;
  return {
    inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.totalTokens,
    cost: usage.cost, toolCalls: usage.toolCalls ?? 0,
  };
}

export async function runOcrArm(ctx: AppContext, task: VerifyCommentTask, model?: string): Promise<VerifyCommentResult> {
  const started = performance.now();
  const prompt = buildOcrReflectionPrompt({
    diff: task.material.diff,
    comment: { id: "c-0", path: task.comment.path, content: task.comment.note },
  });
  let session: AgentHandle | undefined;
  let text: string | undefined;
  let error: string | undefined;
  let usage: Record<string, number> | null = null;
  try {
    session = await ctx.factory.createSession({
      cwd: ctx.repoRoot,
      systemRole: "ocr comment reflection (AACR-Bench M0 comparison arm)",
      tools: [],
      builtinTools: [],
      model,
    });
    await session.prompt(prompt.user + "\n\n" + prompt.system);
    text = session.getLastAssistantText();
    error = session.getLastAssistantError();
  } finally {
    if (session) {
      try { usage = summarizeUsage(session.getUsage?.()); } catch { /* usage is best-effort */ }
      try { session.dispose(); } catch { /* disposal is best-effort */ }
    }
  }
  const parsed = error ? { decision: "parse-error" as const, reason: error.slice(0, 300) } : parseOcrDecision(text);
  return {
    id: task.id, arm: "ocr", model: model ?? null,
    head: task.material.head, diffBase: task.material.diffBase, diffBaseKind: task.material.diffBaseKind ?? "unknown",
    pathInDiff: Boolean(task.material.pathInDiff),
    decision: parsed.decision === "remove" ? "kill" : parsed.decision === "approve" ? "keep" : "invalid",
    ocrDecision: parsed.decision, ocrReason: parsed.reason,
    usage, durationMs: Math.round(performance.now() - started),
  };
}

/** Uncertainty reasons that mean "the verifier never produced a verdict". */
const NO_VERDICT_REASONS = new Set(["provider-error", "missing-verdict"]);

/**
 * Normalize a verifier verdict into the benchmark's keep/kill decision.
 * F-188: a crashed session (provider error) or a session that never called
 * submit_verdict produced no decision at all — it must not be scored as a
 * keep just because it is "not rejected". Only a verdict-less uncertainty is
 * invalid; missing-evidence/tool-limit abstentions stay keeps under the
 * uncertain=keep policy.
 */
export function decisionForVerdict(verdict: VerifierResult): "keep" | "kill" | "invalid" {
  if (verdict.verdict === "rejected") return "kill";
  if (verdict.verdict === "uncertain" && NO_VERDICT_REASONS.has(verdict.uncertaintyReason ?? "")) return "invalid";
  return "keep";
}

export async function runVerifierArm(ctx: AppContext, task: VerifyCommentTask, model?: string): Promise<VerifyCommentResult> {
  const started = performance.now();
  const candidate = commentToCandidate(task);
  const toolCtx = buildVerificationContext(ctx, task);
  const verdict = await runVerifier({
    factory: ctx.factory,
    ctx: toolCtx,
    candidate,
    priorDecisions: [],
    model,
  });
  return {
    id: task.id, arm: "verifier", model: model ?? null,
    head: task.material.head, diffBase: task.material.diffBase, diffBaseKind: task.material.diffBaseKind ?? "unknown",
    pathInDiff: Boolean(task.material.pathInDiff),
    decision: decisionForVerdict(verdict),
    verdict: verdict.verdict,
    confidence: typeof verdict.confidence === "number" ? verdict.confidence : null,
    uncertaintyReason: verdict.uncertaintyReason ?? null,
    rejectionGround: verdict.rejectionGround ?? null,
    rationale: verdict.rationale,
    usage: summarizeUsage(verdict.usage),
    durationMs: Math.round(performance.now() - started),
  };
}

export async function runVerifyComment(ctx: AppContext, task: VerifyCommentTask, options: VerifyCommentOptions = {}): Promise<VerifyCommentResult> {
  const arm = options.arm ?? "verifier";
  if (arm === "ocr") return runOcrArm(ctx, task, options.model);
  if (arm !== "verifier") throw new Error("invalid arm: " + String(arm) + " (verifier|ocr)");
  return runVerifierArm(ctx, task, options.model);
}

/** Deterministic digest of the mapped candidate — recorded per run for audit. */
export function candidateDigest(task: VerifyCommentTask): string {
  return createHash("sha256").update(JSON.stringify(commentToCandidate(task))).digest("hex").slice(0, 16);
}
