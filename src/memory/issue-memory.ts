import { randomUUID } from "node:crypto";
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

  /** Decisions that could apply to a candidate at symbol / feature / project scope. */
  matchingScope(input: { featureKey?: string; entityKey?: string; category: string }): IssueMemory[] {
    const rows = this.store.all<Row>(
      `SELECT * FROM issue_memories
       WHERE project_id = ? AND stale = 0
         AND (entity_key IS NOT NULL OR feature_key IS NOT NULL OR scope = 'project')
       ORDER BY created_at_commit DESC`,
      this.projectId,
    );
    return rows
      .map(toDomain)
      .filter((m) => {
        if (m.entityKey && input.entityKey && m.entityKey === input.entityKey) return true;
        if (!m.entityKey && m.featureKey && input.featureKey && m.featureKey === input.featureKey) return true;
        if (!m.entityKey && !m.featureKey && m.scope === "project") return true;
        return false;
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
