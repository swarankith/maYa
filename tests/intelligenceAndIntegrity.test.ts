import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  applyVersionedMigrations,
  db,
  initializeDatabase,
} from '../src/server/db.ts';
import { registerUser, revokeSessionToken } from '../src/server/authService.ts';
import {
  createEdge,
  createNode,
  createSourceRecord,
  deleteSourceRecord,
  getAllAuditLogs,
  getAllEdges,
  getAllNodes,
  getNodeById,
  updateNode,
} from '../src/server/graphService.ts';
import { runRippleImpactAnalysis } from '../src/server/impactEngine.ts';
import { generateWhatIfPlans } from '../src/server/simulator.ts';
import { selectPlanAndQueueApprovals } from '../src/server/permissionsAndExecution.ts';
import {
  acceptExtractedItem,
  acceptSuggestedRelationship,
  rejectExtractedItem,
} from '../src/server/emailReviewService.ts';

async function main(): Promise<void> {
  initializeDatabase();

  const createdUserIds: string[] = [];
  const createdTokens: string[] = [];

  const createTestUser = (label: string) => {
    const suffix = randomUUID().slice(0, 8);
    const session = registerUser({
      email: `p3-${label}-${suffix}@maya-test.local`,
      password: 'StrongPhase3Password!123',
      displayName: `Phase3 ${label}`,
    });
    createdUserIds.push(session.user.id);
    createdTokens.push(session.token);
    return session;
  };

  try {
    // 1. Database referential integrity: FK enforcement, cascade on workspace delete, audit_logs preserved
    {
      const fkStatus = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
      assert.equal(fkStatus.foreign_keys, 1, 'PRAGMA foreign_keys must be ON');

      const mig = db.prepare('SELECT version, status FROM schema_migrations WHERE version = 1').get() as
        | { version: number; status: string }
        | undefined;
      assert.ok(mig, 'schema_migrations v1 must be recorded');

      const tempUser = createTestUser('cascade');
      const wsId = tempUser.workspace.id;
      const proj = createNode(wsId, { type: 'PROJECT', title: 'Cascade Project', date: '2026-12-10' });
      const task = createNode(wsId, { type: 'TASK', title: 'Cascade Task', projectId: proj.id });
      createEdge(wsId, { sourceId: task.id, targetId: proj.id, relationshipType: 'BELONGS_TO' });
      createSourceRecord(wsId, {
        sourceType: 'DOCUMENT',
        sender: 'tester',
        title: 'Cascade Doc',
        content: 'Doc body',
        projectId: proj.id,
      });

      const auditBefore = getAllAuditLogs(wsId).length;
      assert.ok(auditBefore >= 3);

      // Delete workspace -> workspace-owned tables cascade, audit_logs preserved
      db.prepare('DELETE FROM workspaces WHERE id = ?').run(wsId);
      assert.equal(getAllNodes(wsId).length, 0, 'nodes must cascade-delete with workspace');
      assert.equal(getAllEdges(wsId).length, 0, 'edges must cascade-delete with workspace');
      assert.equal(
        (db.prepare('SELECT COUNT(*) AS cnt FROM integrations WHERE workspace_id = ?').get(wsId) as { cnt: number }).cnt,
        0,
        'integrations must cascade-delete with workspace',
      );
      assert.equal(
        getAllAuditLogs(wsId).length,
        auditBefore,
        'audit_logs must be preserved when workspace is deleted',
      );
      db.prepare('DELETE FROM audit_logs WHERE workspace_id = ?').run(wsId);
      console.log('PASS [1/8]: Workspace FK cascade and audit_logs retention verified');
    }

    // 2. Versioned migration on isolated temp legacy DBs (clean upgrade + orphan preservation + idempotency)
    {
      const cleanPath = path.join(os.tmpdir(), `maya_mig_clean_${randomUUID().slice(0, 8)}.db`);
      const orphanPath = path.join(os.tmpdir(), `maya_mig_orphan_${randomUUID().slice(0, 8)}.db`);
      try {
        const cleanDb = new Database(cleanPath);
        cleanDb.exec(`
          CREATE TABLE workspaces (id TEXT PRIMARY KEY, owner_user_id TEXT, name TEXT NOT NULL, kind TEXT NOT NULL, created_at TEXT NOT NULL);
          CREATE TABLE nodes (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL, subtitle TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'Active', date TEXT, owner_id TEXT, project_id TEXT, metadata_json TEXT NOT NULL DEFAULT '{}', provenance TEXT NOT NULL, fact_status TEXT NOT NULL DEFAULT 'CONFIRMED', is_demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
          CREATE TABLE edges (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, source_id TEXT NOT NULL, target_id TEXT NOT NULL, relationship_type TEXT NOT NULL, label TEXT NOT NULL, provenance TEXT NOT NULL, evidence_text TEXT NOT NULL DEFAULT '', source_record_id TEXT, fact_status TEXT NOT NULL DEFAULT 'CONFIRMED', is_demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
          CREATE TABLE source_records (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, source_type TEXT NOT NULL, external_id TEXT, sender TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, received_at TEXT NOT NULL, parsed_entities_json TEXT NOT NULL DEFAULT '{}', is_demo INTEGER NOT NULL DEFAULT 0, processed INTEGER NOT NULL DEFAULT 1);
          CREATE TABLE impact_analyses (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, change_event_json TEXT NOT NULL, direct_impacts_json TEXT NOT NULL, downstream_impacts_json TEXT NOT NULL, unaffected_items_json TEXT NOT NULL, explanation_summary TEXT NOT NULL, ai_narrative TEXT, ai_status TEXT NOT NULL DEFAULT 'SKIPPED', created_at TEXT NOT NULL);
          CREATE TABLE what_if_plans (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, analysis_id TEXT NOT NULL, option_key TEXT NOT NULL, title TEXT NOT NULL, strategy_summary TEXT NOT NULL, proposed_changes_json TEXT NOT NULL, tasks_affected_json TEXT NOT NULL, meetings_affected_json TEXT NOT NULL, potential_conflicts_json TEXT NOT NULL, advantages_json TEXT NOT NULL, tradeoffs_json TEXT NOT NULL, requires_confirmation_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'PROPOSED');
          CREATE TABLE approvals (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, plan_id TEXT NOT NULL, option_key TEXT NOT NULL, action_type TEXT NOT NULL, target_node_id TEXT NOT NULL, target_label TEXT NOT NULL, permission_scope TEXT NOT NULL, permission_valid INTEGER NOT NULL DEFAULT 1, permission_reason TEXT NOT NULL, proposed_payload_json TEXT NOT NULL, before_state_json TEXT NOT NULL, after_state_json TEXT NOT NULL, rationale TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING', execution_mode TEXT NOT NULL DEFAULT 'SIMULATED_DEMO', decided_at TEXT, decision_note TEXT, created_at TEXT NOT NULL);
          CREATE TABLE integrations (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, service_key TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'DISCONNECTED', execution_policy TEXT NOT NULL, required_scopes_json TEXT NOT NULL, granted_scopes_json TEXT NOT NULL DEFAULT '[]', last_sync_at TEXT, setup_instructions_json TEXT NOT NULL, UNIQUE(workspace_id, service_key));
          CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL, details TEXT NOT NULL DEFAULT '', applied_at TEXT NOT NULL);
          INSERT INTO workspaces VALUES ('ws-1', NULL, 'WS 1', 'PERSONAL', '2026-11-26T00:00:00Z');
          INSERT INTO nodes VALUES ('n-1', 'ws-1', 'PROJECT', 'P1', '', 'Active', NULL, NULL, NULL, '{}', 'test', 'CONFIRMED', 0, '2026-11-26T00:00:00Z', '2026-11-26T00:00:00Z');
        `);
        // Also simulate legacy impact_analyses with workspace_id appended at the end (ALTER TABLE order),
        // one row with NULL ai_narrative and one row with NULL explanation_summary
        cleanDb.exec(`
          DROP TABLE impact_analyses;
          CREATE TABLE impact_analyses (
            id TEXT PRIMARY KEY,
            change_event_json TEXT NOT NULL,
            direct_impacts_json TEXT NOT NULL,
            downstream_impacts_json TEXT NOT NULL,
            unaffected_items_json TEXT NOT NULL,
            explanation_summary TEXT,
            ai_narrative TEXT,
            ai_status TEXT NOT NULL DEFAULT 'SKIPPED',
            created_at TEXT NOT NULL,
            workspace_id TEXT NOT NULL DEFAULT 'ws-demo'
          );
          INSERT INTO impact_analyses (
            id, change_event_json, direct_impacts_json, downstream_impacts_json,
            unaffected_items_json, explanation_summary, ai_narrative, ai_status, created_at, workspace_id
          ) VALUES
            ('imp-leg-1', '{"id":"c1"}', '[{"nodeId":"n-1"}]', '[]', '[]', 'Explicit summary', NULL, 'SKIPPED', '2026-11-26T01:00:00Z', 'ws-1'),
            ('imp-leg-2', '{"id":"c2"}', '[]', '[]', '[]', NULL, NULL, 'UNAVAILABLE', '2026-11-26T02:00:00Z', 'ws-1');
        `);
        const res1 = applyVersionedMigrations(cleanDb);
        assert.equal(res1.status, 'APPLIED');
        assert.equal(res1.migratedTables.length, 7);

        const migratedAnalyses = cleanDb
          .prepare('SELECT * FROM impact_analyses ORDER BY id ASC')
          .all() as Array<Record<string, unknown>>;
        assert.equal(migratedAnalyses.length, 2);
        assert.equal(migratedAnalyses[0].workspace_id, 'ws-1');
        assert.equal(migratedAnalyses[0].explanation_summary, 'Explicit summary');
        assert.equal(migratedAnalyses[0].ai_narrative, null);
        assert.equal(migratedAnalyses[0].created_at, '2026-11-26T01:00:00Z');
        assert.equal(migratedAnalyses[1].workspace_id, 'ws-1');
        assert.equal(
          migratedAnalyses[1].explanation_summary,
          'Legacy impact analysis record (summary unavailable).',
        );
        assert.equal(migratedAnalyses[1].created_at, '2026-11-26T02:00:00Z');

        const res2 = applyVersionedMigrations(cleanDb);
        assert.equal(res2.status, 'ALREADY_APPLIED', 'Migration must be idempotent');
        cleanDb.close();

        const orphanDb = new Database(orphanPath);
        orphanDb.exec(`
          CREATE TABLE workspaces (id TEXT PRIMARY KEY, owner_user_id TEXT, name TEXT NOT NULL, kind TEXT NOT NULL, created_at TEXT NOT NULL);
          CREATE TABLE nodes (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL, subtitle TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'Active', date TEXT, owner_id TEXT, project_id TEXT, metadata_json TEXT NOT NULL DEFAULT '{}', provenance TEXT NOT NULL, fact_status TEXT NOT NULL DEFAULT 'CONFIRMED', is_demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
          CREATE TABLE edges (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, source_id TEXT NOT NULL, target_id TEXT NOT NULL, relationship_type TEXT NOT NULL, label TEXT NOT NULL, provenance TEXT NOT NULL, evidence_text TEXT NOT NULL DEFAULT '', source_record_id TEXT, fact_status TEXT NOT NULL DEFAULT 'CONFIRMED', is_demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
          CREATE TABLE source_records (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, source_type TEXT NOT NULL, external_id TEXT, sender TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, received_at TEXT NOT NULL, parsed_entities_json TEXT NOT NULL DEFAULT '{}', is_demo INTEGER NOT NULL DEFAULT 0, processed INTEGER NOT NULL DEFAULT 1);
          CREATE TABLE impact_analyses (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, change_event_json TEXT NOT NULL, direct_impacts_json TEXT NOT NULL, downstream_impacts_json TEXT NOT NULL, unaffected_items_json TEXT NOT NULL, explanation_summary TEXT NOT NULL, ai_narrative TEXT, ai_status TEXT NOT NULL DEFAULT 'SKIPPED', created_at TEXT NOT NULL);
          CREATE TABLE what_if_plans (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, analysis_id TEXT NOT NULL, option_key TEXT NOT NULL, title TEXT NOT NULL, strategy_summary TEXT NOT NULL, proposed_changes_json TEXT NOT NULL, tasks_affected_json TEXT NOT NULL, meetings_affected_json TEXT NOT NULL, potential_conflicts_json TEXT NOT NULL, advantages_json TEXT NOT NULL, tradeoffs_json TEXT NOT NULL, requires_confirmation_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'PROPOSED');
          CREATE TABLE approvals (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, plan_id TEXT NOT NULL, option_key TEXT NOT NULL, action_type TEXT NOT NULL, target_node_id TEXT NOT NULL, target_label TEXT NOT NULL, permission_scope TEXT NOT NULL, permission_valid INTEGER NOT NULL DEFAULT 1, permission_reason TEXT NOT NULL, proposed_payload_json TEXT NOT NULL, before_state_json TEXT NOT NULL, after_state_json TEXT NOT NULL, rationale TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING', execution_mode TEXT NOT NULL DEFAULT 'SIMULATED_DEMO', decided_at TEXT, decision_note TEXT, created_at TEXT NOT NULL);
          CREATE TABLE integrations (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, service_key TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'DISCONNECTED', execution_policy TEXT NOT NULL, required_scopes_json TEXT NOT NULL, granted_scopes_json TEXT NOT NULL DEFAULT '[]', last_sync_at TEXT, setup_instructions_json TEXT NOT NULL, UNIQUE(workspace_id, service_key));
          CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL, details TEXT NOT NULL DEFAULT '', applied_at TEXT NOT NULL);
          INSERT INTO nodes VALUES ('n-orphan', 'ws-missing', 'PROJECT', 'Orphan', '', 'Active', NULL, NULL, NULL, '{}', 'test', 'CONFIRMED', 0, '2026-11-26T00:00:00Z', '2026-11-26T00:00:00Z');
        `);
        const orphanRes = applyVersionedMigrations(orphanDb);
        assert.equal(orphanRes.status, 'PARTIAL_ORPHANS_PRESERVED');
        assert.ok(orphanRes.skippedTables.some((s) => s.startsWith('nodes(')));
        const keptCount = (orphanDb.prepare('SELECT COUNT(*) AS cnt FROM nodes').get() as { cnt: number }).cnt;
        assert.equal(keptCount, 1, 'Migration must NEVER delete existing orphaned rows');
        orphanDb.close();
      } finally {
        for (const p of [cleanPath, orphanPath]) {
          for (const suf of ['', '-shm', '-wal']) {
            if (fs.existsSync(`${p}${suf}`)) fs.rmSync(`${p}${suf}`, { force: true });
          }
        }
      }
      console.log('PASS [2/8]: Versioned migrations upgrade cleanly, stay idempotent, and preserve orphans');
    }

    // 3. Living Context Graph: CRUD, duplicate edge prevention, provenance, deleted source handling, isolation
    {
      const userA = createTestUser('graphA');
      const userB = createTestUser('graphB');
      const wsA = userA.workspace.id;
      const wsB = userB.workspace.id;

      const projA = createNode(wsA, { type: 'PROJECT', title: 'Alpha Launch', date: '2026-12-10' });
      const taskA = createNode(wsA, { type: 'TASK', title: 'Draft Spec', projectId: projA.id, date: '2026-12-08' });
      const updated = updateNode(wsA, taskA.id, { status: 'In Progress' });
      assert.equal(updated?.status, 'In Progress');

      const src = createSourceRecord(wsA, {
        sourceType: 'EMAIL',
        sender: 'pm@example.com',
        title: 'Spec Kickoff',
        content: 'Draft Spec belongs to Alpha Launch.',
        projectId: projA.id,
      });

      const edge = createEdge(wsA, {
        sourceId: taskA.id,
        targetId: projA.id,
        relationshipType: 'BELONGS_TO',
        sourceRecordId: src.id,
        evidenceText: 'Draft Spec belongs to Alpha Launch.',
      });
      assert.equal(edge.sourceRecordId, src.id);

      assert.throws(
        () =>
          createEdge(wsA, {
            sourceId: taskA.id,
            targetId: projA.id,
            relationshipType: 'BELONGS_TO',
          }),
        /already exists/i,
        'Duplicate relationship must be prevented',
      );

      // Cross-workspace isolation
      const projB = createNode(wsB, { type: 'PROJECT', title: 'Beta Secret' });
      assert.equal(getNodeById(wsB, projA.id), null);
      assert.throws(
        () =>
          createEdge(wsA, {
            sourceId: taskA.id,
            targetId: projB.id,
            relationshipType: 'RELATES_TO',
          }),
        /active workspace/i,
      );

      // Deleted source record still allows graph queries gracefully
      assert.equal(deleteSourceRecord(wsA, src.id), true);
      assert.ok(getAllNodes(wsA).length >= 2);
      console.log('PASS [3/8]: Living Context Graph CRUD, duplicate guard, provenance, and isolation verified');
    }

    // 4 & 5. Ripple Impact Engine: direct, downstream BFS, INFERRED propagation, cycle safety, missing links, isolation
    {
      const user = createTestUser('impact');
      const wsId = user.workspace.id;

      const proj = createNode(wsId, { type: 'PROJECT', title: 'Q4 Launch', date: '2026-12-10' });
      const dl = createNode(wsId, {
        type: 'DEADLINE',
        title: 'Launch Cutoff',
        date: '2026-12-10T17:00',
        projectId: proj.id,
      });
      createEdge(wsId, { sourceId: dl.id, targetId: proj.id, relationshipType: 'BELONGS_TO' });

      const t1 = createNode(wsId, { type: 'TASK', title: 'Write Docs', date: '2026-12-09T10:00', projectId: proj.id });
      const t2 = createNode(wsId, { type: 'TASK', title: 'Review Docs', date: '2026-12-09T15:00', projectId: proj.id });
      createEdge(wsId, { sourceId: t1.id, targetId: proj.id, relationshipType: 'BELONGS_TO' });
      createEdge(wsId, { sourceId: t2.id, targetId: proj.id, relationshipType: 'BELONGS_TO' });
      // Create a DEPENDS_ON cycle (t2 -> t1 and t1 -> t2) with INFERRED edge to test cycle safety + factStatus
      createEdge(wsId, { sourceId: t2.id, targetId: t1.id, relationshipType: 'DEPENDS_ON', factStatus: 'INFERRED' });
      createEdge(wsId, { sourceId: t1.id, targetId: t2.id, relationshipType: 'DEPENDS_ON', factStatus: 'CONFIRMED' });

      const src = createSourceRecord(wsId, {
        sourceType: 'EMAIL',
        sender: 'exec@example.com',
        title: 'Urgent: Move Q4 Launch to Dec 8',
        content: 'Q4 Launch moved to Dec 8.',
        projectId: proj.id,
      });

      // Because both t1 and t2 have DEPENDS_ON edges, test direct + downstream with a root task t0
      const t0 = createNode(wsId, { type: 'TASK', title: 'Freeze API', date: '2026-12-09T09:00', projectId: proj.id });
      createEdge(wsId, { sourceId: t0.id, targetId: proj.id, relationshipType: 'BELONGS_TO' });
      createEdge(wsId, { sourceId: t1.id, targetId: t0.id, relationshipType: 'DEPENDS_ON' });

      const analysis = await runRippleImpactAnalysis(wsId, {
        projectId: proj.id,
        newDeadlineIso: '2026-12-08T17:00',
        sourceRecord: src,
        extractionMethod: 'DIRECT_USER_UPDATE',
        extractionNote: 'Test deadline compression',
      });

      assert.ok(analysis.directImpacts.some((d) => d.nodeId === dl.id));
      assert.ok(analysis.directImpacts.some((d) => d.nodeId === t0.id));
      const t1Impact = analysis.downstreamImpacts.find((d) => d.nodeId === t1.id);
      const t2Impact = analysis.downstreamImpacts.find((d) => d.nodeId === t2.id);
      assert.ok(t1Impact, 't1 must be impacted downstream of t0');
      assert.ok(t2Impact, 't2 must be impacted downstream of t1 without infinite cycle loop');
      assert.equal(t2Impact.factStatus, 'INFERRED', 'INFERRED edge must propagate INFERRED factStatus');

      // No duplicate impacted nodeIds across direct + downstream
      const allImpactedIds = [...analysis.directImpacts, ...analysis.downstreamImpacts].map((i) => i.nodeId);
      assert.equal(new Set(allImpactedIds).size, allImpactedIds.length, 'Must not emit duplicate impacted nodes');

      // Cross-workspace impact analysis must fail cleanly
      const otherUser = createTestUser('impactOther');
      await assert.rejects(
        () =>
          runRippleImpactAnalysis(otherUser.workspace.id, {
            projectId: proj.id,
            newDeadlineIso: '2026-12-08',
            sourceRecord: src,
            extractionMethod: 'DIRECT_USER_UPDATE',
            extractionNote: 'Cross-ws attempt',
          }),
        /not found/i,
      );
      console.log('PASS [4/8]: Ripple Impact Engine direct/downstream propagation, cycle safety, and isolation verified');
    }

    // 6. What-If Simulator: non-mutating, reproducible, workspace-isolated
    {
      const user = createTestUser('sim');
      const wsId = user.workspace.id;
      const proj = createNode(wsId, { type: 'PROJECT', title: 'Sim Project', date: '2026-12-10' });
      const task = createNode(wsId, { type: 'TASK', title: 'Sim Task', date: '2026-12-09T12:00', projectId: proj.id });
      createEdge(wsId, { sourceId: task.id, targetId: proj.id, relationshipType: 'BELONGS_TO' });
      const src = createSourceRecord(wsId, {
        sourceType: 'SYSTEM',
        sender: 'tester',
        title: 'Shift',
        content: 'Move to Dec 7',
        projectId: proj.id,
      });

      const analysis = await runRippleImpactAnalysis(wsId, {
        projectId: proj.id,
        newDeadlineIso: '2026-12-07T17:00',
        sourceRecord: src,
        extractionMethod: 'DIRECT_USER_UPDATE',
        extractionNote: 'Sim test',
      });

      const plans1 = generateWhatIfPlans(wsId, analysis);
      const plans2 = generateWhatIfPlans(wsId, analysis);
      assert.equal(plans1.length, 2);
      assert.equal(plans1[0].optionKey, 'A');
      assert.equal(plans1[1].optionKey, 'B');
      assert.deepEqual(plans1[0].proposedChanges, plans2[0].proposedChanges, 'Simulator must be reproducible');
      // Confirmed node date must remain unchanged until user approves!
      assert.equal(getNodeById(wsId, task.id)?.date, '2026-12-09T12:00', 'Simulator must NOT mutate workspace nodes');

      const other = createTestUser('simOther');
      assert.throws(
        () => selectPlanAndQueueApprovals(other.workspace.id, plans1[0].id, 'Intruder'),
        /not found/i,
      );
      console.log('PASS [5/8]: What-If Simulator non-mutating, reproducible, and workspace-isolated');
    }

    // 7 & 8. Email Review & Approval: provenance, reject leaves context clean, accept updates graph & prevents dupes
    {
      const user = createTestUser('review');
      const wsId = user.workspace.id;
      const now = new Date().toISOString();

      db.prepare(`
        INSERT INTO gmail_messages (
          id, workspace_id, gmail_message_id, thread_id, history_id, sender, recipients_json,
          subject, snippet, body_text, received_at, source_record_id, extraction_status, created_at
        ) VALUES (?, ?, ?, ?, '1', 'alice@example.com', '[]', 'Release Plan', 'Snippet', 'Body', ?, NULL, 'COMPLETED', ?)
      `).run('gm-rev-1', wsId, 'gmail-rev-1', 'thr-1', now, now);

      db.prepare(`
        INSERT INTO email_extracted_items (
          id, workspace_id, message_row_id, gmail_message_id, item_type, title, description,
          proposed_date, date_ambiguous, fact_status, match_classification, evidence_quote, status, created_at
        ) VALUES (?, ?, 'gm-rev-1', 'gmail-rev-1', 'PROJECT', 'Atlas Release', 'Launch Atlas', '2026-12-15', 0, 'CONFIRMED', 'NEW', 'Atlas Release on Dec 15.', 'PENDING', ?)
      `).run('eitem-proj', wsId, now);

      db.prepare(`
        INSERT INTO email_extracted_items (
          id, workspace_id, message_row_id, gmail_message_id, item_type, title, description,
          proposed_date, date_ambiguous, fact_status, match_classification, evidence_quote, status, created_at
        ) VALUES (?, ?, 'gm-rev-1', 'gmail-rev-1', 'TASK', 'Rejected Rumor Task', 'Do not add', NULL, 1, 'INFERRED', 'NEW', 'Maybe do something.', 'PENDING', ?)
      `).run('eitem-rej', wsId, now);

      db.prepare(`
        INSERT INTO email_extracted_items (
          id, workspace_id, message_row_id, gmail_message_id, item_type, title, description,
          proposed_date, date_ambiguous, fact_status, match_classification, evidence_quote, status, created_at
        ) VALUES (?, ?, 'gm-rev-1', 'gmail-rev-1', 'TASK', 'Finalize Atlas Docs', 'Docs', '2026-12-12', 0, 'CONFIRMED', 'NEW', 'Finalize Atlas Docs by Dec 12.', 'PENDING', ?)
      `).run('eitem-task', wsId, now);

      db.prepare(`
        INSERT INTO email_suggested_relationships (
          id, workspace_id, message_row_id, source_item_id, source_label, target_item_id, target_label,
          relationship_type, rationale, evidence_quote, fact_status, status, created_at
        ) VALUES (?, ?, 'gm-rev-1', 'eitem-task', 'Finalize Atlas Docs', 'eitem-proj', 'Atlas Release', 'BELONGS_TO', 'Task belongs to project', 'Finalize Atlas Docs for Atlas Release.', 'CONFIRMED', 'PENDING', ?)
      `).run('erel-1', wsId, now);

      // Rejecting rumor task must not add any node
      const rejected = rejectExtractedItem(wsId, 'eitem-rej', user.user.displayName);
      assert.equal(rejected.status, 'REJECTED');
      assert.equal(getAllNodes(wsId).length, 0);

      // Accepting project & task creates nodes with Gmail provenance
      const accProj = acceptExtractedItem(wsId, 'eitem-proj', undefined, user.user.displayName);
      const accTask = acceptExtractedItem(wsId, 'eitem-task', undefined, user.user.displayName);
      assert.ok(accProj.node.provenance.includes('Gmail: Release Plan'));
      assert.equal(accProj.item.status, 'ACCEPTED');

      // Re-accepting already accepted item must fail cleanly
      assert.throws(() => acceptExtractedItem(wsId, 'eitem-proj'), /already been accepted/i);

      // Accepting suggested relationship creates edge and links cleanly
      const accRel = acceptSuggestedRelationship(wsId, 'erel-1', undefined, user.user.displayName);
      assert.equal(accRel.relationship.status, 'ACCEPTED');
      assert.equal(getAllEdges(wsId).length, 1);

      const auditActions = getAllAuditLogs(wsId).map((l) => l.actionType);
      assert.ok(auditActions.includes('EMAIL_INSIGHT_REJECTED'));
      assert.ok(auditActions.includes('EMAIL_INSIGHT_ACCEPTED'));
      assert.ok(auditActions.includes('EMAIL_RELATIONSHIP_ACCEPTED'));
      console.log('PASS [6/8]: Email review accept/reject provenance, duplicate guard, and audit trail verified');

      // Also verify approving a second suggested relationship for the same edge reuses existing edge instead of duplicating
      db.prepare(`
        INSERT INTO email_suggested_relationships (
          id, workspace_id, message_row_id, source_node_id, source_label, target_node_id, target_label,
          relationship_type, rationale, evidence_quote, fact_status, status, created_at
        ) VALUES (?, ?, 'gm-rev-1', ?, 'Finalize Atlas Docs', ?, 'Atlas Release', 'BELONGS_TO', 'Duplicate suggestion', 'Finalize Atlas Docs for Atlas Release.', 'CONFIRMED', 'PENDING', ?)
      `).run('erel-dup', wsId, accTask.node.id, accProj.node.id, now);
      const dupRel = acceptSuggestedRelationship(wsId, 'erel-dup', undefined, user.user.displayName);
      assert.equal(dupRel.edgeId, accRel.edgeId, 'Duplicate suggested relationship must reuse existing edge');
      assert.equal(getAllEdges(wsId).length, 1);
      console.log('PASS [7/8]: Duplicate suggested relationship reuse prevents duplicate edges');
      console.log('PASS [8/8]: All Phase 3 data integrity and intelligence engine checks passed');
    }
  } finally {
    for (const token of createdTokens) {
      try {
        revokeSessionToken(token);
      } catch {
        // ignore
      }
    }
    for (const userId of createdUserIds) {
      db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    }
  }
}

main().catch((err) => {
  console.error('PHASE 3 TEST SUITE FAILED:', err);
  process.exit(1);
});
