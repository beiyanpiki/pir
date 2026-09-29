import { randomUUID } from "node:crypto";
import { normalizeClaimText } from "../findings/identity.js";
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
    this.store.run("UPDATE issue_memories SET stale = ? WHERE id = ?", stale ? 1 : 0, id);
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
