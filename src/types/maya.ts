export type NodeType =
  | 'PERSON'
  | 'PROJECT'
  | 'TASK'
  | 'MEETING'
  | 'DEADLINE'
  | 'DOCUMENT'
  | 'EMAIL'
  | 'SOURCE_RECORD';

export type RelationshipType =
  | 'WORKS_ON'
  | 'BELONGS_TO'
  | 'ASSIGNED_TO'
  | 'DEPENDS_ON'
  | 'RELATES_TO'
  | 'MENTIONS'
  | 'SUPPORTS'
  | 'ATTENDS';

export type FactStatus = 'CONFIRMED' | 'INFERRED';

export type WorkspaceMode = 'PERSONAL' | 'DEMO';

export interface UserProfile {
  id: string;
  email: string;
  displayName: string;
  createdAt: string;
}

export interface WorkspaceInfo {
  id: string;
  ownerUserId: string | null;
  name: string;
  kind: WorkspaceMode;
  createdAt: string;
}

export interface AuthSessionResponse {
  token: string;
  user: UserProfile;
  workspace: WorkspaceInfo;
}

export interface ContextNode {
  id: string;
  workspaceId: string;
  type: NodeType;
  title: string;
  subtitle: string;
  status: string;
  date: string | null; // ISO YYYY-MM-DD or YYYY-MM-DDTHH:mm
  ownerId: string | null;
  projectId: string | null;
  metadata: Record<string, unknown>;
  provenance: string;
  factStatus: FactStatus;
  isDemo: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ContextEdge {
  id: string;
  workspaceId: string;
  sourceId: string;
  targetId: string;
  relationshipType: RelationshipType;
  label: string;
  provenance: string;
  evidenceText: string;
  sourceRecordId: string | null;
  factStatus: FactStatus;
  isDemo: boolean;
  createdAt: string;
}

export interface SourceRecord {
  id: string;
  workspaceId: string;
  sourceType: 'EMAIL' | 'CALENDAR' | 'TASKS' | 'DOCUMENT' | 'SYSTEM';
  externalId: string | null;
  sender: string;
  title: string;
  content: string;
  receivedAt: string;
  parsedEntities: Record<string, unknown>;
  isDemo: boolean;
  processed: boolean;
}

export interface ChangeEvent {
  id: string;
  projectId: string;
  projectTitle: string;
  targetNodeId: string;
  targetNodeTitle: string;
  fieldChanged: string;
  originalValue: string;
  newValue: string;
  sourceRecordId: string;
  sourceRecordTitle: string;
  extractionMethod: 'GEMINI_NLU' | 'DETERMINISTIC_PARSER' | 'DIRECT_USER_UPDATE';
  extractionConfidenceNote: string;
  detectedAt: string;
}

export interface ImpactedItem {
  nodeId: string;
  nodeType: NodeType;
  title: string;
  currentDate: string | null;
  status: string;
  category: 'DIRECT' | 'DOWNSTREAM' | 'UNAFFECTED';
  severity: 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';
  reason: string;
  relationshipPath: string[];
  relationshipChainIds: string[];
  supportingSourceIds: string[];
  supportingEvidence: Array<{
    sourceId: string;
    sourceTitle: string;
    evidenceText: string;
  }>;
  factStatus: FactStatus;
}

export interface ImpactAnalysisResult {
  id: string;
  workspaceId: string;
  changeEvent: ChangeEvent;
  directImpacts: ImpactedItem[];
  downstreamImpacts: ImpactedItem[];
  unaffectedItems: ImpactedItem[];
  explanationSummary: string;
  aiNarrative: string | null;
  aiStatus: 'USED' | 'UNAVAILABLE' | 'SKIPPED';
  createdAt: string;
}

export interface ProposedChangeItem {
  actionType:
    | 'UPDATE_TASK_DUE_DATE'
    | 'RESCHEDULE_MEETING'
    | 'UPDATE_DEADLINE'
    | 'UPDATE_DOCUMENT_TEXT'
    | 'REASSIGN_TASK'
    | 'SEND_NOTIFICATION_DRAFT';
  targetNodeId: string;
  targetTitle: string;
  field: string;
  beforeValue: string;
  afterValue: string;
  permissionScope: string;
  requiresConfirmation: boolean;
  rationale: string;
}

export interface WhatIfPlan {
  id: string;
  workspaceId: string;
  analysisId: string;
  optionKey: 'A' | 'B';
  title: string;
  strategySummary: string;
  proposedChanges: ProposedChangeItem[];
  tasksAffected: Array<{ id: string; title: string; change: string }>;
  meetingsAffected: Array<{ id: string; title: string; change: string }>;
  potentialConflicts: Array<{
    severity: 'WARNING' | 'INFO';
    description: string;
    involvedNodeIds: string[];
  }>;
  advantages: string[];
  tradeoffs: string[];
  requiresUserConfirmation: string[];
  status: 'PROPOSED' | 'SELECTED' | 'DISCARDED';
}

export interface ApprovalItem {
  id: string;
  workspaceId: string;
  planId: string;
  optionKey: 'A' | 'B';
  actionType: ProposedChangeItem['actionType'];
  targetNodeId: string;
  targetLabel: string;
  permissionScope: string;
  permissionValid: boolean;
  permissionReason: string;
  proposedPayload: Record<string, unknown>;
  beforeState: Record<string, unknown>;
  afterState: Record<string, unknown>;
  rationale: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  executionMode: 'SIMULATED_DEMO' | 'SIMULATED_LOCAL' | 'LOCAL_WORKSPACE' | 'LIVE_OAUTH' | 'UNSUPPORTED';
  decidedAt: string | null;
  decisionNote: string | null;
  createdAt: string;
}

export interface AuditLogEntry {
  id: string;
  workspaceId: string;
  approvalId: string | null;
  actionType: string;
  targetLabel: string;
  status: 'EXECUTED_SIMULATED' | 'REJECTED' | 'DETECTED' | 'SIMULATED_PLAN' | 'SYSTEM';
  executionMode: 'SIMULATED_DEMO' | 'SIMULATED_LOCAL' | 'LOCAL_WORKSPACE' | 'LIVE_OAUTH' | 'UNSUPPORTED' | 'INTERNAL';
  summary: string;
  details: Record<string, unknown>;
  actor: string;
  timestamp: string;
}

export interface IntegrationConnector {
  id: string;
  workspaceId: string;
  serviceKey: 'gmail' | 'google_calendar' | 'google_tasks';
  name: string;
  description: string;
  status: 'DISCONNECTED' | 'CONNECTED';
  executionPolicy: string;
  requiredScopes: string[];
  grantedScopes: string[];
  lastSyncAt: string | null;
  setupInstructions: string[];
}

export interface GmailConnectionStatus {
  workspaceId: string;
  serviceAvailable: boolean;
  unavailableReason: string | null;
  status: 'CONNECTED' | 'DISCONNECTED' | 'REVOKED' | 'ERROR';
  googleEmail: string | null;
  scopes: string[];
  lastSyncAt: string | null;
  hasHistoryBaseline: boolean;
  lastError: string | null;
  readOnly: true;
}

export type ExtractionStatus =
  | 'PENDING'
  | 'PROCESSING'
  | 'RETRYING'
  | 'COMPLETED'
  | 'FAILED'
  | 'SKIPPED';

export interface ExtractionPipelineSummary {
  pending: number;
  processing: number;
  retrying: number;
  completed: number;
  failed: number;
  skipped: number;
  rateLimitRpm: number;
  batchSize: number;
}

export interface GmailMessageSummary {
  id: string;
  workspaceId: string;
  gmailMessageId: string;
  threadId: string;
  sender: string;
  recipients: string[];
  subject: string;
  snippet: string;
  bodyText: string;
  receivedAt: string;
  sourceRecordId: string | null;
  extractionStatus: ExtractionStatus;
  extractionError: string | null;
  retryCount: number;
  maxRetries: number;
  nextRetryAt: string | null;
  lastAttemptAt: string | null;
  extractedAt: string | null;
  createdAt: string;
}

export type EmailExtractedItemType =
  | 'PROJECT'
  | 'PERSON'
  | 'TASK'
  | 'DEADLINE'
  | 'MEETING'
  | 'DECISION'
  | 'PLAN_CHANGE'
  | 'CONFLICT';

export type EmailMatchClassification = 'NEW' | 'UPDATE' | 'POSSIBLE_DUPLICATE' | 'CONFLICT';

export interface EmailExtractedItem {
  id: string;
  workspaceId: string;
  messageRowId: string;
  gmailMessageId: string;
  messageSubject: string;
  messageSender: string;
  messageReceivedAt: string;
  itemType: EmailExtractedItemType;
  title: string;
  description: string;
  proposedDate: string | null;
  dateAmbiguous: boolean;
  dateNote: string | null;
  assigneeOrPerson: string | null;
  relatedProjectName: string | null;
  factStatus: FactStatus;
  matchClassification: EmailMatchClassification;
  matchedNodeId: string | null;
  matchedNodeTitle: string | null;
  affectedNodeIds: string[];
  evidenceQuote: string;
  confidenceNote: string;
  status: 'PENDING' | 'ACCEPTED' | 'REJECTED';
  appliedNodeId: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

export interface EmailSuggestedRelationship {
  id: string;
  workspaceId: string;
  messageRowId: string;
  messageSubject: string;
  sourceItemId: string | null;
  sourceNodeId: string | null;
  sourceLabel: string;
  targetItemId: string | null;
  targetNodeId: string | null;
  targetLabel: string;
  relationshipType: RelationshipType;
  rationale: string;
  evidenceQuote: string;
  factStatus: FactStatus;
  status: 'PENDING' | 'ACCEPTED' | 'REJECTED';
  appliedEdgeId: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

export interface EmailInsightsResponse {
  connection: GmailConnectionStatus;
  extractionSummary: ExtractionPipelineSummary;
  messages: GmailMessageSummary[];
  extractedItems: EmailExtractedItem[];
  suggestedRelationships: EmailSuggestedRelationship[];
}

export interface GmailSyncResult {
  fetchedCount: number;
  skippedDuplicates: number;
  queuedForExtraction: number;
  extractedItemsCreated: number;
  suggestedRelationshipsCreated: number;
  syncMode: 'HISTORY_INCREMENTAL' | 'MESSAGE_LIST';
  lastSyncAt: string;
  errors: string[];
}

export interface DashboardSummary {
  workspace: WorkspaceInfo;
  counts: {
    nodes: number;
    edges: number;
    activeProjects: number;
    tasks: number;
    people: number;
    meetings: number;
    documents: number;
    sourceRecords: number;
    upcomingDeadlines: number;
    pendingApprovals: number;
    pendingEmailInsights?: number;
    impactAnalyses: number;
    auditEntries: number;
  };
  activeProjects: ContextNode[];
  upcomingDeadlines: ContextNode[];
  recentChanges: ImpactAnalysisResult[];
  pendingApprovals: ApprovalItem[];
  latestAnalysis: ImpactAnalysisResult | null;
  latestPlans: WhatIfPlan[];
  demoPhase: 'BASELINE' | 'IMPACT_DETECTED' | 'PLAN_SELECTED' | 'EXECUTED';
}
