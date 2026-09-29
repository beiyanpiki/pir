import path from "node:path";
import { MIGRATIONS } from "./migrations.js";
import { SqliteStore } from "./sqlite-store.js";
import { projectStateDir } from "./identity.js";

/** Schema version snapshots are tagged with (the latest applied migration). */
export const MEMORY_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

/**
 * Wire version for memory sync, decoupled from the SQLite migration level:
 * migrations may add run-local tables (audit coverage, run modes) without
 * breaking snapshot exchange between pir versions. Bump ONLY when the
 * syncable knowledge tables' shape changes.
 */
export const MEMORY_WIRE_SCHEMA_VERSION = 4;

/**
 * Column lists are pinned on purpose: a snapshot is a wire format between pir
 * versions, and apply writes exactly these columns. When a migration adds a
 * column, extend the list here in the same change.
 */
const COLUMNS = {
  projects: ["id", "remote", "normalized_remote", "root_commit", "created_at", "last_indexed_commit"],
  project_memories: [
    "id", "project_id", "architecture_summary", "responsibilities", "invariants", "conventions",
    "risk_areas", "feature_keys", "source", "created_at_commit", "validated_at_commit", "stale",
    "agent_fields",
  ],
  features: [
    "id", "project_id", "key", "name", "summary", "responsibilities", "invariants", "entry_points",
    "dependencies", "related_feature_keys", "source", "confidence", "created_at_commit",
    "validated_at_commit", "stale", "agent_fields",
  ],
  code_entities: [
    "id", "project_id", "symbol_key", "qualified_name", "kind", "path", "signature",
    "responsibilities", "invariants", "notes", "feature_keys", "source", "signature_hash",
    "body_hash", "last_seen_commit", "stale", "agent_fields",
  ],
  feature_entities: ["feature_id", "entity_id"],
  issue_memories: [
    "id", "project_id", "feature_key", "entity_key", "fingerprint", "category", "claim", "trigger",
    "decision", "priority", "rationale", "scope", "source", "anchor_paths", "created_at_commit",
    "valid_until_commit", "stale",
  ],
  finding_resolutions: [
    "id", "project_id", "finding_id", "fingerprint", "feature_key", "entity_key", "category", "original_claim",
    "original_trigger", "resolution", "explanation", "before_commit", "after_commit",
    "before_code_hash", "after_code_hash", "fix_commit", "fix_diff_hash", "verified", "created_at",
  ],
} as const;

export type SyncTableName = keyof typeof COLUMNS;
export type SyncRow = Record<string, string | number | null>;

export interface MemorySnapshot {
  schemaVersion: number;
  projectId: string;
  exportedAt: number;
  tables: { [K in SyncTableName]: SyncRow[] };
  /** table -> record id -> last write epoch ms, from the memory_versions audit log. */
  writeTimes: Record<string, Record<string, number>>;
}

export interface SyncTableStats {
  localOnly: number;
  remoteOnly: number;
  bothIdentical: number;
  /** Conflicting rows resolved by field-level merge (e.g. the projects row). */
  merged: number;
  conflicts: { localWon: number; remoteWon: number };
}

export interface SyncStats {
  tables: { [K in SyncTableName]: SyncTableStats };
}

export interface SyncResult {
  merged: MemorySnapshot;
  stats: SyncStats;
}

/** memory_versions.memory_type values keyed by their sync table. */
const MEMORY_TYPE_TO_TABLE: Record<string, SyncTableName> = {
  project_memory: "project_memories",
  feature: "features",
  code_entity: "code_entities",
  issue_memory: "issue_memories",
  finding_resolution: "finding_resolutions",
};

/** Inverse of MEMORY_TYPE_TO_TABLE (tables that carry a version log). */
const TABLE_TO_MEMORY_TYPE: Partial<Record<SyncTableName, string>> = Object.fromEntries(
  Object.entries(MEMORY_TYPE_TO_TABLE).map(([type, table]) => [table, type]),
);

/** Source precedence for conflicts: user knowledge always beats agent output. */
const SOURCE_RANK: Record<string, number> = { user_explicit: 3, verified_fix: 2, agent_summary: 1, derived: 0 };

function sourceRank(row: SyncRow): number {
  return SOURCE_RANK[String(row.source ?? "")] ?? 0;
}

function canonical(row: SyncRow): string {
  return JSON.stringify(row, Object.keys(row).sort());
}

function tableSpec(name: SyncTableName): SyncTableStats {
  return { localOnly: 0, remoteOnly: 0, bothIdentical: 0, merged: 0, conflicts: { localWon: 0, remoteWon: 0 } };
}

function emptyStats(): SyncStats {
  const tables = {} as SyncStats["tables"];
  for (const name of Object.keys(COLUMNS) as SyncTableName[]) tables[name] = tableSpec(name);
  return { tables };
}

function selectSql(table: SyncTableName, where: string): string {
  return `SELECT ${COLUMNS[table].join(", ")} FROM ${table} WHERE ${where}`;
}

/**
 * Export one project's syncable rows (the five memory layers plus the
 * feature/entity link table). findings / runs / feedback events are session
 * artifacts and stay local; memory_versions is rebuilt by the receiving side.
 */
export function exportSnapshot(store: SqliteStore, projectId: string): MemorySnapshot {
  const projectScoped = (table: SyncTableName): SyncRow[] =>
    store.all<SyncRow>(selectSql(table, "project_id = ?"), projectId);
  const writeTimes: Record<string, Record<string, number>> = {};
  for (const [type, table] of Object.entries(MEMORY_TYPE_TO_TABLE)) {
    writeTimes[table] = {};
    for (const row of store.all<{ memory_id: string; ts: number }>(
      "SELECT memory_id, MAX(created_at) AS ts FROM memory_versions WHERE memory_type = ? GROUP BY memory_id",
      type,
    )) {
      writeTimes[table]![row.memory_id] = row.ts;
    }
  }
  return {
    schemaVersion: MEMORY_WIRE_SCHEMA_VERSION,
    projectId,
    exportedAt: Date.now(),
    tables: {
      projects: store.all<SyncRow>(selectSql("projects", "id = ?"), projectId),
      project_memories: projectScoped("project_memories"),
      features: projectScoped("features"),
      code_entities: projectScoped("code_entities"),
      feature_entities: store.all<SyncRow>(
        selectSql(
          "feature_entities",
          "feature_id IN (SELECT id FROM features WHERE project_id = ?) " +
            "OR entity_id IN (SELECT id FROM code_entities WHERE project_id = ?)",
        ),
        projectId,
        projectId,
      ),
      issue_memories: projectScoped("issue_memories"),
      finding_resolutions: projectScoped("finding_resolutions"),
    },
    writeTimes,
  };
}

/**
 * Pure path of the centralized per-project store — no directory creation, so
 * callers can probe for existence without side effects.
 */
export function syncTargetDbPath(projectId: string): string {
  const root = process.env.PIR_STATE_ROOT;
  if (root) return path.join(root, projectId, "memory.sqlite");
  return path.join(projectStateDir(projectId), "memory.sqlite");
}

/** An empty snapshot representing "this side has never seen the project". */
export function emptySnapshot(projectId: string): MemorySnapshot {
  return {
    schemaVersion: MEMORY_WIRE_SCHEMA_VERSION,
    projectId,
    exportedAt: 0,
    tables: {
      projects: [],
      project_memories: [],
      features: [],
      code_entities: [],
      feature_entities: [],
      issue_memories: [],
      finding_resolutions: [],
    },
    writeTimes: {},
  };
}

/** Open (and migrate) the centralized server-side store for a project. */
export function openSyncTargetStore(
  projectId: string,
  identity: { remote: string | null; normalizedRemote: string | null; rootCommit: string },
): SqliteStore {
  const store = SqliteStore.open(syncTargetDbPath(projectId));
  store.run(
    `INSERT INTO projects (id, remote, normalized_remote, root_commit, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (id) DO NOTHING`,
    projectId,
    identity.remote,
    identity.normalizedRemote,
    identity.rootCommit,
    Date.now(),
  );
  return store;
}

interface WinnerHooks {
  /** Negative favors b, positive favors a; 0 falls through to later rules. */
  prefer?: (a: SyncRow, b: SyncRow) => number;
}

/**
 * Conflict winner, in order: source precedence (user knowledge wins) >
 * last write time > table-specific preference > canonical content (keeps the
 * merge deterministic and symmetric — both sides reach the same row).
 */
function pickWinner(
  local: SyncRow,
  remote: SyncRow,
  times: { local: number; remote: number },
  hooks: WinnerHooks = {},
): { side: "local" | "remote"; row: SyncRow } {
  const rankDelta = sourceRank(local) - sourceRank(remote);
  if (rankDelta !== 0) return { side: rankDelta > 0 ? "local" : "remote", row: rankDelta > 0 ? local : remote };
  if (times.local !== times.remote) {
    return { side: times.local > times.remote ? "local" : "remote", row: times.local > times.remote ? local : remote };
  }
  const prefer = hooks.prefer?.(local, remote) ?? 0;
  if (prefer !== 0) return { side: prefer > 0 ? "local" : "remote", row: prefer > 0 ? local : remote };
  const cmp = canonical(local).localeCompare(canonical(remote));
  return { side: cmp >= 0 ? "local" : "remote", row: cmp >= 0 ? local : remote };
}

interface KeyedMergeResult {
  rows: SyncRow[];
  /** Losing record id -> winning record id (for feature_entities remapping). */
  idRemap: Map<string, string>;
  stats: SyncTableStats;
}

/**
 * Union two sides' rows by a logical key. `time` maps a row to its last write
 * epoch ms (0 when unknown). Rows only on one side pass through untouched.
 * Output is sorted by key so the merged snapshot is byte-stable regardless of
 * which side was "local".
 */
function mergeKeyed(
  table: SyncTableName,
  localRows: SyncRow[],
  remoteRows: SyncRow[],
  keyOf: (row: SyncRow) => string,
  idColumn: string | null,
  timeOf: (side: "local" | "remote", row: SyncRow) => number,
  hooks: WinnerHooks = {},
): KeyedMergeResult {
  const stats = tableSpec(table);
  const byKey = new Map<string, { side: "local" | "remote"; row: SyncRow }[]>();
  for (const side of ["local", "remote"] as const) {
    for (const row of side === "local" ? localRows : remoteRows) {
      const key = keyOf(row);
      const bucket = byKey.get(key) ?? [];
      bucket.push({ side, row });
      byKey.set(key, bucket);
    }
  }
  const rows: SyncRow[] = [];
  const idRemap = new Map<string, string>();
  for (const key of [...byKey.keys()].sort()) {
    const bucket = byKey.get(key)!;
    if (bucket.length === 1) {
      const only = bucket[0]!;
      stats[only.side === "local" ? "localOnly" : "remoteOnly"] += 1;
      rows.push(only.row);
      if (idColumn) idRemap.set(String(only.row[idColumn]), String(only.row[idColumn]));
      continue;
    }
    const [a, b] = [bucket[0]!, bucket[1]!];
    if (canonical(a.row) === canonical(b.row)) {
      stats.bothIdentical += 1;
      rows.push(a.row);
      if (idColumn) {
        idRemap.set(String(a.row[idColumn]), String(a.row[idColumn]));
        idRemap.set(String(b.row[idColumn]), String(a.row[idColumn]));
      }
      continue;
    }
    const local = a.side === "local" ? a : b;
    const remote = a.side === "local" ? b : a;
    const winner = pickWinner(local.row, remote.row, { local: timeOf("local", local.row), remote: timeOf("remote", remote.row) }, hooks);
    stats.conflicts[winner.side === "local" ? "localWon" : "remoteWon"] += 1;
    rows.push(winner.row);
    if (idColumn) {
      idRemap.set(String(local.row[idColumn]), String(winner.row[idColumn]));
      idRemap.set(String(remote.row[idColumn]), String(winner.row[idColumn]));
    }
  }
  return { rows, idRemap, stats };
}

/** Stable content signature of a row group, independent of row order. */
function canonicalGroup(rows: SyncRow[]): string {
  return JSON.stringify(rows.map((row) => canonical(row)).sort());
}

interface GroupedMergeResult {
  rows: SyncRow[];
  stats: SyncTableStats;
}

/**
 * Merge tables whose rows carry per-replica UUIDs but describe one logical
 * record through a shared fingerprint (issue decisions, fix resolutions).
 * Rows are grouped by fingerprint and a contested fingerprint keeps ONE
 * side's rows wholesale — unioning both sides would leave twin live rows that
 * retrieval reports as contradictory decisions for the same finding. Group
 * precedence follows the conflict rule: trusted knowledge (user decisions,
 * verified fixes) beats fresher agent output, then newest write wins, then
 * canonical content keeps the result deterministic and symmetric. Rows
 * without a fingerprint have no natural key and union by id as before.
 */
function mergeFingerprinted(
  table: "issue_memories" | "finding_resolutions",
  localRows: SyncRow[],
  remoteRows: SyncRow[],
  timeOf: (side: "local" | "remote", row: SyncRow) => number,
  groupRank: (rows: SyncRow[]) => number,
): GroupedMergeResult {
  const stats = tableSpec(table);
  const keyed = mergeKeyed(
    table,
    localRows.filter((row) => row.fingerprint == null),
    remoteRows.filter((row) => row.fingerprint == null),
    (row) => String(row.id),
    null,
    timeOf,
  );
  const rows = [...keyed.rows];
  for (const counter of ["localOnly", "remoteOnly", "bothIdentical", "merged"] as const) {
    stats[counter] += keyed.stats[counter];
  }
  stats.conflicts.localWon += keyed.stats.conflicts.localWon;
  stats.conflicts.remoteWon += keyed.stats.conflicts.remoteWon;

  const groupsOf = (sideRows: SyncRow[]): Map<string, SyncRow[]> => {
    const groups = new Map<string, SyncRow[]>();
    for (const row of sideRows) {
      if (row.fingerprint == null) continue;
      const fp = String(row.fingerprint);
      groups.set(fp, [...(groups.get(fp) ?? []), row]);
    }
    return groups;
  };
  const localGroups = groupsOf(localRows);
  const remoteGroups = groupsOf(remoteRows);

  for (const fp of [...new Set([...localGroups.keys(), ...remoteGroups.keys()])].sort()) {
    const mine = localGroups.get(fp);
    const theirs = remoteGroups.get(fp);
    if (!mine || !theirs) {
      const only = mine ?? theirs!;
      stats[mine ? "localOnly" : "remoteOnly"] += only.length;
      rows.push(...only);
      continue;
    }
    const mineSig = canonicalGroup(mine);
    const theirsSig = canonicalGroup(theirs);
    if (mineSig === theirsSig) {
      stats.bothIdentical += mine.length;
      rows.push(...mine);
      continue;
    }
    const mineTime = Math.max(...mine.map((row) => timeOf("local", row)));
    const theirsTime = Math.max(...theirs.map((row) => timeOf("remote", row)));
    const rankDelta = groupRank(mine) - groupRank(theirs);
    let winner: "local" | "remote";
    if (rankDelta !== 0) winner = rankDelta > 0 ? "local" : "remote";
    else if (mineTime !== theirsTime) winner = mineTime > theirsTime ? "local" : "remote";
    else winner = mineSig > theirsSig ? "local" : "remote";
    stats.conflicts[winner === "local" ? "localWon" : "remoteWon"] += 1;
    rows.push(...(winner === "local" ? mine : theirs));
  }
  rows.sort((a, b) => {
    const fa = a.fingerprint == null ? "\uffff" : String(a.fingerprint);
    const fb = b.fingerprint == null ? "\uffff" : String(b.fingerprint);
    return fa === fb ? (String(a.id) < String(b.id) ? -1 : 1) : fa < fb ? -1 : 1;
  });
  return { rows, stats };
}

/** Prefer non-null; when both sides have a value, take the deterministic max. */
function pickField(a: string | number | null | undefined, b: string | number | null | undefined): string | number | null {
  if (a === null || a === undefined) return b ?? null;
  if (b === null || b === undefined) return a;
  return a > b ? a : b;
}

/**
 * Deterministic, symmetric merge of two snapshots of the same project. Both
 * sides converge once each applies the returned `merged` snapshot — memories
 * are never deleted (staleness is a flag), so the merge is a pure union plus
 * conflict resolution, with no tombstones.
 *
 * The merged rows are identical whichever snapshot comes first, but the STATS
 * are told from the FIRST snapshot's perspective ("local"); the server passes
 * the client's snapshot first so the client can read the counters as-is.
 */
export function mergeSnapshots(local: MemorySnapshot, remote: MemorySnapshot): SyncResult {
  if (local.projectId !== remote.projectId) {
    throw new Error(`snapshot project mismatch: ${local.projectId} vs ${remote.projectId}`);
  }
  for (const side of [local, remote]) {
    if (side.schemaVersion !== MEMORY_WIRE_SCHEMA_VERSION) {
      throw new Error(
        `snapshot schema version ${side.schemaVersion} does not match ${MEMORY_WIRE_SCHEMA_VERSION}; ` +
          "upgrade pir so both sides share one schema",
      );
    }
  }
  const stats = emptyStats();
  const timeOf = (side: "local" | "remote", table: SyncTableName, id: string): number =>
    (side === "local" ? local : remote).writeTimes[table]?.[id] ?? 0;

  // projects: a single identity row; merge field-wise instead of picking one.
  const projects: SyncRow[] = [];
  const lp = local.tables.projects[0];
  const rp = remote.tables.projects[0];
  if (lp || rp) {
    if (lp && rp) {
      const merged: SyncRow = { ...lp };
      merged.remote = pickField(lp.remote, rp.remote);
      merged.normalized_remote = pickField(lp.normalized_remote, rp.normalized_remote);
      // last_indexed_commit is machine-local git state: a foreign SHA need not
      // be an ancestor of this replica's HEAD, and incremental refresh diffs
      // against it. Keep it only when both replicas agree; on divergence (or a
      // one-sided pointer) drop it so the next refresh re-indexes fully.
      merged.last_indexed_commit =
        lp.last_indexed_commit != null && lp.last_indexed_commit === rp.last_indexed_commit
          ? lp.last_indexed_commit
          : null;
      merged.created_at = Math.min(Number(lp.created_at), Number(rp.created_at));
      stats.tables.projects[canonical(lp) === canonical(rp) ? "bothIdentical" : "merged"] += 1;
      projects.push(merged);
    } else {
      const only = (lp ?? rp)!;
      stats.tables.projects[lp ? "localOnly" : "remoteOnly"] += 1;
      projects.push(only);
    }
  }

  const writeTimeOf =
    (table: SyncTableName) =>
    (side: "local" | "remote", row: SyncRow): number =>
      timeOf(side, table, String(row.id));

  const projectMemories = mergeKeyed(
    "project_memories",
    local.tables.project_memories,
    remote.tables.project_memories,
    (row) => String(row.project_id),
    null,
    writeTimeOf("project_memories"),
  );
  const features = mergeKeyed(
    "features",
    local.tables.features,
    remote.tables.features,
    (row) => String(row.key),
    "id",
    writeTimeOf("features"),
    { prefer: (a, b) => Number(a.confidence) - Number(b.confidence) },
  );
  const entities = mergeKeyed(
    "code_entities",
    local.tables.code_entities,
    remote.tables.code_entities,
    (row) => String(row.symbol_key),
    "id",
    writeTimeOf("code_entities"),
  );
  const issues = mergeFingerprinted(
    "issue_memories",
    local.tables.issue_memories,
    remote.tables.issue_memories,
    writeTimeOf("issue_memories"),
    // A group's rank is its most trusted row: user knowledge beats agent output.
    (rows) => Math.max(...rows.map((row) => SOURCE_RANK[String(row.source ?? "")] ?? 0)),
  );
  const resolutions = mergeFingerprinted(
    "finding_resolutions",
    local.tables.finding_resolutions,
    remote.tables.finding_resolutions,
    writeTimeOf("finding_resolutions"),
    // A verifier-confirmed fix outranks an unverified copy regardless of time.
    (rows) => (rows.some((row) => Number(row.verified) === 1) ? 1 : 0),
  );

  // Link pairs follow the surviving feature/entity ids; union both sides.
  const featureIds = new Set(features.rows.map((r) => String(r.id)));
  const entityIds = new Set(entities.rows.map((r) => String(r.id)));
  const pairKeyOf = (row: SyncRow): string | null => {
    const featureId = features.idRemap.get(String(row.feature_id));
    const entityId = entities.idRemap.get(String(row.entity_id));
    if (!featureId || !entityId) return null; // orphaned link — drop defensively
    if (!featureIds.has(featureId) || !entityIds.has(entityId)) return null;
    return JSON.stringify([featureId, entityId]);
  };
  const localKeys = new Set(
    local.tables.feature_entities.map(pairKeyOf).filter((key): key is string => key !== null),
  );
  const remoteKeys = new Set(
    remote.tables.feature_entities.map(pairKeyOf).filter((key): key is string => key !== null),
  );
  const pairs = new Set([...localKeys, ...remoteKeys]);
  const featureEntities = [...pairs]
    .map((p) => {
      const [featureId, entityId] = JSON.parse(p) as [string, string];
      return { feature_id: featureId, entity_id: entityId };
    })
    .sort((a, b) => (a.feature_id === b.feature_id ? (a.entity_id < b.entity_id ? -1 : 1) : a.feature_id < b.feature_id ? -1 : 1));
  // Count real deltas (like every other table) so push/pull reporting stays honest.
  stats.tables.feature_entities = {
    ...tableSpec("feature_entities"),
    localOnly: [...localKeys].filter((key) => !remoteKeys.has(key)).length,
    remoteOnly: [...remoteKeys].filter((key) => !localKeys.has(key)).length,
    bothIdentical: [...localKeys].filter((key) => remoteKeys.has(key)).length,
  };

  stats.tables.project_memories = projectMemories.stats;
  stats.tables.features = features.stats;
  stats.tables.code_entities = entities.stats;
  stats.tables.issue_memories = issues.stats;
  stats.tables.finding_resolutions = resolutions.stats;

  // writeTimes carry the versioned tables only (the map's VALUES — its keys
  // are memory-type names, a different namespace than snapshot writeTimes).
  const writeTimes: Record<string, Record<string, number>> = {};
  for (const table of Object.values(MEMORY_TYPE_TO_TABLE)) {
    writeTimes[table] = {};
    for (const source of [local, remote]) {
      for (const [id, ts] of Object.entries(source.writeTimes[table] ?? {})) {
        writeTimes[table]![id] = Math.max(writeTimes[table]![id] ?? 0, ts);
      }
    }
  }

  const merged: MemorySnapshot = {
    schemaVersion: MEMORY_WIRE_SCHEMA_VERSION,
    projectId: local.projectId,
    exportedAt: Math.max(local.exportedAt, remote.exportedAt),
    tables: {
      projects,
      project_memories: projectMemories.rows,
      features: features.rows,
      code_entities: entities.rows,
      feature_entities: featureEntities,
      issue_memories: issues.rows,
      finding_resolutions: resolutions.rows,
    },
    writeTimes,
  };
  return { merged, stats };
}

function insertValues(table: SyncTableName): { sql: string; values: (row: SyncRow) => (string | number | null)[] } {
  const cols = COLUMNS[table];
  const values = (row: SyncRow): (string | number | null)[] => cols.map((c) => row[c] ?? null);
  return { sql: `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, values };
}

/**
 * Apply a merged snapshot to a store: every changed row is upserted inside one
 * transaction; identical rows are skipped so repeated syncs stay cheap and the
 * version log only grows for real changes. Natural-keyed tables (features,
 * code_entities, project_memories) are replaced by key so the winning row's id
 * takes over; feature_entities is rewritten in the project's scope.
 *
 * Returns the number of rows written per table.
 */
export function applySnapshot(store: SqliteStore, projectId: string, snapshot: MemorySnapshot): Record<SyncTableName, number> {
  if (snapshot.projectId !== projectId) {
    throw new Error(`snapshot belongs to project ${snapshot.projectId}, not ${projectId}`);
  }
  if (snapshot.schemaVersion !== MEMORY_WIRE_SCHEMA_VERSION) {
    throw new Error(
      `snapshot schema version ${snapshot.schemaVersion} does not match ${MEMORY_WIRE_SCHEMA_VERSION}; ` +
        "upgrade pir so both sides share one schema",
    );
  }
  const applied = {} as Record<SyncTableName, number>;
  for (const name of Object.keys(COLUMNS) as SyncTableName[]) applied[name] = 0;

  const changed = (existing: SyncRow | undefined, incoming: SyncRow): boolean =>
    !existing || canonical(existing) !== canonical(incoming);

  store.transaction(() => {
    // projects: identity fields are immutable; the syncable fields are the
    // remote hints, last_indexed_commit and created_at (merged to the
    // earliest opening time so replicas converge).
    const project = snapshot.tables.projects[0];
    if (project) {
      const existing = store.get<SyncRow>(selectSql("projects", "id = ?"), projectId);
      const hintsOf = (row: SyncRow | undefined): string =>
        row
          ? JSON.stringify([
              row.remote ?? null,
              row.normalized_remote ?? null,
              row.last_indexed_commit ?? null,
              row.created_at ?? null,
            ])
          : "";
      if (hintsOf(existing) !== hintsOf(project)) {
        store.run(
          `INSERT INTO projects (${COLUMNS.projects.join(", ")}) VALUES (${COLUMNS.projects.map(() => "?").join(", ")})
           ON CONFLICT (id) DO UPDATE SET
             remote = excluded.remote,
             normalized_remote = excluded.normalized_remote,
             last_indexed_commit = excluded.last_indexed_commit,
             created_at = excluded.created_at`,
          ...COLUMNS.projects.map((c) => project[c] ?? null),
        );
        applied.projects = 1;
      }
    }

    const replaceByKey = (table: "project_memories" | "features" | "code_entities", keyColumn: string): void => {
      const { sql, values } = insertValues(table);
      for (const row of snapshot.tables[table]) {
        const key = String(row[keyColumn] ?? "");
        const existing = store.get<SyncRow>(selectSql(table, `project_id = ? AND ${keyColumn} = ?`), projectId, key);
        if (!changed(existing, row)) continue;
        store.run(`DELETE FROM ${table} WHERE project_id = ? AND ${keyColumn} = ?`, projectId, key);
        store.run(sql, ...values(row));
        store.recordMemoryVersion(TABLE_TO_MEMORY_TYPE[table]!, String(row.id), row, "sync");
        applied[table] += 1;
      }
    };
    replaceByKey("project_memories", "project_id");
    replaceByKey("features", "key");
    replaceByKey("code_entities", "symbol_key");

    // Fingerprinted rows replace per group, scoped to this project: a merge
    // can swap which replica's history survives for a fingerprint, and a
    // plain upsert would keep the losing twin rows alive beside the winners.
    // Fingerprint-less rows have no natural key and keep the plain
    // upsert-by-id.
    const replaceByFingerprint = (table: "issue_memories" | "finding_resolutions"): void => {
      const cols = COLUMNS[table];
      const { sql, values } = insertValues(table);
      const groups = new Map<string, SyncRow[]>();
      const unkeyed: SyncRow[] = [];
      for (const row of snapshot.tables[table]) {
        if (row.fingerprint == null) unkeyed.push(row);
        else groups.set(String(row.fingerprint), [...(groups.get(String(row.fingerprint)) ?? []), row]);
      }
      for (const [fp, groupRows] of groups) {
        const existing = store.all<SyncRow>(selectSql(table, "project_id = ? AND fingerprint = ?"), projectId, fp);
        if (existing.length === groupRows.length && canonicalGroup(existing) === canonicalGroup(groupRows)) continue;
        store.run(`DELETE FROM ${table} WHERE project_id = ? AND fingerprint = ?`, projectId, fp);
        for (const row of groupRows) {
          store.run(sql, ...values(row));
          store.recordMemoryVersion(TABLE_TO_MEMORY_TYPE[table]!, String(row.id), row, "sync");
          applied[table] += 1;
        }
      }
      for (const row of unkeyed) {
        const existing = store.get<SyncRow>(selectSql(table, "id = ?"), String(row.id));
        if (!changed(existing, row)) continue;
        store.run(
          `${sql} ON CONFLICT (id) DO UPDATE SET ${cols.filter((c) => c !== "id").map((c) => `${c} = excluded.${c}`).join(", ")}`,
          ...values(row),
        );
        store.recordMemoryVersion(TABLE_TO_MEMORY_TYPE[table]!, String(row.id), row, "sync");
        applied[table] += 1;
      }
    };
    replaceByFingerprint("issue_memories");
    replaceByFingerprint("finding_resolutions");

    // Rewrite the link table in the project's scope: applying a merge can
    // swap a feature/entity row's id (natural-key replace), which orphans
    // the old pairs, so double-dangling orphans are cleaned too — a plain
    // membership-scoped delete would miss exactly those. Other projects'
    // pairs in a shared DB (PIR_MEMORY_DB / dbPath override) stay untouched;
    // links are fully derived state, so scoped delete-all + insert is both
    // correct and simple.
    const pairScope =
      "feature_id IN (SELECT id FROM features WHERE project_id = ?) " +
      "OR entity_id IN (SELECT id FROM code_entities WHERE project_id = ?) " +
      "OR (feature_id NOT IN (SELECT id FROM features) AND entity_id NOT IN (SELECT id FROM code_entities))";
    const currentPairs = store
      .all<SyncRow>(selectSql("feature_entities", pairScope), projectId, projectId)
      .map((r) => JSON.stringify([r.feature_id, r.entity_id]))
      .sort();
    const mergedPairs = snapshot.tables.feature_entities
      .map((r) => JSON.stringify([r.feature_id, r.entity_id]))
      .sort();
    if (JSON.stringify(currentPairs) !== JSON.stringify(mergedPairs)) {
      store.run(`DELETE FROM feature_entities WHERE ${pairScope}`, projectId, projectId);
      for (const pair of snapshot.tables.feature_entities) {
        store.run(
          "INSERT OR IGNORE INTO feature_entities (feature_id, entity_id) VALUES (?, ?)",
          pair.feature_id ?? null,
          pair.entity_id ?? null,
        );
      }
      applied.feature_entities = snapshot.tables.feature_entities.length;
    }
  });
  return applied;
}
