import { randomUUID } from "node:crypto";
import { claimOverlap, normalizeClaimText } from "../findings/identity.js";
import { parseJsonArray, SUPPRESSION_SOURCES, type MemorySource } from "../core/types.js";
import type { SqliteStore } from "./sqlite-store.js";

export type IssueDecision = "expected" | "false_positive" | "accepted_risk" | "wont_fix" | "confirmed";
export type IssueScope = "exact" | "symbol" | "feature" | "project";

export interface IssueMemory {
  id: string;
  featureKey: string | null;
  entityKey: string | null;
  fingerprint: string | null;
  category: string;
  claim: string;
  trigger: string;
  decision: IssueDecision;
  priority: string | null;
  rationale: string;
  scope: IssueScope;
  source: MemorySource;
  /** Repo paths of the finding's anchors at feedback time (migration v2). */
  anchorPaths: string[];
  createdAtCommit: string | null;
  validUntilCommit: string | null;
  stale: boolean;
}

export type IssueDraft = Omit<IssueMemory, "id" | "anchorPaths"> & { anchorPaths?: string[] };

/**
 * Decisions that count as a historical dismissal for cross-entity signal
 * (ADR 0003) — the same list as applyVerdict's suppressive decisions;
 * "confirmed" is not a dismissal. Kept local to avoid a runtime cycle with
 * core/review-state.
 */
const DISMISSAL_DECISIONS: readonly IssueDecision[] = ["expected", "false_positive", "accepted_risk", "wont_fix"];

export interface SimilarDismissedInput {
  category: string;
  anchorPaths: string[];
  normalizedClaim: string;
}

export interface SimilarDismissedSample {
  id: string;
  decision: IssueDecision;
  claim: string;
  scope: IssueScope;
  /** Staleness is signal, not exclusion — samples carry the flag. */
  stale: boolean;
  overlap: number;
}

export interface SimilarDismissedResult {
  /** Total matching dismissals; samples are the top few by overlap. */
  count: number;
  samples: SimilarDismissedSample[];
}

interface Row {
  id: string;
  feature_key: string | null;
  entity_key: string | null;
  fingerprint: string | null;
  category: string;
  claim: string;
  trigger: string;
  decision: string;
  priority: string | null;
  rationale: string;
  scope: string;
  source: string;
  anchor_paths: string | null;
  created_at_commit: string | null;
  valid_until_commit: string | null;
  stale: number;
}

function toDomain(row: Row): IssueMemory {
  return {
    id: row.id,
    featureKey: row.feature_key,
    entityKey: row.entity_key,
    fingerprint: row.fingerprint,
    category: row.category,
    claim: row.claim,
    trigger: row.trigger,
    decision: row.decision as IssueDecision,
    priority: row.priority,
    rationale: row.rationale,
    scope: row.scope as IssueScope,
    source: row.source as MemorySource,
    anchorPaths: parseJsonArray(row.anchor_paths),
    createdAtCommit: row.created_at_commit,
    validUntilCommit: row.valid_until_commit,
    stale: row.stale === 1,
  };
}

export class IssueMemoriesRepo {
  constructor(
    private readonly store: SqliteStore,
    private readonly projectId: string,
  ) {}

  insert(draft: IssueDraft): IssueMemory {
    const id = randomUUID();
    this.store.run(
      `INSERT INTO issue_memories (id, project_id, feature_key, entity_key, fingerprint, category, claim, trigger, decision, priority, rationale, scope, source, anchor_paths, created_at_commit, valid_until_commit, stale)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      this.projectId,
      draft.featureKey,
      draft.entityKey,
      draft.fingerprint,
      draft.category,
      draft.claim,
      draft.trigger,
      draft.decision,
      draft.priority,
      draft.rationale,
      draft.scope,
      draft.source,
      JSON.stringify(draft.anchorPaths ?? []),
      draft.createdAtCommit,
      draft.validUntilCommit,
      draft.stale ? 1 : 0,
    );
    this.store.recordMemoryVersion("issue_memory", id, draft, "insert");
    return { ...draft, anchorPaths: draft.anchorPaths ?? [], id };
  }

  byFingerprint(fingerprint: string): IssueMemory[] {
    return this.store
      .all<Row>(
        "SELECT * FROM issue_memories WHERE project_id = ? AND fingerprint = ? AND stale = 0",
        this.projectId,
        fingerprint,
      )
      .map(toDomain);
  }

  /** Respect the declared decision scope; exact decisions never broaden by key. */
  matchingScope(input: { featureKey?: string; entityKey?: string; category: string }): IssueMemory[] {
    const category = normalizeClaimText(input.category);
    const rows = this.store.all<Row>(
      `SELECT * FROM issue_memories
       WHERE project_id = ? AND stale = 0 AND scope IN ('symbol', 'feature', 'project')
       ORDER BY CASE scope WHEN 'symbol' THEN 0 WHEN 'feature' THEN 1 ELSE 2 END, id`,
      this.projectId,
    );
    return rows.map(toDomain).filter((memory) => {
      if (category && normalizeClaimText(memory.category) !== category) return false;
      if (memory.scope === "symbol") {
        return !!input.entityKey && memory.entityKey === input.entityKey
          && (!input.featureKey || !memory.featureKey || memory.featureKey === input.featureKey);
      }
      if (memory.scope === "feature") return !!input.featureKey && memory.featureKey === input.featureKey;
      return memory.scope === "project";
    });
  }

  byEntity(entityKey: string): IssueMemory[] {
    return this.store
      .all<Row>(
        "SELECT * FROM issue_memories WHERE project_id = ? AND entity_key = ? AND stale = 0",
        this.projectId,
        entityKey,
      )
      .map(toDomain);
  }

  byFeature(featureKey: string): IssueMemory[] {
    return this.store
      .all<Row>(
        "SELECT * FROM issue_memories WHERE project_id = ? AND feature_key = ? AND stale = 0",
        this.projectId,
        featureKey,
      )
      .map(toDomain);
  }

  /**
   * Cross-entity dismissal signal (ADR 0003, observational): past findings
   * that were dismissed AND resemble this candidate by shared anchor path or
   * claim overlap. Unlike the scope-channels in matchIssueHistory, this is a
   * straight table scan over the whole project's issues (bounded size; index
   * only if a measured need appears) and deliberately includes stale entries
   * — staleness is signal, not exclusion. Background context only: the result
   * can never suppress; applyVerdict's trusted-decision + endorsement path
   * is the sole suppression route.
   */
  similarDismissed(
    input: SimilarDismissedInput,
    opts?: { minOverlap?: number; limit?: number },
  ): SimilarDismissedResult {
    const minOverlap = opts?.minOverlap ?? 0.5;
    const limit = opts?.limit ?? 3;
    const category = normalizeClaimText(input.category);
    const paths = new Set(input.anchorPaths);
    const rows = this.store.all<Row>(
      "SELECT * FROM issue_memories WHERE project_id = ?",
      this.projectId,
    );
    const scored: SimilarDismissedSample[] = [];
    for (const row of rows) {
      const memory = toDomain(row);
      if (!DISMISSAL_DECISIONS.includes(memory.decision)) continue;
      if (category && normalizeClaimText(memory.category) !== category) continue;
      const pathIntersection = memory.anchorPaths.some((path) => paths.has(path));
      const overlap = input.normalizedClaim ? claimOverlap(memory.claim, input.normalizedClaim) : 0;
      if (!pathIntersection && overlap < minOverlap) continue;
      scored.push({
        id: memory.id, decision: memory.decision, claim: memory.claim,
        scope: memory.scope, stale: memory.stale, overlap,
      });
    }
    scored.sort((a, b) => b.overlap - a.overlap || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return { count: scored.length, samples: scored.slice(0, limit) };
  }

  recent(limit = 50): IssueMemory[] {
    return this.store
      .all<Row>(
        "SELECT * FROM issue_memories WHERE project_id = ? AND stale = 0 ORDER BY rowid DESC LIMIT ?",
        this.projectId,
        limit,
      )
      .map(toDomain);
  }

  /**
   * Only decisions from trusted sources (user_explicit, verified_fix) may act
   * as suppression evidence; agent summaries never suppress.
   */
  suppressionEvidence(matches: IssueMemory[]): IssueMemory[] {
    return matches.filter((m) => SUPPRESSION_SOURCES.includes(m.source));
  }

  markStale(id: string, stale: boolean): void {
    const current = this.store.get<Row>("SELECT * FROM issue_memories WHERE id = ?", id);
    if (!current) return;
    this.store.run("UPDATE issue_memories SET stale = ? WHERE id = ?", stale ? 1 : 0, id);
    // Versioned so sync's last-write-wins sees staleness flips, not just inserts.
    this.store.recordMemoryVersion("issue_memory", id, { ...toDomain(current), stale }, stale ? "mark_stale" : "mark_fresh");
  }

  invalidateForFingerprint(fingerprint: string): number {
    const rows = this.store
      .all<{ id: string }>(
        "SELECT id FROM issue_memories WHERE project_id = ? AND fingerprint = ?",
        this.projectId,
        fingerprint,
      );
    for (const row of rows) this.markStale(row.id, true);
    return rows.length;
  }
}
