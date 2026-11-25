import 'dotenv/config';
import express, { type NextFunction, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  loginUser,
  registerUser,
  revokeSessionToken,
  verifySessionToken,
} from './src/server/authService.ts';
import {
  DEMO_WORKSPACE_ID,
  db,
  getWorkspaceById,
  initializeDatabase,
  resetAndSeedDemoData,
} from './src/server/db.ts';
import { extractChangeFromText } from './src/server/geminiService.ts';
import {
  createEdge,
  createNode,
  createSourceRecord,
  deleteEdge,
  deleteNode,
  deleteSourceRecord,
  getAllApprovals,
  getAllAuditLogs,
  getAllEdges,
  getAllNodes,
  getAllSourceRecords,
  getIntegrations,
  getNodeById,
  upsertSourceRecord,
  updateNode,
} from './src/server/graphService.ts';
import { runRippleImpactAnalysis } from './src/server/impactEngine.ts';
import {
  executeApprovedAction,
  rejectApprovalAction,
  selectPlanAndQueueApprovals,
} from './src/server/permissionsAndExecution.ts';
import { generateWhatIfPlans, getPlansByAnalysisId } from './src/server/simulator.ts';
import {
  ADMIN_OAUTH_CONFIG_ERROR,
  AdminConfigurationError,
  createGmailAuthUrl,
  disconnectGmail,
  exchangeGmailCode,
  getGmailConnectionStatus,
  handleGmailOAuthCallback,
  syncGmailMessages,
} from './src/server/gmailService.ts';
import {
  acceptExtractedItem,
  acceptSuggestedRelationship,
  getEmailInsights,
  rejectExtractedItem,
  rejectSuggestedRelationship,
} from './src/server/emailReviewService.ts';
import {
  enqueueWorkspaceExtraction,
  getExtractionSummary,
  initializeExtractionQueueOnStartup,
  retryFailedExtractions,
} from './src/server/extractionQueue.ts';
import type {
  DashboardSummary,
  EmailExtractedItemType,
  FactStatus,
  ImpactAnalysisResult,
  SourceRecord,
  UserProfile,
  WhatIfPlan,
  WorkspaceInfo,
} from './src/types/maya.ts';

initializeDatabase();

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));

interface AuthenticatedRequest extends Request {
  auth?: {
    token: string;
    user: UserProfile;
    workspace: WorkspaceInfo;
  };
}

function extractBearerToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return undefined;
  return header.slice(7).trim() || undefined;
}

function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const token = extractBearerToken(req);
  const verified = verifySessionToken(token);
  if (!verified || !token) {
    res.status(401).json({ error: 'Authentication required. Please sign in to access your workspace.' });
    return;
  }
  req.auth = {
    token,
    user: verified.user,
    workspace: verified.workspace,
  };
  next();
}

function mapAnalysisRow(row: Record<string, unknown>): ImpactAnalysisResult {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id ?? DEMO_WORKSPACE_ID),
    changeEvent: JSON.parse(String(row.change_event_json)) as ImpactAnalysisResult['changeEvent'],
    directImpacts: JSON.parse(String(row.direct_impacts_json)) as ImpactAnalysisResult['directImpacts'],
    downstreamImpacts: JSON.parse(
      String(row.downstream_impacts_json),
    ) as ImpactAnalysisResult['downstreamImpacts'],
    unaffectedItems: JSON.parse(
      String(row.unaffected_items_json),
    ) as ImpactAnalysisResult['unaffectedItems'],
    explanationSummary: String(row.explanation_summary),
    aiNarrative: row.ai_narrative ? String(row.ai_narrative) : null,
    aiStatus: row.ai_status as ImpactAnalysisResult['aiStatus'],
    createdAt: String(row.created_at),
  };
}

function buildDashboardSummary(workspaceId: string): DashboardSummary {
  const workspace = getWorkspaceById(workspaceId);
  if (!workspace) {
    throw new Error('Workspace not found.');
  }

  const nodes = getAllNodes(workspaceId);
  const edges = getAllEdges(workspaceId);
  const sources = getAllSourceRecords(workspaceId);
  const approvals = getAllApprovals(workspaceId);
  const auditLogs = getAllAuditLogs(workspaceId);

  const analysesRows = db
    .prepare('SELECT * FROM impact_analyses WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 10')
    .all(workspaceId) as Record<string, unknown>[];
  const recentChanges = analysesRows.map(mapAnalysisRow);
  const latestAnalysis = recentChanges[0] ?? null;
  const latestPlans: WhatIfPlan[] = latestAnalysis
    ? getPlansByAnalysisId(workspaceId, latestAnalysis.id)
    : [];

  const activeProjects = nodes.filter((n) => n.type === 'PROJECT');
  const upcomingDeadlines = nodes
    .filter((n) => n.type === 'DEADLINE')
    .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
  const pendingApprovals = approvals.filter((a) => a.status === 'PENDING');

  let demoPhase: DashboardSummary['demoPhase'] = 'BASELINE';
  if (approvals.some((a) => a.status === 'APPROVED')) {
    demoPhase = 'EXECUTED';
  } else if (latestPlans.some((p) => p.status === 'SELECTED') || pendingApprovals.length > 0) {
    demoPhase = 'PLAN_SELECTED';
  } else if (latestAnalysis) {
    demoPhase = 'IMPACT_DETECTED';
  }

  const pendingInsightCountRow =
    workspaceId === DEMO_WORKSPACE_ID
      ? { count: 0 }
      : (db
          .prepare(`
            SELECT
              (SELECT COUNT(*) FROM email_extracted_items WHERE workspace_id = ? AND status = 'PENDING') +
              (SELECT COUNT(*) FROM email_suggested_relationships WHERE workspace_id = ? AND status = 'PENDING')
              AS count
          `)
          .get(workspaceId, workspaceId) as { count: number });

  return {
    workspace,
    counts: {
      nodes: nodes.length,
      edges: edges.length,
      activeProjects: activeProjects.length,
      tasks: nodes.filter((n) => n.type === 'TASK').length,
      people: nodes.filter((n) => n.type === 'PERSON').length,
      meetings: nodes.filter((n) => n.type === 'MEETING').length,
      documents: nodes.filter((n) => n.type === 'DOCUMENT').length,
      sourceRecords: sources.length,
      upcomingDeadlines: upcomingDeadlines.length,
      pendingApprovals: pendingApprovals.length,
      pendingEmailInsights: pendingInsightCountRow.count,
      impactAnalyses: recentChanges.length,
      auditEntries: auditLogs.length,
    },
    activeProjects,
    upcomingDeadlines,
    recentChanges,
    pendingApprovals,
    latestAnalysis,
    latestPlans,
    demoPhase,
  };
}

// --- Authentication Routes ---
app.post('/api/auth/register', (req, res) => {
  try {
    const body = req.body as Record<string, unknown>;
    const session = registerUser({
      email: String(body.email ?? ''),
      password: String(body.password ?? ''),
      displayName: typeof body.displayName === 'string' ? body.displayName : undefined,
    });
    res.status(201).json(session);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Registration failed' });
  }
});

app.post('/api/auth/login', (req, res) => {
  try {
    const body = req.body as Record<string, unknown>;
    const session = loginUser({
      email: String(body.email ?? ''),
      password: String(body.password ?? ''),
    });
    res.json(session);
  } catch (err) {
    res.status(401).json({ error: err instanceof Error ? err.message : 'Login failed' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  const token = extractBearerToken(req);
  revokeSessionToken(token);
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth, (req: AuthenticatedRequest, res) => {
  res.json({
    user: req.auth!.user,
    workspace: req.auth!.workspace,
  });
});

// --- Shared Workspace Route Builder (Personal Workspace vs Isolated Demo Workspace) ---
function createWorkspaceRouter(
  resolveContext: (req: AuthenticatedRequest) => { workspaceId: string; actorName: string },
) {
  const router = express.Router();

  router.get('/dashboard', (req: AuthenticatedRequest, res) => {
    try {
      const { workspaceId } = resolveContext(req);
      res.json(buildDashboardSummary(workspaceId));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to load dashboard' });
    }
  });

  router.get('/graph', (req: AuthenticatedRequest, res) => {
    const { workspaceId } = resolveContext(req);
    res.json({
      nodes: getAllNodes(workspaceId),
      edges: getAllEdges(workspaceId),
      sourceRecords: getAllSourceRecords(workspaceId),
    });
  });

  router.post('/graph/nodes', (req: AuthenticatedRequest, res) => {
    try {
      const { workspaceId, actorName } = resolveContext(req);
      const body = req.body as Record<string, unknown>;
      const type = String(body.type ?? '').trim();
      const title = String(body.title ?? '').trim();
      if (!type || !title) {
        res.status(400).json({ error: 'Both node type and title are required.' });
        return;
      }
      const allowedTypes = new Set([
        'PERSON',
        'PROJECT',
        'TASK',
        'MEETING',
        'DEADLINE',
        'DOCUMENT',
        'EMAIL',
        'SOURCE_RECORD',
      ]);
      if (!allowedTypes.has(type)) {
        res.status(400).json({ error: `Unsupported node type "${type}".` });
        return;
      }

      const created = createNode(
        workspaceId,
        {
          type: type as Parameters<typeof createNode>[1]['type'],
          title,
          subtitle: typeof body.subtitle === 'string' ? body.subtitle : '',
          status: typeof body.status === 'string' ? body.status : 'Active',
          date: typeof body.date === 'string' && body.date.trim() ? body.date.trim() : null,
          ownerId: typeof body.ownerId === 'string' && body.ownerId ? body.ownerId : null,
          projectId: typeof body.projectId === 'string' && body.projectId ? body.projectId : null,
          provenance:
            typeof body.provenance === 'string' && body.provenance.trim()
              ? body.provenance.trim()
              : undefined,
          factStatus: body.factStatus === 'INFERRED' ? 'INFERRED' : 'CONFIRMED',
        },
        actorName,
      );

      res.status(201).json(created);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to create node' });
    }
  });

  router.patch('/graph/nodes/:id', (req: AuthenticatedRequest, res) => {
    try {
      const { workspaceId } = resolveContext(req);
      const id = String(req.params.id);
      const body = req.body as Record<string, unknown>;
      const updated = updateNode(workspaceId, id, {
        title: typeof body.title === 'string' ? body.title : undefined,
        subtitle: typeof body.subtitle === 'string' ? body.subtitle : undefined,
        status: typeof body.status === 'string' ? body.status : undefined,
        date: body.date === null || typeof body.date === 'string' ? body.date : undefined,
        factStatus:
          body.factStatus === 'CONFIRMED' || body.factStatus === 'INFERRED'
            ? body.factStatus
            : undefined,
      });
      if (!updated) {
        res.status(404).json({ error: 'Node not found in your workspace.' });
        return;
      }
      res.json(updated);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to update node' });
    }
  });

  router.delete('/graph/nodes/:id', (req: AuthenticatedRequest, res) => {
    const { workspaceId, actorName } = resolveContext(req);
    const deleted = deleteNode(workspaceId, String(req.params.id), actorName);
    if (!deleted) {
      res.status(404).json({ error: 'Node not found in your workspace.' });
      return;
    }
    res.json({ ok: true });
  });

  router.post('/graph/edges', (req: AuthenticatedRequest, res) => {
    try {
      const { workspaceId, actorName } = resolveContext(req);
      const body = req.body as Record<string, unknown>;
      const sourceId = String(body.sourceId ?? '').trim();
      const targetId = String(body.targetId ?? '').trim();
      const relationshipType = String(body.relationshipType ?? '').trim();
      if (!sourceId || !targetId || !relationshipType) {
        res.status(400).json({ error: 'sourceId, targetId, and relationshipType are required.' });
        return;
      }

      const created = createEdge(
        workspaceId,
        {
          sourceId,
          targetId,
          relationshipType: relationshipType as Parameters<typeof createEdge>[1]['relationshipType'],
          label: typeof body.label === 'string' ? body.label : undefined,
          evidenceText: typeof body.evidenceText === 'string' ? body.evidenceText : undefined,
          provenance: typeof body.provenance === 'string' ? body.provenance : undefined,
          sourceRecordId:
            typeof body.sourceRecordId === 'string' && body.sourceRecordId
              ? body.sourceRecordId
              : null,
          factStatus: body.factStatus === 'INFERRED' ? 'INFERRED' : 'CONFIRMED',
        },
        actorName,
      );

      res.status(201).json(created);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to create relationship' });
    }
  });

  router.delete('/graph/edges/:id', (req: AuthenticatedRequest, res) => {
    const { workspaceId, actorName } = resolveContext(req);
    const deleted = deleteEdge(workspaceId, String(req.params.id), actorName);
    if (!deleted) {
      res.status(404).json({ error: 'Relationship not found in your workspace.' });
      return;
    }
    res.json({ ok: true });
  });

  router.post('/sources', (req: AuthenticatedRequest, res) => {
    try {
      const { workspaceId, actorName } = resolveContext(req);
      const body = req.body as Record<string, unknown>;
      const title = String(body.title ?? '').trim();
      const content = String(body.content ?? '').trim();
      if (!title || !content) {
        res.status(400).json({ error: 'Source record title and content are required.' });
        return;
      }
      const allowedSourceTypes = new Set(['EMAIL', 'CALENDAR', 'TASKS', 'DOCUMENT', 'SYSTEM']);
      const rawType = String(body.sourceType ?? 'DOCUMENT').toUpperCase();
      const sourceType = (allowedSourceTypes.has(rawType) ? rawType : 'DOCUMENT') as SourceRecord['sourceType'];

      const created = createSourceRecord(
        workspaceId,
        {
          sourceType,
          sender: typeof body.sender === 'string' ? body.sender : actorName,
          title,
          content,
          projectId: typeof body.projectId === 'string' && body.projectId ? body.projectId : null,
        },
        actorName,
      );
      res.status(201).json(created);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to create source record' });
    }
  });

  router.delete('/sources/:id', (req: AuthenticatedRequest, res) => {
    const { workspaceId } = resolveContext(req);
    const deleted = deleteSourceRecord(workspaceId, String(req.params.id));
    if (!deleted) {
      res.status(404).json({ error: 'Source record not found in your workspace.' });
      return;
    }
    res.json({ ok: true });
  });

  router.post('/impact/analyze-message', async (req: AuthenticatedRequest, res) => {
    try {
      const { workspaceId } = resolveContext(req);
      const body = req.body as Record<string, unknown>;
      const title = String(body.title ?? '').trim();
      const content = String(body.content ?? '').trim();
      const sender = String(body.sender ?? 'External Update <update@workspace.local>').trim();

      if (!title || !content) {
        res.status(400).json({ error: 'Both message title and content are required.' });
        return;
      }

      // Strictly query ONLY projects in this workspaceId
      const projects = getAllNodes(workspaceId).filter((n) => n.type === 'PROJECT');
      if (projects.length === 0) {
        res.status(400).json({
          error: 'Create at least one Project in your workspace before running impact analysis.',
        });
        return;
      }

      let matchedProject = null;
      if (typeof body.projectId === 'string' && body.projectId.trim()) {
        const candidate = getNodeById(workspaceId, body.projectId.trim());
        if (!candidate || candidate.type !== 'PROJECT') {
          res.status(404).json({ error: 'Target project not found in your workspace.' });
          return;
        }
        matchedProject = candidate;
      }

      const extracted = await extractChangeFromText(title, content, projects);

      if (!matchedProject) {
        matchedProject =
          projects.find((p) => p.title.toLowerCase() === extracted.projectTitleMatch.toLowerCase()) ||
          projects[0];
      }

      const sourceRecord: SourceRecord = {
        id: `src-${randomUUID().slice(0, 10)}`,
        workspaceId,
        sourceType: 'EMAIL',
        externalId: null,
        sender,
        title,
        content,
        receivedAt: new Date().toISOString(),
        parsedEntities: {
          project: matchedProject.title,
          newDate: extracted.newDateIso,
        },
        isDemo: workspaceId === DEMO_WORKSPACE_ID,
        processed: true,
      };

      upsertSourceRecord(workspaceId, sourceRecord);

      const analysis = await runRippleImpactAnalysis(workspaceId, {
        projectId: matchedProject.id,
        newDeadlineIso: `${extracted.newDateIso}T${extracted.newTimeHint || '17:00'}`,
        sourceRecord,
        extractionMethod: extracted.usedGemini ? 'GEMINI_NLU' : 'DETERMINISTIC_PARSER',
        extractionNote: extracted.usedGemini
          ? 'Extracted via Gemini API (gemini-4-hydrogen) JSON schema using strictly your workspace projects.'
          : extracted.aiError ?? 'Extracted via deterministic change parser.',
      });

      const plans = generateWhatIfPlans(workspaceId, analysis);

      res.status(201).json({
        sourceRecord,
        extracted,
        analysis,
        plans,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Impact analysis failed' });
    }
  });

  router.post('/impact/run-project', async (req: AuthenticatedRequest, res) => {
    try {
      const { workspaceId, actorName } = resolveContext(req);
      const body = req.body as Record<string, unknown>;
      const projectId = String(body.projectId ?? '').trim();
      const newDate = String(body.newDate ?? '').trim();
      const reason = String(body.reason ?? 'Direct deadline update triggered by user.').trim();

      if (!projectId || !newDate) {
        res.status(400).json({ error: 'projectId and newDate are required.' });
        return;
      }

      const project = getNodeById(workspaceId, projectId);
      if (!project || project.type !== 'PROJECT') {
        res.status(404).json({ error: 'Project not found in your workspace.' });
        return;
      }

      const sourceRecord: SourceRecord = {
        id: `src-${randomUUID().slice(0, 10)}`,
        workspaceId,
        sourceType: 'SYSTEM',
        externalId: null,
        sender: actorName,
        title: `Deadline Change Signal: ${project.title}`,
        content: reason,
        receivedAt: new Date().toISOString(),
        parsedEntities: { project: project.title, newDate },
        isDemo: workspaceId === DEMO_WORKSPACE_ID,
        processed: true,
      };

      upsertSourceRecord(workspaceId, sourceRecord);

      const analysis = await runRippleImpactAnalysis(workspaceId, {
        projectId: project.id,
        newDeadlineIso: newDate,
        sourceRecord,
        extractionMethod: 'DIRECT_USER_UPDATE',
        extractionNote: 'Triggered directly from workspace deadline shift form.',
      });

      const plans = generateWhatIfPlans(workspaceId, analysis);
      res.status(201).json({ sourceRecord, analysis, plans });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to run project impact' });
    }
  });

  router.get('/impact/analyses', (req: AuthenticatedRequest, res) => {
    const { workspaceId } = resolveContext(req);
    const rows = db
      .prepare('SELECT * FROM impact_analyses WHERE workspace_id = ? ORDER BY created_at DESC')
      .all(workspaceId) as Record<string, unknown>[];
    const analyses = rows.map(mapAnalysisRow);
    const items = analyses.map((a) => ({
      analysis: a,
      plans: getPlansByAnalysisId(workspaceId, a.id),
    }));
    res.json(items);
  });

  router.post('/plans/:planId/select', (req: AuthenticatedRequest, res) => {
    try {
      const { workspaceId, actorName } = resolveContext(req);
      const approvals = selectPlanAndQueueApprovals(
        workspaceId,
        String(req.params.planId),
        actorName,
      );
      res.json({ ok: true, approvals });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to select plan' });
    }
  });

  router.get('/approvals', (req: AuthenticatedRequest, res) => {
    const { workspaceId } = resolveContext(req);
    res.json(getAllApprovals(workspaceId));
  });

  router.post('/approvals/:id/approve', (req: AuthenticatedRequest, res) => {
    try {
      const { workspaceId, actorName } = resolveContext(req);
      const note = typeof req.body?.note === 'string' ? req.body.note : undefined;
      const updated = executeApprovedAction(workspaceId, String(req.params.id), note, actorName);
      res.json(updated);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Approval execution failed' });
    }
  });

  router.post('/approvals/:id/reject', (req: AuthenticatedRequest, res) => {
    try {
      const { workspaceId, actorName } = resolveContext(req);
      const note = typeof req.body?.note === 'string' ? req.body.note : undefined;
      const updated = rejectApprovalAction(workspaceId, String(req.params.id), note, actorName);
      res.json(updated);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Rejection failed' });
    }
  });

  router.post('/approvals/approve-all-pending', (req: AuthenticatedRequest, res) => {
    try {
      const { workspaceId, actorName } = resolveContext(req);
      const pending = getAllApprovals(workspaceId).filter(
        (a) => a.status === 'PENDING' && a.permissionValid,
      );
      const note = typeof req.body?.note === 'string' ? req.body.note : 'Batch approved by user.';
      const results = pending.map((item) =>
        executeApprovedAction(workspaceId, item.id, note, actorName),
      );
      res.json({ executedCount: results.length, approvals: results });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Batch approval failed' });
    }
  });

  router.get('/audit', (req: AuthenticatedRequest, res) => {
    const { workspaceId } = resolveContext(req);
    res.json(getAllAuditLogs(workspaceId));
  });

  router.get('/integrations', (req: AuthenticatedRequest, res) => {
    const { workspaceId } = resolveContext(req);
    res.json(getIntegrations(workspaceId));
  });

  return router;
}

// --- Isolated DEMO MODE Router (`ws-demo` only) ---
const demoRouter = createWorkspaceRouter(() => ({
  workspaceId: DEMO_WORKSPACE_ID,
  actorName: 'Demo Presenter',
}));

demoRouter.post('/reset', (_req, res) => {
  try {
    resetAndSeedDemoData();
    res.json({ ok: true, message: 'Demo workspace restored without affecting personal workspaces.' });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to reset demo' });
  }
});

demoRouter.post('/run', async (_req, res) => {
  try {
    resetAndSeedDemoData();

    const incomingEmail: SourceRecord = {
      id: 'src-demo-deadline-shift',
      workspaceId: DEMO_WORKSPACE_ID,
      sourceType: 'EMAIL',
      externalId: 'demo-msg-urgent-901',
      sender: 'Dr. Elena Vance <chair@research-board.org>',
      title: 'URGENT: AI Research Project deadline moved from Friday to Wednesday',
      content:
        'Hi team — due to the moved steering committee review, the AI Research Project final submission deadline has been brought forward from Friday (Nov 27) to this Wednesday (Nov 25) at 17:00. Please ensure Task A research documentation, Task B review, and Task C presentation materials are aligned accordingly.',
      receivedAt: new Date().toISOString(),
      parsedEntities: {
        project: 'AI Research Project',
        originalDeadline: '2026-11-27',
        newDeadline: '2026-11-25T17:00',
      },
      isDemo: true,
      processed: true,
    };

    upsertSourceRecord(DEMO_WORKSPACE_ID, incomingEmail);

    const emailNodeId = 'email-demo-shift';
    const now = new Date().toISOString();
    db.prepare(`
      INSERT OR REPLACE INTO nodes (
        id, workspace_id, type, title, subtitle, status, date, owner_id, project_id,
        metadata_json, provenance, fact_status, is_demo, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      emailNodeId,
      DEMO_WORKSPACE_ID,
      'EMAIL',
      'Email: Deadline Moved to Wednesday',
      'From Dr. Elena Vance · Urgent Change Signal',
      'Detected Change',
      '2026-11-25T17:00',
      'person-ananya',
      'proj-ai-research',
      JSON.stringify({ sourceRecordId: incomingEmail.id, originalDay: 'Friday', newDay: 'Wednesday' }),
      'Incoming Email Source Record (DEMO MODE)',
      'CONFIRMED',
      1,
      now,
      now,
    );

    db.prepare(`
      INSERT OR REPLACE INTO edges (
        id, workspace_id, source_id, target_id, relationship_type, label, provenance,
        evidence_text, source_record_id, fact_status, is_demo, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'edge-demo-email-support',
      DEMO_WORKSPACE_ID,
      emailNodeId,
      'dl-ai-research',
      'SUPPORTS',
      'signals deadline change',
      'Incoming Email Extraction (src-demo-deadline-shift)',
      incomingEmail.content,
      incomingEmail.id,
      'CONFIRMED',
      1,
      now,
    );

    const projects = getAllNodes(DEMO_WORKSPACE_ID).filter((n) => n.type === 'PROJECT');
    const extracted = await extractChangeFromText(
      incomingEmail.title,
      incomingEmail.content,
      projects,
    );

    const analysis = await runRippleImpactAnalysis(DEMO_WORKSPACE_ID, {
      projectId: 'proj-ai-research',
      newDeadlineIso: `${extracted.newDateIso || '2026-11-25'}T${extracted.newTimeHint || '17:00'}`,
      sourceRecord: incomingEmail,
      extractionMethod: extracted.usedGemini ? 'GEMINI_NLU' : 'DETERMINISTIC_PARSER',
      extractionNote: extracted.usedGemini
        ? 'Extracted structured deadline shift via Gemini API (gemini-4-hydrogen).'
        : extracted.aiError ?? 'Extracted via deterministic change parser.',
    });

    const plans = generateWhatIfPlans(DEMO_WORKSPACE_ID, analysis);

    res.json({
      sourceRecord: incomingEmail,
      extracted,
      analysis,
      plans,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to run maYa demo' });
  }
});

demoRouter.get('/integrations/gmail/status', (_req, res) => {
  res.json(getGmailConnectionStatus(DEMO_WORKSPACE_ID));
});

demoRouter.post('/integrations/gmail/*', (_req, res) => {
  res.status(403).json({
    error: 'Real Gmail OAuth connections and sync are disabled in DEMO MODE.',
  });
});

demoRouter.get('/email-insights', (_req, res) => {
  res.json(getEmailInsights(DEMO_WORKSPACE_ID));
});

demoRouter.post('/email-insights/*', (_req, res) => {
  res.status(403).json({
    error: 'Email Insights review is disabled in DEMO MODE.',
  });
});

app.use('/api/demo', demoRouter);

// --- Google OAuth 2.0 Callback (CSRF-protected via single-use state bound to user + workspace) ---
const gmailCallbackHandler = async (req: Request, res: Response) => {
  const code = typeof req.query.code === 'string' ? req.query.code : undefined;
  const state = typeof req.query.state === 'string' ? req.query.state : undefined;
  const error = typeof req.query.error === 'string' ? req.query.error : undefined;

  let result: { ok: boolean; email?: string; workspaceId?: string; error?: string };
  try {
    result = await handleGmailOAuthCallback({ code, state, error });
  } catch (err) {
    result = {
      ok: false,
      error: err instanceof Error ? err.message : 'Unexpected error completing Gmail authorization.',
    };
  }
  const payload = result.ok
    ? { type: 'MAYA_GMAIL_OAUTH_SUCCESS', email: result.email ?? null }
    : { type: 'MAYA_GMAIL_OAUTH_ERROR', error: result.error ?? 'Gmail connection failed.' };

  const statusText = result.ok
    ? `Gmail connected (${result.email ?? 'authorized account'}). This window will close automatically.`
    : `Gmail authorization failed: ${result.error ?? 'Unknown error'}`;

  res.status(result.ok ? 200 : 400).setHeader('Content-Type', 'text/html; charset=utf-8').send(`<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>maYa Gmail Authorization</title></head>
  <body style="background:#070D19;color:#F1F5F9;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px;">
    <div style="max-width:420px;text-align:center;border:1px solid #1E293B;background:#0D1526;border-radius:12px;padding:24px;">
      <p id="msg" style="font-size:14px;line-height:1.5;margin:0 0 12px 0;"></p>
      <button onclick="window.close()" style="background:#2563EB;color:#fff;border:none;border-radius:8px;padding:8px 16px;font-size:12px;cursor:pointer;">Close Window</button>
    </div>
    <script>
      document.getElementById('msg').textContent = ${JSON.stringify(statusText)};
      try {
        if (window.opener) {
          window.opener.postMessage(${JSON.stringify(payload)}, '*');
          setTimeout(function() { window.close(); }, 600);
        }
      } catch (e) {}
    </script>
  </body>
</html>`);
};

app.get(['/api/integrations/gmail/callback', '/api/integrations/gmail/callback/'], gmailCallbackHandler);

// --- Authenticated Personal Workspace Router ---
const personalRouter = createWorkspaceRouter((req: AuthenticatedRequest) => ({
  workspaceId: req.auth!.workspace.id,
  actorName: req.auth!.user.displayName,
}));

function requestOriginHint(req: Request): string {
  const proto = req.headers['x-forwarded-proto']?.toString().split(',')[0]?.trim() || req.protocol;
  const host = req.headers['x-forwarded-host']?.toString().split(',')[0]?.trim() || req.get('host');
  return host ? `${proto}://${host}` : 'http://localhost:3000';
}

personalRouter.get('/integrations/gmail/status', (req: AuthenticatedRequest, res) => {
  res.json(getGmailConnectionStatus(req.auth!.workspace.id, requestOriginHint(req)));
});

personalRouter.post('/integrations/gmail/connect', (req: AuthenticatedRequest, res) => {
  try {
    const result = createGmailAuthUrl(
      req.auth!.user.id,
      req.auth!.workspace.id,
      requestOriginHint(req),
    );
    res.json(result);
  } catch (err) {
    const status = err instanceof AdminConfigurationError ? 503 : 400;
    res.status(status).json({ error: err instanceof Error ? err.message : 'Unable to start Gmail OAuth' });
  }
});

personalRouter.post('/integrations/gmail/exchange-code', async (req: AuthenticatedRequest, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const code = typeof body.code === 'string' ? body.code : '';
    const state = typeof body.state === 'string' ? body.state : '';

    const result = await exchangeGmailCode({
      code,
      state,
      userId: req.auth!.user.id,
      workspaceId: req.auth!.workspace.id,
    });

    if (!result.ok) {
      const status = result.error === ADMIN_OAUTH_CONFIG_ERROR ? 503 : 400;
      res.status(status).json({ error: result.error ?? 'Failed to exchange Gmail authorization code.' });
      return;
    }

    res.json({ ok: true, email: result.email ?? null });
  } catch (err) {
    const status = err instanceof AdminConfigurationError ? 503 : 400;
    res.status(status).json({ error: err instanceof Error ? err.message : 'Unable to complete Gmail OAuth' });
  }
});

personalRouter.post('/integrations/gmail/sync', async (req: AuthenticatedRequest, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const maxMessages = typeof body.maxMessages === 'number' ? body.maxMessages : undefined;
    const query = typeof body.query === 'string' ? body.query : undefined;
    const result = await syncGmailMessages(req.auth!.workspace.id, req.auth!.user.displayName, {
      maxMessages,
      query,
    });
    res.json(result);
  } catch (err) {
    const status = err instanceof AdminConfigurationError ? 503 : 400;
    res.status(status).json({ error: err instanceof Error ? err.message : 'Gmail synchronization failed' });
  }
});

personalRouter.post('/integrations/gmail/disconnect', async (req: AuthenticatedRequest, res) => {
  try {
    await disconnectGmail(req.auth!.workspace.id, req.auth!.user.displayName);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to disconnect Gmail' });
  }
});

personalRouter.get('/email-insights', (req: AuthenticatedRequest, res) => {
  res.json(getEmailInsights(req.auth!.workspace.id, requestOriginHint(req)));
});

personalRouter.post('/email-insights/process', (req: AuthenticatedRequest, res) => {
  try {
    const workspaceId = req.auth!.workspace.id;
    enqueueWorkspaceExtraction(workspaceId);
    res.json({
      ok: true,
      extractionSummary: getExtractionSummary(workspaceId),
    });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : 'Unable to start email extraction queue',
    });
  }
});

personalRouter.post('/email-insights/retry-failed', (req: AuthenticatedRequest, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const messageId = typeof body.messageId === 'string' && body.messageId.trim() ? body.messageId.trim() : undefined;
    const workspaceId = req.auth!.workspace.id;
    const { retriedCount } = retryFailedExtractions(workspaceId, messageId);
    res.json({
      ok: true,
      retriedCount,
      extractionSummary: getExtractionSummary(workspaceId),
    });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : 'Unable to retry failed email extractions',
    });
  }
});

personalRouter.post('/email-insights/items/:id/accept', (req: AuthenticatedRequest, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const allowedItemTypes = new Set<EmailExtractedItemType>([
      'PROJECT',
      'PERSON',
      'TASK',
      'DEADLINE',
      'MEETING',
      'DECISION',
      'PLAN_CHANGE',
      'CONFLICT',
    ]);
    const itemType =
      typeof body.itemType === 'string' && allowedItemTypes.has(body.itemType as EmailExtractedItemType)
        ? (body.itemType as EmailExtractedItemType)
        : undefined;
    const factStatus: FactStatus | undefined =
      body.factStatus === 'CONFIRMED' || body.factStatus === 'INFERRED' ? body.factStatus : undefined;
    const actionMode =
      body.actionMode === 'CREATE_NEW' || body.actionMode === 'UPDATE_MATCHED'
        ? body.actionMode
        : undefined;

    const result = acceptExtractedItem(
      req.auth!.workspace.id,
      String(req.params.id),
      {
        title: typeof body.title === 'string' ? body.title : undefined,
        description: typeof body.description === 'string' ? body.description : undefined,
        itemType,
        proposedDate:
          body.proposedDate === null || typeof body.proposedDate === 'string'
            ? body.proposedDate
            : undefined,
        factStatus,
        actionMode,
        targetNodeId: typeof body.targetNodeId === 'string' ? body.targetNodeId : undefined,
      },
      req.auth!.user.displayName,
    );
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to accept extracted insight';
    res.status(msg.includes('not found') ? 404 : 400).json({ error: msg });
  }
});

personalRouter.post('/email-insights/items/:id/reject', (req: AuthenticatedRequest, res) => {
  try {
    const item = rejectExtractedItem(
      req.auth!.workspace.id,
      String(req.params.id),
      req.auth!.user.displayName,
    );
    res.json(item);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to reject extracted insight';
    res.status(msg.includes('not found') ? 404 : 400).json({ error: msg });
  }
});

personalRouter.post('/email-insights/relationships/:id/accept', (req: AuthenticatedRequest, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = acceptSuggestedRelationship(
      req.auth!.workspace.id,
      String(req.params.id),
      {
        sourceNodeId: typeof body.sourceNodeId === 'string' ? body.sourceNodeId : undefined,
        targetNodeId: typeof body.targetNodeId === 'string' ? body.targetNodeId : undefined,
      },
      req.auth!.user.displayName,
    );
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to accept suggested relationship';
    res.status(msg.includes('not found') ? 404 : 400).json({ error: msg });
  }
});

personalRouter.post('/email-insights/relationships/:id/reject', (req: AuthenticatedRequest, res) => {
  try {
    const rel = rejectSuggestedRelationship(
      req.auth!.workspace.id,
      String(req.params.id),
      req.auth!.user.displayName,
    );
    res.json(rel);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to reject suggested relationship';
    res.status(msg.includes('not found') ? 404 : 400).json({ error: msg });
  }
});

app.use('/api', requireAuth, personalRouter);

// --- Vite / Static Serving ---
function resolveServerPort(isProdRuntime: boolean): number {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--port' && argv[i + 1]) {
      const parsed = Number(argv[i + 1]);
      if (Number.isInteger(parsed) && parsed > 0) {
        return parsed;
      }
    } else if (arg.startsWith('--port=')) {
      const parsed = Number(arg.slice('--port='.length));
      if (Number.isInteger(parsed) && parsed > 0) {
        return parsed;
      }
    }
  }

  if (isProdRuntime && process.env.PORT) {
    const envPort = Number(process.env.PORT);
    if (Number.isInteger(envPort) && envPort > 0) {
      return envPort;
    }
  }

  return 3000;
}

async function startServer(): Promise<void> {
  const isDevExplicit =
    (process.env.NODE_ENV === 'development' || process.env.npm_lifecycle_event === 'dev') &&
    process.env.npm_lifecycle_event !== 'start';
  const isProd =
    process.env.NODE_ENV === 'production' ||
    process.env.npm_lifecycle_event === 'start' ||
    !isDevExplicit;
  const PORT = resolveServerPort(isProd);

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    const indexHtmlPath = path.join(distDir, 'index.html');
    app.use(express.static(distDir));
    app.get('*', (req, res) => {
      if (req.path.startsWith('/api/')) {
        res.status(404).json({ error: 'API endpoint not found.' });
        return;
      }
      if (!fs.existsSync(indexHtmlPath)) {
        res
          .status(503)
          .type('text/plain')
          .send('Application build artifacts are missing. Run `npm run build` before starting.');
        return;
      }
      res.sendFile(indexHtmlPath);
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`maYa multi-user server listening on http://localhost:${PORT}`);
    initializeExtractionQueueOnStartup();
  });
}

startServer().catch((err) => {
  console.error('[server] Fatal startup error:', err);
  process.exit(1);
});
