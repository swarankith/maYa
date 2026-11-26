import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  ApprovalItem,
  AuditLogEntry,
  ContextEdge,
  ContextNode,
  IntegrationConnector,
  SourceRecord,
  WorkspaceInfo,
} from '../types/maya.ts';

export const DEMO_WORKSPACE_ID = 'ws-demo';

function isWritableSqliteTarget(targetPath: string): boolean {
  try {
    const dir = path.dirname(targetPath);
    fs.accessSync(dir, fs.constants.W_OK);
    if (fs.existsSync(targetPath)) {
      fs.accessSync(targetPath, fs.constants.W_OK);
    }
    return true;
  } catch {
    return false;
  }
}

export function resolveSqliteDatabaseCandidates(options?: {
  configuredPath?: string;
  nodeEnv?: string;
  cwd?: string;
}): { primaryPath: string; candidates: string[]; allowTempFallback: boolean } {
  const configured = (options?.configuredPath ?? process.env.MAYA_DB_PATH)?.trim();
  const isProduction = (options?.nodeEnv ?? process.env.NODE_ENV) === 'production';
  const cwd = options?.cwd ?? process.cwd();
  const primaryPath = configured
    ? path.resolve(configured)
    : path.resolve(cwd, 'maya_context.db');
  const fallbackPath = path.join(os.tmpdir(), 'maya_context.db');

  // Production or explicitly configured MAYA_DB_PATH must fail fast instead of silently
  // falling back to ephemeral os.tmpdir() storage.
  if (configured || isProduction) {
    return {
      primaryPath,
      candidates: [primaryPath],
      allowTempFallback: false,
    };
  }

  const candidates = isWritableSqliteTarget(primaryPath)
    ? [primaryPath, fallbackPath]
    : [fallbackPath];
  return {
    primaryPath,
    candidates,
    allowTempFallback: true,
  };
}

function openResilientDatabase(): { db: Database.Database; dbPath: string } {
  const { primaryPath, candidates, allowTempFallback } = resolveSqliteDatabaseCandidates();

  let lastError: unknown;
  for (const candidate of candidates) {
    if (!isWritableSqliteTarget(candidate)) {
      lastError = new Error(`SQLite target path is not writable: ${candidate}`);
      continue;
    }
    try {
      const instance = new Database(candidate);
      instance.pragma('journal_mode = WAL');
      instance.pragma('foreign_keys = ON');
      if (candidate !== primaryPath && allowTempFallback) {
        console.warn(
          `[db] [DEV-ONLY] Primary DB path (${primaryPath}) is not writable; using temporary fallback ${candidate}.`,
        );
      }
      return { db: instance, dbPath: candidate };
    } catch (err) {
      lastError = err;
    }
  }

  const reason = lastError instanceof Error ? lastError.message : String(lastError ?? 'unknown error');
  throw new Error(
    `[db] Fatal: Unable to open persistent SQLite database at "${primaryPath}" (${reason}). Configure a writable MAYA_DB_PATH.`,
  );
}

const opened = openResilientDatabase();
export const DB_PATH = opened.dbPath;
export const db = opened.db;

function hasColumn(tableName: string, columnName: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === columnName);
}

export function initializeSchema(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT,
      name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'PERSONAL',
      created_at TEXT NOT NULL,
      FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL DEFAULT 'ws-demo',
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      subtitle TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'Active',
      date TEXT,
      owner_id TEXT,
      project_id TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      provenance TEXT NOT NULL,
      fact_status TEXT NOT NULL DEFAULT 'CONFIRMED',
      is_demo INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS edges (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL DEFAULT 'ws-demo',
      source_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      relationship_type TEXT NOT NULL,
      label TEXT NOT NULL,
      provenance TEXT NOT NULL,
      evidence_text TEXT NOT NULL DEFAULT '',
      source_record_id TEXT,
      fact_status TEXT NOT NULL DEFAULT 'CONFIRMED',
      is_demo INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (source_id) REFERENCES nodes(id) ON DELETE CASCADE,
      FOREIGN KEY (target_id) REFERENCES nodes(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS source_records (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL DEFAULT 'ws-demo',
      source_type TEXT NOT NULL,
      external_id TEXT,
      sender TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      received_at TEXT NOT NULL,
      parsed_entities_json TEXT NOT NULL DEFAULT '{}',
      is_demo INTEGER NOT NULL DEFAULT 0,
      processed INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS impact_analyses (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL DEFAULT 'ws-demo',
      change_event_json TEXT NOT NULL,
      direct_impacts_json TEXT NOT NULL,
      downstream_impacts_json TEXT NOT NULL,
      unaffected_items_json TEXT NOT NULL,
      explanation_summary TEXT NOT NULL,
      ai_narrative TEXT,
      ai_status TEXT NOT NULL DEFAULT 'SKIPPED',
      created_at TEXT NOT NULL,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS what_if_plans (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL DEFAULT 'ws-demo',
      analysis_id TEXT NOT NULL,
      option_key TEXT NOT NULL,
      title TEXT NOT NULL,
      strategy_summary TEXT NOT NULL,
      proposed_changes_json TEXT NOT NULL,
      tasks_affected_json TEXT NOT NULL,
      meetings_affected_json TEXT NOT NULL,
      potential_conflicts_json TEXT NOT NULL,
      advantages_json TEXT NOT NULL,
      tradeoffs_json TEXT NOT NULL,
      requires_confirmation_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PROPOSED',
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (analysis_id) REFERENCES impact_analyses(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL DEFAULT 'ws-demo',
      plan_id TEXT NOT NULL,
      option_key TEXT NOT NULL,
      action_type TEXT NOT NULL,
      target_node_id TEXT NOT NULL,
      target_label TEXT NOT NULL,
      permission_scope TEXT NOT NULL,
      permission_valid INTEGER NOT NULL DEFAULT 1,
      permission_reason TEXT NOT NULL,
      proposed_payload_json TEXT NOT NULL,
      before_state_json TEXT NOT NULL,
      after_state_json TEXT NOT NULL,
      rationale TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      execution_mode TEXT NOT NULL DEFAULT 'SIMULATED_DEMO',
      decided_at TEXT,
      decision_note TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL DEFAULT 'ws-demo',
      approval_id TEXT,
      action_type TEXT NOT NULL,
      target_label TEXT NOT NULL,
      status TEXT NOT NULL,
      execution_mode TEXT NOT NULL,
      summary TEXT NOT NULL,
      details_json TEXT NOT NULL DEFAULT '{}',
      actor TEXT NOT NULL,
      timestamp TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS integrations (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL DEFAULT 'ws-demo',
      service_key TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'DISCONNECTED',
      execution_policy TEXT NOT NULL,
      required_scopes_json TEXT NOT NULL,
      granted_scopes_json TEXT NOT NULL DEFAULT '[]',
      last_sync_at TEXT,
      setup_instructions_json TEXT NOT NULL,
      UNIQUE(workspace_id, service_key),
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS oauth_states (
      state TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS gmail_connections (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL,
      google_email TEXT,
      scopes_json TEXT NOT NULL DEFAULT '[]',
      encrypted_access_token TEXT,
      encrypted_refresh_token TEXT,
      token_expires_at TEXT,
      status TEXT NOT NULL DEFAULT 'DISCONNECTED',
      last_error TEXT,
      history_id TEXT,
      last_sync_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS gmail_messages (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      gmail_message_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      history_id TEXT,
      sender TEXT NOT NULL,
      recipients_json TEXT NOT NULL DEFAULT '[]',
      subject TEXT NOT NULL,
      snippet TEXT NOT NULL DEFAULT '',
      body_text TEXT NOT NULL DEFAULT '',
      received_at TEXT NOT NULL,
      source_record_id TEXT,
      extraction_status TEXT NOT NULL DEFAULT 'PENDING',
      extraction_error TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      max_retries INTEGER NOT NULL DEFAULT 4,
      next_retry_at TEXT,
      last_attempt_at TEXT,
      extracted_at TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(workspace_id, gmail_message_id),
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS email_extracted_items (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      message_row_id TEXT NOT NULL,
      gmail_message_id TEXT NOT NULL,
      item_type TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      proposed_date TEXT,
      date_ambiguous INTEGER NOT NULL DEFAULT 0,
      date_note TEXT,
      assignee_or_person TEXT,
      related_project_name TEXT,
      fact_status TEXT NOT NULL DEFAULT 'CONFIRMED',
      match_classification TEXT NOT NULL DEFAULT 'NEW',
      matched_node_id TEXT,
      matched_node_title TEXT,
      affected_node_ids_json TEXT NOT NULL DEFAULT '[]',
      evidence_quote TEXT NOT NULL DEFAULT '',
      confidence_note TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'PENDING',
      edited_payload_json TEXT,
      applied_node_id TEXT,
      reviewed_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (message_row_id) REFERENCES gmail_messages(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS email_suggested_relationships (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      message_row_id TEXT NOT NULL,
      source_item_id TEXT,
      source_node_id TEXT,
      source_label TEXT NOT NULL,
      target_item_id TEXT,
      target_node_id TEXT,
      target_label TEXT NOT NULL,
      relationship_type TEXT NOT NULL,
      rationale TEXT NOT NULL,
      evidence_quote TEXT NOT NULL,
      fact_status TEXT NOT NULL DEFAULT 'CONFIRMED',
      status TEXT NOT NULL DEFAULT 'PENDING',
      applied_edge_id TEXT,
      reviewed_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (message_row_id) REFERENCES gmail_messages(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS gemini_quota_state (
      id TEXT PRIMARY KEY,
      cooldown_until_ms INTEGER NOT NULL DEFAULT 0,
      cooldown_reason TEXT,
      last_error_code INTEGER,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT '',
      applied_at TEXT NOT NULL
    );
  `);
}

function hasWorkspaceCascadeFk(tableName: string): boolean {
  const fks = db.prepare(`PRAGMA foreign_key_list(${tableName})`).all() as Array<{
    table: string;
    from: string;
    on_delete: string;
  }>;
  return fks.some(
    (fk) =>
      fk.table === 'workspaces' &&
      fk.from === 'workspace_id' &&
      fk.on_delete.toUpperCase() === 'CASCADE',
  );
}

/**
 * Versioned, idempotent migration (v1): adds ON DELETE CASCADE workspace_id foreign keys
 * to pre-existing workspace-owned tables ONLY when zero orphaned rows exist.
 * Never deletes user data or orphaned rows, and intentionally preserves audit_logs without cascade.
 */
export function applyVersionedMigrations(targetDb: Database.Database = db): {
  version: number;
  status: string;
  migratedTables: string[];
  skippedTables: string[];
} {
  const MIGRATION_VERSION = 1;
  const MIGRATION_NAME = 'workspace_fk_cascade_v1';

  const existing = targetDb
    .prepare('SELECT version, status FROM schema_migrations WHERE version = ?')
    .get(MIGRATION_VERSION) as { version: number; status: string } | undefined;
  if (existing && existing.status === 'APPLIED') {
    return { version: MIGRATION_VERSION, status: 'ALREADY_APPLIED', migratedTables: [], skippedTables: [] };
  }

  const specs: Array<{
    table: string;
    ddl: string;
    columns: Array<{ name: string; fallbackExpr?: string }>;
    indexes: string[];
  }> = [
    {
      table: 'nodes',
      ddl: `CREATE TABLE nodes_v2 (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL DEFAULT 'ws-demo', type TEXT NOT NULL,
        title TEXT NOT NULL, subtitle TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'Active',
        date TEXT, owner_id TEXT, project_id TEXT, metadata_json TEXT NOT NULL DEFAULT '{}',
        provenance TEXT NOT NULL, fact_status TEXT NOT NULL DEFAULT 'CONFIRMED',
        is_demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
      )`,
      columns: [
        { name: 'id' },
        { name: 'workspace_id', fallbackExpr: "COALESCE(NULLIF(TRIM(workspace_id), ''), 'ws-demo')" },
        { name: 'type' },
        { name: 'title' },
        { name: 'subtitle', fallbackExpr: "COALESCE(subtitle, '')" },
        { name: 'status', fallbackExpr: "COALESCE(status, 'Active')" },
        { name: 'date' },
        { name: 'owner_id' },
        { name: 'project_id' },
        { name: 'metadata_json', fallbackExpr: "COALESCE(metadata_json, '{}')" },
        { name: 'provenance', fallbackExpr: "COALESCE(provenance, 'Legacy Context')" },
        { name: 'fact_status', fallbackExpr: "COALESCE(fact_status, 'CONFIRMED')" },
        { name: 'is_demo', fallbackExpr: 'COALESCE(is_demo, 0)' },
        { name: 'created_at' },
        { name: 'updated_at' },
      ],
      indexes: [
        'CREATE INDEX IF NOT EXISTS idx_nodes_ws ON nodes(workspace_id)',
        'CREATE INDEX IF NOT EXISTS idx_nodes_ws_type ON nodes(workspace_id, type)',
      ],
    },
    {
      table: 'edges',
      ddl: `CREATE TABLE edges_v2 (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL DEFAULT 'ws-demo', source_id TEXT NOT NULL,
        target_id TEXT NOT NULL, relationship_type TEXT NOT NULL, label TEXT NOT NULL,
        provenance TEXT NOT NULL, evidence_text TEXT NOT NULL DEFAULT '', source_record_id TEXT,
        fact_status TEXT NOT NULL DEFAULT 'CONFIRMED', is_demo INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
        FOREIGN KEY (source_id) REFERENCES nodes(id) ON DELETE CASCADE,
        FOREIGN KEY (target_id) REFERENCES nodes(id) ON DELETE CASCADE
      )`,
      columns: [
        { name: 'id' },
        { name: 'workspace_id', fallbackExpr: "COALESCE(NULLIF(TRIM(workspace_id), ''), 'ws-demo')" },
        { name: 'source_id' },
        { name: 'target_id' },
        { name: 'relationship_type' },
        { name: 'label' },
        { name: 'provenance', fallbackExpr: "COALESCE(provenance, 'Legacy Link')" },
        { name: 'evidence_text', fallbackExpr: "COALESCE(evidence_text, '')" },
        { name: 'source_record_id' },
        { name: 'fact_status', fallbackExpr: "COALESCE(fact_status, 'CONFIRMED')" },
        { name: 'is_demo', fallbackExpr: 'COALESCE(is_demo, 0)' },
        { name: 'created_at' },
      ],
      indexes: [
        'CREATE INDEX IF NOT EXISTS idx_edges_ws ON edges(workspace_id)',
        'CREATE INDEX IF NOT EXISTS idx_edges_ws_src ON edges(workspace_id, source_id)',
        'CREATE INDEX IF NOT EXISTS idx_edges_ws_tgt ON edges(workspace_id, target_id)',
      ],
    },
    {
      table: 'source_records',
      ddl: `CREATE TABLE source_records_v2 (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL DEFAULT 'ws-demo', source_type TEXT NOT NULL,
        external_id TEXT, sender TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
        received_at TEXT NOT NULL, parsed_entities_json TEXT NOT NULL DEFAULT '{}',
        is_demo INTEGER NOT NULL DEFAULT 0, processed INTEGER NOT NULL DEFAULT 1,
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
      )`,
      columns: [
        { name: 'id' },
        { name: 'workspace_id', fallbackExpr: "COALESCE(NULLIF(TRIM(workspace_id), ''), 'ws-demo')" },
        { name: 'source_type' },
        { name: 'external_id' },
        { name: 'sender' },
        { name: 'title' },
        { name: 'content' },
        { name: 'received_at' },
        { name: 'parsed_entities_json', fallbackExpr: "COALESCE(parsed_entities_json, '{}')" },
        { name: 'is_demo', fallbackExpr: 'COALESCE(is_demo, 0)' },
        { name: 'processed', fallbackExpr: 'COALESCE(processed, 1)' },
      ],
      indexes: ['CREATE INDEX IF NOT EXISTS idx_sources_ws ON source_records(workspace_id)'],
    },
    {
      table: 'impact_analyses',
      ddl: `CREATE TABLE impact_analyses_v2 (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL DEFAULT 'ws-demo',
        change_event_json TEXT NOT NULL, direct_impacts_json TEXT NOT NULL,
        downstream_impacts_json TEXT NOT NULL, unaffected_items_json TEXT NOT NULL,
        explanation_summary TEXT NOT NULL, ai_narrative TEXT,
        ai_status TEXT NOT NULL DEFAULT 'SKIPPED', created_at TEXT NOT NULL,
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
      )`,
      columns: [
        { name: 'id' },
        { name: 'workspace_id', fallbackExpr: "COALESCE(NULLIF(TRIM(workspace_id), ''), 'ws-demo')" },
        { name: 'change_event_json', fallbackExpr: "COALESCE(change_event_json, '{}')" },
        { name: 'direct_impacts_json', fallbackExpr: "COALESCE(direct_impacts_json, '[]')" },
        { name: 'downstream_impacts_json', fallbackExpr: "COALESCE(downstream_impacts_json, '[]')" },
        { name: 'unaffected_items_json', fallbackExpr: "COALESCE(unaffected_items_json, '[]')" },
        {
          name: 'explanation_summary',
          fallbackExpr:
            "COALESCE(NULLIF(TRIM(explanation_summary), ''), NULLIF(TRIM(ai_narrative), ''), 'Legacy impact analysis record (summary unavailable).')",
        },
        { name: 'ai_narrative' },
        { name: 'ai_status', fallbackExpr: "COALESCE(NULLIF(TRIM(ai_status), ''), 'SKIPPED')" },
        { name: 'created_at' },
      ],
      indexes: ['CREATE INDEX IF NOT EXISTS idx_analyses_ws ON impact_analyses(workspace_id)'],
    },
    {
      table: 'what_if_plans',
      ddl: `CREATE TABLE what_if_plans_v2 (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL DEFAULT 'ws-demo', analysis_id TEXT NOT NULL,
        option_key TEXT NOT NULL, title TEXT NOT NULL, strategy_summary TEXT NOT NULL,
        proposed_changes_json TEXT NOT NULL, tasks_affected_json TEXT NOT NULL,
        meetings_affected_json TEXT NOT NULL, potential_conflicts_json TEXT NOT NULL,
        advantages_json TEXT NOT NULL, tradeoffs_json TEXT NOT NULL,
        requires_confirmation_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'PROPOSED',
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
        FOREIGN KEY (analysis_id) REFERENCES impact_analyses(id) ON DELETE CASCADE
      )`,
      columns: [
        { name: 'id' },
        { name: 'workspace_id', fallbackExpr: "COALESCE(NULLIF(TRIM(workspace_id), ''), 'ws-demo')" },
        { name: 'analysis_id' },
        { name: 'option_key' },
        { name: 'title' },
        { name: 'strategy_summary', fallbackExpr: "COALESCE(strategy_summary, '')" },
        { name: 'proposed_changes_json', fallbackExpr: "COALESCE(proposed_changes_json, '[]')" },
        { name: 'tasks_affected_json', fallbackExpr: "COALESCE(tasks_affected_json, '[]')" },
        { name: 'meetings_affected_json', fallbackExpr: "COALESCE(meetings_affected_json, '[]')" },
        { name: 'potential_conflicts_json', fallbackExpr: "COALESCE(potential_conflicts_json, '[]')" },
        { name: 'advantages_json', fallbackExpr: "COALESCE(advantages_json, '[]')" },
        { name: 'tradeoffs_json', fallbackExpr: "COALESCE(tradeoffs_json, '[]')" },
        { name: 'requires_confirmation_json', fallbackExpr: "COALESCE(requires_confirmation_json, '[]')" },
        { name: 'status', fallbackExpr: "COALESCE(status, 'PROPOSED')" },
      ],
      indexes: ['CREATE INDEX IF NOT EXISTS idx_plans_ws ON what_if_plans(workspace_id)'],
    },
    {
      table: 'approvals',
      ddl: `CREATE TABLE approvals_v2 (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL DEFAULT 'ws-demo', plan_id TEXT NOT NULL,
        option_key TEXT NOT NULL, action_type TEXT NOT NULL, target_node_id TEXT NOT NULL,
        target_label TEXT NOT NULL, permission_scope TEXT NOT NULL,
        permission_valid INTEGER NOT NULL DEFAULT 1, permission_reason TEXT NOT NULL,
        proposed_payload_json TEXT NOT NULL, before_state_json TEXT NOT NULL,
        after_state_json TEXT NOT NULL, rationale TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING', execution_mode TEXT NOT NULL DEFAULT 'SIMULATED_DEMO',
        decided_at TEXT, decision_note TEXT, created_at TEXT NOT NULL,
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
      )`,
      columns: [
        { name: 'id' },
        { name: 'workspace_id', fallbackExpr: "COALESCE(NULLIF(TRIM(workspace_id), ''), 'ws-demo')" },
        { name: 'plan_id' },
        { name: 'option_key' },
        { name: 'action_type' },
        { name: 'target_node_id' },
        { name: 'target_label' },
        { name: 'permission_scope' },
        { name: 'permission_valid', fallbackExpr: 'COALESCE(permission_valid, 1)' },
        { name: 'permission_reason', fallbackExpr: "COALESCE(permission_reason, '')" },
        { name: 'proposed_payload_json', fallbackExpr: "COALESCE(proposed_payload_json, '{}')" },
        { name: 'before_state_json', fallbackExpr: "COALESCE(before_state_json, '{}')" },
        { name: 'after_state_json', fallbackExpr: "COALESCE(after_state_json, '{}')" },
        { name: 'rationale', fallbackExpr: "COALESCE(rationale, '')" },
        { name: 'status', fallbackExpr: "COALESCE(status, 'PENDING')" },
        { name: 'execution_mode', fallbackExpr: "COALESCE(execution_mode, 'SIMULATED_DEMO')" },
        { name: 'decided_at' },
        { name: 'decision_note' },
        { name: 'created_at' },
      ],
      indexes: ['CREATE INDEX IF NOT EXISTS idx_approvals_ws ON approvals(workspace_id)'],
    },
    {
      table: 'integrations',
      ddl: `CREATE TABLE integrations_v2 (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL DEFAULT 'ws-demo', service_key TEXT NOT NULL,
        name TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'DISCONNECTED',
        execution_policy TEXT NOT NULL, required_scopes_json TEXT NOT NULL,
        granted_scopes_json TEXT NOT NULL DEFAULT '[]', last_sync_at TEXT,
        setup_instructions_json TEXT NOT NULL, UNIQUE(workspace_id, service_key),
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
      )`,
      columns: [
        { name: 'id' },
        { name: 'workspace_id', fallbackExpr: "COALESCE(NULLIF(TRIM(workspace_id), ''), 'ws-demo')" },
        { name: 'service_key' },
        { name: 'name' },
        { name: 'description' },
        { name: 'status', fallbackExpr: "COALESCE(status, 'DISCONNECTED')" },
        { name: 'execution_policy' },
        { name: 'required_scopes_json', fallbackExpr: "COALESCE(required_scopes_json, '[]')" },
        { name: 'granted_scopes_json', fallbackExpr: "COALESCE(granted_scopes_json, '[]')" },
        { name: 'last_sync_at' },
        { name: 'setup_instructions_json', fallbackExpr: "COALESCE(setup_instructions_json, '[]')" },
      ],
      indexes: ['CREATE INDEX IF NOT EXISTS idx_integrations_ws ON integrations(workspace_id)'],
    },
  ];

  const migratedTables: string[] = [];
  const skippedTables: string[] = [];

  targetDb.pragma('foreign_keys = OFF');
  try {
    const tx = targetDb.transaction(() => {
      for (const spec of specs) {
        const fks = targetDb.prepare(`PRAGMA foreign_key_list(${spec.table})`).all() as Array<{
          table: string;
          from: string;
          on_delete: string;
        }>;
        const alreadyHasFk = fks.some(
          (fk) =>
            fk.table === 'workspaces' &&
            fk.from === 'workspace_id' &&
            fk.on_delete.toUpperCase() === 'CASCADE',
        );
        if (alreadyHasFk) continue;

        const orphanRow = targetDb
          .prepare(
            `SELECT COUNT(*) AS cnt FROM ${spec.table} t LEFT JOIN workspaces w ON t.workspace_id = w.id WHERE w.id IS NULL`,
          )
          .get() as { cnt: number };

        if (orphanRow.cnt > 0) {
          skippedTables.push(`${spec.table}(${orphanRow.cnt} orphans)`);
          continue;
        }

        const existingCols = new Set(
          (targetDb.prepare(`PRAGMA table_info(${spec.table})`).all() as Array<{ name: string }>).map(
            (c) => c.name,
          ),
        );
        const targetColNames = spec.columns.map((c) => c.name);
        const selectExprs = spec.columns.map((c) => {
          if (c.name === 'explanation_summary' && !existingCols.has('explanation_summary')) {
            return existingCols.has('ai_narrative')
              ? "COALESCE(NULLIF(TRIM(ai_narrative), ''), 'Legacy impact analysis record (summary unavailable).')"
              : "'Legacy impact analysis record (summary unavailable).'";
          }
          if (!existingCols.has(c.name)) {
            return 'NULL';
          }
          return c.fallbackExpr ?? c.name;
        });

        targetDb.exec(spec.ddl);
        targetDb.exec(
          `INSERT INTO ${spec.table}_v2 (${targetColNames.join(', ')}) SELECT ${selectExprs.join(', ')} FROM ${spec.table}`,
        );
        targetDb.exec(`DROP TABLE ${spec.table}`);
        targetDb.exec(`ALTER TABLE ${spec.table}_v2 RENAME TO ${spec.table}`);
        for (const idx of spec.indexes) {
          targetDb.exec(idx);
        }
        migratedTables.push(spec.table);
      }

      const fkViolations = targetDb.prepare('PRAGMA foreign_key_check').all() as unknown[];
      if (fkViolations.length > 0) {
        throw new Error(`Foreign key check failed after migration (${fkViolations.length} violations).`);
      }

      const finalStatus = skippedTables.length > 0 ? 'PARTIAL_ORPHANS_PRESERVED' : 'APPLIED';
      targetDb
        .prepare(
          `INSERT INTO schema_migrations (version, name, status, details, applied_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(version) DO UPDATE SET status = excluded.status, details = excluded.details, applied_at = excluded.applied_at`,
        )
        .run(
          MIGRATION_VERSION,
          MIGRATION_NAME,
          finalStatus,
          JSON.stringify({ migratedTables, skippedTables }),
          new Date().toISOString(),
        );
    });
    tx();
  } finally {
    targetDb.pragma('foreign_keys = ON');
  }

  const finalStatus = skippedTables.length > 0 ? 'PARTIAL_ORPHANS_PRESERVED' : 'APPLIED';
  return { version: MIGRATION_VERSION, status: finalStatus, migratedTables, skippedTables };
}

/**
 * Safely migrates pre-upgrade single-tenant tables into multi-user isolated tables,
 * quarantining all legacy demo rows exclusively inside `ws-demo`.
 */
export function migrateSchemaToMultiTenant(): void {
  const now = new Date().toISOString();

  // Ensure dedicated DEMO workspace exists
  db.prepare(`
    INSERT OR IGNORE INTO workspaces (id, owner_user_id, name, kind, created_at)
    VALUES (?, NULL, ?, 'DEMO', ?)
  `).run(DEMO_WORKSPACE_ID, 'maYa Showcase Demo', now);

  const tablesNeedingWorkspace = [
    'nodes',
    'edges',
    'source_records',
    'impact_analyses',
    'what_if_plans',
    'approvals',
    'audit_logs',
  ];

  const tx = db.transaction(() => {
    for (const tbl of tablesNeedingWorkspace) {
      if (!hasColumn(tbl, 'workspace_id')) {
        db.exec(`ALTER TABLE ${tbl} ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'ws-demo'`);
      }
    }

    // Safely migrate legacy integrations table (previously had global UNIQUE on service_key)
    if (!hasColumn('integrations', 'workspace_id')) {
      db.exec(`
        CREATE TABLE integrations_v2 (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL DEFAULT 'ws-demo',
          service_key TEXT NOT NULL,
          name TEXT NOT NULL,
          description TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'DISCONNECTED',
          execution_policy TEXT NOT NULL,
          required_scopes_json TEXT NOT NULL,
          granted_scopes_json TEXT NOT NULL DEFAULT '[]',
          last_sync_at TEXT,
          setup_instructions_json TEXT NOT NULL,
          UNIQUE(workspace_id, service_key)
        );

        INSERT INTO integrations_v2 (
          id, workspace_id, service_key, name, description, status, execution_policy,
          required_scopes_json, granted_scopes_json, last_sync_at, setup_instructions_json
        )
        SELECT
          id, 'ws-demo', service_key, name, description, status, execution_policy,
          required_scopes_json, granted_scopes_json, last_sync_at, setup_instructions_json
        FROM integrations;

        DROP TABLE integrations;
        ALTER TABLE integrations_v2 RENAME TO integrations;
      `);
    }

    // Create workspace isolation & query indexes
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_workspaces_owner ON workspaces(owner_user_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash);
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_nodes_ws ON nodes(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_nodes_ws_type ON nodes(workspace_id, type);
      CREATE INDEX IF NOT EXISTS idx_edges_ws ON edges(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_edges_ws_src ON edges(workspace_id, source_id);
      CREATE INDEX IF NOT EXISTS idx_edges_ws_tgt ON edges(workspace_id, target_id);
      CREATE INDEX IF NOT EXISTS idx_sources_ws ON source_records(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_analyses_ws ON impact_analyses(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_plans_ws ON what_if_plans(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_approvals_ws ON approvals(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_audit_ws ON audit_logs(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_integrations_ws ON integrations(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_oauth_states_ws ON oauth_states(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_gmail_conn_ws ON gmail_connections(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_gmail_msg_ws ON gmail_messages(workspace_id, received_at DESC);
      CREATE INDEX IF NOT EXISTS idx_email_items_ws ON email_extracted_items(workspace_id, status);
      CREATE INDEX IF NOT EXISTS idx_email_items_msg ON email_extracted_items(message_row_id);
      CREATE INDEX IF NOT EXISTS idx_email_rels_ws ON email_suggested_relationships(workspace_id, status);
      CREATE INDEX IF NOT EXISTS idx_email_rels_msg ON email_suggested_relationships(message_row_id);
    `);

    // Safely add extraction queue & retry columns to pre-existing gmail_messages tables
    const gmailRetryColumns: Array<{ name: string; ddl: string }> = [
      { name: 'retry_count', ddl: 'INTEGER NOT NULL DEFAULT 0' },
      { name: 'max_retries', ddl: 'INTEGER NOT NULL DEFAULT 4' },
      { name: 'next_retry_at', ddl: 'TEXT' },
      { name: 'last_attempt_at', ddl: 'TEXT' },
      { name: 'extracted_at', ddl: 'TEXT' },
    ];
    for (const col of gmailRetryColumns) {
      if (!hasColumn('gmail_messages', col.name)) {
        db.exec(`ALTER TABLE gmail_messages ADD COLUMN ${col.name} ${col.ddl}`);
      }
    }

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_gmail_msg_status ON gmail_messages(workspace_id, extraction_status, next_retry_at);
    `);

    // Migrate legacy EXTRACTED status -> COMPLETED and recover interrupted PROCESSING rows
    db.prepare(`
      UPDATE gmail_messages
      SET extraction_status = 'COMPLETED',
          extracted_at = COALESCE(extracted_at, created_at)
      WHERE extraction_status = 'EXTRACTED'
    `).run();

    db.prepare(`
      UPDATE gmail_messages
      SET extraction_status = 'PENDING'
      WHERE extraction_status = 'PROCESSING'
    `).run();

    // Ensure user-facing integration instructions never expose server env var names
    db.prepare(`
      UPDATE integrations
      SET setup_instructions_json = ?
      WHERE service_key = 'gmail'
        AND setup_instructions_json LIKE '%GOOGLE_CLIENT_ID%'
    `).run(
      JSON.stringify([
        'Click Connect Gmail to open Google’s OAuth consent screen for your personal Google account.',
        'Grant strictly read-only permission (gmail.readonly).',
        'Click Sync Now to extract insights for human review before adding them to your Context Graph.',
      ]),
    );
  });

  tx();
}

export function seedWorkspaceIntegrations(workspaceId: string): void {
  const existing = db
    .prepare('SELECT COUNT(*) as count FROM integrations WHERE workspace_id = ?')
    .get(workspaceId) as { count: number };
  if (existing.count > 0) return;

  const insertIntegration = db.prepare(`
    INSERT INTO integrations (
      id, workspace_id, service_key, name, description, status, execution_policy,
      required_scopes_json, granted_scopes_json, last_sync_at, setup_instructions_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const connectors: Omit<IntegrationConnector, 'workspaceId'>[] = [
    {
      id: `int-gmail-${workspaceId === DEMO_WORKSPACE_ID ? 'demo' : randomUUID().slice(0, 8)}`,
      serviceKey: 'gmail',
      name: 'Gmail API',
      description:
        'Reads recent emails with strictly read-only permissions (gmail.readonly) to surface projects, tasks, deadlines, conflicts, and relationship proposals for human review.',
      status: 'DISCONNECTED',
      executionPolicy:
        'Read-only ingestion only (gmail.readonly). Sending, deleting, or archiving is disabled; accepted insights update your private workspace only after review.',
      requiredScopes: ['https://www.googleapis.com/auth/gmail.readonly'],
      grantedScopes: [],
      lastSyncAt: null,
      setupInstructions: [
        'Click Connect Gmail to open Google’s OAuth consent screen for your personal Google account.',
        'Grant strictly read-only permission (gmail.readonly).',
        'Click Sync Now to extract insights for human review before adding them to your Context Graph.',
      ],
    },
    {
      id: `int-cal-${workspaceId === DEMO_WORKSPACE_ID ? 'demo' : randomUUID().slice(0, 8)}`,
      serviceKey: 'google_calendar',
      name: 'Google Calendar API',
      description:
        'Ingests review meetings, project milestones, and schedule windows; writes only after user approval.',
      status: 'DISCONNECTED',
      executionPolicy: 'Minimum read scope; calendar.events writes gated by Approvals queue.',
      requiredScopes: [
        'https://www.googleapis.com/auth/calendar.readonly',
        'https://www.googleapis.com/auth/calendar.events',
      ],
      grantedScopes: [],
      lastSyncAt: null,
      setupInstructions: [
        'Planned for a future milestone using centralized maYa Google OAuth.',
        'Will request calendar.readonly for context sync and calendar.events for approved reschedules.',
        'Reschedules currently update your local workspace schedule only.',
      ],
    },
    {
      id: `int-tasks-${workspaceId === DEMO_WORKSPACE_ID ? 'demo' : randomUUID().slice(0, 8)}`,
      serviceKey: 'google_tasks',
      name: 'Google Tasks API',
      description:
        'Synchronizes task due dates, completion states, and assignee dependencies into your Context Graph.',
      status: 'DISCONNECTED',
      executionPolicy: 'Task mutations require explicit approval and log before/after state diffs.',
      requiredScopes: ['https://www.googleapis.com/auth/tasks'],
      grantedScopes: [],
      lastSyncAt: null,
      setupInstructions: [
        'Planned for a future milestone using centralized maYa Google OAuth.',
        'Will sync task statuses and due dates with explicit approval controls.',
        'Personal workspace tasks currently persist directly in your isolated workspace.',
      ],
    },
  ];

  for (const c of connectors) {
    insertIntegration.run(
      c.id,
      workspaceId,
      c.serviceKey,
      c.name,
      c.description,
      c.status,
      c.executionPolicy,
      JSON.stringify(c.requiredScopes),
      JSON.stringify(c.grantedScopes),
      c.lastSyncAt,
      JSON.stringify(c.setupInstructions),
    );
  }
}

/**
 * Resets and seeds ONLY the isolated DEMO workspace (`ws-demo`).
 * Never touches any user's personal workspace records.
 */
export function resetAndSeedDemoData(): void {
  const now = '2026-11-23T09:00:00Z';

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM approvals WHERE workspace_id = ?').run(DEMO_WORKSPACE_ID);
    db.prepare('DELETE FROM what_if_plans WHERE workspace_id = ?').run(DEMO_WORKSPACE_ID);
    db.prepare('DELETE FROM impact_analyses WHERE workspace_id = ?').run(DEMO_WORKSPACE_ID);
    db.prepare('DELETE FROM audit_logs WHERE workspace_id = ?').run(DEMO_WORKSPACE_ID);
    db.prepare('DELETE FROM edges WHERE workspace_id = ?').run(DEMO_WORKSPACE_ID);
    db.prepare('DELETE FROM nodes WHERE workspace_id = ?').run(DEMO_WORKSPACE_ID);
    db.prepare('DELETE FROM source_records WHERE workspace_id = ?').run(DEMO_WORKSPACE_ID);

    const insertSource = db.prepare(`
      INSERT INTO source_records (
        id, workspace_id, source_type, external_id, sender, title, content, received_at,
        parsed_entities_json, is_demo, processed
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const sources: SourceRecord[] = [
      {
        id: 'src-email-kickoff',
        workspaceId: DEMO_WORKSPACE_ID,
        sourceType: 'EMAIL',
        externalId: 'demo-msg-101',
        sender: 'Research Steering Committee <chair@research-board.org>',
        title: 'AI Research Project — Milestone & Friday Submission Schedule',
        content:
          'Confirmed schedule for AI Research Project: Final submission deadline is Friday, Nov 27, 2026 at 17:00. Ananya Rao leads documentation; Rohan Kulkarni serves as Project Reviewer.',
        receivedAt: '2026-11-18T10:15:00Z',
        parsedEntities: { project: 'AI Research Project', deadline: '2026-11-27' },
        isDemo: true,
        processed: true,
      },
      {
        id: 'src-cal-review',
        workspaceId: DEMO_WORKSPACE_ID,
        sourceType: 'CALENDAR',
        externalId: 'demo-cal-204',
        sender: 'Google Calendar (Demo Snapshot)',
        title: 'Project Review: AI Research — Thursday Nov 26, 14:00',
        content:
          'Calendar invite: Project Review on Thursday, Nov 26, 2026 from 14:00 to 15:00. Attendees: Ananya Rao, Rohan Kulkarni (Project Reviewer), Meera Nair.',
        receivedAt: '2026-11-19T08:30:00Z',
        parsedEntities: { meeting: 'Project Review: AI Research', date: '2026-11-26T14:00' },
        isDemo: true,
        processed: true,
      },
      {
        id: 'src-tasks-sync',
        workspaceId: DEMO_WORKSPACE_ID,
        sourceType: 'TASKS',
        externalId: 'demo-tasks-309',
        sender: 'Google Tasks (Demo Snapshot)',
        title: 'AI Research Project Task Dependency Chain',
        content:
          'Task A (Complete research documentation, due Thu Nov 26 10:00) -> Task B (Review research documentation, due Thu Nov 26 16:00, assignee Rohan Kulkarni) -> Task C (Prepare presentation, due Fri Nov 27 14:00, assignee Meera Nair).',
        receivedAt: '2026-11-20T11:45:00Z',
        parsedEntities: { tasks: ['Task A', 'Task B', 'Task C'] },
        isDemo: true,
        processed: true,
      },
      {
        id: 'src-doc-plan',
        workspaceId: DEMO_WORKSPACE_ID,
        sourceType: 'DOCUMENT',
        externalId: 'demo-doc-412',
        sender: 'Workspace Drive (Demo Snapshot)',
        title: 'Document: AI Research Project Plan',
        content:
          'AI Research Project Plan (v2.1). Submission Deadline: Friday, Nov 27, 2026. Workstream: Task A documentation feeds Task B peer review and Task C executive presentation.',
        receivedAt: '2026-11-21T15:20:00Z',
        parsedEntities: { document: 'AI Research Project Plan', deadlineText: 'Friday, Nov 27, 2026' },
        isDemo: true,
        processed: true,
      },
      {
        id: 'src-email-campus',
        workspaceId: DEMO_WORKSPACE_ID,
        sourceType: 'EMAIL',
        externalId: 'demo-msg-118',
        sender: 'Kabir Verma <kabir@campus-mobility.org>',
        title: 'Campus Mobility Sync — GTFS Feed & Beta Freeze',
        content:
          'GTFS parser work is tracking on schedule for Nov 28 ahead of our Tuesday, Dec 1 Beta Freeze. Friday sprint sync remains unchanged.',
        receivedAt: '2026-11-22T09:10:00Z',
        parsedEntities: { project: 'Campus Mobility Sync', deadline: '2026-12-01' },
        isDemo: true,
        processed: true,
      },
      {
        id: 'src-email-security',
        workspaceId: DEMO_WORKSPACE_ID,
        sourceType: 'EMAIL',
        externalId: 'demo-msg-122',
        sender: 'Security Governance <secops@internal.org>',
        title: 'Q4 Security & Compliance Audit — Dec 4 Sign-off',
        content:
          'OAuth token vault verification and SOC2 archive compilation remain scheduled for Dec 2–3 ahead of Friday, Dec 4 sign-off.',
        receivedAt: '2026-11-22T17:00:00Z',
        parsedEntities: { project: 'Q4 Security & Compliance Audit', deadline: '2026-12-04' },
        isDemo: true,
        processed: true,
      },
    ];

    for (const s of sources) {
      insertSource.run(
        s.id,
        DEMO_WORKSPACE_ID,
        s.sourceType,
        s.externalId,
        s.sender,
        s.title,
        s.content,
        s.receivedAt,
        JSON.stringify(s.parsedEntities),
        1,
        s.processed ? 1 : 0,
      );
    }

    const insertNode = db.prepare(`
      INSERT INTO nodes (
        id, workspace_id, type, title, subtitle, status, date, owner_id, project_id,
        metadata_json, provenance, fact_status, is_demo, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const nodes: ContextNode[] = [
      {
        id: 'person-ananya',
        workspaceId: DEMO_WORKSPACE_ID,
        type: 'PERSON',
        title: 'Ananya Rao',
        subtitle: 'Lead Researcher · AI Research Owner',
        status: 'Active',
        date: null,
        ownerId: null,
        projectId: null,
        metadata: { email: 'ananya.rao@lab.org', role: 'Lead Researcher', capacity: 'High' },
        provenance: 'Seeded Workspace Directory',
        factStatus: 'CONFIRMED',
        isDemo: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'person-rohan',
        workspaceId: DEMO_WORKSPACE_ID,
        type: 'PERSON',
        title: 'Rohan Kulkarni',
        subtitle: 'Project Reviewer · Technical Governance',
        status: 'Active',
        date: null,
        ownerId: null,
        projectId: null,
        metadata: { email: 'rohan.k@lab.org', role: 'Project Reviewer', capacity: 'Moderate' },
        provenance: 'Seeded Workspace Directory',
        factStatus: 'CONFIRMED',
        isDemo: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'person-meera',
        workspaceId: DEMO_WORKSPACE_ID,
        type: 'PERSON',
        title: 'Meera Nair',
        subtitle: 'ML Systems Engineer',
        status: 'Active',
        date: null,
        ownerId: null,
        projectId: null,
        metadata: { email: 'meera.nair@lab.org', role: 'ML Systems Engineer', capacity: 'Available' },
        provenance: 'Seeded Workspace Directory',
        factStatus: 'CONFIRMED',
        isDemo: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'person-kabir',
        workspaceId: DEMO_WORKSPACE_ID,
        type: 'PERSON',
        title: 'Kabir Verma',
        subtitle: 'Product Architect · Mobility & Security',
        status: 'Active',
        date: null,
        ownerId: null,
        projectId: null,
        metadata: { email: 'kabir.v@lab.org', role: 'Product Architect', capacity: 'Moderate' },
        provenance: 'Seeded Workspace Directory',
        factStatus: 'CONFIRMED',
        isDemo: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'person-swarankith',
        workspaceId: DEMO_WORKSPACE_ID,
        type: 'PERSON',
        title: 'Swarankith P.',
        subtitle: 'Workspace Decision Owner',
        status: 'Active',
        date: null,
        ownerId: null,
        projectId: null,
        metadata: { email: 'pamarthi.swarankith@gmail.com', role: 'Decision Owner' },
        provenance: 'Seeded Workspace Profile',
        factStatus: 'CONFIRMED',
        isDemo: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'proj-ai-research',
        workspaceId: DEMO_WORKSPACE_ID,
        type: 'PROJECT',
        title: 'AI Research Project',
        subtitle: 'Primary Deliverable · Neural Context Evaluation',
        status: 'Active',
        date: '2026-11-27',
        ownerId: 'person-ananya',
        projectId: 'proj-ai-research',
        metadata: { priority: 'Critical', originalDeadlineLabel: 'Friday, Nov 27' },
        provenance: 'Seeded Email (src-email-kickoff)',
        factStatus: 'CONFIRMED',
        isDemo: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'proj-campus-sync',
        workspaceId: DEMO_WORKSPACE_ID,
        type: 'PROJECT',
        title: 'Campus Mobility Sync',
        subtitle: 'Transit GTFS & Live Routing Service',
        status: 'Active',
        date: '2026-12-01',
        ownerId: 'person-kabir',
        projectId: 'proj-campus-sync',
        metadata: { priority: 'Standard' },
        provenance: 'Seeded Email (src-email-campus)',
        factStatus: 'CONFIRMED',
        isDemo: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'proj-q4-ops',
        workspaceId: DEMO_WORKSPACE_ID,
        type: 'PROJECT',
        title: 'Q4 Security & Compliance Audit',
        subtitle: 'OAuth Token Vault & SOC2 Archive',
        status: 'Active',
        date: '2026-12-04',
        ownerId: 'person-kabir',
        projectId: 'proj-q4-ops',
        metadata: { priority: 'High' },
        provenance: 'Seeded Email (src-email-security)',
        factStatus: 'CONFIRMED',
        isDemo: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'dl-ai-research',
        workspaceId: DEMO_WORKSPACE_ID,
        type: 'DEADLINE',
        title: 'AI Research Final Submission',
        subtitle: 'Friday, Nov 27 · 17:00',
        status: 'On Track',
        date: '2026-11-27T17:00',
        ownerId: 'person-ananya',
        projectId: 'proj-ai-research',
        metadata: { dayLabel: 'Friday', timeLabel: '17:00' },
        provenance: 'Seeded Email (src-email-kickoff)',
        factStatus: 'CONFIRMED',
        isDemo: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'dl-campus-sync',
        workspaceId: DEMO_WORKSPACE_ID,
        type: 'DEADLINE',
        title: 'Campus Mobility Beta Freeze',
        subtitle: 'Tuesday, Dec 1 · 18:00',
        status: 'On Track',
        date: '2026-12-01T18:00',
        ownerId: 'person-kabir',
        projectId: 'proj-campus-sync',
        metadata: { dayLabel: 'Tuesday', timeLabel: '18:00' },
        provenance: 'Seeded Email (src-email-campus)',
        factStatus: 'CONFIRMED',
        isDemo: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'dl-q4-ops',
        workspaceId: DEMO_WORKSPACE_ID,
        type: 'DEADLINE',
        title: 'Q4 Compliance Sign-off',
        subtitle: 'Friday, Dec 4 · 16:00',
        status: 'On Track',
        date: '2026-12-04T16:00',
        ownerId: 'person-kabir',
        projectId: 'proj-q4-ops',
        metadata: { dayLabel: 'Friday', timeLabel: '16:00' },
        provenance: 'Seeded Email (src-email-security)',
        factStatus: 'CONFIRMED',
        isDemo: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'task-a',
        workspaceId: DEMO_WORKSPACE_ID,
        type: 'TASK',
        title: 'Task A: Complete research documentation',
        subtitle: 'Due Thu Nov 26 · Assigned to Ananya Rao',
        status: 'In Progress',
        date: '2026-11-26T10:00',
        ownerId: 'person-ananya',
        projectId: 'proj-ai-research',
        metadata: { code: 'TASK-A', estimatedHours: 6 },
        provenance: 'Seeded Google Tasks (src-tasks-sync)',
        factStatus: 'CONFIRMED',
        isDemo: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'task-b',
        workspaceId: DEMO_WORKSPACE_ID,
        type: 'TASK',
        title: 'Task B: Review research documentation',
        subtitle: 'Due Thu Nov 26 · Assigned to Rohan Kulkarni',
        status: 'Scheduled',
        date: '2026-11-26T16:00',
        ownerId: 'person-rohan',
        projectId: 'proj-ai-research',
        metadata: { code: 'TASK-B', estimatedHours: 3 },
        provenance: 'Seeded Google Tasks (src-tasks-sync)',
        factStatus: 'CONFIRMED',
        isDemo: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'task-c',
        workspaceId: DEMO_WORKSPACE_ID,
        type: 'TASK',
        title: 'Task C: Prepare presentation',
        subtitle: 'Due Fri Nov 27 · Assigned to Meera Nair',
        status: 'Scheduled',
        date: '2026-11-27T14:00',
        ownerId: 'person-meera',
        projectId: 'proj-ai-research',
        metadata: { code: 'TASK-C', estimatedHours: 4 },
        provenance: 'Seeded Google Tasks (src-tasks-sync)',
        factStatus: 'CONFIRMED',
        isDemo: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'task-d',
        workspaceId: DEMO_WORKSPACE_ID,
        type: 'TASK',
        title: 'Benchmark edge inference latency',
        subtitle: 'Completed Tue Nov 24 · Assigned to Meera Nair',
        status: 'Completed',
        date: '2026-11-24T15:00',
        ownerId: 'person-meera',
        projectId: 'proj-ai-research',
        metadata: { code: 'TASK-D', estimatedHours: 4 },
        provenance: 'Seeded Google Tasks (src-tasks-sync)',
        factStatus: 'CONFIRMED',
        isDemo: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'task-e',
        workspaceId: DEMO_WORKSPACE_ID,
        type: 'TASK',
        title: 'Finalize GTFS transit feed parser',
        subtitle: 'Due Sat Nov 28 · Assigned to Kabir Verma',
        status: 'In Progress',
        date: '2026-11-28T17:00',
        ownerId: 'person-kabir',
        projectId: 'proj-campus-sync',
        metadata: { code: 'TASK-E', estimatedHours: 5 },
        provenance: 'Seeded Email (src-email-campus)',
        factStatus: 'CONFIRMED',
        isDemo: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'task-f',
        workspaceId: DEMO_WORKSPACE_ID,
        type: 'TASK',
        title: 'Load-test route matching API',
        subtitle: 'Due Mon Nov 30 · Assigned to Meera Nair',
        status: 'Scheduled',
        date: '2026-11-30T16:00',
        ownerId: 'person-meera',
        projectId: 'proj-campus-sync',
        metadata: { code: 'TASK-F', estimatedHours: 3 },
        provenance: 'Inferred from Campus Mobility Sprint Plan',
        factStatus: 'INFERRED',
        isDemo: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'task-g',
        workspaceId: DEMO_WORKSPACE_ID,
        type: 'TASK',
        title: 'Verify OAuth token vault policies',
        subtitle: 'Due Wed Dec 2 · Assigned to Kabir Verma',
        status: 'Scheduled',
        date: '2026-12-02T15:00',
        ownerId: 'person-kabir',
        projectId: 'proj-q4-ops',
        metadata: { code: 'TASK-G', estimatedHours: 4 },
        provenance: 'Seeded Email (src-email-security)',
        factStatus: 'CONFIRMED',
        isDemo: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'task-h',
        workspaceId: DEMO_WORKSPACE_ID,
        type: 'TASK',
        title: 'Compile SOC2 evidence archive',
        subtitle: 'Due Thu Dec 3 · Assigned to Ananya Rao',
        status: 'Scheduled',
        date: '2026-12-03T12:00',
        ownerId: 'person-ananya',
        projectId: 'proj-q4-ops',
        metadata: { code: 'TASK-H', estimatedHours: 4 },
        provenance: 'Seeded Email (src-email-security)',
        factStatus: 'CONFIRMED',
        isDemo: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'task-i',
        workspaceId: DEMO_WORKSPACE_ID,
        type: 'TASK',
        title: 'Prepare compliance briefing memo',
        subtitle: 'Due Fri Dec 4 · Assigned to Rohan Kulkarni',
        status: 'Scheduled',
        date: '2026-12-04T11:00',
        ownerId: 'person-rohan',
        projectId: 'proj-q4-ops',
        metadata: { code: 'TASK-I', estimatedHours: 2 },
        provenance: 'Inferred from Q4 Governance Checklist',
        factStatus: 'INFERRED',
        isDemo: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'meet-proj-review',
        workspaceId: DEMO_WORKSPACE_ID,
        type: 'MEETING',
        title: 'Project Review: AI Research',
        subtitle: 'Thursday, Nov 26 · 14:00–15:00',
        status: 'Confirmed',
        date: '2026-11-26T14:00',
        ownerId: 'person-rohan',
        projectId: 'proj-ai-research',
        metadata: { durationMinutes: 60, location: 'Review Room B / Meet' },
        provenance: 'Seeded Google Calendar (src-cal-review)',
        factStatus: 'CONFIRMED',
        isDemo: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'meet-campus-sync',
        workspaceId: DEMO_WORKSPACE_ID,
        type: 'MEETING',
        title: 'Campus Mobility Sprint Sync',
        subtitle: 'Friday, Nov 27 · 11:00–11:45',
        status: 'Confirmed',
        date: '2026-11-27T11:00',
        ownerId: 'person-kabir',
        projectId: 'proj-campus-sync',
        metadata: { durationMinutes: 45, location: 'Engineering Sync' },
        provenance: 'Seeded Email (src-email-campus)',
        factStatus: 'CONFIRMED',
        isDemo: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'meet-q4-review',
        workspaceId: DEMO_WORKSPACE_ID,
        type: 'MEETING',
        title: 'Security Posture Sign-Off',
        subtitle: 'Thursday, Dec 3 · 16:00–17:00',
        status: 'Confirmed',
        date: '2026-12-03T16:00',
        ownerId: 'person-rohan',
        projectId: 'proj-q4-ops',
        metadata: { durationMinutes: 60, location: 'Governance Review' },
        provenance: 'Seeded Email (src-email-security)',
        factStatus: 'CONFIRMED',
        isDemo: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'doc-project-plan',
        workspaceId: DEMO_WORKSPACE_ID,
        type: 'DOCUMENT',
        title: 'AI Research Project Plan',
        subtitle: 'Contains deadline: Friday, Nov 27, 2026',
        status: 'Active',
        date: '2026-11-27',
        ownerId: 'person-ananya',
        projectId: 'proj-ai-research',
        metadata: {
          referencedDeadline: '2026-11-27',
          referencedDeadlineText: 'Friday, Nov 27, 2026',
          excerpt: 'Final submission deadline is Friday, Nov 27, 2026.',
        },
        provenance: 'Seeded Document Extract (src-doc-plan)',
        factStatus: 'CONFIRMED',
        isDemo: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'doc-campus-spec',
        workspaceId: DEMO_WORKSPACE_ID,
        type: 'DOCUMENT',
        title: 'Campus Mobility Architecture Spec',
        subtitle: 'Contains freeze date: Tuesday, Dec 1, 2026',
        status: 'Active',
        date: '2026-12-01',
        ownerId: 'person-kabir',
        projectId: 'proj-campus-sync',
        metadata: {
          referencedDeadline: '2026-12-01',
          referencedDeadlineText: 'Tuesday, Dec 1, 2026',
        },
        provenance: 'Seeded Workspace Document',
        factStatus: 'CONFIRMED',
        isDemo: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'email-kickoff',
        workspaceId: DEMO_WORKSPACE_ID,
        type: 'EMAIL',
        title: 'Email: AI Research Kickoff & Deadline',
        subtitle: 'From Research Steering Committee · Nov 18',
        status: 'Processed',
        date: '2026-11-18T10:15',
        ownerId: 'person-ananya',
        projectId: 'proj-ai-research',
        metadata: { sourceRecordId: 'src-email-kickoff' },
        provenance: 'Seeded Email (src-email-kickoff)',
        factStatus: 'CONFIRMED',
        isDemo: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'sr-node-tasks',
        workspaceId: DEMO_WORKSPACE_ID,
        type: 'SOURCE_RECORD',
        title: 'Source: Google Tasks Snapshot',
        subtitle: 'Dependency Schedule · Nov 20',
        status: 'Synced',
        date: '2026-11-20T11:45',
        ownerId: null,
        projectId: 'proj-ai-research',
        metadata: { sourceRecordId: 'src-tasks-sync' },
        provenance: 'Seeded Google Tasks Snapshot',
        factStatus: 'CONFIRMED',
        isDemo: true,
        createdAt: now,
        updatedAt: now,
      },
    ];

    for (const n of nodes) {
      insertNode.run(
        n.id,
        DEMO_WORKSPACE_ID,
        n.type,
        n.title,
        n.subtitle,
        n.status,
        n.date,
        n.ownerId,
        n.projectId,
        JSON.stringify(n.metadata),
        n.provenance,
        n.factStatus,
        1,
        n.createdAt,
        n.updatedAt,
      );
    }

    const insertEdge = db.prepare(`
      INSERT INTO edges (
        id, workspace_id, source_id, target_id, relationship_type, label, provenance,
        evidence_text, source_record_id, fact_status, is_demo, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const edges: Omit<ContextEdge, 'workspaceId'>[] = [
      {
        id: 'edge-1',
        sourceId: 'person-ananya',
        targetId: 'proj-ai-research',
        relationshipType: 'WORKS_ON',
        label: 'leads',
        provenance: 'Seeded Email (src-email-kickoff)',
        evidenceText: 'Ananya Rao is listed as Lead Researcher on AI Research Project.',
        sourceRecordId: 'src-email-kickoff',
        factStatus: 'CONFIRMED',
        isDemo: true,
        createdAt: now,
      },
      {
        id: 'edge-2',
        sourceId: 'person-rohan',
        targetId: 'proj-ai-research',
        relationshipType: 'WORKS_ON',
        label: 'reviews',
        provenance: 'Seeded Email (src-email-kickoff)',
        evidenceText: 'Rohan Kulkarni serves as designated Project Reviewer.',
        sourceRecordId: 'src-email-kickoff',
        factStatus: 'CONFIRMED',
        isDemo: true,
        createdAt: now,
      },
      {
        id: 'edge-3',
        sourceId: 'person-meera',
        targetId: 'proj-ai-research',
        relationshipType: 'WORKS_ON',
        label: 'contributes to',
        provenance: 'Inferred from Task C and Task D ownership',
        evidenceText: 'Assigned to two deliverables belonging to AI Research Project.',
        sourceRecordId: 'src-tasks-sync',
        factStatus: 'INFERRED',
        isDemo: true,
        createdAt: now,
      },
      {
        id: 'edge-4',
        sourceId: 'person-kabir',
        targetId: 'proj-campus-sync',
        relationshipType: 'WORKS_ON',
        label: 'leads',
        provenance: 'Seeded Email (src-email-campus)',
        evidenceText: 'Kabir Verma sent status update for Campus Mobility Sync.',
        sourceRecordId: 'src-email-campus',
        factStatus: 'CONFIRMED',
        isDemo: true,
        createdAt: now,
      },
      {
        id: 'edge-5',
        sourceId: 'person-kabir',
        targetId: 'proj-q4-ops',
        relationshipType: 'WORKS_ON',
        label: 'coordinates',
        provenance: 'Seeded Email (src-email-security)',
        evidenceText: 'Assigned to OAuth token vault verification.',
        sourceRecordId: 'src-email-security',
        factStatus: 'CONFIRMED',
        isDemo: true,
        createdAt: now,
      },
      {
        id: 'edge-6',
        sourceId: 'dl-ai-research',
        targetId: 'proj-ai-research',
        relationshipType: 'BELONGS_TO',
        label: 'deadline for',
        provenance: 'Seeded Email (src-email-kickoff)',
        evidenceText: 'Submission deadline is Friday, Nov 27, 2026 at 17:00.',
        sourceRecordId: 'src-email-kickoff',
        factStatus: 'CONFIRMED',
        isDemo: true,
        createdAt: now,
      },
      {
        id: 'edge-7',
        sourceId: 'dl-campus-sync',
        targetId: 'proj-campus-sync',
        relationshipType: 'BELONGS_TO',
        label: 'deadline for',
        provenance: 'Seeded Email (src-email-campus)',
        evidenceText: 'Beta freeze set for Tuesday, Dec 1, 2026.',
        sourceRecordId: 'src-email-campus',
        factStatus: 'CONFIRMED',
        isDemo: true,
        createdAt: now,
      },
      {
        id: 'edge-8',
        sourceId: 'dl-q4-ops',
        targetId: 'proj-q4-ops',
        relationshipType: 'BELONGS_TO',
        label: 'deadline for',
        provenance: 'Seeded Email (src-email-security)',
        evidenceText: 'Compliance sign-off scheduled for Dec 4, 2026.',
        sourceRecordId: 'src-email-security',
        factStatus: 'CONFIRMED',
        isDemo: true,
        createdAt: now,
      },
      {
        id: 'edge-9',
        sourceId: 'task-a',
        targetId: 'proj-ai-research',
        relationshipType: 'BELONGS_TO',
        label: 'belongs to',
        provenance: 'Seeded Google Tasks (src-tasks-sync)',
        evidenceText: 'Listed under AI Research Project workstream.',
        sourceRecordId: 'src-tasks-sync',
        factStatus: 'CONFIRMED',
        isDemo: true,
        createdAt: now,
      },
      {
        id: 'edge-10',
        sourceId: 'task-b',
        targetId: 'proj-ai-research',
        relationshipType: 'BELONGS_TO',
        label: 'belongs to',
        provenance: 'Seeded Google Tasks (src-tasks-sync)',
        evidenceText: 'Listed under AI Research Project workstream.',
        sourceRecordId: 'src-tasks-sync',
        factStatus: 'CONFIRMED',
        isDemo: true,
        createdAt: now,
      },
      {
        id: 'edge-11',
        sourceId: 'task-c',
        targetId: 'proj-ai-research',
        relationshipType: 'BELONGS_TO',
        label: 'belongs to',
        provenance: 'Seeded Google Tasks (src-tasks-sync)',
        evidenceText: 'Listed under AI Research Project workstream.',
        sourceRecordId: 'src-tasks-sync',
        factStatus: 'CONFIRMED',
        isDemo: true,
        createdAt: now,
      },
      {
        id: 'edge-12',
        sourceId: 'task-d',
        targetId: 'proj-ai-research',
        relationshipType: 'BELONGS_TO',
        label: 'belongs to',
        provenance: 'Seeded Google Tasks (src-tasks-sync)',
        evidenceText: 'Completed latency benchmark for AI Research Project.',
        sourceRecordId: 'src-tasks-sync',
        factStatus: 'CONFIRMED',
        isDemo: true,
        createdAt: now,
      },
      {
        id: 'edge-13',
        sourceId: 'task-e',
        targetId: 'proj-campus-sync',
        relationshipType: 'BELONGS_TO',
        label: 'belongs to',
        provenance: 'Seeded Email (src-email-campus)',
        evidenceText: 'GTFS feed parser is part of Campus Mobility Sync.',
        sourceRecordId: 'src-email-campus',
        factStatus: 'CONFIRMED',
        isDemo: true,
        createdAt: now,
      },
      {
        id: 'edge-14',
        sourceId: 'task-f',
        targetId: 'proj-campus-sync',
        relationshipType: 'BELONGS_TO',
        label: 'belongs to',
        provenance: 'Inferred from Campus Mobility Sprint Plan',
        evidenceText: 'Load test follows GTFS parser milestone.',
        sourceRecordId: 'src-email-campus',
        factStatus: 'INFERRED',
        isDemo: true,
        createdAt: now,
      },
      {
        id: 'edge-15',
        sourceId: 'task-g',
        targetId: 'proj-q4-ops',
        relationshipType: 'BELONGS_TO',
        label: 'belongs to',
        provenance: 'Seeded Email (src-email-security)',
        evidenceText: 'Part of Q4 Security & Compliance Audit.',
        sourceRecordId: 'src-email-security',
        factStatus: 'CONFIRMED',
        isDemo: true,
        createdAt: now,
      },
      {
        id: 'edge-16',
        sourceId: 'task-h',
        targetId: 'proj-q4-ops',
        relationshipType: 'BELONGS_TO',
        label: 'belongs to',
        provenance: 'Seeded Email (src-email-security)',
        evidenceText: 'Part of Q4 Security & Compliance Audit.',
        sourceRecordId: 'src-email-security',
        factStatus: 'CONFIRMED',
        isDemo: true,
        createdAt: now,
      },
      {
        id: 'edge-17',
        sourceId: 'task-i',
        targetId: 'proj-q4-ops',
        relationshipType: 'BELONGS_TO',
        label: 'belongs to',
        provenance: 'Inferred from Q4 Governance Checklist',
        evidenceText: 'Briefing memo supports compliance sign-off.',
        sourceRecordId: 'src-email-security',
        factStatus: 'INFERRED',
        isDemo: true,
        createdAt: now,
      },
      {
        id: 'edge-18',
        sourceId: 'task-b',
        targetId: 'task-a',
        relationshipType: 'DEPENDS_ON',
        label: 'depends on',
        provenance: 'Seeded Google Tasks (src-tasks-sync)',
        evidenceText:
          'Task B (Review research documentation) cannot begin until Task A (Complete research documentation) finishes.',
        sourceRecordId: 'src-tasks-sync',
        factStatus: 'CONFIRMED',
        isDemo: true,
        createdAt: now,
      },
      {
        id: 'edge-19',
        sourceId: 'task-c',
        targetId: 'task-b',
        relationshipType: 'DEPENDS_ON',
        label: 'depends on',
        provenance: 'Seeded Google Tasks (src-tasks-sync)',
        evidenceText:
          'Task C (Prepare presentation) incorporates approved findings from Task B review.',
        sourceRecordId: 'src-tasks-sync',
        factStatus: 'CONFIRMED',
        isDemo: true,
        createdAt: now,
      },
      {
        id: 'edge-20',
        sourceId: 'task-f',
        targetId: 'task-e',
        relationshipType: 'DEPENDS_ON',
        label: 'depends on',
        provenance: 'Inferred from Campus Mobility Sprint Plan',
        evidenceText: 'Route matching API load test requires finalized GTFS parser.',
        sourceRecordId: 'src-email-campus',
        factStatus: 'INFERRED',
        isDemo: true,
        createdAt: now,
      },
      {
        id: 'edge-21',
        sourceId: 'task-h',
        targetId: 'task-g',
        relationshipType: 'DEPENDS_ON',
        label: 'depends on',
        provenance: 'Seeded Email (src-email-security)',
        evidenceText: 'SOC2 evidence archive includes OAuth vault verification output.',
        sourceRecordId: 'src-email-security',
        factStatus: 'CONFIRMED',
        isDemo: true,
        createdAt: now,
      },
      {
        id: 'edge-22',
        sourceId: 'task-a',
        targetId: 'person-ananya',
        relationshipType: 'ASSIGNED_TO',
        label: 'assigned to',
        provenance: 'Seeded Google Tasks (src-tasks-sync)',
        evidenceText: 'Ananya Rao is task owner for Task A.',
        sourceRecordId: 'src-tasks-sync',
        factStatus: 'CONFIRMED',
        isDemo: true,
        createdAt: now,
      },
      {
        id: 'edge-23',
        sourceId: 'task-b',
        targetId: 'person-rohan',
        relationshipType: 'ASSIGNED_TO',
        label: 'assigned to',
        provenance: 'Seeded Google Tasks (src-tasks-sync)',
        evidenceText: 'Rohan Kulkarni (Project Reviewer) is assigned Task B review.',
        sourceRecordId: 'src-tasks-sync',
        factStatus: 'CONFIRMED',
        isDemo: true,
        createdAt: now,
      },
      {
        id: 'edge-24',
        sourceId: 'task-c',
        targetId: 'person-meera',
        relationshipType: 'ASSIGNED_TO',
        label: 'assigned to',
        provenance: 'Seeded Google Tasks (src-tasks-sync)',
        evidenceText: 'Meera Nair is assigned Task C presentation prep.',
        sourceRecordId: 'src-tasks-sync',
        factStatus: 'CONFIRMED',
        isDemo: true,
        createdAt: now,
      },
      {
        id: 'edge-25',
        sourceId: 'task-e',
        targetId: 'person-kabir',
        relationshipType: 'ASSIGNED_TO',
        label: 'assigned to',
        provenance: 'Seeded Email (src-email-campus)',
        evidenceText: 'Kabir Verma owns GTFS feed parser.',
        sourceRecordId: 'src-email-campus',
        factStatus: 'CONFIRMED',
        isDemo: true,
        createdAt: now,
      },
      {
        id: 'edge-26',
        sourceId: 'meet-proj-review',
        targetId: 'proj-ai-research',
        relationshipType: 'RELATES_TO',
        label: 'reviews',
        provenance: 'Seeded Google Calendar (src-cal-review)',
        evidenceText:
          'Calendar event "Project Review: AI Research" scheduled for Thursday Nov 26 14:00.',
        sourceRecordId: 'src-cal-review',
        factStatus: 'CONFIRMED',
        isDemo: true,
        createdAt: now,
      },
      {
        id: 'edge-27',
        sourceId: 'person-rohan',
        targetId: 'meet-proj-review',
        relationshipType: 'ATTENDS',
        label: 'attends as reviewer',
        provenance: 'Seeded Google Calendar (src-cal-review)',
        evidenceText: 'Rohan Kulkarni is required reviewer on calendar invite.',
        sourceRecordId: 'src-cal-review',
        factStatus: 'CONFIRMED',
        isDemo: true,
        createdAt: now,
      },
      {
        id: 'edge-28',
        sourceId: 'person-ananya',
        targetId: 'meet-proj-review',
        relationshipType: 'ATTENDS',
        label: 'hosts',
        provenance: 'Seeded Google Calendar (src-cal-review)',
        evidenceText: 'Ananya Rao is organizer on calendar invite.',
        sourceRecordId: 'src-cal-review',
        factStatus: 'CONFIRMED',
        isDemo: true,
        createdAt: now,
      },
      {
        id: 'edge-29',
        sourceId: 'meet-campus-sync',
        targetId: 'proj-campus-sync',
        relationshipType: 'RELATES_TO',
        label: 'syncs',
        provenance: 'Seeded Email (src-email-campus)',
        evidenceText: 'Campus Mobility Sprint Sync on Friday Nov 27.',
        sourceRecordId: 'src-email-campus',
        factStatus: 'CONFIRMED',
        isDemo: true,
        createdAt: now,
      },
      {
        id: 'edge-30',
        sourceId: 'meet-q4-review',
        targetId: 'proj-q4-ops',
        relationshipType: 'RELATES_TO',
        label: 'reviews',
        provenance: 'Seeded Email (src-email-security)',
        evidenceText: 'Security Posture Sign-Off on Thursday Dec 3.',
        sourceRecordId: 'src-email-security',
        factStatus: 'CONFIRMED',
        isDemo: true,
        createdAt: now,
      },
      {
        id: 'edge-31',
        sourceId: 'doc-project-plan',
        targetId: 'proj-ai-research',
        relationshipType: 'RELATES_TO',
        label: 'documents',
        provenance: 'Seeded Document Extract (src-doc-plan)',
        evidenceText: 'Document states: "Final submission deadline is Friday, Nov 27, 2026."',
        sourceRecordId: 'src-doc-plan',
        factStatus: 'CONFIRMED',
        isDemo: true,
        createdAt: now,
      },
      {
        id: 'edge-32',
        sourceId: 'doc-project-plan',
        targetId: 'task-a',
        relationshipType: 'MENTIONS',
        label: 'mentions',
        provenance: 'Seeded Document Extract (src-doc-plan)',
        evidenceText: 'Section 2 references Task A research documentation deliverable.',
        sourceRecordId: 'src-doc-plan',
        factStatus: 'CONFIRMED',
        isDemo: true,
        createdAt: now,
      },
      {
        id: 'edge-33',
        sourceId: 'doc-project-plan',
        targetId: 'task-b',
        relationshipType: 'MENTIONS',
        label: 'mentions',
        provenance: 'Seeded Document Extract (src-doc-plan)',
        evidenceText: 'Section 2 references Task B peer review gate.',
        sourceRecordId: 'src-doc-plan',
        factStatus: 'CONFIRMED',
        isDemo: true,
        createdAt: now,
      },
      {
        id: 'edge-34',
        sourceId: 'doc-project-plan',
        targetId: 'task-c',
        relationshipType: 'MENTIONS',
        label: 'mentions',
        provenance: 'Inferred from Document Workstream Summary',
        evidenceText: 'Document references "executive presentation", matched to Task C.',
        sourceRecordId: 'src-doc-plan',
        factStatus: 'INFERRED',
        isDemo: true,
        createdAt: now,
      },
      {
        id: 'edge-35',
        sourceId: 'doc-campus-spec',
        targetId: 'proj-campus-sync',
        relationshipType: 'RELATES_TO',
        label: 'documents',
        provenance: 'Seeded Workspace Document',
        evidenceText: 'Architecture Spec references Campus Mobility Beta Freeze.',
        sourceRecordId: 'src-email-campus',
        factStatus: 'CONFIRMED',
        isDemo: true,
        createdAt: now,
      },
      {
        id: 'edge-36',
        sourceId: 'email-kickoff',
        targetId: 'dl-ai-research',
        relationshipType: 'SUPPORTS',
        label: 'confirms deadline',
        provenance: 'Seeded Email (src-email-kickoff)',
        evidenceText: 'Steering committee email established Friday Nov 27 submission deadline.',
        sourceRecordId: 'src-email-kickoff',
        factStatus: 'CONFIRMED',
        isDemo: true,
        createdAt: now,
      },
      {
        id: 'edge-37',
        sourceId: 'sr-node-tasks',
        targetId: 'task-b',
        relationshipType: 'SUPPORTS',
        label: 'evidences dependency',
        provenance: 'Seeded Google Tasks (src-tasks-sync)',
        evidenceText: 'Tasks snapshot recorded dependency Task B -> Task A.',
        sourceRecordId: 'src-tasks-sync',
        factStatus: 'CONFIRMED',
        isDemo: true,
        createdAt: now,
      },
    ];

    for (const e of edges) {
      insertEdge.run(
        e.id,
        DEMO_WORKSPACE_ID,
        e.sourceId,
        e.targetId,
        e.relationshipType,
        e.label,
        e.provenance,
        e.evidenceText,
        e.sourceRecordId,
        e.factStatus,
        1,
        e.createdAt,
      );
    }

    const insertAudit = db.prepare(`
      INSERT INTO audit_logs (
        id, workspace_id, approval_id, action_type, target_label, status, execution_mode,
        summary, details_json, actor, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const initialLog: AuditLogEntry = {
      id: 'audit-seed-1',
      workspaceId: DEMO_WORKSPACE_ID,
      approvalId: null,
      actionType: 'CONTEXT_BOOTSTRAP',
      targetLabel: 'Demo Living Context Graph (DEMO MODE)',
      status: 'SYSTEM',
      executionMode: 'INTERNAL',
      summary:
        'Initialized isolated DEMO MODE context graph with 3 projects, 9 tasks, 5 people, 3 meetings, 2 documents, and 6 source records.',
      details: { workspaceId: DEMO_WORKSPACE_ID, mode: 'DEMO_MODE', externalWrites: false },
      actor: 'maYa Context Engine',
      timestamp: now,
    };

    insertAudit.run(
      initialLog.id,
      DEMO_WORKSPACE_ID,
      initialLog.approvalId,
      initialLog.actionType,
      initialLog.targetLabel,
      initialLog.status,
      initialLog.executionMode,
      initialLog.summary,
      JSON.stringify(initialLog.details),
      initialLog.actor,
      initialLog.timestamp,
    );
  });

  tx();
}

export function initializeDatabase(): void {
  initializeSchema();
  migrateSchemaToMultiTenant();
  applyVersionedMigrations();
  seedWorkspaceIntegrations(DEMO_WORKSPACE_ID);

  const demoCount = db
    .prepare('SELECT COUNT(*) as count FROM nodes WHERE workspace_id = ?')
    .get(DEMO_WORKSPACE_ID) as { count: number };
  if (demoCount.count === 0) {
    resetAndSeedDemoData();
  }
}

export function getWorkspaceById(workspaceId: string): WorkspaceInfo | null {
  const row = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;
  return {
    id: String(row.id),
    ownerUserId: row.owner_user_id ? String(row.owner_user_id) : null,
    name: String(row.name),
    kind: row.kind as WorkspaceInfo['kind'],
    createdAt: String(row.created_at),
  };
}

export function mapNodeRow(row: Record<string, unknown>): ContextNode {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id ?? DEMO_WORKSPACE_ID),
    type: row.type as ContextNode['type'],
    title: String(row.title),
    subtitle: String(row.subtitle ?? ''),
    status: String(row.status),
    date: row.date ? String(row.date) : null,
    ownerId: row.owner_id ? String(row.owner_id) : null,
    projectId: row.project_id ? String(row.project_id) : null,
    metadata: JSON.parse(String(row.metadata_json ?? '{}')) as Record<string, unknown>,
    provenance: String(row.provenance),
    factStatus: row.fact_status as ContextNode['factStatus'],
    isDemo: Boolean(row.is_demo),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function mapEdgeRow(row: Record<string, unknown>): ContextEdge {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id ?? DEMO_WORKSPACE_ID),
    sourceId: String(row.source_id),
    targetId: String(row.target_id),
    relationshipType: row.relationship_type as ContextEdge['relationshipType'],
    label: String(row.label),
    provenance: String(row.provenance),
    evidenceText: String(row.evidence_text ?? ''),
    sourceRecordId: row.source_record_id ? String(row.source_record_id) : null,
    factStatus: row.fact_status as ContextEdge['factStatus'],
    isDemo: Boolean(row.is_demo),
    createdAt: String(row.created_at),
  };
}

export function mapSourceRow(row: Record<string, unknown>): SourceRecord {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id ?? DEMO_WORKSPACE_ID),
    sourceType: row.source_type as SourceRecord['sourceType'],
    externalId: row.external_id ? String(row.external_id) : null,
    sender: String(row.sender),
    title: String(row.title),
    content: String(row.content),
    receivedAt: String(row.received_at),
    parsedEntities: JSON.parse(String(row.parsed_entities_json ?? '{}')) as Record<string, unknown>,
    isDemo: Boolean(row.is_demo),
    processed: Boolean(row.processed),
  };
}

export function mapApprovalRow(row: Record<string, unknown>): ApprovalItem {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id ?? DEMO_WORKSPACE_ID),
    planId: String(row.plan_id),
    optionKey: row.option_key as 'A' | 'B',
    actionType: row.action_type as ApprovalItem['actionType'],
    targetNodeId: String(row.target_node_id),
    targetLabel: String(row.target_label),
    permissionScope: String(row.permission_scope),
    permissionValid: Boolean(row.permission_valid),
    permissionReason: String(row.permission_reason),
    proposedPayload: JSON.parse(String(row.proposed_payload_json ?? '{}')) as Record<string, unknown>,
    beforeState: JSON.parse(String(row.before_state_json ?? '{}')) as Record<string, unknown>,
    afterState: JSON.parse(String(row.after_state_json ?? '{}')) as Record<string, unknown>,
    rationale: String(row.rationale),
    status: row.status as ApprovalItem['status'],
    executionMode: row.execution_mode as ApprovalItem['executionMode'],
    decidedAt: row.decided_at ? String(row.decided_at) : null,
    decisionNote: row.decision_note ? String(row.decision_note) : null,
    createdAt: String(row.created_at),
  };
}

export function mapAuditRow(row: Record<string, unknown>): AuditLogEntry {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id ?? DEMO_WORKSPACE_ID),
    approvalId: row.approval_id ? String(row.approval_id) : null,
    actionType: String(row.action_type),
    targetLabel: String(row.target_label),
    status: row.status as AuditLogEntry['status'],
    executionMode: row.execution_mode as AuditLogEntry['executionMode'],
    summary: String(row.summary),
    details: JSON.parse(String(row.details_json ?? '{}')) as Record<string, unknown>,
    actor: String(row.actor),
    timestamp: String(row.timestamp),
  };
}
