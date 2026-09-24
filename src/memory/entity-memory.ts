import { randomUUID } from "node:crypto";
import { parseJsonArray, type MemorySource } from "../core/types.js";
import type { SqliteStore } from "./sqlite-store.js";

export interface CodeEntityMemory {
  id: string;
  /** Stable key such as "PaymentService.retry" or "src/pay/service.ts#retry". */
  symbolKey: string;
  qualifiedName: string;
  kind: string;
  path: string;
  signature: string | null;
  responsibilities: string[];
  invariants: string[];
  notes: string[];
  featureKeys: string[];
  source: MemorySource;
  signatureHash: string | null;
  bodyHash: string | null;
  lastSeenCommit: string | null;
  stale: boolean;
}

export type EntityDraft = Omit<CodeEntityMemory, "id">;

interface Row {
  id: string;
  symbol_key: string;
  qualified_name: string;
  kind: string;
  path: string;
  signature: string | null;
  responsibilities: string;
  invariants: string;
  notes: string;
  feature_keys: string;
  source: string;
  signature_hash: string | null;
  body_hash: string | null;
  last_seen_commit: string | null;
  stale: number;
}

function toDomain(row: Row): CodeEntityMemory {
  return {
    id: row.id,
    symbolKey: row.symbol_key,
    qualifiedName: row.qualified_name,
    kind: row.kind,
    path: row.path,
    signature: row.signature,
    responsibilities: parseJsonArray(row.responsibilities),
    invariants: parseJsonArray(row.invariants),
    notes: parseJsonArray(row.notes),
    featureKeys: parseJsonArray(row.feature_keys),
    source: row.source as MemorySource,
    signatureHash: row.signature_hash,
    bodyHash: row.body_hash,
    lastSeenCommit: row.last_seen_commit,
    stale: row.stale === 1,
  };
}

export class EntitiesRepo {
  constructor(
    private readonly store: SqliteStore,
    private readonly projectId: string,
  ) {}

  get(symbolKey: string): CodeEntityMemory | null {
    const row = this.store.get<Row>(
      "SELECT * FROM code_entities WHERE project_id = ? AND symbol_key = ?",
      this.projectId,
      symbolKey,
    );
    return row ? toDomain(row) : null;
  }

  list(): CodeEntityMemory[] {
    return this.store
      .all<Row>("SELECT * FROM code_entities WHERE project_id = ? ORDER BY symbol_key", this.projectId)
      .map(toDomain);
  }

  byPaths(paths: string[]): CodeEntityMemory[] {
    if (paths.length === 0) return [];
    const placeholders = paths.map(() => "?").join(", ");
    return this.store
      .all<Row>(
        `SELECT * FROM code_entities WHERE project_id = ? AND path IN (${placeholders})`,
        this.projectId,
        ...paths,
      )
      .map(toDomain);
  }

  byQualifiedName(name: string): CodeEntityMemory | null {
    const row = this.store.get<Row>(
      "SELECT * FROM code_entities WHERE project_id = ? AND qualified_name = ?",
      this.projectId,
      name,
    );
    return row ? toDomain(row) : null;
  }

  upsert(draft: EntityDraft): CodeEntityMemory {
    const existing = this.store.get<{ id: string }>(
      "SELECT id FROM code_entities WHERE project_id = ? AND symbol_key = ?",
      this.projectId,
      draft.symbolKey,
    );
    const id = existing?.id ?? randomUUID();
    this.store.run(
      `INSERT INTO code_entities (id, project_id, symbol_key, qualified_name, kind, path, signature, responsibilities, invariants, notes, feature_keys, source, signature_hash, body_hash, last_seen_commit, stale)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (project_id, symbol_key) DO UPDATE SET
         qualified_name = excluded.qualified_name,
         kind = excluded.kind,
         path = excluded.path,
         signature = excluded.signature,
         responsibilities = excluded.responsibilities,
         invariants = excluded.invariants,
         notes = excluded.notes,
         feature_keys = excluded.feature_keys,
         source = CASE WHEN excluded.source = 'user_explicit' THEN 'user_explicit' ELSE code_entities.source END,
         signature_hash = excluded.signature_hash,
         body_hash = excluded.body_hash,
         last_seen_commit = excluded.last_seen_commit,
         stale = excluded.stale`,
      id,
      this.projectId,
      draft.symbolKey,
      draft.qualifiedName,
      draft.kind,
      draft.path,
      draft.signature,
      JSON.stringify(draft.responsibilities),
      JSON.stringify(draft.invariants),
      JSON.stringify(draft.notes),
      JSON.stringify(draft.featureKeys),
      draft.source,
      draft.signatureHash,
      draft.bodyHash,
      draft.lastSeenCommit,
      draft.stale ? 1 : 0,
    );
    this.store.recordMemoryVersion("code_entity", id, draft, "upsert");
    this.linkFeature(id, draft.featureKeys);
    return { ...draft, id };
  }

  private linkFeature(entityId: string, featureKeys: string[]): void {
    for (const key of featureKeys) {
      const feature = this.store.get<{ id: string }>(
        "SELECT id FROM features WHERE project_id = ? AND key = ?",
        this.projectId,
        key,
      );
      if (!feature) continue;
      this.store.run(
        "INSERT OR IGNORE INTO feature_entities (feature_id, entity_id) VALUES (?, ?)",
        feature.id,
        entityId,
      );
    }
  }

  appendUserKnowledge(
    symbolKey: string,
    kind: "invariant" | "note",
    text: string,
    commit: string | null,
  ): CodeEntityMemory {
    const existing = this.get(symbolKey);
    const draft: EntityDraft =
      existing ?? {
        symbolKey,
        qualifiedName: symbolKey,
        kind: "unknown",
        path: "",
        signature: null,
        responsibilities: [],
        invariants: [],
        notes: [],
        featureKeys: [],
        source: "user_explicit",
        signatureHash: null,
        bodyHash: null,
        lastSeenCommit: commit,
        stale: false,
      };
    if (kind === "invariant") {
      if (!draft.invariants.includes(text)) draft.invariants.push(text);
    } else {
      if (!draft.notes.includes(text)) draft.notes.push(text);
    }
    return this.upsert({ ...draft, source: "user_explicit", lastSeenCommit: commit ?? draft.lastSeenCommit, stale: false });
  }

  markSeen(symbolKey: string, commit: string): void {
    this.store.run(
      "UPDATE code_entities SET last_seen_commit = ?, stale = 0 WHERE project_id = ? AND symbol_key = ?",
      commit,
      this.projectId,
      symbolKey,
    );
  }

  /** Entities whose stored body hash no longer matches the file hash at commit. */
  markStaleWhereHashMismatch(commit: string, hashByPath: Map<string, string>): number {
    let count = 0;
    for (const entity of this.list()) {
      if (!entity.path || entity.stale) continue;
      const current = hashByPath.get(entity.path);
      if (current === undefined) continue;
      if (entity.bodyHash && entity.bodyHash !== current) {
        this.store.run(
          "UPDATE code_entities SET stale = 1 WHERE project_id = ? AND symbol_key = ?",
          this.projectId,
          entity.symbolKey,
        );
        count += 1;
      } else if (!entity.bodyHash) {
        this.store.run(
          "UPDATE code_entities SET body_hash = ?, last_seen_commit = ? WHERE project_id = ? AND symbol_key = ?",
          current,
          commit,
          this.projectId,
          entity.symbolKey,
        );
      }
    }
    return count;
  }
}
