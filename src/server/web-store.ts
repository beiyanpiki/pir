import { existsSync, readdirSync, readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { listRepos, type RepoEntry } from "../app/repos.js";
import type { RunManifest, RunSessionRef } from "../observability/run-events.js";

/**
 * Read-only data access for the web UI. Everything here treats pir's state as
 * an archive: fresh read-only sqlite connections (no migrations, no WAL
 * writes) against per-project memory DBs, plus transcript/manifest JSON on
 * disk. Nothing in this module may write or execute pir commands.
 */

export interface ProjectSummary {
  projectId: string;
  /** Human name: repo registry name > git remote > short id. */
  name: string;
  remote: string | null;
  runsTotal: number;
  lastRunAt: number | null;
  lastRunStatus: string | null;
  openFindings: number;
  namedInRegistry: boolean;
}

export interface RunSummary {
  runId: string;
  mode: string;
  base: string | null;
  head: string;
  startedAt: number;
  finishedAt: number | null;
  status: string;
  rounds: number;
  candidates: number;
  confirmed: number;
  rejected: number;
  uncertain: number;
  notes: string | null;
  /** From run.json when the run recorded one; null otherwise. */
  model: string | null;
  durationMs: number | null;
  totalTokens: number | null;
  cost: number | null;
  transcriptsAvailable: boolean;
  verifierModel: string | null;
  runVerdict: string | null;
  incomplete: boolean;
  stoppedBecause: string | null;
  lastUpdatedAt: number | null;
}

export interface FindingSummary {
  /** Enough to render a collapsed row; the detail fetch carries the rest. */
  id: string;
  displayId: string;
  title: string;
  category: string;
  severity: string;
  status: string;
  round: number;
  createdAt: number;
  evidenceCount: number;
  confidence: number | null;
}

export interface FindingView {
  id: string;
  displayId: string;
  title: string;
  claim: string;
  trigger: string;
  category: string;
  severity: string;
  status: string;
  featureKey: string | null;
  entityKey: string | null;
  anchors: Array<{ path: string; startLine: number; endLine?: number }>;
  evidence: Array<{ kind: string; path?: string; startLine?: number; excerpt?: string; description?: string }>;
  memoryMatches: unknown[];
  verifierRationale: string | null;
  round: number;
  createdAt: number;
  confidence: number | null;
  relatedSessions: Array<{ sessionKey: string; relation: "candidate" | "verification"; originalDisplayId?: string }>;
}

export interface SessionRef {
  file: string;
  transcriptFile?: string;
  sessionKind: "reviewer" | "verifier" | "unknown";
  round?: number;
  unitId?: string;
  attempt?: number;
  displayId?: string;
  /** F1: the specialized finder angle this reviewer session ran as. */
  angle?: string;
  /** F1: collector-id → supervisor-reassigned runtime id, for parallel angle sessions. */
  idMap?: Array<{ from: string; to: string }>;
  findingIdMap?: Array<{ from: string; to: string }>;
}

export interface FeedbackEventView {
  id: number;
  ts: number;
  findingId: string | null;
  action: string;
  decision: string | null;
  priority: string | null;
  note: string | null;
  scope: string | null;
  target: string | null;
}

export interface RunDetail {
  run: RunSummary;
  /** Row summaries only — claim/evidence/rationale load per finding on demand. */
  findings: { items: FindingSummary[]; total: number };
  manifest: RunManifest | null;
  sessions: SessionRef[];
  /** False when the run predates transcripts (nothing to replay). */
  transcriptsAvailable: boolean;
}

export interface ChangeCoverageFileView { path: string; covered: number; total: number }
export interface ChangeCoverageSummaryView { hunksTotal: number; hunksCovered: number; filesTotal: number; filesCovered: number; files: ChangeCoverageFileView[] }
export interface AuditUnitView { id: string; module: string; state: string; reason?: string; files: number; attempts: number }
export interface AuditFileCoverageView { path: string; blobId: string; state: string; reason?: string; rangesTotal: number; rangesReviewed: number }
export interface AuditCoverageSummaryView {
  filesTotal: number; filesNotSelected: number; filesExcluded: number; filesInScope: number;
  filesReviewed: number; filesPartial: number; filesUnreviewed: number; filesBlocked: number; filesFailed: number;
  batchesTotal: number; batchesCompleted: number; batchesBlocked: number; batchesFailed: number;
}
export type CoverageView =
  | { mode: "change"; available: true; summary: ChangeCoverageSummaryView; files: ChangeCoverageFileView[] }
  | { mode: "audit"; available: true; summary: AuditCoverageSummaryView; units: AuditUnitView[]; files: AuditFileCoverageView[]; target: unknown }
  | { mode: "change" | "audit"; available: false; reason: "not-recorded" | "unavailable" };

const PROJECT_ID_PATTERN = /^[0-9a-f]{64}$/;
const SUMMARY_CACHE_TTL_MS = 5_000;

/** pir's state base directory (PIR_STATE_ROOT or the platform default). */
export function pirStateBase(home = homedir()): string {
  const root = process.env.PIR_STATE_ROOT;
  if (root) return root;
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "pir");
  }
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), "pir");
  }
  const xdgState = process.env.XDG_STATE_HOME ?? path.join(home, ".local", "state");
  return path.join(xdgState, "pir");
}

export function isValidProjectId(projectId: string): boolean {
  return PROJECT_ID_PATTERN.test(projectId);
}

/**
 * Read-only sqlite handle. node:sqlite's readOnly option keeps the web layer
 * honest (SELECT-only at the driver level) and lets WAL readers run alongside
 * the single writer without touching the enqueue queue.
 */
function openReadonly(dbPath: string): DatabaseSync {
  try {
    return new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    // Older node patch levels lack readOnly; SELECT-only usage still holds.
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA query_only = ON");
    return db;
  }
}

function withDb<T>(dbPath: string, fn: (db: DatabaseSync) => T): T | null {
  if (!existsSync(dbPath)) return null;
  let db: DatabaseSync;
  try {
    db = openReadonly(dbPath);
  } catch {
    return null;
  }
  try {
    db.exec("PRAGMA busy_timeout = 2000");
    return fn(db);
  } catch {
    return null;
  } finally {
    try {
      db.close();
    } catch {
      // A closed/broken handle is not worth failing the request over.
    }
  }
}

function repoNamesByProjectId(): Map<string, RepoEntry> {
  try {
    return new Map(listRepos().map((entry) => [entry.projectId, entry]));
  } catch {
    return new Map();
  }
}

interface CachedProjectSummary {
  expiresAt: number;
  summary: ProjectSummary;
}

const summaryCache = new Map<string, CachedProjectSummary>();

function projectSummary(projectId: string, dbPath: string, names: Map<string, RepoEntry>): ProjectSummary {
  const cached = summaryCache.get(projectId);
  if (cached && cached.expiresAt > Date.now()) return cached.summary;
  const summary = withDb(dbPath, (db) => {
    const project = db.prepare("SELECT remote, normalized_remote FROM projects LIMIT 1").get() as
      | { remote: string | null; normalized_remote: string | null }
      | undefined;
    const runs = db.prepare("SELECT COUNT(*) AS n, MAX(started_at) AS last, (SELECT status FROM review_runs ORDER BY started_at DESC LIMIT 1) AS lastStatus FROM review_runs").get() as
      | { n: number; last: number | null; lastStatus: string | null }
      | undefined;
    const open = db.prepare("SELECT COUNT(*) AS n FROM findings WHERE status IN ('confirmed', 'uncertain')").get() as { n: number } | undefined;
    const entry = names.get(projectId);
    const remote = project?.normalized_remote ?? project?.remote ?? null;
    const name = entry?.name ?? (remote ? remote.replace(/^https?:\/\//, "").replace(/\.git$/, "") : projectId.slice(0, 12));
    return {
      projectId,
      name,
      remote,
      runsTotal: runs?.n ?? 0,
      lastRunAt: runs?.last ?? null,
      lastRunStatus: runs?.lastStatus ?? null,
      openFindings: open?.n ?? 0,
      namedInRegistry: Boolean(entry),
    };
  }) ?? {
    projectId,
    name: names.get(projectId)?.name ?? projectId.slice(0, 12),
    remote: names.get(projectId)?.url ?? null,
    runsTotal: 0,
    lastRunAt: null,
    lastRunStatus: null,
    openFindings: 0,
    namedInRegistry: names.has(projectId),
  };
  summaryCache.set(projectId, { expiresAt: Date.now() + SUMMARY_CACHE_TTL_MS, summary });
  return summary;
}

export function listProjects(stateRoot = pirStateBase()): ProjectSummary[] {
  const names = repoNamesByProjectId();
  let entries: string[] = [];
  try {
    entries = readdirSync(stateRoot);
  } catch {
    return [];
  }
  const summaries: ProjectSummary[] = [];
  for (const projectId of entries) {
    if (!isValidProjectId(projectId)) continue;
    const dbPath = path.join(stateRoot, projectId, "memory.sqlite");
    if (!existsSync(dbPath)) continue;
    summaries.push(projectSummary(projectId, dbPath, names));
  }
  summaries.sort((a, b) => (b.lastRunAt ?? 0) - (a.lastRunAt ?? 0) || a.name.localeCompare(b.name));
  return summaries;
}

export function invalidateProjectSummaryCache(): void {
  summaryCache.clear();
}

interface RawRunRow {
  id: string;
  mode: string;
  base: string | null;
  head: string;
  started_at: number;
  finished_at: number | null;
  status: string;
  rounds: number;
  candidates: number;
  confirmed: number;
  rejected: number;
  uncertain: number;
  notes: string | null;
  target?: string | null;
  updated_at?: number | null;
}

function manifestFor(stateRoot: string, projectId: string, runId: string): RunManifest | null {
  const file = path.join(stateRoot, projectId, "transcripts", runId, "run.json");
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as RunManifest;
    if (parsed?.schemaVersion !== 1 || typeof parsed.runId !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

function toRunSummary(row: RawRunRow, stateRoot: string, projectId: string): RunSummary {
  const manifest = manifestFor(stateRoot, projectId, row.id);
  return {
    runId: row.id,
    // Pre-v5 archives predate the audit mode; every recorded run is a change.
    mode: typeof row.mode === "string" ? row.mode : "change",
    base: row.base,
    head: row.head,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: row.status,
    rounds: row.rounds,
    candidates: row.candidates,
    confirmed: row.confirmed,
    rejected: row.rejected,
    uncertain: row.uncertain,
    notes: row.notes,
    model: manifest?.model ?? null,
    durationMs: manifest?.durationMs ?? (row.finished_at !== null ? row.finished_at - row.started_at : null),
    totalTokens: manifest?.usage?.totalTokens ?? null,
    cost: manifest?.usage?.cost ?? null,
    transcriptsAvailable: existsSync(path.join(stateRoot, projectId, "transcripts", row.id)),
    verifierModel: manifest?.verifierModel ?? null,
    runVerdict: manifest?.incomplete ? "incomplete" : manifest?.runVerdict === "correct" ? "clean" : manifest?.runVerdict === "incorrect" ? "incorrect" : manifest?.runVerdict ? "unknown" : null,
    incomplete: manifest?.incomplete ?? row.status === "incomplete",
    stoppedBecause: manifest?.stoppedBecause ?? row.notes ?? null,
    lastUpdatedAt: row.updated_at ?? manifest?.finishedAt ?? row.finished_at ?? row.started_at,
  };
}

export function listRuns(
  projectId: string,
  options: { limit?: number; offset?: number; status?: string; mode?: "change" | "audit" } = {},
  stateRoot = pirStateBase(),
): { runs: RunSummary[]; total: number } | null {
  if (!isValidProjectId(projectId)) return null;
  const dbPath = path.join(stateRoot, projectId, "memory.sqlite");
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const offset = Math.max(options.offset ?? 0, 0);
  return withDb(dbPath, (db) => {
    const clauses: string[] = [];
    const values: string[] = [];
    if (options.status) { clauses.push("status = ?"); values.push(options.status); }
    if (options.mode) {
      // Archives written before migration v5 have no mode column; they are all
      // change reviews, so an audit filter is empty rather than a 404.
      const hasMode = (db.prepare("PRAGMA table_info(review_runs)").all() as Array<{ name: string }>)
        .some((column) => column.name === "mode");
      if (!hasMode) {
        if (options.mode === "audit") return { runs: [], total: 0 };
      } else {
        clauses.push("mode = ?");
        values.push(options.mode);
      }
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    const totalRow = db.prepare(
      `SELECT COUNT(*) AS n FROM review_runs${where}`,
    ).get(...values) as { n: number };
    const rows = db.prepare(`SELECT * FROM review_runs${where} ORDER BY started_at DESC LIMIT ? OFFSET ?`)
      .all(...values, limit, offset) as unknown as RawRunRow[];
    return { runs: rows.map((row) => toRunSummary(row, stateRoot, projectId)), total: totalRow?.n ?? 0 };
  });
}

interface RawFindingRow {
  id: string;
  display_id: string;
  title: string;
  claim: string;
  trigger: string;
  category: string;
  severity: string;
  status: string;
  feature_key: string | null;
  entity_key: string | null;
  anchors: string;
  memory_matches: string;
  verifier_rationale: string | null;
  round: number;
  created_at: number;
  confidence?: number | null;
}

interface RawEvidenceRow {
  kind: string;
  path: string | null;
  start_line: number | null;
  end_line: number | null;
  excerpt: string | null;
  description: string | null;
}

function parseJsonArray(raw: string): unknown[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function toFindingView(row: RawFindingRow, evidenceRows: RawEvidenceRow[]): FindingView {
  return {
    id: row.id,
    displayId: row.display_id,
    title: row.title,
    claim: row.claim,
    trigger: row.trigger,
    category: row.category,
    severity: row.severity,
    status: row.status,
    featureKey: row.feature_key,
    entityKey: row.entity_key,
    anchors: parseJsonArray(row.anchors) as FindingView["anchors"],
    evidence: evidenceRows.map((evidence) => ({
      kind: evidence.kind,
      ...(evidence.path !== null ? { path: evidence.path } : {}),
      ...(evidence.start_line !== null ? { startLine: evidence.start_line } : {}),
      ...(evidence.excerpt !== undefined ? { excerpt: evidence.excerpt ?? undefined } : {}),
      ...(evidence.description !== null ? { description: evidence.description } : {}),
    })),
    memoryMatches: parseJsonArray(row.memory_matches),
    verifierRationale: row.verifier_rationale,
    round: row.round,
    createdAt: row.created_at,
    confidence: row.confidence ?? null,
    relatedSessions: [],
  };
}

interface RawSummaryRow {
  id: string;
  display_id: string;
  title: string;
  category: string;
  severity: string;
  status: string;
  round: number;
  created_at: number;
  confidence?: number | null;
}

const FINDINGS_ORDER = "ORDER BY severity, created_at";

/** Collapsed-row summaries for one run: one small query pair, no heavy text. */
function findingSummaries(
  db: DatabaseSync,
  runId: string,
  options: { limit?: number; offset?: number } = {},
): { items: FindingSummary[]; total: number } {
  const total = (db.prepare("SELECT COUNT(*) AS n FROM findings WHERE run_id = ?").get(runId) as { n: number }).n;
  const limit = options.limit !== undefined ? Math.min(Math.max(options.limit, 1), 500) : -1;
  const offset = options.offset !== undefined ? Math.max(options.offset, 0) : 0;
  const rows = db
    .prepare(`SELECT * FROM findings WHERE run_id = ? ${FINDINGS_ORDER} LIMIT ? OFFSET ?`)
    .all(runId, limit, offset) as unknown as RawSummaryRow[];
  const counts = new Map<string, number>();
  for (const row of db
    .prepare("SELECT finding_id, COUNT(*) AS n FROM finding_evidence WHERE finding_id IN (SELECT id FROM findings WHERE run_id = ?) GROUP BY finding_id")
    .all(runId) as unknown as Array<{ finding_id: string; n: number }>) {
    counts.set(row.finding_id, row.n);
  }
  return {
    total,
    items: rows.map((row) => ({
      id: row.id,
      displayId: row.display_id,
      title: row.title,
      category: row.category,
      severity: row.severity,
      status: row.status,
      round: row.round,
      createdAt: row.created_at,
      evidenceCount: counts.get(row.id) ?? 0,
      confidence: row.confidence ?? null,
    })),
  };
}

function runExists(db: DatabaseSync, runId: string): boolean {
  return db.prepare("SELECT 1 AS one FROM review_runs WHERE id = ?").get(runId) !== undefined;
}

/** One finding with its full evidence — the expand-a-row payload. */
function findingView(db: DatabaseSync, runId: string, findingId: string): FindingView | null {
  const row = db.prepare("SELECT * FROM findings WHERE run_id = ? AND (id = ? OR display_id = ?)").get(runId, findingId, findingId) as unknown as RawFindingRow | undefined;
  if (!row) return null;
  const evidence = db
    .prepare("SELECT kind, path, start_line, end_line, excerpt, description FROM finding_evidence WHERE finding_id = ? ORDER BY created_at")
    .all(row.id) as unknown as RawEvidenceRow[];
  return toFindingView(row, evidence);
}

function sessionsFor(stateRoot: string, projectId: string, runId: string, manifest: RunManifest | null): SessionRef[] {
  if (manifest?.sessions?.length) {
    return manifest.sessions.map((session: RunSessionRef) => ({ ...session }));
  }
  const dir = path.join(stateRoot, projectId, "transcripts", runId);
  if (!existsSync(dir)) return [];
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((file) => file.endsWith(".json") && file !== "run.json").sort();
  } catch {
    return [];
  }
  // Filename conventions only — the manifest is authoritative when present.
  return files.map((file) => {
    const sessionKind = file.startsWith("verifier") ? "verifier" : "reviewer";
    const roundMatch = /-r(\d+)-/.exec(file);
    const displayMatch = /-r\d+-(.+)\.json$/.exec(file);
    const unitMatch = /^reviewer-(.+)-a(\d+)\.json$/.exec(file);
    return {
      file,
      sessionKind,
      ...(roundMatch ? { round: Number(roundMatch[1]) } : {}),
      ...(unitMatch ? { unitId: unitMatch[1], attempt: Number(unitMatch[2]) } : {}),
      ...(sessionKind === "verifier" && displayMatch ? { displayId: displayMatch[1] } : {}),
    } as SessionRef;
  });
}

export function runDetail(projectId: string, runId: string, stateRoot = pirStateBase()): RunDetail | null {
  if (!isValidProjectId(projectId) || !/^[\w-]+$/.test(runId)) return null;
  const dbPath = path.join(stateRoot, projectId, "memory.sqlite");
  return withDb(dbPath, (db) => {
    const row = db.prepare("SELECT * FROM review_runs WHERE id = ?").get(runId) as unknown as RawRunRow | undefined;
    if (!row) return null;
    const manifest = manifestFor(stateRoot, projectId, runId);
    return {
      run: toRunSummary(row, stateRoot, projectId),
      findings: findingSummaries(db, runId),
      manifest,
      sessions: sessionsFor(stateRoot, projectId, runId, manifest),
      transcriptsAvailable: existsSync(path.join(stateRoot, projectId, "transcripts", runId)),
    };
  });
}

/** Findings of one run as row summaries, optionally paginated. Null = unknown run. */
export function listFindings(
  projectId: string,
  runId: string,
  options: { limit?: number; offset?: number } = {},
  stateRoot = pirStateBase(),
): { items: FindingSummary[]; total: number } | null {
  if (!isValidProjectId(projectId) || !/^[\w-]+$/.test(runId)) return null;
  const dbPath = path.join(stateRoot, projectId, "memory.sqlite");
  return withDb(dbPath, (db) => {
    if (!runExists(db, runId)) return null;
    return findingSummaries(db, runId, options);
  });
}

/** One finding with full evidence. Null = unknown run or finding. */
export function findingById(
  projectId: string,
  runId: string,
  findingId: string,
  stateRoot = pirStateBase(),
): FindingView | null {
  if (!isValidProjectId(projectId) || !/^[\w-]+$/.test(runId) || !/^[\w-]+$/.test(findingId)) return null;
  const dbPath = path.join(stateRoot, projectId, "memory.sqlite");
  return withDb(dbPath, (db) => {
    if (!runExists(db, runId)) return null;
    const view = findingView(db, runId, findingId);
    if (!view) return null;
    const manifest = manifestFor(stateRoot, projectId, runId);
    view.relatedSessions = (manifest?.sessions ?? []).flatMap<FindingView["relatedSessions"][number]>((session) => {
      const key = `persisted:${session.file}`;
      const mapped = session.idMap?.find((entry) => entry.to === view.displayId);
      if (session.sessionKind === "verifier" && session.displayId === view.displayId) return [{ sessionKey: key, relation: "verification" as const }];
      if (session.sessionKind === "reviewer" && mapped) return [{ sessionKey: key, relation: "candidate" as const, originalDisplayId: mapped.from }];
      return [];
    });
    return view;
  });
}

export interface TranscriptFile {
  payload: unknown;
  /** Stat-based weak validator: transcripts are written once and never rewritten. */
  etag: string;
}

/**
 * One session transcript. `file` is constrained to a bare .json name inside
 * the run's transcript directory — path traversal cannot escape it.
 */
export async function readTranscript(
  projectId: string,
  runId: string,
  file: string,
  stateRoot = pirStateBase(),
): Promise<TranscriptFile | null> {
  if (!isValidProjectId(projectId) || !/^[\w-]+$/.test(runId) || !/^[\w.-]+\.json$/.test(file)) return null;
  const dir = path.join(stateRoot, projectId, "transcripts", runId);
  const resolved = path.resolve(dir, file);
  if (!resolved.startsWith(`${dir}${path.sep}`)) return null;
  let stats;
  try {
    stats = await stat(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!stats.isFile()) return null;
  const etag = `"tx-${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`;
  const payload: unknown = JSON.parse(await readFile(resolved, "utf8"));
  return { payload, etag };
}


function parseJsonRecord(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "string") return null;
  try { const value = JSON.parse(raw); return value && typeof value === "object" ? value as Record<string, unknown> : null; } catch { return null; }
}

/** Read the mode-specific coverage artifact without converting missing data to zero. */
export function coverageFor(projectId: string, runId: string, stateRoot = pirStateBase()): CoverageView | null {
  if (!isValidProjectId(projectId) || !/^[\w-]+$/.test(runId)) return null;
  const manifest = manifestFor(stateRoot, projectId, runId);
  const dbPath = path.join(stateRoot, projectId, "memory.sqlite");
  return withDb(dbPath, (db) => {
    const row = db.prepare("SELECT * FROM review_runs WHERE id = ?").get(runId) as { mode?: string; target?: string | null } | undefined;
    if (!row) return null;
    const mode = row.mode === "audit" ? "audit" : "change";
    if (mode === "change") {
      const summary = manifest?.changeCoverage;
      if (!summary) return { mode, available: false, reason: "not-recorded" };
      return { mode, available: true, summary, files: summary.files ?? [] };
    }
    let summary = manifest?.coverage;
    let units: AuditUnitView[] = [];
    let files: AuditFileCoverageView[] = [];
    try {
      units = (db.prepare("SELECT unit_id, state, reason, files, attempts FROM audit_work_units WHERE run_id = ? ORDER BY unit_id").all(runId) as Array<Record<string, unknown>>).map((u) => ({
        id: String(u.unit_id), module: String(u.unit_id), state: String(u.state), ...(u.reason ? { reason: String(u.reason) } : {}), files: Number(u.files ?? 0), attempts: Number(u.attempts ?? 0),
      }));
      files = (db.prepare("SELECT path, blob_id, state, reason, ranges_total, ranges_reviewed FROM audit_file_coverage WHERE run_id = ? ORDER BY path").all(runId) as Array<Record<string, unknown>>).map((f) => ({
        path: String(f.path), blobId: String(f.blob_id), state: String(f.state), ...(f.reason ? { reason: String(f.reason) } : {}), rangesTotal: Number(f.ranges_total ?? 0), rangesReviewed: Number(f.ranges_reviewed ?? 0),
      }));
    } catch {
      return { mode, available: false, reason: "unavailable" };
    }
    if (!summary && files.length === 0 && units.length === 0) return { mode, available: false, reason: "not-recorded" };
    if (!summary) {
      const count = (state: string) => files.filter((f) => f.state === state).length;
      summary = {
        filesTotal: files.length, filesNotSelected: count("notSelected"), filesExcluded: count("excluded"),
        filesInScope: files.filter((f) => !["notSelected", "excluded"].includes(f.state)).length,
        filesReviewed: count("reviewed"), filesPartial: count("partial"), filesUnreviewed: count("unreviewed"), filesBlocked: count("blocked"), filesFailed: count("failed"),
        batchesTotal: units.length, batchesCompleted: units.filter((u) => u.state === "reviewed").length, batchesBlocked: units.filter((u) => u.state === "blocked").length, batchesFailed: units.filter((u) => u.state === "failed").length,
      };
    }
    return { mode, available: true, summary, units, files, target: parseJsonRecord(row.target) ?? null };
  });
}

export function recentFeedback(projectId: string, limit = 20, stateRoot = pirStateBase()): FeedbackEventView[] | null {
  if (!isValidProjectId(projectId)) return null;
  const dbPath = path.join(stateRoot, projectId, "memory.sqlite");
  const bounded = Math.min(Math.max(limit, 1), 100);
  return withDb(dbPath, (db) => {
    const rows = db
      .prepare("SELECT id, ts, finding_id, action, decision, priority, note, scope, target FROM feedback_events ORDER BY ts DESC LIMIT ?")
      .all(bounded) as unknown as Array<{
      id: number; ts: number; finding_id: string | null; action: string;
      decision: string | null; priority: string | null; note: string | null; scope: string | null; target: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id, ts: row.ts, findingId: row.finding_id, action: row.action, decision: row.decision,
      priority: row.priority, note: row.note, scope: row.scope, target: row.target,
    }));
  });
}
