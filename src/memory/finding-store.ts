import { randomUUID } from "node:crypto";
import { parseJsonArray, parseJsonObject } from "../core/types.js";
import type { FindingEvidence, MemoryMatch, VerifiedFinding } from "../findings/types.js";
import type { SqliteStore } from "./sqlite-store.js";

export interface FindingRow {
  id: string;
  projectId: string;
  runId: string;
  displayId: string;
  fingerprint: string;
  featureKey: string | null;
  entityKey: string | null;
  title: string;
  claim: string;
  trigger: string;
  category: string;
  severity: string;
  status: string;
  anchors: string;
  memoryMatches: string;
  verifierRationale: string | null;
  round: number;
  createdAt: number;
  updatedAt: number;
}

export interface ReviewRunRow {
  id: string;
  projectId: string;
  base: string;
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
}

interface RawFinding extends Omit<FindingRow, "memoryMatches"> {
  memory_matches: string;
  verifier_rationale: string | null;
  feature_key: string | null;
  entity_key: string | null;
  display_id: string;
  run_id: string;
  project_id: string;
  created_at: number;
  updated_at: number;
  verifier_rationale__: never;
}

function rawToRow(raw: Record<string, unknown>): FindingRow {
  return {
    id: String(raw.id),
    projectId: String(raw.project_id),
    runId: String(raw.run_id),
    displayId: String(raw.display_id),
    fingerprint: String(raw.fingerprint),
    featureKey: (raw.feature_key as string | null) ?? null,
    entityKey: (raw.entity_key as string | null) ?? null,
    title: String(raw.title),
    claim: String(raw.claim),
    trigger: String(raw.trigger),
    category: String(raw.category),
    severity: String(raw.severity),
    status: String(raw.status),
    anchors: String(raw.anchors ?? "[]"),
    memoryMatches: String(raw.memory_matches ?? "[]"),
    verifierRationale: (raw.verifier_rationale as string | null) ?? null,
    round: Number(raw.round),
    createdAt: Number(raw.created_at),
    updatedAt: Number(raw.updated_at),
  };
}

export class FindingStore {
  constructor(
    private readonly store: SqliteStore,
    private readonly projectId: string,
  ) {}

  /** F-1, F-2, ... sequential per project. */
  nextDisplayId(): string {
    const row = this.store.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM findings WHERE project_id = ?",
      this.projectId,
    );
    return `F-${(row?.n ?? 0) + 1}`;
  }

  insert(finding: VerifiedFinding, runId: string): FindingRow {
    const id = randomUUID();
    const displayId = this.nextDisplayId();
    const now = Date.now();
    this.store.run(
      `INSERT INTO findings (id, project_id, run_id, display_id, fingerprint, title, claim, trigger, category, severity, status, feature_key, entity_key, anchors, memory_matches, verifier_rationale, round, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      this.projectId,
      runId,
      displayId,
      finding.identity.fingerprint,
      finding.title,
      finding.claim,
      finding.trigger,
      finding.category,
      finding.severity,
      finding.status,
      finding.featureKey ?? null,
      finding.entityKey ?? null,
      JSON.stringify(finding.anchors ?? []),
      JSON.stringify(finding.memoryMatches ?? []),
      finding.verifierRationale ?? null,
      finding.round,
      now,
      now,
    );
    for (const ev of finding.evidence ?? []) {
      this.store.run(
        `INSERT INTO finding_evidence (id, finding_id, kind, path, start_line, end_line, excerpt, description, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        randomUUID(),
        id,
        ev.kind,
        ev.path ?? null,
        ev.startLine ?? null,
        ev.endLine ?? null,
        ev.excerpt ?? null,
        ev.description ?? null,
        now,
      );
    }
    return {
      id,
      projectId: this.projectId,
      runId,
      displayId,
      fingerprint: finding.identity.fingerprint,
      featureKey: finding.featureKey ?? null,
      entityKey: finding.entityKey ?? null,
      title: finding.title,
      claim: finding.claim,
      trigger: finding.trigger,
      category: finding.category,
      severity: finding.severity,
      status: finding.status,
      anchors: JSON.stringify(finding.anchors ?? []),
      memoryMatches: JSON.stringify(finding.memoryMatches ?? []),
      verifierRationale: finding.verifierRationale ?? null,
      round: finding.round,
      createdAt: now,
      updatedAt: now,
    };
  }

  /** Accepts "F-12" or a raw UUID. */
  get(idOrDisplayId: string): FindingRow | null {
    const byDisplay = this.store.get<Record<string, unknown>>(
      "SELECT * FROM findings WHERE project_id = ? AND display_id = ?",
      this.projectId,
      idOrDisplayId,
    );
    if (byDisplay) return rawToRow(byDisplay);
    const byId = this.store.get<Record<string, unknown>>(
      "SELECT * FROM findings WHERE id = ?",
      idOrDisplayId,
    );
    return byId ? rawToRow(byId) : null;
  }

  updateStatus(id: string, status: string): void {
    this.store.run("UPDATE findings SET status = ?, updated_at = ? WHERE id = ?", status, Date.now(), id);
  }

  updateSeverity(id: string, severity: string): void {
    this.store.run("UPDATE findings SET severity = ?, updated_at = ? WHERE id = ?", severity, Date.now(), id);
  }

  updateMemoryMatches(id: string, matches: MemoryMatch[]): void {
    this.store.run(
      "UPDATE findings SET memory_matches = ?, updated_at = ? WHERE id = ?",
      JSON.stringify(matches),
      Date.now(),
      id,
    );
  }

  list(opts: { status?: string; limit?: number } = {}): FindingRow[] {
    const limit = opts.limit ?? 100;
    const rows = opts.status
      ? this.store.all<Record<string, unknown>>(
          "SELECT * FROM findings WHERE project_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?",
          this.projectId,
          opts.status,
          limit,
        )
      : this.store.all<Record<string, unknown>>(
          "SELECT * FROM findings WHERE project_id = ? ORDER BY created_at DESC LIMIT ?",
          this.projectId,
          limit,
        );
    return rows.map(rawToRow);
  }

  evidence(findingId: string): FindingEvidence[] {
    const rows = this.store.all<Record<string, unknown>>(
      "SELECT * FROM finding_evidence WHERE finding_id = ? ORDER BY rowid",
      findingId,
    );
    return rows.map((r) => ({
      kind: String(r.kind) as FindingEvidence["kind"],
      path: (r.path as string | null) ?? undefined,
      startLine: r.start_line === null ? undefined : Number(r.start_line),
      endLine: r.end_line === null ? undefined : Number(r.end_line),
      excerpt: (r.excerpt as string | null) ?? undefined,
      description: (r.description as string | null) ?? undefined,
    }));
  }

  anchors(row: FindingRow): Array<{ path: string; startLine: number; endLine?: number }> {
    return parseJsonArray(row.anchors).length > 0
      ? (parseJsonObject<Array<{ path: string; startLine: number; endLine?: number }>>(row.anchors) ?? [])
      : [];
  }

  memoryMatches(row: FindingRow): MemoryMatch[] {
    return parseJsonObject<MemoryMatch[]>(row.memoryMatches) ?? [];
  }

  createRun(base: string, head: string): ReviewRunRow {
    const id = randomUUID();
    const startedAt = Date.now();
    this.store.run(
      "INSERT INTO review_runs (id, project_id, base, head, started_at, status) VALUES (?, ?, ?, ?, ?, 'running')",
      id,
      this.projectId,
      base,
      head,
      startedAt,
    );
    return {
      id,
      projectId: this.projectId,
      base,
      head,
      startedAt,
      finishedAt: null,
      status: "running",
      rounds: 0,
      candidates: 0,
      confirmed: 0,
      rejected: 0,
      uncertain: 0,
      notes: null,
    };
  }

  finishRun(
    runId: string,
    stats: { rounds: number; candidates: number; confirmed: number; rejected: number; uncertain: number; status?: string; notes?: string },
  ): void {
    this.store.run(
      `UPDATE review_runs SET finished_at = ?, status = ?, rounds = ?, candidates = ?, confirmed = ?, rejected = ?, uncertain = ?, notes = ? WHERE id = ?`,
      Date.now(),
      stats.status ?? "completed",
      stats.rounds,
      stats.candidates,
      stats.confirmed,
      stats.rejected,
      stats.uncertain,
      stats.notes ?? null,
      runId,
    );
  }

  appendFeedbackEvent(event: {
    findingId?: string | null;
    action: string;
    decision?: string | null;
    priority?: string | null;
    note?: string | null;
    scope?: string | null;
    target?: string | null;
  }): number {
    this.store.run(
      "INSERT INTO feedback_events (ts, finding_id, action, decision, priority, note, scope, target) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      Date.now(),
      event.findingId ?? null,
      event.action,
      event.decision ?? null,
      event.priority ?? null,
      event.note ?? null,
      event.scope ?? null,
      event.target ?? null,
    );
    const row = this.store.get<{ id: number }>("SELECT last_insert_rowid() AS id");
    return row?.id ?? 0;
  }

  listFeedbackEvents(findingId?: string, limit = 100): Array<Record<string, unknown>> {
    return findingId
      ? this.store.all(
          "SELECT * FROM feedback_events WHERE finding_id = ? ORDER BY id DESC LIMIT ?",
          findingId,
          limit,
        )
      : this.store.all("SELECT * FROM feedback_events ORDER BY id DESC LIMIT ?", limit);
  }
}

export type { RawFinding };
