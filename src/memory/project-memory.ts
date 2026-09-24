import { randomUUID } from "node:crypto";
import { parseJsonArray, type MemorySource } from "../core/types.js";
import type { SqliteStore } from "./sqlite-store.js";

export interface ProjectMemory {
  id: string;
  architectureSummary: string;
  responsibilities: string[];
  invariants: string[];
  conventions: string[];
  riskAreas: string[];
  featureKeys: string[];
  source: MemorySource;
  createdAtCommit: string | null;
  validatedAtCommit: string | null;
  stale: boolean;
}

interface Row {
  id: string;
  architecture_summary: string;
  responsibilities: string;
  invariants: string;
  conventions: string;
  risk_areas: string;
  feature_keys: string;
  source: string;
  created_at_commit: string | null;
  validated_at_commit: string | null;
  stale: number;
}

function toDomain(row: Row): ProjectMemory {
  return {
    id: row.id,
    architectureSummary: row.architecture_summary,
    responsibilities: parseJsonArray(row.responsibilities),
    invariants: parseJsonArray(row.invariants),
    conventions: parseJsonArray(row.conventions),
    riskAreas: parseJsonArray(row.risk_areas),
    featureKeys: parseJsonArray(row.feature_keys),
    source: row.source as MemorySource,
    createdAtCommit: row.created_at_commit,
    validatedAtCommit: row.validated_at_commit,
    stale: row.stale === 1,
  };
}

export class ProjectMemoriesRepo {
  constructor(
    private readonly store: SqliteStore,
    private readonly projectId: string,
  ) {}

  get(): ProjectMemory | null {
    const row = this.store.get<Row>(
      "SELECT * FROM project_memories WHERE project_id = ? ORDER BY created_at_commit DESC LIMIT 1",
      this.projectId,
    );
    return row ? toDomain(row) : null;
  }

  upsert(mem: Omit<ProjectMemory, "id"> & { id?: string }): ProjectMemory {
    const existing = this.store.get<{ id: string }>(
      "SELECT id FROM project_memories WHERE project_id = ? LIMIT 1",
      this.projectId,
    );
    const id = existing?.id ?? mem.id ?? randomUUID();
    this.store.run(
      `INSERT INTO project_memories (id, project_id, architecture_summary, responsibilities, invariants, conventions, risk_areas, feature_keys, source, created_at_commit, validated_at_commit, stale)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         architecture_summary = excluded.architecture_summary,
         responsibilities = excluded.responsibilities,
         invariants = excluded.invariants,
         conventions = excluded.conventions,
         risk_areas = excluded.risk_areas,
         feature_keys = excluded.feature_keys,
         source = excluded.source,
         validated_at_commit = excluded.validated_at_commit,
         stale = excluded.stale`,
      id,
      this.projectId,
      mem.architectureSummary,
      JSON.stringify(mem.responsibilities),
      JSON.stringify(mem.invariants),
      JSON.stringify(mem.conventions),
      JSON.stringify(mem.riskAreas),
      JSON.stringify(mem.featureKeys),
      mem.source,
      mem.createdAtCommit,
      mem.validatedAtCommit,
      mem.stale ? 1 : 0,
    );
    this.store.recordMemoryVersion("project_memory", id, mem, "upsert");
    return { ...mem, id };
  }

  /** Append a user-supplied invariant/convention without clobbering the rest. */
  appendUserKnowledge(field: "invariants" | "conventions" | "riskAreas", text: string): void {
    const current = this.get();
    const base: Omit<ProjectMemory, "id"> = current ?? {
      architectureSummary: "",
      responsibilities: [],
      invariants: [],
      conventions: [],
      riskAreas: [],
      featureKeys: [],
      source: "agent_summary",
      createdAtCommit: null,
      validatedAtCommit: null,
      stale: false,
    };
    const list = [...base[field]];
    if (!list.includes(text)) list.push(text);
    this.upsert({ ...base, [field]: list, source: "user_explicit", stale: false });
  }

  markStale(stale: boolean): void {
    this.store.run("UPDATE project_memories SET stale = ? WHERE project_id = ?", stale ? 1 : 0, this.projectId);
  }
}
