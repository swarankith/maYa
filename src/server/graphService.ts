import { randomUUID } from 'node:crypto';
import {
  DEMO_WORKSPACE_ID,
  db,
  mapApprovalRow,
  mapAuditRow,
  mapEdgeRow,
  mapNodeRow,
  mapSourceRow,
} from './db.ts';
import type {
  ApprovalItem,
  AuditLogEntry,
  ContextEdge,
  ContextNode,
  FactStatus,
  IntegrationConnector,
  NodeType,
  RelationshipType,
  SourceRecord,
} from '../types/maya.ts';

export function getAllNodes(workspaceId: string): ContextNode[] {
  const rows = db
    .prepare('SELECT * FROM nodes WHERE workspace_id = ? ORDER BY type, title')
    .all(workspaceId) as Record<string, unknown>[];
  return rows.map(mapNodeRow);
}

export function getNodeById(workspaceId: string, id: string): ContextNode | null {
  const row = db
    .prepare('SELECT * FROM nodes WHERE id = ? AND workspace_id = ?')
    .get(id, workspaceId) as Record<string, unknown> | undefined;
  return row ? mapNodeRow(row) : null;
}

export function getAllEdges(workspaceId: string): ContextEdge[] {
  const rows = db
    .prepare('SELECT * FROM edges WHERE workspace_id = ? ORDER BY created_at')
    .all(workspaceId) as Record<string, unknown>[];
  return rows.map(mapEdgeRow);
}

export function getAllSourceRecords(workspaceId: string): SourceRecord[] {
  const rows = db
    .prepare('SELECT * FROM source_records WHERE workspace_id = ? ORDER BY received_at DESC')
    .all(workspaceId) as Record<string, unknown>[];
  return rows.map(mapSourceRow);
}

export function getSourceRecordById(workspaceId: string, id: string): SourceRecord | null {
  const row = db
    .prepare('SELECT * FROM source_records WHERE id = ? AND workspace_id = ?')
    .get(id, workspaceId) as Record<string, unknown> | undefined;
  return row ? mapSourceRow(row) : null;
}

export function createNode(
  workspaceId: string,
  input: {
    type: NodeType;
    title: string;
    subtitle?: string;
    status?: string;
    date?: string | null;
    ownerId?: string | null;
    projectId?: string | null;
    metadata?: Record<string, unknown>;
    provenance?: string;
    factStatus?: FactStatus;
  },
  actorName = 'Workspace User',
): ContextNode {
  const now = new Date().toISOString();
  const isDemo = workspaceId === DEMO_WORKSPACE_ID;
  const id = `node-${randomUUID().slice(0, 10)}`;

  // Validate ownerId / projectId belong to same workspace if supplied
  let validOwnerId: string | null = null;
  if (input.ownerId) {
    const owner = getNodeById(workspaceId, input.ownerId);
    if (!owner) {
      throw new Error('Referenced owner node does not exist in this workspace.');
    }
    validOwnerId = owner.id;
  }

  let validProjectId: string | null = null;
  if (input.projectId) {
    const proj = getNodeById(workspaceId, input.projectId);
    if (!proj) {
      throw new Error('Referenced project node does not exist in this workspace.');
    }
    validProjectId = proj.id;
  }

  const node: ContextNode = {
    id,
    workspaceId,
    type: input.type,
    title: input.title.trim(),
    subtitle: (input.subtitle ?? '').trim(),
    status: (input.status ?? 'Active').trim(),
    date: input.date ?? null,
    ownerId: validOwnerId,
    projectId: validProjectId,
    metadata: input.metadata ?? {},
    provenance:
      input.provenance ?? (isDemo ? 'Manual Entry (DEMO MODE)' : 'User Workspace Entry'),
    factStatus: input.factStatus ?? 'CONFIRMED',
    isDemo,
    createdAt: now,
    updatedAt: now,
  };

  db.prepare(`
    INSERT INTO nodes (
      id, workspace_id, type, title, subtitle, status, date, owner_id, project_id,
      metadata_json, provenance, fact_status, is_demo, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    node.id,
    workspaceId,
    node.type,
    node.title,
    node.subtitle,
    node.status,
    node.date,
    node.ownerId,
    node.projectId,
    JSON.stringify(node.metadata),
    node.provenance,
    node.factStatus,
    isDemo ? 1 : 0,
    node.createdAt,
    node.updatedAt,
  );

  // If a TASK, DEADLINE, MEETING, or DOCUMENT specifies a projectId, auto-link cleanly if desired?
  // Let explicit edge creation or caller control relationships, keeping graph accurate.
  recordAuditLog(workspaceId, {
    actionType: 'GRAPH_NODE_CREATED',
    targetLabel: `${node.type}: ${node.title}`,
    status: 'SYSTEM',
    executionMode: isDemo ? 'SIMULATED_DEMO' : 'LOCAL_WORKSPACE',
    summary: `Added ${node.type.toLowerCase()} "${node.title}" (${node.factStatus}).`,
    details: { nodeId: node.id, provenance: node.provenance },
    actor: actorName,
  });

  return node;
}

export function updateNode(
  workspaceId: string,
  id: string,
  patch: Partial<{
    title: string;
    subtitle: string;
    status: string;
    date: string | null;
    factStatus: FactStatus;
    provenance: string;
    metadata: Record<string, unknown>;
  }>,
): ContextNode | null {
  const existing = getNodeById(workspaceId, id);
  if (!existing) return null;

  const updated: ContextNode = {
    ...existing,
    title: patch.title !== undefined ? patch.title.trim() : existing.title,
    subtitle: patch.subtitle !== undefined ? patch.subtitle.trim() : existing.subtitle,
    status: patch.status !== undefined ? patch.status.trim() : existing.status,
    date: patch.date !== undefined ? patch.date : existing.date,
    factStatus: patch.factStatus !== undefined ? patch.factStatus : existing.factStatus,
    provenance: patch.provenance !== undefined ? patch.provenance : existing.provenance,
    metadata: patch.metadata !== undefined ? { ...existing.metadata, ...patch.metadata } : existing.metadata,
    updatedAt: new Date().toISOString(),
  };

  db.prepare(`
    UPDATE nodes
    SET title = ?, subtitle = ?, status = ?, date = ?, fact_status = ?,
        provenance = ?, metadata_json = ?, updated_at = ?
    WHERE id = ? AND workspace_id = ?
  `).run(
    updated.title,
    updated.subtitle,
    updated.status,
    updated.date,
    updated.factStatus,
    updated.provenance,
    JSON.stringify(updated.metadata),
    updated.updatedAt,
    id,
    workspaceId,
  );

  return updated;
}

export function deleteNode(workspaceId: string, id: string, actorName = 'Workspace User'): boolean {
  const existing = getNodeById(workspaceId, id);
  if (!existing) return false;

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM edges WHERE workspace_id = ? AND (source_id = ? OR target_id = ?)').run(
      workspaceId,
      id,
      id,
    );
    db.prepare('DELETE FROM nodes WHERE id = ? AND workspace_id = ?').run(id, workspaceId);
  });
  tx();

  recordAuditLog(workspaceId, {
    actionType: 'GRAPH_NODE_DELETED',
    targetLabel: `${existing.type}: ${existing.title}`,
    status: 'SYSTEM',
    executionMode: workspaceId === DEMO_WORKSPACE_ID ? 'SIMULATED_DEMO' : 'LOCAL_WORKSPACE',
    summary: `Deleted ${existing.type.toLowerCase()} "${existing.title}" and its connected edges.`,
    details: { nodeId: id },
    actor: actorName,
  });

  return true;
}

export function createEdge(
  workspaceId: string,
  input: {
    sourceId: string;
    targetId: string;
    relationshipType: RelationshipType;
    label?: string;
    provenance?: string;
    evidenceText?: string;
    sourceRecordId?: string | null;
    factStatus?: FactStatus;
  },
  actorName = 'Workspace User',
): ContextEdge {
  const sourceNode = getNodeById(workspaceId, input.sourceId);
  const targetNode = getNodeById(workspaceId, input.targetId);
  if (!sourceNode || !targetNode) {
    throw new Error('Both sourceId and targetId must belong to your active workspace.');
  }

  if (input.sourceRecordId) {
    const src = getSourceRecordById(workspaceId, input.sourceRecordId);
    if (!src) {
      throw new Error('Referenced source record does not belong to your active workspace.');
    }
  }

  const duplicateEdge = db
    .prepare(
      'SELECT id FROM edges WHERE workspace_id = ? AND source_id = ? AND target_id = ? AND relationship_type = ?',
    )
    .get(workspaceId, input.sourceId, input.targetId, input.relationshipType) as
    | { id: string }
    | undefined;
  if (duplicateEdge) {
    throw new Error(
      `A ${input.relationshipType} relationship between "${sourceNode.title}" and "${targetNode.title}" already exists in your workspace.`,
    );
  }

  const now = new Date().toISOString();
  const isDemo = workspaceId === DEMO_WORKSPACE_ID;
  const id = `edge-${randomUUID().slice(0, 10)}`;
  const edge: ContextEdge = {
    id,
    workspaceId,
    sourceId: input.sourceId,
    targetId: input.targetId,
    relationshipType: input.relationshipType,
    label: (input.label ?? input.relationshipType.toLowerCase().replace(/_/g, ' ')).trim(),
    provenance: input.provenance ?? (isDemo ? 'Manual Demo Link' : 'User Relationship Link'),
    evidenceText: (input.evidenceText ?? `Linked ${sourceNode.title} -> ${targetNode.title}`).trim(),
    sourceRecordId: input.sourceRecordId ?? null,
    factStatus: input.factStatus ?? 'CONFIRMED',
    isDemo,
    createdAt: now,
  };

  db.prepare(`
    INSERT INTO edges (
      id, workspace_id, source_id, target_id, relationship_type, label, provenance,
      evidence_text, source_record_id, fact_status, is_demo, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    edge.id,
    workspaceId,
    edge.sourceId,
    edge.targetId,
    edge.relationshipType,
    edge.label,
    edge.provenance,
    edge.evidenceText,
    edge.sourceRecordId,
    edge.factStatus,
    isDemo ? 1 : 0,
    edge.createdAt,
  );

  recordAuditLog(workspaceId, {
    actionType: 'GRAPH_EDGE_CREATED',
    targetLabel: `${sourceNode.title} -> ${targetNode.title}`,
    status: 'SYSTEM',
    executionMode: isDemo ? 'SIMULATED_DEMO' : 'LOCAL_WORKSPACE',
    summary: `Created ${edge.relationshipType} relationship (${edge.factStatus}).`,
    details: { edgeId: edge.id, evidence: edge.evidenceText },
    actor: actorName,
  });

  return edge;
}

export function deleteEdge(workspaceId: string, id: string, actorName = 'Workspace User'): boolean {
  const existing = db
    .prepare('SELECT * FROM edges WHERE id = ? AND workspace_id = ?')
    .get(id, workspaceId) as Record<string, unknown> | undefined;
  if (!existing) return false;

  db.prepare('DELETE FROM edges WHERE id = ? AND workspace_id = ?').run(id, workspaceId);

  recordAuditLog(workspaceId, {
    actionType: 'GRAPH_EDGE_DELETED',
    targetLabel: `${String(existing.relationship_type)} (${id})`,
    status: 'SYSTEM',
    executionMode: workspaceId === DEMO_WORKSPACE_ID ? 'SIMULATED_DEMO' : 'LOCAL_WORKSPACE',
    summary: `Removed relationship link "${String(existing.label)}".`,
    details: { edgeId: id },
    actor: actorName,
  });

  return true;
}

export function upsertSourceRecord(workspaceId: string, record: SourceRecord): SourceRecord {
  const isDemo = workspaceId === DEMO_WORKSPACE_ID;
  db.prepare(`
    INSERT OR REPLACE INTO source_records (
      id, workspace_id, source_type, external_id, sender, title, content, received_at,
      parsed_entities_json, is_demo, processed
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id,
    workspaceId,
    record.sourceType,
    record.externalId,
    record.sender,
    record.title,
    record.content,
    record.receivedAt,
    JSON.stringify(record.parsedEntities),
    isDemo ? 1 : 0,
    record.processed ? 1 : 0,
  );
  return { ...record, workspaceId, isDemo };
}

export function createSourceRecord(
  workspaceId: string,
  input: {
    sourceType: SourceRecord['sourceType'];
    sender: string;
    title: string;
    content: string;
    projectId?: string | null;
  },
  actorName = 'Workspace User',
): SourceRecord {
  const isDemo = workspaceId === DEMO_WORKSPACE_ID;
  const now = new Date().toISOString();
  const record: SourceRecord = {
    id: `src-${randomUUID().slice(0, 10)}`,
    workspaceId,
    sourceType: input.sourceType,
    externalId: null,
    sender: input.sender.trim() || actorName,
    title: input.title.trim(),
    content: input.content.trim(),
    receivedAt: now,
    parsedEntities: input.projectId ? { projectId: input.projectId } : {},
    isDemo,
    processed: true,
  };
  upsertSourceRecord(workspaceId, record);

  // Also create a corresponding SOURCE_RECORD or EMAIL node in the graph for visibility
  const nodeType: NodeType = input.sourceType === 'EMAIL' ? 'EMAIL' : 'SOURCE_RECORD';
  const node = createNode(
    workspaceId,
    {
      type: nodeType,
      title: record.title,
      subtitle: `From ${record.sender}`,
      status: 'Captured',
      date: now.slice(0, 16),
      projectId: input.projectId ?? null,
      metadata: { sourceRecordId: record.id },
      provenance: `Source Record (${record.sourceType})`,
      factStatus: 'CONFIRMED',
    },
    actorName,
  );

  if (input.projectId) {
    const project = getNodeById(workspaceId, input.projectId);
    if (project) {
      createEdge(
        workspaceId,
        {
          sourceId: node.id,
          targetId: project.id,
          relationshipType: 'SUPPORTS',
          label: 'supports context',
          evidenceText: record.content.slice(0, 180),
          sourceRecordId: record.id,
          factStatus: 'CONFIRMED',
        },
        actorName,
      );
    }
  }

  return record;
}

export function deleteSourceRecord(workspaceId: string, id: string): boolean {
  const result = db
    .prepare('DELETE FROM source_records WHERE id = ? AND workspace_id = ?')
    .run(id, workspaceId);
  return result.changes > 0;
}

export function getAllApprovals(workspaceId: string): ApprovalItem[] {
  const rows = db
    .prepare('SELECT * FROM approvals WHERE workspace_id = ? ORDER BY created_at DESC')
    .all(workspaceId) as Record<string, unknown>[];
  return rows.map(mapApprovalRow);
}

export function getAllAuditLogs(workspaceId: string): AuditLogEntry[] {
  const rows = db
    .prepare('SELECT * FROM audit_logs WHERE workspace_id = ? ORDER BY timestamp DESC')
    .all(workspaceId) as Record<string, unknown>[];
  return rows.map(mapAuditRow);
}

export function recordAuditLog(
  workspaceId: string,
  entry: {
    approvalId?: string | null;
    actionType: string;
    targetLabel: string;
    status: AuditLogEntry['status'];
    executionMode: AuditLogEntry['executionMode'];
    summary: string;
    details?: Record<string, unknown>;
    actor?: string;
  },
): AuditLogEntry {
  const log: AuditLogEntry = {
    id: `audit-${randomUUID().slice(0, 10)}`,
    workspaceId,
    approvalId: entry.approvalId ?? null,
    actionType: entry.actionType,
    targetLabel: entry.targetLabel,
    status: entry.status,
    executionMode: entry.executionMode,
    summary: entry.summary,
    details: entry.details ?? {},
    actor: entry.actor ?? 'maYa Policy Engine',
    timestamp: new Date().toISOString(),
  };

  db.prepare(`
    INSERT INTO audit_logs (
      id, workspace_id, approval_id, action_type, target_label, status, execution_mode,
      summary, details_json, actor, timestamp
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    log.id,
    workspaceId,
    log.approvalId,
    log.actionType,
    log.targetLabel,
    log.status,
    log.executionMode,
    log.summary,
    JSON.stringify(log.details),
    log.actor,
    log.timestamp,
  );

  return log;
}

export function getIntegrations(workspaceId: string): IntegrationConnector[] {
  const rows = db
    .prepare('SELECT * FROM integrations WHERE workspace_id = ? ORDER BY name')
    .all(workspaceId) as Record<string, unknown>[];
  return rows.map((row) => ({
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    serviceKey: row.service_key as IntegrationConnector['serviceKey'],
    name: String(row.name),
    description: String(row.description),
    status: row.status as IntegrationConnector['status'],
    executionPolicy: String(row.execution_policy),
    requiredScopes: JSON.parse(String(row.required_scopes_json ?? '[]')) as string[],
    grantedScopes: JSON.parse(String(row.granted_scopes_json ?? '[]')) as string[],
    lastSyncAt: row.last_sync_at ? String(row.last_sync_at) : null,
    setupInstructions: JSON.parse(String(row.setup_instructions_json ?? '[]')) as string[],
  }));
}
