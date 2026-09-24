import { randomUUID } from "node:crypto";
import type { SqliteStore } from "./sqlite-store.js";

export type ResolutionKind = "fixed" | "accepted_risk" | "wont_fix" | "expected" | "false_positive";

export interface FindingResolution {
  id: string;
  findingId: string;
  fingerprint: string;
  featureKey: string | null;
  entityKey: string | null;
  category: string;
  originalClaim: string;
  originalTrigger: string;
  resolution: ResolutionKind;
  explanation: string;
  beforeCommit: string | null;
  afterCommit: string | null;
  beforeCodeHash: string | null;
  afterCodeHash: string | null;
  fixCommit: string | null;
  fixDiffHash: string | null;
  /** True once a verifier confirmed the original trigger no longer reproduces. */
  verified: boolean;
  createdAt: number;
}

export type ResolutionDraft = Omit<FindingResolution, "id" | "createdAt">;

interface Row {
  id: string;
  finding_id: string;
  fingerprint: string;
  feature_key: string | null;
  entity_key: string | null;
  category: string;
  original_claim: string;
  original_trigger: string;
  resolution: string;
  explanation: string;
  before_commit: string | null;
  after_commit: string | null;
  before_code_hash: string | null;
  after_code_hash: string | null;
  fix_commit: string | null;
  fix_diff_hash: string | null;
  verified: number;
  created_at: number;
}

function toDomain(row: Row): FindingResolution {
  return {
    id: row.id,
    findingId: row.finding_id,
    fingerprint: row.fingerprint,
    featureKey: row.feature_key,
    entityKey: row.entity_key,
    category: row.category,
    originalClaim: row.original_claim,
    originalTrigger: row.original_trigger,
    resolution: row.resolution as ResolutionKind,
    explanation: row.explanation,
    beforeCommit: row.before_commit,
    afterCommit: row.after_commit,
    beforeCodeHash: row.before_code_hash,
    afterCodeHash: row.after_code_hash,
    fixCommit: row.fix_commit,
    fixDiffHash: row.fix_diff_hash,
    verified: row.verified === 1,
    createdAt: row.created_at,
  };
}

export class ResolutionsRepo {
  constructor(
    private readonly store: SqliteStore,
    private readonly projectId: string,
  ) {}

  insert(draft: ResolutionDraft): FindingResolution {
    const id = randomUUID();
    const createdAt = Date.now();
    this.store.run(
      `INSERT INTO finding_resolutions (id, finding_id, fingerprint, feature_key, entity_key, category, original_claim, original_trigger, resolution, explanation, before_commit, after_commit, before_code_hash, after_code_hash, fix_commit, fix_diff_hash, verified, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      draft.findingId,
      draft.fingerprint,
      draft.featureKey,
      draft.entityKey,
      draft.category,
      draft.originalClaim,
      draft.originalTrigger,
      draft.resolution,
      draft.explanation,
      draft.beforeCommit,
      draft.afterCommit,
      draft.beforeCodeHash,
      draft.afterCodeHash,
      draft.fixCommit,
      draft.fixDiffHash,
      draft.verified ? 1 : 0,
      createdAt,
    );
    this.store.recordMemoryVersion("finding_resolution", id, draft, "insert");
    return { ...draft, id, createdAt };
  }

  markVerified(id: string, afterCommit: string | null, fixCommit: string | null): void {
    this.store.run(
      "UPDATE finding_resolutions SET verified = 1, after_commit = COALESCE(?, after_commit), fix_commit = COALESCE(?, fix_commit) WHERE id = ?",
      afterCommit,
      fixCommit,
      id,
    );
  }

  byFingerprint(fingerprint: string): FindingResolution[] {
    return this.store
      .all<Row>("SELECT * FROM finding_resolutions WHERE fingerprint = ?", fingerprint)
      .map(toDomain);
  }

  byFindingId(findingId: string): FindingResolution[] {
    return this.store
      .all<Row>("SELECT * FROM finding_resolutions WHERE finding_id = ? ORDER BY created_at DESC", findingId)
      .map(toDomain);
  }

  byEntityOrFeature(input: { featureKey?: string; entityKey?: string }, limit = 20): FindingResolution[] {
    if (input.entityKey) {
      const rows = this.store.all<Row>(
        "SELECT * FROM finding_resolutions WHERE entity_key = ? ORDER BY created_at DESC LIMIT ?",
        input.entityKey,
        limit,
      );
      if (rows.length > 0) return rows.map(toDomain);
    }
    if (input.featureKey) {
      return this.store
        .all<Row>(
          "SELECT * FROM finding_resolutions WHERE feature_key = ? ORDER BY created_at DESC LIMIT ?",
          input.featureKey,
          limit,
        )
        .map(toDomain);
    }
    return [];
  }

  /** Verified fixes become regression memory: feature-level "this bug class was fixed here". */
  verifiedFixes(limit = 50): FindingResolution[] {
    return this.store
      .all<Row>(
        "SELECT * FROM finding_resolutions WHERE verified = 1 AND resolution = 'fixed' ORDER BY created_at DESC LIMIT ?",
        limit,
      )
      .map(toDomain);
  }

  recent(limit = 50): FindingResolution[] {
    return this.store
      .all<Row>("SELECT * FROM finding_resolutions ORDER BY created_at DESC LIMIT ?", limit)
      .map(toDomain);
  }
}
