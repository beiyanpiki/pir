export interface Migration {
  version: number;
  statements: string[];
}

/**
 * Append-only migration list. Never edit an applied migration — add a new one.
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        remote TEXT,
        normalized_remote TEXT,
        root_commit TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_indexed_commit TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS project_memories (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        architecture_summary TEXT NOT NULL DEFAULT '',
        responsibilities TEXT NOT NULL DEFAULT '[]',
        invariants TEXT NOT NULL DEFAULT '[]',
        conventions TEXT NOT NULL DEFAULT '[]',
        risk_areas TEXT NOT NULL DEFAULT '[]',
        feature_keys TEXT NOT NULL DEFAULT '[]',
        source TEXT NOT NULL DEFAULT 'agent_summary',
        created_at_commit TEXT,
        validated_at_commit TEXT,
        stale INTEGER NOT NULL DEFAULT 0
      )`,
      `CREATE TABLE IF NOT EXISTS features (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        key TEXT NOT NULL,
        name TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        responsibilities TEXT NOT NULL DEFAULT '[]',
        invariants TEXT NOT NULL DEFAULT '[]',
        entry_points TEXT NOT NULL DEFAULT '[]',
        dependencies TEXT NOT NULL DEFAULT '[]',
        related_feature_keys TEXT NOT NULL DEFAULT '[]',
        source TEXT NOT NULL DEFAULT 'agent_summary',
        confidence REAL NOT NULL DEFAULT 0.5,
        created_at_commit TEXT,
        validated_at_commit TEXT,
        stale INTEGER NOT NULL DEFAULT 0,
        UNIQUE (project_id, key)
      )`,
      `CREATE TABLE IF NOT EXISTS code_entities (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        symbol_key TEXT NOT NULL,
        qualified_name TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'unknown',
        path TEXT NOT NULL DEFAULT '',
        signature TEXT,
        responsibilities TEXT NOT NULL DEFAULT '[]',
        invariants TEXT NOT NULL DEFAULT '[]',
        notes TEXT NOT NULL DEFAULT '[]',
        feature_keys TEXT NOT NULL DEFAULT '[]',
        source TEXT NOT NULL DEFAULT 'agent_summary',
        signature_hash TEXT,
        body_hash TEXT,
        last_seen_commit TEXT,
        stale INTEGER NOT NULL DEFAULT 0,
        UNIQUE (project_id, symbol_key)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_code_entities_path ON code_entities (project_id, path)`,
      `CREATE TABLE IF NOT EXISTS feature_entities (
        feature_id TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        PRIMARY KEY (feature_id, entity_id)
      )`,
      `CREATE TABLE IF NOT EXISTS issue_memories (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        feature_key TEXT,
        entity_key TEXT,
        fingerprint TEXT,
        category TEXT NOT NULL DEFAULT 'other',
        claim TEXT NOT NULL,
        trigger TEXT NOT NULL DEFAULT '',
        decision TEXT NOT NULL,
        priority TEXT,
        rationale TEXT NOT NULL DEFAULT '',
        scope TEXT NOT NULL DEFAULT 'symbol',
        source TEXT NOT NULL DEFAULT 'user_explicit',
        created_at_commit TEXT,
        valid_until_commit TEXT,
        stale INTEGER NOT NULL DEFAULT 0
      )`,
      `CREATE INDEX IF NOT EXISTS idx_issue_memories_fp ON issue_memories (project_id, fingerprint)`,
      `CREATE INDEX IF NOT EXISTS idx_issue_memories_scope ON issue_memories (project_id, feature_key, entity_key)`,
      `CREATE TABLE IF NOT EXISTS findings (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        display_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        title TEXT NOT NULL,
        claim TEXT NOT NULL,
        trigger TEXT NOT NULL DEFAULT '',
        category TEXT NOT NULL DEFAULT 'other',
        severity TEXT NOT NULL DEFAULT 'P2',
        status TEXT NOT NULL DEFAULT 'candidate',
        feature_key TEXT,
        entity_key TEXT,
        anchors TEXT NOT NULL DEFAULT '[]',
        memory_matches TEXT NOT NULL DEFAULT '[]',
        verifier_rationale TEXT,
        round INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (project_id, display_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_findings_run ON findings (run_id)`,
      `CREATE INDEX IF NOT EXISTS idx_findings_fp ON findings (project_id, fingerprint)`,
      `CREATE TABLE IF NOT EXISTS finding_evidence (
        id TEXT PRIMARY KEY,
        finding_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        path TEXT,
        start_line INTEGER,
        end_line INTEGER,
        excerpt TEXT,
        description TEXT,
        created_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_finding_evidence ON finding_evidence (finding_id)`,
      `CREATE TABLE IF NOT EXISTS finding_resolutions (
        id TEXT PRIMARY KEY,
        finding_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        feature_key TEXT,
        entity_key TEXT,
        category TEXT NOT NULL DEFAULT 'other',
        original_claim TEXT NOT NULL,
        original_trigger TEXT NOT NULL DEFAULT '',
        resolution TEXT NOT NULL,
        explanation TEXT NOT NULL DEFAULT '',
        before_commit TEXT,
        after_commit TEXT,
        before_code_hash TEXT,
        after_code_hash TEXT,
        fix_commit TEXT,
        fix_diff_hash TEXT,
        verified INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_resolutions_fp ON finding_resolutions (fingerprint)`,
      `CREATE TABLE IF NOT EXISTS feedback_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        finding_id TEXT,
        action TEXT NOT NULL,
        decision TEXT,
        priority TEXT,
        note TEXT,
        scope TEXT,
        target TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_feedback_finding ON feedback_events (finding_id)`,
      `CREATE TABLE IF NOT EXISTS review_runs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        base TEXT NOT NULL,
        head TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        status TEXT NOT NULL DEFAULT 'running',
        rounds INTEGER NOT NULL DEFAULT 0,
        candidates INTEGER NOT NULL DEFAULT 0,
        confirmed INTEGER NOT NULL DEFAULT 0,
        rejected INTEGER NOT NULL DEFAULT 0,
        uncertain INTEGER NOT NULL DEFAULT 0,
        notes TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS memory_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_type TEXT NOT NULL,
        memory_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        payload TEXT NOT NULL,
        reason TEXT,
        created_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_memory_versions ON memory_versions (memory_type, memory_id)`,
    ],
  },
  {
    version: 2,
    statements: [
      // Anchor paths captured when the user gave feedback: lets future
      // candidates with drifted wording but the same code location still
      // find the decision.
      `ALTER TABLE issue_memories ADD COLUMN anchor_paths TEXT NOT NULL DEFAULT '[]'`,
    ],
  },
  {
    version: 3,
    statements: [
      // Which array entries the agent generated last: a re-bootstrap replaces
      // these wholesale while user-added entries (never listed here) survive.
      // NULL = no generated set recorded; merging degrades to keep-everything.
      `ALTER TABLE project_memories ADD COLUMN agent_fields TEXT`,
      `ALTER TABLE features ADD COLUMN agent_fields TEXT`,
      `ALTER TABLE code_entities ADD COLUMN agent_fields TEXT`,
    ],
  },
  {
    version: 4,
    statements: [
      // finding_resolutions gains project scoping: PIR_MEMORY_DB / dbPath can
      // legitimately host several projects in one DB, and export, fingerprint
      // replacement, and queries must not touch another project's fix history.
      // Legacy rows are attributed when the DB holds exactly one project (the
      // common case); rows in a multi-project DB cannot be attributed and stay
      // NULL—invisible to scoped queries rather than mis-attributed.
      `ALTER TABLE finding_resolutions ADD COLUMN project_id TEXT`,
      `UPDATE finding_resolutions SET project_id = (SELECT id FROM projects LIMIT 1)
        WHERE (SELECT COUNT(*) FROM projects) = 1`,
      `CREATE INDEX IF NOT EXISTS idx_resolutions_project_fp ON finding_resolutions (project_id, fingerprint)`,
    ],
  },
  {
    version: 5,
    statements: [
      // Full-repository audits: review_runs gains a mode and a genuinely
      // nullable base (audits have no comparison base — never a fake one), and
      // run-local coverage ledgers get their own tables. These are run
      // artifacts: they stay out of memory sync (see MEMORY_WIRE_SCHEMA_VERSION).
      `CREATE TABLE review_runs_v5 (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'change',
        base TEXT,
        head TEXT NOT NULL,
        target TEXT,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        status TEXT NOT NULL DEFAULT 'running',
        rounds INTEGER NOT NULL DEFAULT 0,
        candidates INTEGER NOT NULL DEFAULT 0,
        confirmed INTEGER NOT NULL DEFAULT 0,
        rejected INTEGER NOT NULL DEFAULT 0,
        uncertain INTEGER NOT NULL DEFAULT 0,
        notes TEXT
      )`,
      `INSERT INTO review_runs_v5 (id, project_id, mode, base, head, started_at, finished_at, status, rounds, candidates, confirmed, rejected, uncertain, notes)
        SELECT id, project_id, 'change', base, head, started_at, finished_at, status, rounds, candidates, confirmed, rejected, uncertain, notes FROM review_runs`,
      `DROP TABLE review_runs`,
      `ALTER TABLE review_runs_v5 RENAME TO review_runs`,
      `CREATE TABLE IF NOT EXISTS audit_work_units (
        run_id TEXT NOT NULL,
        unit_id TEXT NOT NULL,
        state TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        files INTEGER NOT NULL DEFAULT 0,
        reason TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (run_id, unit_id)
      )`,
      `CREATE TABLE IF NOT EXISTS audit_file_coverage (
        run_id TEXT NOT NULL,
        path TEXT NOT NULL,
        blob_id TEXT NOT NULL,
        state TEXT NOT NULL,
        reason TEXT,
        ranges_total INTEGER NOT NULL DEFAULT 0,
        ranges_reviewed INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (run_id, path)
      )`,
    ],
  },
  {
    version: 6,
    statements: [
      // Run liveness heartbeat (#38): review_runs.updated_at advances on every
      // persisted progress step (per round, per audit work unit), so a live
      // run and an orphaned status='running' row (serve died mid-run) are
      // distinguishable from the DB alone — heartbeat age — and mid-run
      // inspection no longer relies on the WAL-frozen main file.
      `ALTER TABLE review_runs ADD COLUMN updated_at INTEGER`,
    ],
  },
  {
    version: 7,
    statements: [
      // Verifier confidence (roadmap Q4): the verifier's 0–1 self-assessment
      // survives applyVerdict and persists with the finding, so reporting can
      // bucket on it (--min-confidence). Nullable: rows persisted before this
      // column have no confidence on record.
      `ALTER TABLE findings ADD COLUMN confidence REAL`,
    ],
  },
];
