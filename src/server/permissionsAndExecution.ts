import { randomUUID } from 'node:crypto';
import { DEMO_WORKSPACE_ID, db, mapApprovalRow } from './db.ts';
import {
  getIntegrations,
  getNodeById,
  recordAuditLog,
  updateNode,
} from './graphService.ts';
import { formatFriendlyDate } from './impactEngine.ts';
import type { ApprovalItem, WhatIfPlan } from '../types/maya.ts';

const ALLOWED_LOCAL_SCOPES = new Set([
  'local.context.write',
  'tasks.write',
  'calendar.events',
  'workspace.docs.write',
  'gmail.compose',
]);

const GMAIL_COMPOSE_SCOPE = 'https://www.googleapis.com/auth/gmail.compose';
const CALENDAR_EVENTS_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const TASKS_WRITE_SCOPE = 'https://www.googleapis.com/auth/tasks';

function getGrantedGmailScopes(workspaceId: string): { connected: boolean; scopes: string[] } {
  const row = db
    .prepare('SELECT status, scopes_json FROM gmail_connections WHERE workspace_id = ?')
    .get(workspaceId) as { status: string; scopes_json: string } | undefined;
  if (!row || row.status !== 'CONNECTED') {
    return { connected: false, scopes: [] };
  }
  try {
    const parsed = JSON.parse(String(row.scopes_json ?? '[]'));
    return {
      connected: true,
      scopes: Array.isArray(parsed) ? parsed.map((s) => String(s)) : [],
    };
  } catch {
    return { connected: true, scopes: [] };
  }
}

export function validatePermissionForScope(
  workspaceId: string,
  scope: string,
): {
  valid: boolean;
  executionMode: ApprovalItem['executionMode'];
  reason: string;
} {
  const isDemo = workspaceId === DEMO_WORKSPACE_ID;
  const integrations = getIntegrations(workspaceId);
  const calConnector = integrations.find((i) => i.serviceKey === 'google_calendar');
  const tasksConnector = integrations.find((i) => i.serviceKey === 'google_tasks');
  const gmailConn = getGrantedGmailScopes(workspaceId);

  const calHasWriteScope =
    calConnector?.status === 'CONNECTED' &&
    calConnector.grantedScopes.includes(CALENDAR_EVENTS_SCOPE);
  const tasksHasWriteScope =
    tasksConnector?.status === 'CONNECTED' &&
    tasksConnector.grantedScopes.includes(TASKS_WRITE_SCOPE);
  const gmailHasComposeScope =
    gmailConn.connected && gmailConn.scopes.includes(GMAIL_COMPOSE_SCOPE);

  if (!ALLOWED_LOCAL_SCOPES.has(scope)) {
    return {
      valid: false,
      executionMode: 'UNSUPPORTED',
      reason: `Scope "${scope}" is outside the permitted action policy.`,
    };
  }

  if (scope === 'gmail.compose') {
    if (isDemo) {
      return {
        valid: true,
        executionMode: 'SIMULATED_DEMO',
        reason:
          'DEMO MODE: Gmail compose is not connected. Policy permits local simulated notification draft only (no email sent or drafted in Gmail).',
      };
    }
    if (!gmailHasComposeScope) {
      return {
        valid: false,
        executionMode: 'UNSUPPORTED',
        reason: gmailConn.connected
          ? 'Gmail compose is unavailable: connected account only granted read-only scope (gmail.readonly); gmail.compose scope is not granted.'
          : 'Gmail compose is unavailable: required gmail.compose OAuth scope is not granted.',
      };
    }
    return {
      valid: false,
      executionMode: 'UNSUPPORTED',
      reason:
        'Gmail draft creation is currently unsupported: no real Gmail compose execution handler is enabled.',
    };
  }

  if (scope === 'calendar.events' && calHasWriteScope) {
    return {
      valid: true,
      executionMode: 'LOCAL_WORKSPACE',
      reason:
        'Calendar scope granted, but external Calendar write handler is not yet enabled; updates local workspace only.',
    };
  }
  if (scope === 'tasks.write' && tasksHasWriteScope) {
    return {
      valid: true,
      executionMode: 'LOCAL_WORKSPACE',
      reason:
        'Tasks scope granted, but external Tasks write handler is not yet enabled; updates local workspace only.',
    };
  }

  if (isDemo) {
    return {
      valid: true,
      executionMode: 'SIMULATED_DEMO',
      reason: `DEMO MODE: External OAuth disconnected. Policy permits local DEMO DATA simulation for "${scope}" after explicit approval.`,
    };
  }

  return {
    valid: true,
    executionMode: 'LOCAL_WORKSPACE',
    reason: `External OAuth disconnected. Policy permits updating your private SQLite workspace for "${scope}" after explicit approval; external services are not mutated.`,
  };
}

export function selectPlanAndQueueApprovals(
  workspaceId: string,
  planId: string,
  actorName = 'Workspace User',
): ApprovalItem[] {
  const planRow = db
    .prepare('SELECT * FROM what_if_plans WHERE id = ? AND workspace_id = ?')
    .get(planId, workspaceId) as Record<string, unknown> | undefined;

  if (!planRow) {
    throw new Error(`What-if plan "${planId}" not found in your active workspace.`);
  }

  const analysisId = String(planRow.analysis_id);
  const optionKey = planRow.option_key as 'A' | 'B';
  const proposedChanges = JSON.parse(
    String(planRow.proposed_changes_json),
  ) as WhatIfPlan['proposedChanges'];

  const now = new Date().toISOString();

  const tx = db.transaction(() => {
    db.prepare(
      'UPDATE what_if_plans SET status = ? WHERE analysis_id = ? AND workspace_id = ? AND id != ?',
    ).run('DISCARDED', analysisId, workspaceId, planId);
    db.prepare('UPDATE what_if_plans SET status = ? WHERE id = ? AND workspace_id = ?').run(
      'SELECTED',
      planId,
      workspaceId,
    );

    db.prepare("DELETE FROM approvals WHERE status = 'PENDING' AND workspace_id = ?").run(
      workspaceId,
    );

    const insertApproval = db.prepare(`
      INSERT INTO approvals (
        id, workspace_id, plan_id, option_key, action_type, target_node_id, target_label,
        permission_scope, permission_valid, permission_reason, proposed_payload_json,
        before_state_json, after_state_json, rationale, status, execution_mode,
        decided_at, decision_note, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const change of proposedChanges) {
      const check = validatePermissionForScope(workspaceId, change.permissionScope);
      const itemId = `apr-${randomUUID().slice(0, 10)}`;

      insertApproval.run(
        itemId,
        workspaceId,
        planId,
        optionKey,
        change.actionType,
        change.targetNodeId,
        change.targetTitle,
        change.permissionScope,
        check.valid ? 1 : 0,
        check.reason,
        JSON.stringify({
          field: change.field,
          afterValue: change.afterValue,
        }),
        JSON.stringify({ [change.field]: change.beforeValue }),
        JSON.stringify({ [change.field]: change.afterValue }),
        change.rationale,
        'PENDING',
        check.executionMode,
        null,
        null,
        now,
      );
    }
  });

  tx();

  recordAuditLog(workspaceId, {
    actionType: 'PLAN_SELECTED_FOR_APPROVAL',
    targetLabel: `${String(planRow.title)}`,
    status: 'SIMULATED_PLAN',
    executionMode: 'INTERNAL',
    summary: `Selected Option ${optionKey} and staged ${proposedChanges.length} proposed action(s) in the human approval queue. Zero writes executed yet.`,
    details: { planId, optionKey, actionCount: proposedChanges.length },
    actor: actorName,
  });

  const rows = db
    .prepare('SELECT * FROM approvals WHERE plan_id = ? AND workspace_id = ? ORDER BY created_at ASC')
    .all(planId, workspaceId) as Record<string, unknown>[];
  return rows.map(mapApprovalRow);
}

export function executeApprovedAction(
  workspaceId: string,
  approvalId: string,
  decisionNote?: string,
  actorName = 'Workspace User',
): ApprovalItem {
  const row = db
    .prepare('SELECT * FROM approvals WHERE id = ? AND workspace_id = ?')
    .get(approvalId, workspaceId) as Record<string, unknown> | undefined;
  if (!row) {
    throw new Error(`Approval item "${approvalId}" not found in your active workspace.`);
  }

  const approval = mapApprovalRow(row);
  if (approval.status !== 'PENDING') {
    throw new Error(`Approval "${approvalId}" has already been ${approval.status.toLowerCase()}.`);
  }
  if (!approval.permissionValid || approval.executionMode === 'UNSUPPORTED') {
    throw new Error(`Permission check failed: ${approval.permissionReason}`);
  }
  if (approval.executionMode === 'LIVE_OAUTH') {
    throw new Error(
      `Live OAuth execution for "${approval.actionType}" is not enabled; external Google API writes are disabled.`,
    );
  }

  const now = new Date().toISOString();
  const field = String(approval.proposedPayload.field ?? 'date');
  const afterValue = String(approval.proposedPayload.afterValue ?? '');
  const modeLabel =
    approval.executionMode === 'SIMULATED_DEMO' || approval.executionMode === 'SIMULATED_LOCAL'
      ? 'Simulated'
      : 'Workspace Approved';

  if (approval.actionType === 'SEND_NOTIFICATION_DRAFT') {
    if (approval.executionMode !== 'SIMULATED_DEMO' && approval.executionMode !== 'SIMULATED_LOCAL') {
      throw new Error(
        'Gmail draft creation is unsupported: no real Gmail compose execution handler is enabled.',
      );
    }
  } else {
    const targetNode = getNodeById(workspaceId, approval.targetNodeId);
    if (targetNode) {
      if (approval.actionType === 'UPDATE_DEADLINE') {
        updateNode(workspaceId, targetNode.id, {
          date: afterValue,
          subtitle: `${formatFriendlyDate(afterValue)} · Updated via Approved Plan`,
          status: `Updated (${modeLabel})`,
          provenance: `Approved Action (${approval.id})`,
        });
        if (targetNode.projectId) {
          const proj = getNodeById(workspaceId, targetNode.projectId);
          if (proj) {
            updateNode(workspaceId, proj.id, {
              date: afterValue.slice(0, 10),
              status: `Aligned (${modeLabel})`,
            });
          }
        }
      } else if (
        approval.actionType === 'UPDATE_TASK_DUE_DATE' ||
        approval.actionType === 'RESCHEDULE_MEETING'
      ) {
        updateNode(workspaceId, targetNode.id, {
          date: afterValue,
          subtitle: `${formatFriendlyDate(afterValue)} · Rescheduled (${modeLabel})`,
          status: `Rescheduled (${modeLabel})`,
          provenance: `Approved Action (${approval.id})`,
        });
      } else if (approval.actionType === 'UPDATE_DOCUMENT_TEXT') {
        updateNode(workspaceId, targetNode.id, {
          date: afterValue,
          subtitle: `Updated deadline reference: ${formatFriendlyDate(afterValue)}`,
          status: `Revised (${modeLabel})`,
          metadata: {
            referencedDeadline: afterValue.slice(0, 10),
            referencedDeadlineText: formatFriendlyDate(afterValue),
          },
          provenance: `Approved Action (${approval.id})`,
        });
      } else if (approval.actionType === 'REASSIGN_TASK') {
        updateNode(workspaceId, targetNode.id, {
          subtitle: `Assignee updated: ${afterValue} (${modeLabel})`,
          status: `Reassigned (${modeLabel})`,
          metadata: { coReviewers: afterValue },
        });
      }
    }
  }

  db.prepare(
    'UPDATE approvals SET status = ?, decided_at = ?, decision_note = ? WHERE id = ? AND workspace_id = ?',
  ).run(
    'APPROVED',
    now,
    decisionNote ??
      (approval.actionType === 'SEND_NOTIFICATION_DRAFT'
        ? 'Approved in simulation mode only; no email drafted or sent in Gmail.'
        : 'Approved by user in Controlled Execution queue.'),
    approvalId,
    workspaceId,
  );

  const updatedRow = db
    .prepare('SELECT * FROM approvals WHERE id = ? AND workspace_id = ?')
    .get(approvalId, workspaceId) as Record<string, unknown>;
  const updated = mapApprovalRow(updatedRow);

  const auditSummary =
    approval.actionType === 'SEND_NOTIFICATION_DRAFT'
      ? `[${updated.executionMode}] Simulated notification draft only (no email sent or drafted in Gmail) for "${updated.targetLabel}".`
      : `[${updated.executionMode}] Executed ${updated.actionType} on "${updated.targetLabel}": ${JSON.stringify(
          updated.beforeState,
        )} -> ${JSON.stringify(updated.afterState)}.`;

  recordAuditLog(workspaceId, {
    approvalId: updated.id,
    actionType: updated.actionType,
    targetLabel: updated.targetLabel,
    status: 'EXECUTED_SIMULATED',
    executionMode: updated.executionMode,
    summary: auditSummary,
    details: {
      field,
      before: updated.beforeState,
      after: updated.afterState,
      permissionScope: updated.permissionScope,
      decisionNote: updated.decisionNote,
    },
    actor: `${actorName} (Explicit Approval)`,
  });

  return updated;
}

export function rejectApprovalAction(
  workspaceId: string,
  approvalId: string,
  decisionNote?: string,
  actorName = 'Workspace User',
): ApprovalItem {
  const row = db
    .prepare('SELECT * FROM approvals WHERE id = ? AND workspace_id = ?')
    .get(approvalId, workspaceId) as Record<string, unknown> | undefined;
  if (!row) {
    throw new Error(`Approval item "${approvalId}" not found in your active workspace.`);
  }

  const approval = mapApprovalRow(row);
  if (approval.status !== 'PENDING') {
    throw new Error(`Approval "${approvalId}" has already been ${approval.status.toLowerCase()}.`);
  }

  const now = new Date().toISOString();
  db.prepare(
    'UPDATE approvals SET status = ?, decided_at = ?, decision_note = ? WHERE id = ? AND workspace_id = ?',
  ).run(
    'REJECTED',
    now,
    decisionNote ?? 'Rejected by user; no changes applied.',
    approvalId,
    workspaceId,
  );

  const updatedRow = db
    .prepare('SELECT * FROM approvals WHERE id = ? AND workspace_id = ?')
    .get(approvalId, workspaceId) as Record<string, unknown>;
  const updated = mapApprovalRow(updatedRow);

  recordAuditLog(workspaceId, {
    approvalId: updated.id,
    actionType: updated.actionType,
    targetLabel: updated.targetLabel,
    status: 'REJECTED',
    executionMode: updated.executionMode,
    summary: `Rejected proposed ${updated.actionType} on "${updated.targetLabel}". Context state preserved.`,
    details: {
      before: updated.beforeState,
      proposedAfter: updated.afterState,
      decisionNote: updated.decisionNote,
    },
    actor: `${actorName} (Explicit Rejection)`,
  });

  return updated;
}
