import { randomUUID } from 'node:crypto';
import { DEMO_WORKSPACE_ID, db } from './db.ts';
import { getExtractionSummary } from './extractionQueue.ts';
import { getGmailConnectionStatus, getGmailMessages } from './gmailService.ts';
import { getAllNodes, getNodeById } from './graphService.ts';
import type {
  ContextNode,
  EmailExtractedItem,
  EmailExtractedItemType,
  EmailInsightsResponse,
  EmailSuggestedRelationship,
  FactStatus,
  NodeType,
  RelationshipType,
} from '../types/maya.ts';

function mapExtractedItemTypeToNodeType(itemType: EmailExtractedItemType): NodeType {
  switch (itemType) {
    case 'PROJECT':
      return 'PROJECT';
    case 'PERSON':
      return 'PERSON';
    case 'TASK':
      return 'TASK';
    case 'DEADLINE':
      return 'DEADLINE';
    case 'MEETING':
      return 'MEETING';
    case 'DECISION':
    case 'PLAN_CHANGE':
    case 'CONFLICT':
    default:
      return 'DOCUMENT';
  }
}

export function getExtractedItems(workspaceId: string): EmailExtractedItem[] {
  if (workspaceId === DEMO_WORKSPACE_ID) return [];
  const rows = db
    .prepare(`
      SELECT ei.*, gm.subject AS msg_subject, gm.sender AS msg_sender, gm.received_at AS msg_received_at
      FROM email_extracted_items ei
      JOIN gmail_messages gm ON ei.message_row_id = gm.id AND ei.workspace_id = gm.workspace_id
      WHERE ei.workspace_id = ?
      ORDER BY
        CASE WHEN ei.status = 'PENDING' THEN 0 ELSE 1 END,
        ei.created_at DESC
    `)
    .all(workspaceId) as Record<string, unknown>[];

  return rows.map((row) => ({
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    messageRowId: String(row.message_row_id),
    gmailMessageId: String(row.gmail_message_id),
    messageSubject: String(row.msg_subject),
    messageSender: String(row.msg_sender),
    messageReceivedAt: String(row.msg_received_at),
    itemType: String(row.item_type) as EmailExtractedItemType,
    title: String(row.title),
    description: String(row.description ?? ''),
    proposedDate: row.proposed_date ? String(row.proposed_date) : null,
    dateAmbiguous: Boolean(row.date_ambiguous),
    dateNote: row.date_note ? String(row.date_note) : null,
    assigneeOrPerson: row.assignee_or_person ? String(row.assignee_or_person) : null,
    relatedProjectName: row.related_project_name ? String(row.related_project_name) : null,
    factStatus: String(row.fact_status) as FactStatus,
    matchClassification: String(
      row.match_classification,
    ) as EmailExtractedItem['matchClassification'],
    matchedNodeId: row.matched_node_id ? String(row.matched_node_id) : null,
    matchedNodeTitle: row.matched_node_title ? String(row.matched_node_title) : null,
    affectedNodeIds: JSON.parse(String(row.affected_node_ids_json ?? '[]')) as string[],
    evidenceQuote: String(row.evidence_quote ?? ''),
    confidenceNote: String(row.confidence_note ?? ''),
    status: String(row.status) as EmailExtractedItem['status'],
    appliedNodeId: row.applied_node_id ? String(row.applied_node_id) : null,
    reviewedAt: row.reviewed_at ? String(row.reviewed_at) : null,
    createdAt: String(row.created_at),
  }));
}

export function getSuggestedRelationships(workspaceId: string): EmailSuggestedRelationship[] {
  if (workspaceId === DEMO_WORKSPACE_ID) return [];
  const rows = db
    .prepare(`
      SELECT er.*, gm.subject AS msg_subject
      FROM email_suggested_relationships er
      JOIN gmail_messages gm ON er.message_row_id = gm.id AND er.workspace_id = gm.workspace_id
      WHERE er.workspace_id = ?
      ORDER BY
        CASE WHEN er.status = 'PENDING' THEN 0 ELSE 1 END,
        er.created_at DESC
    `)
    .all(workspaceId) as Record<string, unknown>[];

  return rows.map((row) => ({
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    messageRowId: String(row.message_row_id),
    messageSubject: String(row.msg_subject),
    sourceItemId: row.source_item_id ? String(row.source_item_id) : null,
    sourceNodeId: row.source_node_id ? String(row.source_node_id) : null,
    sourceLabel: String(row.source_label),
    targetItemId: row.target_item_id ? String(row.target_item_id) : null,
    targetNodeId: row.target_node_id ? String(row.target_node_id) : null,
    targetLabel: String(row.target_label),
    relationshipType: String(row.relationship_type) as RelationshipType,
    rationale: String(row.rationale),
    evidenceQuote: String(row.evidence_quote),
    factStatus: String(row.fact_status) as FactStatus,
    status: String(row.status) as EmailSuggestedRelationship['status'],
    appliedEdgeId: row.applied_edge_id ? String(row.applied_edge_id) : null,
    reviewedAt: row.reviewed_at ? String(row.reviewed_at) : null,
    createdAt: String(row.created_at),
  }));
}

export function getEmailInsights(workspaceId: string, originHint?: string): EmailInsightsResponse {
  return {
    connection: getGmailConnectionStatus(workspaceId, originHint),
    extractionSummary: getExtractionSummary(workspaceId),
    messages: getGmailMessages(workspaceId),
    extractedItems: getExtractedItems(workspaceId),
    suggestedRelationships: getSuggestedRelationships(workspaceId),
  };
}

export function acceptExtractedItem(
  workspaceId: string,
  itemId: string,
  input?: {
    title?: string;
    description?: string;
    itemType?: EmailExtractedItemType;
    proposedDate?: string | null;
    factStatus?: FactStatus;
    actionMode?: 'CREATE_NEW' | 'UPDATE_MATCHED';
    targetNodeId?: string;
  },
  actorName = 'Workspace User',
): { item: EmailExtractedItem; node: ContextNode } {
  if (workspaceId === DEMO_WORKSPACE_ID) {
    throw new Error('DEMO MODE cannot accept personal Gmail insights.');
  }

  const row = db
    .prepare(`
      SELECT ei.*, gm.subject AS msg_subject, gm.sender AS msg_sender, gm.source_record_id AS msg_source_id
      FROM email_extracted_items ei
      JOIN gmail_messages gm ON ei.message_row_id = gm.id AND ei.workspace_id = gm.workspace_id
      WHERE ei.id = ? AND ei.workspace_id = ?
    `)
    .get(itemId, workspaceId) as Record<string, unknown> | undefined;

  if (!row) {
    throw new Error('Extracted email item not found in your active workspace.');
  }
  if (String(row.status) !== 'PENDING') {
    throw new Error(`Item has already been ${String(row.status).toLowerCase()}.`);
  }

  const finalTitle = (input?.title ?? String(row.title)).trim();
  if (!finalTitle) {
    throw new Error('Title cannot be empty when accepting an email insight.');
  }

  const finalItemType = (input?.itemType ?? String(row.item_type)) as EmailExtractedItemType;
  const finalDescription = (input?.description ?? String(row.description ?? '')).trim();
  const finalDate =
    input?.proposedDate !== undefined
      ? input.proposedDate?.trim() || null
      : row.proposed_date
        ? String(row.proposed_date)
        : null;
  const finalFactStatus = (input?.factStatus ?? String(row.fact_status)) as FactStatus;
  const provenanceLabel = `Gmail: ${String(row.msg_subject)} (${String(row.msg_sender)})`;
  const sourceRecordId = row.msg_source_id ? String(row.msg_source_id) : null;
  const gmailMessageId = String(row.gmail_message_id);
  const evidenceQuote = String(row.evidence_quote ?? '');
  const now = new Date().toISOString();

  const candidateMatchedId =
    input?.targetNodeId?.trim() || (row.matched_node_id ? String(row.matched_node_id) : null);
  const shouldUpdateMatched =
    input?.actionMode === 'UPDATE_MATCHED' ||
    (input?.actionMode !== 'CREATE_NEW' &&
      Boolean(candidateMatchedId) &&
      (String(row.match_classification) === 'UPDATE' ||
        String(row.match_classification) === 'CONFLICT'));

  let appliedNode!: ContextNode;

  const tx = db.transaction(() => {
    if (shouldUpdateMatched && candidateMatchedId) {
      const existingNode = getNodeById(workspaceId, candidateMatchedId);
      if (!existingNode) {
        throw new Error('Target matched node does not exist in your active workspace.');
      }

      const nextMetadata = {
        ...existingNode.metadata,
        lastEmailSourceRecordId: sourceRecordId,
        lastGmailMessageId: gmailMessageId,
        lastEvidenceQuote: evidenceQuote,
      };
      const nextDate = finalDate !== null ? finalDate : existingNode.date;
      const nextSubtitle = finalDescription || existingNode.subtitle;

      db.prepare(`
        UPDATE nodes
        SET title = ?, subtitle = ?, date = ?, fact_status = ?, provenance = ?,
            metadata_json = ?, updated_at = ?
        WHERE id = ? AND workspace_id = ?
      `).run(
        finalTitle,
        nextSubtitle,
        nextDate,
        finalFactStatus,
        provenanceLabel,
        JSON.stringify(nextMetadata),
        now,
        existingNode.id,
        workspaceId,
      );

      appliedNode = getNodeById(workspaceId, existingNode.id)!;
    } else {
      const nodeId = `node-${randomUUID().slice(0, 10)}`;
      const nodeType = mapExtractedItemTypeToNodeType(finalItemType);

      // Try linking to an existing workspace project if relatedProjectName was supplied
      let relatedProjectId: string | null = null;
      const relProjName = row.related_project_name ? String(row.related_project_name) : '';
      if (relProjName && nodeType !== 'PROJECT') {
        const proj = getAllNodes(workspaceId).find(
          (n) => n.type === 'PROJECT' && n.title.toLowerCase() === relProjName.toLowerCase(),
        );
        if (proj) relatedProjectId = proj.id;
      }

      const metadata = {
        sourceRecordId,
        gmailMessageId,
        evidenceQuote,
        extractedItemType: finalItemType,
      };

      db.prepare(`
        INSERT INTO nodes (
          id, workspace_id, type, title, subtitle, status, date, owner_id, project_id,
          metadata_json, provenance, fact_status, is_demo, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'Active', ?, NULL, ?, ?, ?, ?, 0, ?, ?)
      `).run(
        nodeId,
        workspaceId,
        nodeType,
        finalTitle,
        finalDescription,
        finalDate,
        relatedProjectId,
        JSON.stringify(metadata),
        provenanceLabel,
        finalFactStatus,
        now,
        now,
      );

      appliedNode = getNodeById(workspaceId, nodeId)!;
    }

    db.prepare(`
      UPDATE email_extracted_items
      SET status = 'ACCEPTED',
          edited_payload_json = ?,
          applied_node_id = ?,
          reviewed_at = ?
      WHERE id = ? AND workspace_id = ?
    `).run(
      JSON.stringify({
        title: finalTitle,
        description: finalDescription,
        itemType: finalItemType,
        proposedDate: finalDate,
        factStatus: finalFactStatus,
      }),
      appliedNode.id,
      now,
      itemId,
      workspaceId,
    );

    // Update any suggested relationships in the same workspace that referenced this extracted item
    db.prepare(`
      UPDATE email_suggested_relationships
      SET source_node_id = ?
      WHERE workspace_id = ? AND source_item_id = ? AND source_node_id IS NULL
    `).run(appliedNode.id, workspaceId, itemId);

    db.prepare(`
      UPDATE email_suggested_relationships
      SET target_node_id = ?
      WHERE workspace_id = ? AND target_item_id = ? AND target_node_id IS NULL
    `).run(appliedNode.id, workspaceId, itemId);

    db.prepare(`
      INSERT INTO audit_logs (
        id, workspace_id, approval_id, action_type, target_label, status, execution_mode,
        summary, details_json, actor, timestamp
      ) VALUES (?, ?, NULL, ?, ?, 'EXECUTED_SIMULATED', 'LOCAL_WORKSPACE', ?, ?, ?, ?)
    `).run(
      `audit-${randomUUID().slice(0, 10)}`,
      workspaceId,
      shouldUpdateMatched ? 'EMAIL_INSIGHT_UPDATED_NODE' : 'EMAIL_INSIGHT_ACCEPTED',
      `${appliedNode.type}: ${appliedNode.title}`,
      `${shouldUpdateMatched ? 'Updated existing node' : 'Added node'} from reviewed Gmail insight "${finalTitle}" (source: ${String(row.msg_subject)}).`,
      JSON.stringify({
        extractedItemId: itemId,
        appliedNodeId: appliedNode.id,
        gmailMessageId,
        sourceRecordId,
        evidenceQuote,
      }),
      actorName,
      now,
    );
  });

  tx();

  const updatedItem = getExtractedItems(workspaceId).find((i) => i.id === itemId)!;
  return { item: updatedItem, node: appliedNode };
}

export function rejectExtractedItem(
  workspaceId: string,
  itemId: string,
  actorName = 'Workspace User',
): EmailExtractedItem {
  if (workspaceId === DEMO_WORKSPACE_ID) {
    throw new Error('DEMO MODE cannot review personal Gmail insights.');
  }

  const row = db
    .prepare('SELECT * FROM email_extracted_items WHERE id = ? AND workspace_id = ?')
    .get(itemId, workspaceId) as Record<string, unknown> | undefined;
  if (!row) {
    throw new Error('Extracted email item not found in your active workspace.');
  }
  if (String(row.status) !== 'PENDING') {
    throw new Error(`Item has already been ${String(row.status).toLowerCase()}.`);
  }

  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    db.prepare(
      'UPDATE email_extracted_items SET status = ?, reviewed_at = ? WHERE id = ? AND workspace_id = ?',
    ).run('REJECTED', now, itemId, workspaceId);

    db.prepare(`
      INSERT INTO audit_logs (
        id, workspace_id, approval_id, action_type, target_label, status, execution_mode,
        summary, details_json, actor, timestamp
      ) VALUES (?, ?, NULL, ?, ?, 'REJECTED', 'LOCAL_WORKSPACE', ?, ?, ?, ?)
    `).run(
      `audit-${randomUUID().slice(0, 10)}`,
      workspaceId,
      'EMAIL_INSIGHT_REJECTED',
      String(row.title),
      `Rejected extracted Gmail insight "${String(row.title)}". Zero workspace changes applied.`,
      JSON.stringify({ extractedItemId: itemId, gmailMessageId: String(row.gmail_message_id) }),
      actorName,
      now,
    );
  });
  tx();

  return getExtractedItems(workspaceId).find((i) => i.id === itemId)!;
}

export function acceptSuggestedRelationship(
  workspaceId: string,
  relId: string,
  overrides?: { sourceNodeId?: string; targetNodeId?: string },
  actorName = 'Workspace User',
): { relationship: EmailSuggestedRelationship; edgeId: string } {
  if (workspaceId === DEMO_WORKSPACE_ID) {
    throw new Error('DEMO MODE cannot accept personal Gmail relationships.');
  }

  const row = db
    .prepare(`
      SELECT er.*, gm.subject AS msg_subject, gm.source_record_id AS msg_source_id
      FROM email_suggested_relationships er
      JOIN gmail_messages gm ON er.message_row_id = gm.id AND er.workspace_id = gm.workspace_id
      WHERE er.id = ? AND er.workspace_id = ?
    `)
    .get(relId, workspaceId) as Record<string, unknown> | undefined;

  if (!row) {
    throw new Error('Suggested relationship not found in your active workspace.');
  }
  if (String(row.status) !== 'PENDING') {
    throw new Error(`Relationship has already been ${String(row.status).toLowerCase()}.`);
  }

  const workspaceNodes = getAllNodes(workspaceId);
  const resolveNode = (
    overrideId: string | undefined,
    storedNodeId: unknown,
    itemId: unknown,
    fallbackLabel: string,
  ): ContextNode | null => {
    if (overrideId?.trim()) {
      return getNodeById(workspaceId, overrideId.trim());
    }
    if (storedNodeId) {
      const n = getNodeById(workspaceId, String(storedNodeId));
      if (n) return n;
    }
    if (itemId) {
      const itemRow = db
        .prepare('SELECT applied_node_id FROM email_extracted_items WHERE id = ? AND workspace_id = ?')
        .get(String(itemId), workspaceId) as { applied_node_id: string | null } | undefined;
      if (itemRow?.applied_node_id) {
        const n = getNodeById(workspaceId, itemRow.applied_node_id);
        if (n) return n;
      }
    }
    const lower = fallbackLabel.trim().toLowerCase();
    return workspaceNodes.find((n) => n.title.toLowerCase() === lower) ?? null;
  };

  const sourceNode = resolveNode(
    overrides?.sourceNodeId,
    row.source_node_id,
    row.source_item_id,
    String(row.source_label),
  );
  const targetNode = resolveNode(
    overrides?.targetNodeId,
    row.target_node_id,
    row.target_item_id,
    String(row.target_label),
  );

  if (!sourceNode || !targetNode) {
    throw new Error(
      `Both entities ("${String(row.source_label)}" and "${String(row.target_label)}") must exist or be accepted in your workspace before approving this relationship.`,
    );
  }

  const edgeId = `edge-${randomUUID().slice(0, 10)}`;
  const now = new Date().toISOString();
  const relType = String(row.relationship_type) as RelationshipType;
  const provenance = `Gmail: ${String(row.msg_subject)}`;
  const sourceRecordId = row.msg_source_id ? String(row.msg_source_id) : null;

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO edges (
        id, workspace_id, source_id, target_id, relationship_type, label, provenance,
        evidence_text, source_record_id, fact_status, is_demo, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `).run(
      edgeId,
      workspaceId,
      sourceNode.id,
      targetNode.id,
      relType,
      relType.toLowerCase().replace(/_/g, ' '),
      provenance,
      String(row.evidence_quote),
      sourceRecordId,
      String(row.fact_status),
      now,
    );

    db.prepare(`
      UPDATE email_suggested_relationships
      SET status = 'ACCEPTED',
          source_node_id = ?,
          target_node_id = ?,
          applied_edge_id = ?,
          reviewed_at = ?
      WHERE id = ? AND workspace_id = ?
    `).run(sourceNode.id, targetNode.id, edgeId, now, relId, workspaceId);

    db.prepare(`
      INSERT INTO audit_logs (
        id, workspace_id, approval_id, action_type, target_label, status, execution_mode,
        summary, details_json, actor, timestamp
      ) VALUES (?, ?, NULL, ?, ?, 'EXECUTED_SIMULATED', 'LOCAL_WORKSPACE', ?, ?, ?, ?)
    `).run(
      `audit-${randomUUID().slice(0, 10)}`,
      workspaceId,
      'EMAIL_RELATIONSHIP_ACCEPTED',
      `${sourceNode.title} -> ${targetNode.title}`,
      `Approved Gmail-suggested ${relType} link between "${sourceNode.title}" and "${targetNode.title}".`,
      JSON.stringify({
        suggestedRelationshipId: relId,
        edgeId,
        sourceRecordId,
        evidenceQuote: String(row.evidence_quote),
      }),
      actorName,
      now,
    );
  });

  tx();

  const updatedRel = getSuggestedRelationships(workspaceId).find((r) => r.id === relId)!;
  return { relationship: updatedRel, edgeId };
}

export function rejectSuggestedRelationship(
  workspaceId: string,
  relId: string,
  actorName = 'Workspace User',
): EmailSuggestedRelationship {
  if (workspaceId === DEMO_WORKSPACE_ID) {
    throw new Error('DEMO MODE cannot review personal Gmail relationships.');
  }

  const row = db
    .prepare('SELECT * FROM email_suggested_relationships WHERE id = ? AND workspace_id = ?')
    .get(relId, workspaceId) as Record<string, unknown> | undefined;
  if (!row) {
    throw new Error('Suggested relationship not found in your active workspace.');
  }
  if (String(row.status) !== 'PENDING') {
    throw new Error(`Relationship has already been ${String(row.status).toLowerCase()}.`);
  }

  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    db.prepare(
      'UPDATE email_suggested_relationships SET status = ?, reviewed_at = ? WHERE id = ? AND workspace_id = ?',
    ).run('REJECTED', now, relId, workspaceId);

    db.prepare(`
      INSERT INTO audit_logs (
        id, workspace_id, approval_id, action_type, target_label, status, execution_mode,
        summary, details_json, actor, timestamp
      ) VALUES (?, ?, NULL, ?, ?, 'REJECTED', 'LOCAL_WORKSPACE', ?, ?, ?, ?)
    `).run(
      `audit-${randomUUID().slice(0, 10)}`,
      workspaceId,
      'EMAIL_RELATIONSHIP_REJECTED',
      `${String(row.source_label)} -> ${String(row.target_label)}`,
      `Rejected suggested ${String(row.relationship_type)} relationship. Zero graph edges created.`,
      JSON.stringify({ suggestedRelationshipId: relId }),
      actorName,
      now,
    );
  });

  tx();

  return getSuggestedRelationships(workspaceId).find((r) => r.id === relId)!;
}
