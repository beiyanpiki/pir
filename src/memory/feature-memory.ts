import { randomUUID } from "node:crypto";
import { parseJsonArray, type MemorySource } from "../core/types.js";
import type { SqliteStore } from "./sqlite-store.js";

export interface FeatureMemory {
  id: string;
  key: string;
  name: string;
  summary: string;
  responsibilities: string[];
  invariants: string[];
  entryPoints: string[];
  dependencies: string[];
  relatedFeatureKeys: string[];
  source: MemorySource;
  confidence: number;
  createdAtCommit: string | null;
  validatedAtCommit: string | null;
  stale: boolean;
}

export type FeatureDraft = Omit<FeatureMemory, "id">;

interface Row {
  id: string;
  key: string;
  name: string;
  summary: string;
  responsibilities: string;
  invariants: string;
  entry_points: string;
  dependencies: string;
  related_feature_keys: string;
  source: string;
  confidence: number;
  created_at_commit: string | null;
  validated_at_commit: string | null;
  stale: number;
}

function toDomain(row: Row): FeatureMemory {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    summary: row.summary,
    responsibilities: parseJsonArray(row.responsibilities),
    invariants: parseJsonArray(row.invariants),
    entryPoints: parseJsonArray(row.entry_points),
    dependencies: parseJsonArray(row.dependencies),
    relatedFeatureKeys: parseJsonArray(row.related_feature_keys),
    source: row.source as MemorySource,
    confidence: row.confidence,
    createdAtCommit: row.created_at_commit,
    validatedAtCommit: row.validated_at_commit,
    stale: row.stale === 1,
  };
}

export class FeaturesRepo {
  constructor(
    private readonly store: SqliteStore,
    private readonly projectId: string,
  ) {}

  get(key: string): FeatureMemory | null {
    const row = this.store.get<Row>(
      "SELECT * FROM features WHERE project_id = ? AND key = ?",
      this.projectId,
      key,
    );
    return row ? toDomain(row) : null;
  }

  list(): FeatureMemory[] {
    return this.store
      .all<Row>("SELECT * FROM features WHERE project_id = ? ORDER BY key", this.projectId)
      .map(toDomain);
  }

  upsert(draft: FeatureDraft): FeatureMemory {
    const existing = this.store.get<{ id: string }>(
      "SELECT id FROM features WHERE project_id = ? AND key = ?",
      this.projectId,
      draft.key,
    );
    const id = existing?.id ?? randomUUID();
    this.store.run(
      `INSERT INTO features (id, project_id, key, name, summary, responsibilities, invariants, entry_points, dependencies, related_feature_keys, source, confidence, created_at_commit, validated_at_commit, stale)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (project_id, key) DO UPDATE SET
         name = excluded.name,
         summary = excluded.summary,
         responsibilities = excluded.responsibilities,
         invariants = excluded.invariants,
         entry_points = excluded.entry_points,
         dependencies = excluded.dependencies,
         related_feature_keys = excluded.related_feature_keys,
         source = CASE WHEN excluded.source = 'user_explicit' THEN 'user_explicit' ELSE features.source END,
         confidence = MAX(features.confidence, excluded.confidence),
         validated_at_commit = excluded.validated_at_commit,
         stale = excluded.stale`,
      id,
      this.projectId,
      draft.key,
      draft.name,
      draft.summary,
      JSON.stringify(draft.responsibilities),
      JSON.stringify(draft.invariants),
      JSON.stringify(draft.entryPoints),
      JSON.stringify(draft.dependencies),
      JSON.stringify(draft.relatedFeatureKeys),
      draft.source,
      draft.confidence,
      draft.createdAtCommit,
      draft.validatedAtCommit,
      draft.stale ? 1 : 0,
    );
    this.store.recordMemoryVersion("feature", id, draft, "upsert");
    return { ...draft, id };
  }

  markValidated(key: string, commit: string): void {
    this.store.run(
      "UPDATE features SET validated_at_commit = ?, stale = 0 WHERE project_id = ? AND key = ?",
      commit,
      this.projectId,
      key,
    );
  }

  appendUserKnowledge(key: string, kind: "invariant" | "note", text: string, commit: string | null): void {
    const existing = this.get(key);
    const draft: FeatureDraft =
      existing ?? {
        key,
        name: key,
        summary: "",
        responsibilities: [],
        invariants: [],
        entryPoints: [],
        dependencies: [],
        relatedFeatureKeys: [],
        source: "user_explicit",
        confidence: 1,
        createdAtCommit: commit,
        validatedAtCommit: commit,
        stale: false,
      };
    if (kind === "invariant") {
      if (!draft.invariants.includes(text)) draft.invariants.push(text);
    } else {
      if (!draft.responsibilities.includes(text)) draft.responsibilities.push(text);
    }
    this.upsert({ ...draft, source: "user_explicit", confidence: 1, stale: false, validatedAtCommit: commit });
  }
}
