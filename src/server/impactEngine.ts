import { randomUUID } from 'node:crypto';
import { db } from './db.ts';
import {
  getAllEdges,
  getAllNodes,
  getAllSourceRecords,
  recordAuditLog,
} from './graphService.ts';
import { generateExplainableNarrative } from './geminiService.ts';
import type {
  ChangeEvent,
  ContextEdge,
  ContextNode,
  FactStatus,
  ImpactAnalysisResult,
  ImpactedItem,
  SourceRecord,
} from '../types/maya.ts';

function toComparableDate(iso: string | null): number {
  if (!iso) return Number.MAX_SAFE_INTEGER;
  const normalized = iso.length === 10 ? `${iso}T23:59:00` : iso;
  const ms = new Date(normalized).getTime();
  return Number.isNaN(ms) ? Number.MAX_SAFE_INTEGER : ms;
}

export function formatFriendlyDate(iso: string | null): string {
  if (!iso) return 'Unscheduled';
  const normalized = iso.length === 10 ? `${iso}T12:00:00` : iso;
  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) return iso;
  const datePart = d.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
  if (iso.length > 10) {
    const timePart = iso.slice(11, 16);
    return `${datePart} · ${timePart}`;
  }
  return datePart;
}

function buildEvidenceLookup(
  edgeIds: string[],
  edgesById: Map<string, ContextEdge>,
  sourcesById: Map<string, SourceRecord>,
): Array<{ sourceId: string; sourceTitle: string; evidenceText: string }> {
  const result: Array<{ sourceId: string; sourceTitle: string; evidenceText: string }> = [];
  const seen = new Set<string>();

  for (const eid of edgeIds) {
    const edge = edgesById.get(eid);
    if (!edge) continue;
    const src = edge.sourceRecordId ? sourcesById.get(edge.sourceRecordId) : undefined;
    const key = `${src?.id ?? 'edge'}-${edge.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      sourceId: src?.id ?? edge.id,
      sourceTitle: src?.title ?? edge.provenance,
      evidenceText: edge.evidenceText || edge.provenance,
    });
  }

  return result;
}

export async function runRippleImpactAnalysis(
  workspaceId: string,
  params: {
    projectId: string;
    newDeadlineIso: string; // YYYY-MM-DD or YYYY-MM-DDTHH:mm
    sourceRecord: SourceRecord;
    extractionMethod: 'GEMINI_NLU' | 'DETERMINISTIC_PARSER' | 'DIRECT_USER_UPDATE';
    extractionNote: string;
  },
): Promise<ImpactAnalysisResult> {
  // Strictly load ONLY records belonging to the authenticated/active workspaceId
  const nodes = getAllNodes(workspaceId);
  const edges = getAllEdges(workspaceId);
  const sources = getAllSourceRecords(workspaceId);

  const nodesById = new Map(nodes.map((n) => [n.id, n]));
  const edgesById = new Map(edges.map((e) => [e.id, e]));
  const sourcesById = new Map(sources.map((s) => [s.id, s]));

  const projectNode = nodesById.get(params.projectId);
  if (!projectNode || projectNode.type !== 'PROJECT') {
    throw new Error(`Project "${params.projectId}" not found in active workspace.`);
  }

  // Locate primary deadline node belonging to this project (either via BELONGS_TO edge or projectId field)
  const deadlineEdge = edges.find(
    (e) =>
      e.targetId === projectNode.id &&
      e.relationshipType === 'BELONGS_TO' &&
      nodesById.get(e.sourceId)?.type === 'DEADLINE',
  );
  const deadlineNode = deadlineEdge
    ? nodesById.get(deadlineEdge.sourceId) ?? null
    : nodes.find((n) => n.type === 'DEADLINE' && n.projectId === projectNode.id) ?? null;

  const targetNode = deadlineNode ?? projectNode;
  const originalDate = targetNode.date ?? projectNode.date ?? params.newDeadlineIso;
  const normalizedNewDate =
    params.newDeadlineIso.length === 10 ? `${params.newDeadlineIso}T17:00` : params.newDeadlineIso;

  const newDeadlineMs = toComparableDate(normalizedNewDate);
  const originalDayPrefix = originalDate.slice(0, 10);

  const changeEvent: ChangeEvent = {
    id: `chg-${randomUUID().slice(0, 8)}`,
    projectId: projectNode.id,
    projectTitle: projectNode.title,
    targetNodeId: targetNode.id,
    targetNodeTitle: targetNode.title,
    fieldChanged: 'deadline',
    originalValue: originalDate,
    newValue: normalizedNewDate,
    sourceRecordId: params.sourceRecord.id,
    sourceRecordTitle: params.sourceRecord.title,
    extractionMethod: params.extractionMethod,
    extractionConfidenceNote: params.extractionNote,
    detectedAt: new Date().toISOString(),
  };

  const directImpacts: ImpactedItem[] = [];
  const downstreamImpacts: ImpactedItem[] = [];
  const unaffectedItems: ImpactedItem[] = [];
  const impactedNodeIds = new Set<string>();

  // 1. Direct Impact on the Deadline / Project Anchor node
  impactedNodeIds.add(targetNode.id);
  directImpacts.push({
    nodeId: targetNode.id,
    nodeType: targetNode.type,
    title: targetNode.title,
    currentDate: originalDate,
    status: targetNode.status,
    category: 'DIRECT',
    severity: 'HIGH',
    reason: `Target deadline shifted from ${formatFriendlyDate(originalDate)} to ${formatFriendlyDate(normalizedNewDate)} based on "${params.sourceRecord.title}".`,
    relationshipPath: [params.sourceRecord.title, targetNode.title, projectNode.title],
    relationshipChainIds: deadlineEdge ? [deadlineEdge.id] : [],
    supportingSourceIds: [params.sourceRecord.id],
    supportingEvidence: [
      {
        sourceId: params.sourceRecord.id,
        sourceTitle: params.sourceRecord.title,
        evidenceText: params.sourceRecord.content,
      },
    ],
    factStatus: targetNode.factStatus,
  });

  // Dependency maps
  const taskDependsOnMap = new Map<string, ContextEdge[]>();
  const reverseDependsMap = new Map<string, ContextEdge[]>();
  for (const e of edges) {
    if (e.relationshipType === 'DEPENDS_ON') {
      const list = taskDependsOnMap.get(e.sourceId) ?? [];
      list.push(e);
      taskDependsOnMap.set(e.sourceId, list);

      const rev = reverseDependsMap.get(e.targetId) ?? [];
      rev.push(e);
      reverseDependsMap.set(e.targetId, rev);
    }
  }

  // 2. Direct Impacts: Tasks belonging to project
  const projectTasks = nodes.filter(
    (n) =>
      n.type === 'TASK' &&
      (n.projectId === projectNode.id ||
        edges.some(
          (e) =>
            (e.sourceId === n.id && e.targetId === projectNode.id) ||
            (e.targetId === n.id && e.sourceId === projectNode.id),
        )),
  );

  const directlyImpactedTaskIds: string[] = [];

  for (const task of projectTasks) {
    const belongsEdge = edges.find(
      (e) =>
        (e.sourceId === task.id && e.targetId === projectNode.id) ||
        (e.targetId === task.id && e.sourceId === projectNode.id),
    );
    const deps = taskDependsOnMap.get(task.id) ?? [];
    const taskMs = toComparableDate(task.date);

    if (task.status.toLowerCase() === 'completed') {
      unaffectedItems.push({
        nodeId: task.id,
        nodeType: task.type,
        title: task.title,
        currentDate: task.date,
        status: task.status,
        category: 'UNAFFECTED',
        severity: 'NONE',
        reason: `Already marked Completed (${formatFriendlyDate(task.date)}) before the revised ${formatFriendlyDate(normalizedNewDate)} deadline.`,
        relationshipPath: [task.title, projectNode.title],
        relationshipChainIds: belongsEdge ? [belongsEdge.id] : [],
        supportingSourceIds: belongsEdge?.sourceRecordId ? [belongsEdge.sourceRecordId] : [],
        supportingEvidence: belongsEdge
          ? buildEvidenceLookup([belongsEdge.id], edgesById, sourcesById)
          : [],
        factStatus: task.factStatus,
      });
      continue;
    }

    // Root tasks with no upstream DEPENDS_ON whose date is after new deadline (or unscheduled tasks tied to project)
    if (deps.length === 0 && (task.date ? taskMs > newDeadlineMs : true)) {
      impactedNodeIds.add(task.id);
      directlyImpactedTaskIds.push(task.id);
      const chainIds = belongsEdge ? [belongsEdge.id] : [];
      directImpacts.push({
        nodeId: task.id,
        nodeType: task.type,
        title: task.title,
        currentDate: task.date,
        status: task.status,
        category: 'DIRECT',
        severity: task.date ? 'HIGH' : 'MEDIUM',
        reason: task.date
          ? `Scheduled for ${formatFriendlyDate(task.date)}, which falls after the revised ${formatFriendlyDate(normalizedNewDate)} project deadline.`
          : `Belongs to ${projectNode.title} with no explicit due date and requires scheduling before ${formatFriendlyDate(normalizedNewDate)}.`,
        relationshipPath: [projectNode.title, task.title],
        relationshipChainIds: chainIds,
        supportingSourceIds: belongsEdge?.sourceRecordId ? [belongsEdge.sourceRecordId] : [],
        supportingEvidence: buildEvidenceLookup(chainIds, edgesById, sourcesById),
        factStatus:
          task.factStatus === 'INFERRED' || belongsEdge?.factStatus === 'INFERRED'
            ? 'INFERRED'
            : 'CONFIRMED',
      });
    }
  }

  // 3. Direct Impacts: Meetings connected to project occurring after new deadline
  const meetingEdges = edges.filter(
    (e) =>
      ((e.targetId === projectNode.id && nodesById.get(e.sourceId)?.type === 'MEETING') ||
        (e.sourceId === projectNode.id && nodesById.get(e.targetId)?.type === 'MEETING')),
  );
  const impactedMeetingIds: string[] = [];

  for (const mEdge of meetingEdges) {
    const meeting =
      nodesById.get(mEdge.sourceId)?.type === 'MEETING'
        ? nodesById.get(mEdge.sourceId)
        : nodesById.get(mEdge.targetId);
    if (!meeting || impactedNodeIds.has(meeting.id)) continue;
    const meetingMs = toComparableDate(meeting.date);

    if (meeting.date && meetingMs > newDeadlineMs) {
      impactedNodeIds.add(meeting.id);
      impactedMeetingIds.push(meeting.id);
      directImpacts.push({
        nodeId: meeting.id,
        nodeType: meeting.type,
        title: meeting.title,
        currentDate: meeting.date,
        status: meeting.status,
        category: 'DIRECT',
        severity: 'HIGH',
        reason: `Review meeting is scheduled on ${formatFriendlyDate(meeting.date)}, which is after the revised ${formatFriendlyDate(normalizedNewDate)} deadline.`,
        relationshipPath: [projectNode.title, meeting.title],
        relationshipChainIds: [mEdge.id],
        supportingSourceIds: mEdge.sourceRecordId ? [mEdge.sourceRecordId] : [],
        supportingEvidence: buildEvidenceLookup([mEdge.id], edgesById, sourcesById),
        factStatus:
          meeting.factStatus === 'INFERRED' || mEdge.factStatus === 'INFERRED'
            ? 'INFERRED'
            : 'CONFIRMED',
      });
    }
  }

  // Also check meetings linked by projectId directly even if user hasn't added a RELATES_TO edge yet
  for (const node of nodes) {
    if (
      node.type === 'MEETING' &&
      node.projectId === projectNode.id &&
      !impactedNodeIds.has(node.id) &&
      node.date &&
      toComparableDate(node.date) > newDeadlineMs
    ) {
      impactedNodeIds.add(node.id);
      impactedMeetingIds.push(node.id);
      directImpacts.push({
        nodeId: node.id,
        nodeType: node.type,
        title: node.title,
        currentDate: node.date,
        status: node.status,
        category: 'DIRECT',
        severity: 'HIGH',
        reason: `Associated with ${projectNode.title} and scheduled on ${formatFriendlyDate(node.date)} after the revised ${formatFriendlyDate(normalizedNewDate)} deadline.`,
        relationshipPath: [projectNode.title, node.title],
        relationshipChainIds: [],
        supportingSourceIds: [],
        supportingEvidence: [],
        factStatus: 'INFERRED',
      });
    }
  }

  // 4. Direct Impacts: Documents referencing the original deadline or connected to project
  const docEdges = edges.filter(
    (e) =>
      ((e.targetId === projectNode.id && nodesById.get(e.sourceId)?.type === 'DOCUMENT') ||
        (e.sourceId === projectNode.id && nodesById.get(e.targetId)?.type === 'DOCUMENT')),
  );

  for (const dEdge of docEdges) {
    const doc =
      nodesById.get(dEdge.sourceId)?.type === 'DOCUMENT'
        ? nodesById.get(dEdge.sourceId)
        : nodesById.get(dEdge.targetId);
    if (!doc || impactedNodeIds.has(doc.id)) continue;
    const refDeadline = String(doc.metadata.referencedDeadline ?? doc.date ?? '');
    if (
      (originalDayPrefix && refDeadline.startsWith(originalDayPrefix)) ||
      (doc.date && toComparableDate(doc.date) > newDeadlineMs)
    ) {
      impactedNodeIds.add(doc.id);
      directImpacts.push({
        nodeId: doc.id,
        nodeType: doc.type,
        title: doc.title,
        currentDate: doc.date,
        status: doc.status,
        category: 'DIRECT',
        severity: 'MEDIUM',
        reason: `Document references original deadline (${String(
          doc.metadata.referencedDeadlineText ?? formatFriendlyDate(originalDate),
        )}) and should be updated to ${formatFriendlyDate(normalizedNewDate)}.`,
        relationshipPath: [projectNode.title, doc.title],
        relationshipChainIds: [dEdge.id],
        supportingSourceIds: dEdge.sourceRecordId ? [dEdge.sourceRecordId] : [],
        supportingEvidence: buildEvidenceLookup([dEdge.id], edgesById, sourcesById),
        factStatus:
          doc.factStatus === 'INFERRED' || dEdge.factStatus === 'INFERRED' ? 'INFERRED' : 'CONFIRMED',
      });
    }
  }

  // 5. Downstream Impacts: BFS along reverse DEPENDS_ON chains
  const queue: Array<{
    nodeId: string;
    pathNames: string[];
    chainEdgeIds: string[];
    factStatus: FactStatus;
  }> = [];

  for (const taskId of directlyImpactedTaskIds) {
    const tNode = nodesById.get(taskId);
    if (tNode) {
      queue.push({
        nodeId: taskId,
        pathNames: [projectNode.title, tNode.title],
        chainEdgeIds: [],
        factStatus: tNode.factStatus,
      });
    }
  }

  const downstreamTaskIds: string[] = [...directlyImpactedTaskIds];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const dependentEdges = reverseDependsMap.get(current.nodeId) ?? [];

    for (const depEdge of dependentEdges) {
      const depTask = nodesById.get(depEdge.sourceId);
      if (!depTask || depTask.status.toLowerCase() === 'completed') continue;

      const currentNode = nodesById.get(current.nodeId);
      const nextFactStatus: FactStatus =
        current.factStatus === 'INFERRED' ||
        depEdge.factStatus === 'INFERRED' ||
        depTask.factStatus === 'INFERRED'
          ? 'INFERRED'
          : 'CONFIRMED';

      const nextPath = [...current.pathNames, depTask.title];
      const nextChain = [...current.chainEdgeIds, depEdge.id];

      if (!impactedNodeIds.has(depTask.id)) {
        impactedNodeIds.add(depTask.id);
        downstreamTaskIds.push(depTask.id);

        const dateConflictNote =
          depTask.date && toComparableDate(depTask.date) > newDeadlineMs
            ? ` and its current due date (${formatFriendlyDate(depTask.date)}) exceeds the revised deadline`
            : '';

        downstreamImpacts.push({
          nodeId: depTask.id,
          nodeType: depTask.type,
          title: depTask.title,
          currentDate: depTask.date,
          status: depTask.status,
          category: 'DOWNSTREAM',
          severity: 'HIGH',
          reason: `${depTask.title} is affected because it depends on ${currentNode?.title ?? current.nodeId}, which must now be completed earlier due to the revised project deadline${dateConflictNote}.`,
          relationshipPath: nextPath,
          relationshipChainIds: nextChain,
          supportingSourceIds: depEdge.sourceRecordId ? [depEdge.sourceRecordId] : [],
          supportingEvidence: buildEvidenceLookup(nextChain, edgesById, sourcesById),
          factStatus: nextFactStatus,
        });

        queue.push({
          nodeId: depTask.id,
          pathNames: nextPath,
          chainEdgeIds: nextChain,
          factStatus: nextFactStatus,
        });
      }
    }
  }

  // Dependent tasks whose parent was not impacted but whose own due date > newDeadlineMs
  for (const task of projectTasks) {
    if (impactedNodeIds.has(task.id) || task.status.toLowerCase() === 'completed') continue;
    const deps = taskDependsOnMap.get(task.id) ?? [];
    if (deps.length > 0 && task.date && toComparableDate(task.date) > newDeadlineMs) {
      const parentEdge = deps[0];
      const parentNode = nodesById.get(parentEdge.targetId);
      if (parentNode) {
        impactedNodeIds.add(task.id);
        downstreamTaskIds.push(task.id);
        downstreamImpacts.push({
          nodeId: task.id,
          nodeType: task.type,
          title: task.title,
          currentDate: task.date,
          status: task.status,
          category: 'DOWNSTREAM',
          severity: 'HIGH',
          reason: `Scheduled for ${formatFriendlyDate(task.date)} after the revised ${formatFriendlyDate(normalizedNewDate)} deadline and depends on ${parentNode.title}.`,
          relationshipPath: [projectNode.title, parentNode.title, task.title],
          relationshipChainIds: [parentEdge.id],
          supportingSourceIds: parentEdge.sourceRecordId ? [parentEdge.sourceRecordId] : [],
          supportingEvidence: buildEvidenceLookup([parentEdge.id], edgesById, sourcesById),
          factStatus: parentEdge.factStatus,
        });
      }
    }
  }

  // 6. Downstream Impacts: Responsible People (ASSIGNED_TO affected tasks or ATTENDS affected meetings or WORKS_ON project)
  const personImpactsMap = new Map<
    string,
    {
      person: ContextNode;
      reasons: string[];
      path: string[];
      chainIds: string[];
      factStatus: FactStatus;
    }
  >();

  for (const taskId of downstreamTaskIds) {
    const taskNode = nodesById.get(taskId);
    if (!taskNode) continue;
    const assignEdges = edges.filter(
      (e) =>
        (e.sourceId === taskId && e.relationshipType === 'ASSIGNED_TO') ||
        (e.targetId === taskId && e.relationshipType === 'ASSIGNED_TO'),
    );
    for (const aEdge of assignEdges) {
      const person =
        nodesById.get(aEdge.targetId)?.type === 'PERSON'
          ? nodesById.get(aEdge.targetId)
          : nodesById.get(aEdge.sourceId);
      if (!person || person.type !== 'PERSON') continue;
      const existing = personImpactsMap.get(person.id);
      const reasonPiece = `Assigned to affected deliverable "${taskNode.title}"`;
      if (!existing) {
        personImpactsMap.set(person.id, {
          person,
          reasons: [reasonPiece],
          path: [projectNode.title, taskNode.title, person.title],
          chainIds: [aEdge.id],
          factStatus: aEdge.factStatus,
        });
      } else {
        existing.reasons.push(reasonPiece);
        existing.chainIds.push(aEdge.id);
      }
    }
  }

  for (const meetId of impactedMeetingIds) {
    const meetNode = nodesById.get(meetId);
    if (!meetNode) continue;
    const attendEdges = edges.filter(
      (e) =>
        (e.targetId === meetId && e.relationshipType === 'ATTENDS') ||
        (e.sourceId === meetId && e.relationshipType === 'ATTENDS'),
    );
    for (const attEdge of attendEdges) {
      const person =
        nodesById.get(attEdge.sourceId)?.type === 'PERSON'
          ? nodesById.get(attEdge.sourceId)
          : nodesById.get(attEdge.targetId);
      if (!person || person.type !== 'PERSON') continue;
      const existing = personImpactsMap.get(person.id);
      const reasonPiece = `Scheduled participant in affected meeting "${meetNode.title}"`;
      if (!existing) {
        personImpactsMap.set(person.id, {
          person,
          reasons: [reasonPiece],
          path: [projectNode.title, meetNode.title, person.title],
          chainIds: [attEdge.id],
          factStatus: attEdge.factStatus,
        });
      } else {
        existing.reasons.push(reasonPiece);
        existing.chainIds.push(attEdge.id);
      }
    }
  }

  // Also include people linked directly via WORKS_ON to the project if not already included
  for (const e of edges) {
    if (e.relationshipType === 'WORKS_ON' && e.targetId === projectNode.id) {
      const person = nodesById.get(e.sourceId);
      if (person && person.type === 'PERSON' && !personImpactsMap.has(person.id)) {
        personImpactsMap.set(person.id, {
          person,
          reasons: [`Contributes to ${projectNode.title}`],
          path: [projectNode.title, person.title],
          chainIds: [e.id],
          factStatus: e.factStatus,
        });
      }
    }
  }

  for (const entry of personImpactsMap.values()) {
    impactedNodeIds.add(entry.person.id);
    const worksOnEdge = edges.find(
      (e) =>
        e.sourceId === entry.person.id &&
        e.targetId === projectNode.id &&
        e.relationshipType === 'WORKS_ON',
    );
    const effectiveFactStatus: FactStatus =
      worksOnEdge?.factStatus === 'INFERRED' || entry.factStatus === 'INFERRED'
        ? 'INFERRED'
        : 'CONFIRMED';

    downstreamImpacts.push({
      nodeId: entry.person.id,
      nodeType: 'PERSON',
      title: entry.person.title,
      currentDate: null,
      status: entry.person.status,
      category: 'DOWNSTREAM',
      severity: entry.reasons.length > 1 ? 'HIGH' : 'MEDIUM',
      reason: `${entry.reasons.join(' and ')}. Timeline compression reduces available execution window.`,
      relationshipPath: entry.path,
      relationshipChainIds: entry.chainIds,
      supportingSourceIds: buildEvidenceLookup(entry.chainIds, edgesById, sourcesById).map(
        (ev) => ev.sourceId,
      ),
      supportingEvidence: buildEvidenceLookup(entry.chainIds, edgesById, sourcesById),
      factStatus: effectiveFactStatus,
    });
  }

  // 7. Unaffected Items in the same workspace
  for (const node of nodes) {
    if (impactedNodeIds.has(node.id)) continue;
    if (unaffectedItems.some((u) => u.nodeId === node.id)) continue;
    if (node.id === projectNode.id || node.type === 'EMAIL' || node.type === 'SOURCE_RECORD') continue;
    if (node.type === 'PERSON') continue;

    unaffectedItems.push({
      nodeId: node.id,
      nodeType: node.type,
      title: node.title,
      currentDate: node.date,
      status: node.status,
      category: 'UNAFFECTED',
      severity: 'NONE',
      reason:
        node.projectId === projectNode.id
          ? 'No date conflict or incomplete dependency link to the shifted deadline.'
          : 'Belongs to a separate project stream with no dependency edge to the shifted deadline.',
      relationshipPath: [node.title],
      relationshipChainIds: [],
      supportingSourceIds: [],
      supportingEvidence: [],
      factStatus: node.factStatus,
    });
  }

  const explanationSummary = `${projectNode.title} deadline moved from ${formatFriendlyDate(
    originalDate,
  )} to ${formatFriendlyDate(normalizedNewDate)}. Graph traversal across your workspace identified ${
    directImpacts.length
  } direct impact(s), ${downstreamImpacts.length} downstream impact(s), and ${
    unaffectedItems.length
  } unaffected item(s).`;

  const baseResult = {
    id: `imp-${randomUUID().slice(0, 10)}`,
    workspaceId,
    changeEvent,
    directImpacts,
    downstreamImpacts,
    unaffectedItems,
    explanationSummary,
    createdAt: new Date().toISOString(),
  };

  const aiResult = await generateExplainableNarrative(baseResult);

  const fullResult: ImpactAnalysisResult = {
    ...baseResult,
    aiNarrative: aiResult.narrative,
    aiStatus: aiResult.aiStatus,
  };

  db.prepare(`
    INSERT INTO impact_analyses (
      id, workspace_id, change_event_json, direct_impacts_json, downstream_impacts_json,
      unaffected_items_json, explanation_summary, ai_narrative, ai_status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    fullResult.id,
    workspaceId,
    JSON.stringify(fullResult.changeEvent),
    JSON.stringify(fullResult.directImpacts),
    JSON.stringify(fullResult.downstreamImpacts),
    JSON.stringify(fullResult.unaffectedItems),
    fullResult.explanationSummary,
    fullResult.aiNarrative,
    fullResult.aiStatus,
    fullResult.createdAt,
  );

  recordAuditLog(workspaceId, {
    actionType: 'RIPPLE_IMPACT_DETECTED',
    targetLabel: `${projectNode.title} (${formatFriendlyDate(originalDate)} -> ${formatFriendlyDate(
      normalizedNewDate,
    )})`,
    status: 'DETECTED',
    executionMode: 'INTERNAL',
    summary: explanationSummary,
    details: {
      analysisId: fullResult.id,
      directCount: directImpacts.length,
      downstreamCount: downstreamImpacts.length,
      extractionMethod: params.extractionMethod,
    },
    actor: 'maYa Ripple Impact Engine',
  });

  return fullResult;
}
