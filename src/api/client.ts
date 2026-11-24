import type {
  ApprovalItem,
  AuditLogEntry,
  AuthSessionResponse,
  ContextEdge,
  ContextNode,
  DashboardSummary,
  EmailExtractedItem,
  EmailExtractedItemType,
  EmailInsightsResponse,
  EmailSuggestedRelationship,
  ExtractionPipelineSummary,
  FactStatus,
  GmailConnectionStatus,
  GmailSyncResult,
  ImpactAnalysisResult,
  IntegrationConnector,
  SourceRecord,
  UserProfile,
  WhatIfPlan,
  WorkspaceInfo,
  WorkspaceMode,
} from '../types/maya.ts';

async function requestJson<T>(
  url: string,
  init?: RequestInit,
  token?: string | null,
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((init?.headers as Record<string, string>) ?? {}),
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(url, {
    ...init,
    headers,
  });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

function prefixForMode(mode: WorkspaceMode): string {
  return mode === 'DEMO' ? '/api/demo' : '/api';
}

export const authApi = {
  register: (payload: { email: string; password: string; displayName?: string }) =>
    requestJson<AuthSessionResponse>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  login: (payload: { email: string; password: string }) =>
    requestJson<AuthSessionResponse>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  logout: (token: string | null) =>
    requestJson<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }, token),

  me: (token: string) =>
    requestJson<{ user: UserProfile; workspace: WorkspaceInfo }>('/api/auth/me', {}, token),
};

export function createWorkspaceApi(mode: WorkspaceMode, token: string | null) {
  const base = prefixForMode(mode);
  const effectiveToken = mode === 'DEMO' ? null : token;

  return {
    getDashboard: () => requestJson<DashboardSummary>(`${base}/dashboard`, {}, effectiveToken),

    getGraph: () =>
      requestJson<{
        nodes: ContextNode[];
        edges: ContextEdge[];
        sourceRecords: SourceRecord[];
      }>(`${base}/graph`, {}, effectiveToken),

    createNode: (payload: {
      type: ContextNode['type'];
      title: string;
      subtitle?: string;
      status?: string;
      date?: string | null;
      ownerId?: string | null;
      projectId?: string | null;
      provenance?: string;
      factStatus?: ContextNode['factStatus'];
    }) =>
      requestJson<ContextNode>(
        `${base}/graph/nodes`,
        {
          method: 'POST',
          body: JSON.stringify(payload),
        },
        effectiveToken,
      ),

    updateNode: (
      id: string,
      payload: Partial<{
        title: string;
        subtitle: string;
        status: string;
        date: string | null;
        factStatus: ContextNode['factStatus'];
      }>,
    ) =>
      requestJson<ContextNode>(
        `${base}/graph/nodes/${encodeURIComponent(id)}`,
        {
          method: 'PATCH',
          body: JSON.stringify(payload),
        },
        effectiveToken,
      ),

    deleteNode: (id: string) =>
      requestJson<{ ok: boolean }>(
        `${base}/graph/nodes/${encodeURIComponent(id)}`,
        { method: 'DELETE' },
        effectiveToken,
      ),

    createEdge: (payload: {
      sourceId: string;
      targetId: string;
      relationshipType: ContextEdge['relationshipType'];
      label?: string;
      evidenceText?: string;
      provenance?: string;
      sourceRecordId?: string | null;
      factStatus?: ContextEdge['factStatus'];
    }) =>
      requestJson<ContextEdge>(
        `${base}/graph/edges`,
        {
          method: 'POST',
          body: JSON.stringify(payload),
        },
        effectiveToken,
      ),

    deleteEdge: (id: string) =>
      requestJson<{ ok: boolean }>(
        `${base}/graph/edges/${encodeURIComponent(id)}`,
        { method: 'DELETE' },
        effectiveToken,
      ),

    createSourceRecord: (payload: {
      sourceType: SourceRecord['sourceType'];
      sender: string;
      title: string;
      content: string;
      projectId?: string | null;
    }) =>
      requestJson<SourceRecord>(
        `${base}/sources`,
        {
          method: 'POST',
          body: JSON.stringify(payload),
        },
        effectiveToken,
      ),

    deleteSourceRecord: (id: string) =>
      requestJson<{ ok: boolean }>(
        `${base}/sources/${encodeURIComponent(id)}`,
        { method: 'DELETE' },
        effectiveToken,
      ),

    runDemo: () =>
      requestJson<{
        sourceRecord: SourceRecord;
        analysis: ImpactAnalysisResult;
        plans: WhatIfPlan[];
      }>('/api/demo/run', { method: 'POST' }),

    resetDemo: () =>
      requestJson<{ ok: boolean; message: string }>('/api/demo/reset', { method: 'POST' }),

    analyzeCustomMessage: (payload: {
      sender: string;
      title: string;
      content: string;
      projectId?: string;
    }) =>
      requestJson<{
        sourceRecord: SourceRecord;
        analysis: ImpactAnalysisResult;
        plans: WhatIfPlan[];
      }>(
        `${base}/impact/analyze-message`,
        {
          method: 'POST',
          body: JSON.stringify(payload),
        },
        effectiveToken,
      ),

    runProjectImpact: (payload: { projectId: string; newDate: string; reason: string }) =>
      requestJson<{
        sourceRecord: SourceRecord;
        analysis: ImpactAnalysisResult;
        plans: WhatIfPlan[];
      }>(
        `${base}/impact/run-project`,
        {
          method: 'POST',
          body: JSON.stringify(payload),
        },
        effectiveToken,
      ),

    getImpactAnalyses: () =>
      requestJson<Array<{ analysis: ImpactAnalysisResult; plans: WhatIfPlan[] }>>(
        `${base}/impact/analyses`,
        {},
        effectiveToken,
      ),

    selectPlan: (planId: string) =>
      requestJson<{ ok: boolean; approvals: ApprovalItem[] }>(
        `${base}/plans/${encodeURIComponent(planId)}/select`,
        { method: 'POST' },
        effectiveToken,
      ),

    getApprovals: () => requestJson<ApprovalItem[]>(`${base}/approvals`, {}, effectiveToken),

    approveAction: (id: string, note?: string) =>
      requestJson<ApprovalItem>(
        `${base}/approvals/${encodeURIComponent(id)}/approve`,
        {
          method: 'POST',
          body: JSON.stringify({ note }),
        },
        effectiveToken,
      ),

    rejectAction: (id: string, note?: string) =>
      requestJson<ApprovalItem>(
        `${base}/approvals/${encodeURIComponent(id)}/reject`,
        {
          method: 'POST',
          body: JSON.stringify({ note }),
        },
        effectiveToken,
      ),

    approveAllPending: () =>
      requestJson<{ executedCount: number; approvals: ApprovalItem[] }>(
        `${base}/approvals/approve-all-pending`,
        { method: 'POST', body: JSON.stringify({}) },
        effectiveToken,
      ),

    getAuditLogs: () => requestJson<AuditLogEntry[]>(`${base}/audit`, {}, effectiveToken),

    getIntegrations: () =>
      requestJson<IntegrationConnector[]>(`${base}/integrations`, {}, effectiveToken),

    getGmailStatus: () =>
      requestJson<GmailConnectionStatus>(`${base}/integrations/gmail/status`, {}, effectiveToken),

    connectGmail: () =>
      requestJson<{ authUrl: string; clientId: string; state: string }>(
        `${base}/integrations/gmail/connect`,
        { method: 'POST', body: JSON.stringify({}) },
        effectiveToken,
      ),

    exchangeGmailCode: (payload: { code: string; state: string }) =>
      requestJson<{ ok: boolean; email: string | null }>(
        `${base}/integrations/gmail/exchange-code`,
        { method: 'POST', body: JSON.stringify(payload) },
        effectiveToken,
      ),

    syncGmail: (payload?: { maxMessages?: number; query?: string }) =>
      requestJson<GmailSyncResult>(
        `${base}/integrations/gmail/sync`,
        { method: 'POST', body: JSON.stringify(payload ?? {}) },
        effectiveToken,
      ),

    disconnectGmail: () =>
      requestJson<{ ok: boolean }>(
        `${base}/integrations/gmail/disconnect`,
        { method: 'POST', body: JSON.stringify({}) },
        effectiveToken,
      ),

    getEmailInsights: () =>
      requestJson<EmailInsightsResponse>(`${base}/email-insights`, {}, effectiveToken),

    processPendingEmails: () =>
      requestJson<{ ok: boolean; extractionSummary: ExtractionPipelineSummary }>(
        `${base}/email-insights/process`,
        { method: 'POST', body: JSON.stringify({}) },
        effectiveToken,
      ),

    retryFailedEmails: (messageId?: string) =>
      requestJson<{
        ok: boolean;
        retriedCount: number;
        extractionSummary: ExtractionPipelineSummary;
      }>(
        `${base}/email-insights/retry-failed`,
        { method: 'POST', body: JSON.stringify(messageId ? { messageId } : {}) },
        effectiveToken,
      ),

    acceptEmailItem: (
      id: string,
      payload?: {
        title?: string;
        description?: string;
        itemType?: EmailExtractedItemType;
        proposedDate?: string | null;
        factStatus?: FactStatus;
        actionMode?: 'CREATE_NEW' | 'UPDATE_MATCHED';
        targetNodeId?: string;
      },
    ) =>
      requestJson<{ item: EmailExtractedItem; node: ContextNode }>(
        `${base}/email-insights/items/${encodeURIComponent(id)}/accept`,
        { method: 'POST', body: JSON.stringify(payload ?? {}) },
        effectiveToken,
      ),

    rejectEmailItem: (id: string) =>
      requestJson<EmailExtractedItem>(
        `${base}/email-insights/items/${encodeURIComponent(id)}/reject`,
        { method: 'POST', body: JSON.stringify({}) },
        effectiveToken,
      ),

    acceptEmailRelationship: (
      id: string,
      payload?: { sourceNodeId?: string; targetNodeId?: string },
    ) =>
      requestJson<{ relationship: EmailSuggestedRelationship; edgeId: string }>(
        `${base}/email-insights/relationships/${encodeURIComponent(id)}/accept`,
        { method: 'POST', body: JSON.stringify(payload ?? {}) },
        effectiveToken,
      ),

    rejectEmailRelationship: (id: string) =>
      requestJson<EmailSuggestedRelationship>(
        `${base}/email-insights/relationships/${encodeURIComponent(id)}/reject`,
        { method: 'POST', body: JSON.stringify({}) },
        effectiveToken,
      ),
  };
}

export type WorkspaceApi = ReturnType<typeof createWorkspaceApi>;
