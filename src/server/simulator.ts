import { randomUUID } from 'node:crypto';
import { db } from './db.ts';
import { getAllNodes, recordAuditLog } from './graphService.ts';
import { formatFriendlyDate } from './impactEngine.ts';
import type {
  ImpactAnalysisResult,
  ProposedChangeItem,
  WhatIfPlan,
} from '../types/maya.ts';

function shiftIsoByDays(isoDate: string, deltaDays: number, overrideTime?: string): string {
  const base = isoDate.slice(0, 10);
  const d = new Date(`${base}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) {
    return `${base}T${overrideTime ?? '12:00'}`;
  }
  d.setUTCDate(d.getUTCDate() + deltaDays);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const timePart = overrideTime ?? (isoDate.length > 10 ? isoDate.slice(11, 16) : '12:00');
  return `${yyyy}-${mm}-${dd}T${timePart}`;
}

export function generateWhatIfPlans(
  workspaceId: string,
  analysis: ImpactAnalysisResult,
): WhatIfPlan[] {
  const nodes = getAllNodes(workspaceId);
  const nodesById = new Map(nodes.map((n) => [n.id, n]));

  const newDeadlineIso = analysis.changeEvent.newValue;
  const newDayIso = newDeadlineIso.slice(0, 10);
  const prevDayIso = shiftIsoByDays(newDayIso, -1, '18:00').slice(0, 10);

  const affectedItems = [...analysis.directImpacts, ...analysis.downstreamImpacts];
  const affectedTasks = affectedItems.filter((i) => i.nodeType === 'TASK');
  const affectedMeetings = affectedItems.filter((i) => i.nodeType === 'MEETING');
  const affectedDocs = affectedItems.filter((i) => i.nodeType === 'DOCUMENT');
  const affectedPeople = affectedItems.filter((i) => i.nodeType === 'PERSON');

  const taskA = affectedTasks.find((t) => t.nodeId === 'task-a') ?? affectedTasks[0];
  const taskB = affectedTasks.find((t) => t.nodeId === 'task-b') ?? affectedTasks[1];
  const taskC = affectedTasks.find((t) => t.nodeId === 'task-c') ?? affectedTasks[2];
  const extraTasks = affectedTasks.filter(
    (t) => t.nodeId !== taskA?.nodeId && t.nodeId !== taskB?.nodeId && t.nodeId !== taskC?.nodeId,
  );

  const primaryMeeting = affectedMeetings[0];
  const primaryDoc = affectedDocs[0];
  const deadlineNode = nodesById.get(analysis.changeEvent.targetNodeId);

  const otherMeetingsOnNewDay = nodes.filter(
    (n) =>
      n.type === 'MEETING' &&
      n.date?.startsWith(newDayIso) &&
      !affectedMeetings.some((m) => m.nodeId === n.id),
  );
  const otherMeetingsOnPrevDay = nodes.filter(
    (n) =>
      n.type === 'MEETING' &&
      n.date?.startsWith(prevDayIso) &&
      !affectedMeetings.some((m) => m.nodeId === n.id),
  );

  // --- OPTION A: Sequential Critical-Path Compression ---
  const optionAChanges: ProposedChangeItem[] = [];

  if (deadlineNode) {
    optionAChanges.push({
      actionType: 'UPDATE_DEADLINE',
      targetNodeId: deadlineNode.id,
      targetTitle: deadlineNode.title,
      field: 'date',
      beforeValue: analysis.changeEvent.originalValue,
      afterValue: newDeadlineIso,
      permissionScope: 'local.context.write',
      requiresConfirmation: true,
      rationale: 'Align stored project deadline with the detected change.',
    });
  }

  if (taskA) {
    optionAChanges.push({
      actionType: 'UPDATE_TASK_DUE_DATE',
      targetNodeId: taskA.nodeId,
      targetTitle: taskA.title,
      field: 'date',
      beforeValue: taskA.currentDate ?? 'Unscheduled',
      afterValue: `${prevDayIso}T18:00`,
      permissionScope: 'tasks.write',
      requiresConfirmation: true,
      rationale: `Prioritise "${taskA.title}" to finish the day before the revised deadline.`,
    });
  }

  if (taskB) {
    optionAChanges.push({
      actionType: 'UPDATE_TASK_DUE_DATE',
      targetNodeId: taskB.nodeId,
      targetTitle: taskB.title,
      field: 'date',
      beforeValue: taskB.currentDate ?? 'Unscheduled',
      afterValue: `${newDayIso}T11:00`,
      permissionScope: 'tasks.write',
      requiresConfirmation: true,
      rationale: `Schedule "${taskB.title}" for morning completion immediately after upstream work.`,
    });
  }

  if (taskC) {
    optionAChanges.push({
      actionType: 'UPDATE_TASK_DUE_DATE',
      targetNodeId: taskC.nodeId,
      targetTitle: taskC.title,
      field: 'date',
      beforeValue: taskC.currentDate ?? 'Unscheduled',
      afterValue: `${newDayIso}T15:30`,
      permissionScope: 'tasks.write',
      requiresConfirmation: true,
      rationale: `Complete "${taskC.title}" 90 minutes prior to the 17:00 deadline cutoff.`,
    });
  }

  for (const t of extraTasks) {
    optionAChanges.push({
      actionType: 'UPDATE_TASK_DUE_DATE',
      targetNodeId: t.nodeId,
      targetTitle: t.title,
      field: 'date',
      beforeValue: t.currentDate ?? 'Unscheduled',
      afterValue: `${newDayIso}T15:00`,
      permissionScope: 'tasks.write',
      requiresConfirmation: true,
      rationale: `Bring "${t.title}" inside the revised ${formatFriendlyDate(newDayIso)} window.`,
    });
  }

  if (primaryMeeting) {
    optionAChanges.push({
      actionType: 'RESCHEDULE_MEETING',
      targetNodeId: primaryMeeting.nodeId,
      targetTitle: primaryMeeting.title,
      field: 'date',
      beforeValue: primaryMeeting.currentDate ?? 'Unscheduled',
      afterValue: `${newDayIso}T12:30`,
      permissionScope: 'calendar.events',
      requiresConfirmation: true,
      rationale: `Move "${primaryMeeting.title}" ahead of the revised deadline.`,
    });
  }

  if (primaryDoc) {
    optionAChanges.push({
      actionType: 'UPDATE_DOCUMENT_TEXT',
      targetNodeId: primaryDoc.nodeId,
      targetTitle: primaryDoc.title,
      field: 'referencedDeadline',
      beforeValue: analysis.changeEvent.originalValue.slice(0, 10),
      afterValue: newDayIso,
      permissionScope: 'workspace.docs.write',
      requiresConfirmation: true,
      rationale: `Update stale deadline reference inside "${primaryDoc.title}".`,
    });
  }

  const conflictsA: WhatIfPlan['potentialConflicts'] = [];
  if (affectedTasks.length >= 2) {
    conflictsA.push({
      severity: 'WARNING',
      description: `Compressing ${affectedTasks.length} tasks around ${formatFriendlyDate(
        newDayIso,
      )} leaves a tight execution buffer before final submission.`,
      involvedNodeIds: affectedTasks.map((t) => t.nodeId),
    });
  } else {
    conflictsA.push({
      severity: 'INFO',
      description: `Timeline compressed to complete all tracked items by ${formatFriendlyDate(
        newDeadlineIso,
      )}.`,
      involvedNodeIds: affectedTasks.map((t) => t.nodeId),
    });
  }

  if (otherMeetingsOnNewDay.length > 0) {
    conflictsA.push({
      severity: 'INFO',
      description: `Existing meeting "${otherMeetingsOnNewDay[0].title}" is also on ${formatFriendlyDate(
        newDayIso,
      )} — verify there is no calendar slot clash.`,
      involvedNodeIds: [otherMeetingsOnNewDay[0].id],
    });
  }

  const planA: WhatIfPlan = {
    id: `plan-${randomUUID().slice(0, 10)}`,
    workspaceId,
    analysisId: analysis.id,
    optionKey: 'A',
    title: 'Option A · Sequential Critical-Path Compression',
    strategySummary:
      'Prioritise upstream deliverables onto the preceding day, execute dependent work sequentially on deadline morning, and move any review meeting ahead of submission.',
    proposedChanges: optionAChanges,
    tasksAffected: optionAChanges
      .filter((c) => c.actionType === 'UPDATE_TASK_DUE_DATE')
      .map((c) => ({
        id: c.targetNodeId,
        title: c.targetTitle,
        change: `${formatFriendlyDate(c.beforeValue)} -> ${formatFriendlyDate(c.afterValue)}`,
      })),
    meetingsAffected: optionAChanges
      .filter((c) => c.actionType === 'RESCHEDULE_MEETING')
      .map((c) => ({
        id: c.targetNodeId,
        title: c.targetTitle,
        change: `${formatFriendlyDate(c.beforeValue)} -> ${formatFriendlyDate(c.afterValue)}`,
      })),
    potentialConflicts: conflictsA,
    advantages: [
      'Preserves strict task dependency order without parallel rework risk.',
      'Keeps existing task ownership unchanged (zero handoff overhead).',
      'Completes reviews prior to the revised submission cutoff.',
    ],
    tradeoffs: [
      'Concentrates review and finalization work into a tighter final-day window.',
      'Requires earlier completion of the initial prerequisite deliverable.',
    ],
    requiresUserConfirmation: [
      'Confirm prerequisite task owners can deliver on the accelerated date.',
      ...(primaryMeeting
        ? [`Approve moving "${primaryMeeting.title}" to ${formatFriendlyDate(`${newDayIso}T12:30`)}.`]
        : []),
    ],
    status: 'PROPOSED',
  };

  // --- OPTION B: Early Checkpoint & Parallel Redistribution ---
  const optionBChanges: ProposedChangeItem[] = [];

  if (deadlineNode) {
    optionBChanges.push({
      actionType: 'UPDATE_DEADLINE',
      targetNodeId: deadlineNode.id,
      targetTitle: deadlineNode.title,
      field: 'date',
      beforeValue: analysis.changeEvent.originalValue,
      afterValue: newDeadlineIso,
      permissionScope: 'local.context.write',
      requiresConfirmation: true,
      rationale: 'Align stored project deadline with the detected change.',
    });
  }

  if (primaryMeeting) {
    optionBChanges.push({
      actionType: 'RESCHEDULE_MEETING',
      targetNodeId: primaryMeeting.nodeId,
      targetTitle: primaryMeeting.title,
      field: 'date',
      beforeValue: primaryMeeting.currentDate ?? 'Unscheduled',
      afterValue: `${prevDayIso}T16:00`,
      permissionScope: 'calendar.events',
      requiresConfirmation: true,
      rationale: `Hold "${primaryMeeting.title}" earlier on ${formatFriendlyDate(prevDayIso)} as a mid-flight checkpoint.`,
    });
  }

  if (taskA) {
    optionBChanges.push({
      actionType: 'UPDATE_TASK_DUE_DATE',
      targetNodeId: taskA.nodeId,
      targetTitle: taskA.title,
      field: 'date',
      beforeValue: taskA.currentDate ?? 'Unscheduled',
      afterValue: `${newDayIso}T09:00`,
      permissionScope: 'tasks.write',
      requiresConfirmation: true,
      rationale: `Allow until ${formatFriendlyDate(`${newDayIso}T09:00`)} to polish "${taskA.title}".`,
    });
  }

  if (taskB) {
    const coReviewerLabel =
      affectedPeople.length >= 2
        ? `${affectedPeople[0].title} + ${affectedPeople[1].title} (co-review)`
        : 'Shared co-review redistribution';

    optionBChanges.push({
      actionType: 'REASSIGN_TASK',
      targetNodeId: taskB.nodeId,
      targetTitle: taskB.title,
      field: 'ownerId',
      beforeValue: 'Single assignee',
      afterValue: coReviewerLabel,
      permissionScope: 'tasks.write',
      requiresConfirmation: true,
      rationale: 'Split review load to shorten turnaround time.',
    });
    optionBChanges.push({
      actionType: 'UPDATE_TASK_DUE_DATE',
      targetNodeId: taskB.nodeId,
      targetTitle: taskB.title,
      field: 'date',
      beforeValue: taskB.currentDate ?? 'Unscheduled',
      afterValue: `${newDayIso}T12:00`,
      permissionScope: 'tasks.write',
      requiresConfirmation: true,
      rationale: 'Target co-review sign-off by midday.',
    });
  }

  if (taskC) {
    optionBChanges.push({
      actionType: 'UPDATE_TASK_DUE_DATE',
      targetNodeId: taskC.nodeId,
      targetTitle: taskC.title,
      field: 'date',
      beforeValue: taskC.currentDate ?? 'Unscheduled',
      afterValue: `${newDayIso}T14:30`,
      permissionScope: 'tasks.write',
      requiresConfirmation: true,
      rationale: `Draft "${taskC.title}" in parallel and lock final edits after review.`,
    });
  }

  for (const t of extraTasks) {
    optionBChanges.push({
      actionType: 'UPDATE_TASK_DUE_DATE',
      targetNodeId: t.nodeId,
      targetTitle: t.title,
      field: 'date',
      beforeValue: t.currentDate ?? 'Unscheduled',
      afterValue: `${newDayIso}T14:00`,
      permissionScope: 'tasks.write',
      requiresConfirmation: true,
      rationale: `Parallelize "${t.title}" ahead of final deadline.`,
    });
  }

  if (primaryDoc) {
    optionBChanges.push({
      actionType: 'UPDATE_DOCUMENT_TEXT',
      targetNodeId: primaryDoc.nodeId,
      targetTitle: primaryDoc.title,
      field: 'referencedDeadline',
      beforeValue: analysis.changeEvent.originalValue.slice(0, 10),
      afterValue: newDayIso,
      permissionScope: 'workspace.docs.write',
      requiresConfirmation: true,
      rationale: `Update "${primaryDoc.title}" deadline and redistribution notes.`,
    });
  }

  const notifyTargetNodeId = affectedPeople[0]?.nodeId ?? analysis.changeEvent.projectId;
  const notifyNames =
    affectedPeople.length > 0
      ? affectedPeople.map((p) => p.title).join(', ')
      : 'Project stakeholders';

  optionBChanges.push({
    actionType: 'SEND_NOTIFICATION_DRAFT',
    targetNodeId: notifyTargetNodeId,
    targetTitle: `Notify affected participants (${notifyNames})`,
    field: 'notification',
    beforeValue: 'No notification drafted',
    afterValue: `Draft update: ${analysis.changeEvent.projectTitle} deadline moved to ${formatFriendlyDate(
      newDeadlineIso,
    )}; proposing schedule redistribution.`,
    permissionScope: 'gmail.compose',
    requiresConfirmation: true,
    rationale: 'Communicate schedule adjustments explicitly to stakeholders.',
  });

  const conflictsB: WhatIfPlan['potentialConflicts'] = [];
  if (taskB && taskC) {
    conflictsB.push({
      severity: 'WARNING',
      description: `Parallelizing "${taskC.title}" ahead of "${taskB.title}" review introduces rework risk if review feedback changes core findings.`,
      involvedNodeIds: [taskB.nodeId, taskC.nodeId],
    });
  } else {
    conflictsB.push({
      severity: 'INFO',
      description: `Parallelizing workstreams requires explicit stakeholder alignment before ${formatFriendlyDate(
        prevDayIso,
      )}.`,
      involvedNodeIds: affectedTasks.map((t) => t.nodeId),
    });
  }

  if (otherMeetingsOnPrevDay.length > 0) {
    conflictsB.push({
      severity: 'INFO',
      description: `Check participant availability around "${otherMeetingsOnPrevDay[0].title}" on ${formatFriendlyDate(
        prevDayIso,
      )}.`,
      involvedNodeIds: [otherMeetingsOnPrevDay[0].id],
    });
  }

  const planB: WhatIfPlan = {
    id: `plan-${randomUUID().slice(0, 10)}`,
    workspaceId,
    analysisId: analysis.id,
    optionKey: 'B',
    title: 'Option B · Early Checkpoint & Parallel Redistribution',
    strategySummary:
      'Shift reviews into an earlier checkpoint, redistribute workload where possible, parallelize downstream prep, and prepare stakeholder notifications.',
    proposedChanges: optionBChanges,
    tasksAffected: optionBChanges
      .filter((c) => c.actionType === 'UPDATE_TASK_DUE_DATE' || c.actionType === 'REASSIGN_TASK')
      .map((c) => ({
        id: c.targetNodeId,
        title: c.targetTitle,
        change: c.field === 'ownerId' ? c.afterValue : formatFriendlyDate(c.afterValue),
      })),
    meetingsAffected: optionBChanges
      .filter((c) => c.actionType === 'RESCHEDULE_MEETING')
      .map((c) => ({
        id: c.targetNodeId,
        title: c.targetTitle,
        change: `${formatFriendlyDate(c.beforeValue)} -> ${formatFriendlyDate(c.afterValue)}`,
      })),
    potentialConflicts: conflictsB,
    advantages: [
      'Provides extra overnight buffer for the initial deliverable.',
      'Surfaces reviewer feedback early before final assembly.',
      'Stages explicit stakeholder notification drafts for approval.',
    ],
    tradeoffs: [
      'Parallelized tasks may require minor edits after review feedback.',
      'Requires coordination across multiple participants.',
    ],
    requiresUserConfirmation: [
      'Confirm stakeholder availability for early checkpoint and redistribution.',
      'Approve sending or saving the stakeholder notification draft.',
    ],
    status: 'PROPOSED',
  };

  const insertPlan = db.prepare(`
    INSERT INTO what_if_plans (
      id, workspace_id, analysis_id, option_key, title, strategy_summary, proposed_changes_json,
      tasks_affected_json, meetings_affected_json, potential_conflicts_json,
      advantages_json, tradeoffs_json, requires_confirmation_json, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const p of [planA, planB]) {
    insertPlan.run(
      p.id,
      workspaceId,
      p.analysisId,
      p.optionKey,
      p.title,
      p.strategySummary,
      JSON.stringify(p.proposedChanges),
      JSON.stringify(p.tasksAffected),
      JSON.stringify(p.meetingsAffected),
      JSON.stringify(p.potentialConflicts),
      JSON.stringify(p.advantages),
      JSON.stringify(p.tradeoffs),
      JSON.stringify(p.requiresUserConfirmation),
      p.status,
    );
  }

  recordAuditLog(workspaceId, {
    actionType: 'WHAT_IF_SIMULATED',
    targetLabel: `${analysis.changeEvent.projectTitle} (Options A & B)`,
    status: 'SIMULATED_PLAN',
    executionMode: 'INTERNAL',
    summary: `Generated 2 workspace-scoped response plans (Option A: ${planA.proposedChanges.length} actions; Option B: ${planB.proposedChanges.length} actions).`,
    details: { analysisId: analysis.id, planIds: [planA.id, planB.id] },
    actor: 'maYa What-if Simulator',
  });

  return [planA, planB];
}

export function getPlansByAnalysisId(workspaceId: string, analysisId: string): WhatIfPlan[] {
  const rows = db
    .prepare(
      'SELECT * FROM what_if_plans WHERE analysis_id = ? AND workspace_id = ? ORDER BY option_key ASC',
    )
    .all(analysisId, workspaceId) as Record<string, unknown>[];

  return rows.map((row) => ({
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    analysisId: String(row.analysis_id),
    optionKey: row.option_key as 'A' | 'B',
    title: String(row.title),
    strategySummary: String(row.strategy_summary),
    proposedChanges: JSON.parse(String(row.proposed_changes_json)) as WhatIfPlan['proposedChanges'],
    tasksAffected: JSON.parse(String(row.tasks_affected_json)) as WhatIfPlan['tasksAffected'],
    meetingsAffected: JSON.parse(String(row.meetings_affected_json)) as WhatIfPlan['meetingsAffected'],
    potentialConflicts: JSON.parse(
      String(row.potential_conflicts_json),
    ) as WhatIfPlan['potentialConflicts'],
    advantages: JSON.parse(String(row.advantages_json)) as string[],
    tradeoffs: JSON.parse(String(row.tradeoffs_json)) as string[],
    requiresUserConfirmation: JSON.parse(String(row.requires_confirmation_json)) as string[],
    status: row.status as WhatIfPlan['status'],
  }));
}
