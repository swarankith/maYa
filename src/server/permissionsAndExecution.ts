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
  const calConnected =
    integrations.find((i) => i.serviceKey === 'google_calendar')?.status === 'CONNECTED';
  const tasksConnected =
    integrations.find((i) => i.serviceKey === 'google_tasks')?.status === 'CONNECTED';
  const gmailConnected =
    integrations.find((i) => i.serviceKey === 'gmail')?.status === 'CONNECTED';

  if (!ALLOWED_LOCAL_SCOPES.has(scope)) {
    return {
      valid: false,
      executionMode: isDemo ? 'SIMULATED_DEMO' : 'LOCAL_WORKSPACE',
      reason: `Scope "${scope}" is outside the permitted action policy.`,
    };
  }

  if (scope === 'calendar.events' && calConnected) {
    return {
      valid: true,
      executionMode: 'LIVE_OAUTH',
      reason: 'Google Calendar OAuth scope granted; awaiting explicit user approval.',
    };
  }
  if (scope === 'tasks.write' && tasksConnected) {
    return {
      valid: true,
      executionMode: 'LIVE_OAUTH',
      reason: 'Google Tasks OAuth scope granted; awaiting explicit user approval.',
    };
  }
  if (scope === 'gmail.compose' && gmailConnected) {
    return {
      valid: true,
      executionMode: 'LIVE_OAUTH',
      reason: 'Gmail OAuth scope granted; awaiting explicit user approval.',
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
  if (!approval.permissionValid) {
    throw new Error(`Permission check failed: ${approval.permissionReason}`);
  }

  const now = new Date().toISOString();
  const field = String(approval.proposedPayload.field ?? 'date');
  const afterValue = String(approval.proposedPayload.afterValue ?? '');
  const modeLabel =
    approval.executionMode === 'SIMULATED_DEMO' ? 'Simulated' : 'Workspace Approved';

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

  db.prepare(
    'UPDATE approvals SET status = ?, decided_at = ?, decision_note = ? WHERE id = ? AND workspace_id = ?',
  ).run(
    'APPROVED',
    now,
    decisionNote ?? 'Approved by user in Controlled Execution queue.',
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
    status: 'EXECUTED_SIMULATED',
    executionMode: updated.executionMode,
    summary: `[${updated.executionMode}] Executed ${updated.actionType} on "${updated.targetLabel}": ${JSON.stringify(
      updated.beforeState,
    )} -> ${JSON.stringify(updated.afterState)}.`,
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
