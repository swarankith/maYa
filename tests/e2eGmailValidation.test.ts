import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { db, initializeDatabase } from '../src/server/db.ts';
import { registerUser, revokeSessionToken } from '../src/server/authService.ts';
import {
  createGmailAuthUrl,
  getGmailConnectionStatus,
  getGmailMessages,
  handleGmailOAuthCallback,
  syncGmailMessages,
  type FetchLike,
} from '../src/server/gmailService.ts';
import { ExtractionQueueController } from '../src/server/extractionQueue.ts';
import {
  acceptExtractedItem,
  acceptSuggestedRelationship,
  getEmailInsights,
  rejectExtractedItem,
} from '../src/server/emailReviewService.ts';
import { getAllAuditLogs, getAllEdges, getAllNodes } from '../src/server/graphService.ts';
import { runRippleImpactAnalysis } from '../src/server/impactEngine.ts';
import { generateWhatIfPlans } from '../src/server/simulator.ts';
import {
  executeApprovedAction,
  selectPlanAndQueueApprovals,
} from '../src/server/permissionsAndExecution.ts';

function toBase64Url(text: string): string {
  return Buffer.from(text, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function main(): Promise<void> {
  initializeDatabase();

  const createdUserIds: string[] = [];
  const createdTokens: string[] = [];

  const prevEnv = {
    TOKEN_ENCRYPTION_KEY: process.env.TOKEN_ENCRYPTION_KEY,
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI: process.env.GOOGLE_REDIRECT_URI,
    GEMINI_MODEL: process.env.GEMINI_MODEL,
  };

  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString('hex');
  process.env.GOOGLE_CLIENT_ID = 'mock-google-client-id.apps.googleusercontent.com';
  process.env.GOOGLE_CLIENT_SECRET = 'mock-google-client-secret';
  process.env.GOOGLE_REDIRECT_URI = 'http://localhost:3000/api/integrations/gmail/callback';
  delete process.env.GEMINI_MODEL;

  const createTestUser = (label: string) => {
    const suffix = randomUUID().slice(0, 8);
    const session = registerUser({
      email: `e2e-${label}-${suffix}@maya-test.local`,
      password: 'StrongE2EPassword!123',
      displayName: `E2E ${label}`,
    });
    createdUserIds.push(session.user.id);
    createdTokens.push(session.token);
    return session;
  };

  try {
    // 1. Controlled E2E Pipeline (Mocked Gmail OAuth + Sync <=5 msgs + Gemini extraction + Graph + Impact + Approval)
    {
      const user = createTestUser('pipeline');
      const otherUser = createTestUser('other');
      const wsId = user.workspace.id;

      const { state } = createGmailAuthUrl(user.user.id, wsId, 'http://localhost:3000');

      const mockFetch: FetchLike = async (input, init) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url === 'https://oauth2.googleapis.com/token') {
          const bodyStr = String(init?.body ?? '');
          if (bodyStr.includes('grant_type=authorization_code')) {
            return new Response(
              JSON.stringify({
                access_token: 'mock-access-token-1',
                refresh_token: 'mock-refresh-token-1',
                expires_in: 3600,
                scope: 'https://www.googleapis.com/auth/gmail.readonly',
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            );
          }
        }
        if (url === 'https://gmail.googleapis.com/gmail/v1/users/me/profile') {
          return new Response(
            JSON.stringify({ emailAddress: 'e2e-inbox@maya-test.local', historyId: '5001' }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (url.startsWith('https://gmail.googleapis.com/gmail/v1/users/me/messages?')) {
          return new Response(
            JSON.stringify({
              messages: [{ id: 'gm-e2e-1' }, { id: 'gm-e2e-2' }, { id: 'gm-e2e-3' }],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (url.startsWith('https://gmail.googleapis.com/gmail/v1/users/me/history')) {
          return new Response(
            JSON.stringify({
              history: [
                {
                  messagesAdded: [
                    { message: { id: 'gm-e2e-1' } },
                    { message: { id: 'gm-e2e-2' } },
                    { message: { id: 'gm-e2e-3' } },
                  ],
                },
              ],
              historyId: '5002',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (url.includes('/messages/gm-e2e-1')) {
          return new Response(
            JSON.stringify({
              id: 'gm-e2e-1',
              threadId: 'thr-1',
              historyId: '5002',
              internalDate: String(Date.parse('2026-11-26T09:00:00Z')),
              snippet: 'Move Phoenix Launch to Dec 8',
              payload: {
                headers: [
                  { name: 'Subject', value: 'Phoenix Launch Deadline Shift' },
                  { name: 'From', value: 'lead@maya-test.local' },
                  { name: 'To', value: 'e2e-inbox@maya-test.local' },
                ],
                mimeType: 'text/plain',
                body: {
                  data: toBase64Url('Phoenix Launch deadline moved to 2026-12-08T17:00:00Z. Complete API Freeze before Dec 7.'),
                },
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (url.includes('/messages/gm-e2e-2')) {
          return new Response(
            JSON.stringify({
              id: 'gm-e2e-2',
              threadId: 'thr-2',
              historyId: '5002',
              internalDate: String(Date.parse('2026-11-26T09:05:00Z')),
              snippet: 'Weekly digest',
              payload: {
                headers: [
                  { name: 'Subject', value: 'Weekly Newsletter' },
                  { name: 'From', value: 'digest@maya-test.local' },
                ],
                mimeType: 'text/plain',
                body: { data: toBase64Url('General reading newsletter.') },
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (url.includes('/messages/gm-e2e-3')) {
          return new Response(
            JSON.stringify({
              id: 'gm-e2e-3',
              threadId: 'thr-3',
              historyId: '5002',
              internalDate: String(Date.parse('2026-11-26T09:10:00Z')),
              snippet: 'Unconfirmed rumor',
              payload: {
                headers: [
                  { name: 'Subject', value: 'Maybe coffee chat soon' },
                  { name: 'From', value: 'peer@maya-test.local' },
                ],
                mimeType: 'text/plain',
                body: { data: toBase64Url('Let us maybe sync soon.') },
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response(JSON.stringify({ error: { message: 'Unexpected URL' } }), { status: 404 });
      };

      const cbRes = await handleGmailOAuthCallback({ code: 'mock-code', state }, mockFetch);
      assert.equal(cbRes.ok, true);
      const connStatus = getGmailConnectionStatus(wsId);
      assert.equal(connStatus.status, 'CONNECTED');
      assert.deepEqual(connStatus.scopes, ['https://www.googleapis.com/auth/gmail.readonly']);

      const controller = new ExtractionQueueController({
        concurrency: 1,
        requestsPerMinute: 10,
        batchSize: 5,
        minSpacingMs: 0,
      });

      const seenModels: string[] = [];
      const mockGemini = async ({ model, contents }: { model: string; contents: string }) => {
        seenModels.push(model);
        const ids = Array.from(
          new Set([...contents.matchAll(/\[messageRowId=([^\]]+)\]/g)].map((m) => m[1])),
        );
        const msgsById = new Map(getGmailMessages(wsId).map((m) => [m.id, m]));
        return JSON.stringify({
          results: ids.map((id) => {
            const msg = msgsById.get(id);
            if (msg?.gmailMessageId === 'gm-e2e-1') {
              return {
                messageRowId: id,
                summary: 'Phoenix Launch deadline moved to Dec 8; API Freeze task.',
                relevance: 'RELEVANT',
                items: [
                  {
                    itemType: 'PROJECT',
                    title: 'Phoenix Launch',
                    description: 'Main release',
                    proposedDate: '2026-12-08T17:00:00Z',
                    dateAmbiguous: false,
                    factStatus: 'CONFIRMED',
                    evidenceQuote: 'Phoenix Launch deadline moved to 2026-12-08T17:00:00Z.',
                  },
                  {
                    itemType: 'TASK',
                    title: 'API Freeze',
                    description: 'Complete before Dec 7',
                    proposedDate: '2026-12-09',
                    dateAmbiguous: false,
                    relatedProjectName: 'Phoenix Launch',
                    factStatus: 'CONFIRMED',
                    evidenceQuote: 'Complete API Freeze before Dec 7.',
                  },
                ],
                relationships: [
                  {
                    sourceTitle: 'API Freeze',
                    targetTitle: 'Phoenix Launch',
                    relationshipType: 'BELONGS_TO',
                    rationale: 'API Freeze belongs to Phoenix Launch',
                    evidenceQuote: 'Complete API Freeze before Dec 7.',
                    factStatus: 'INFERRED',
                  },
                ],
              };
            }
            if (msg?.gmailMessageId === 'gm-e2e-2') {
              return {
                messageRowId: id,
                summary: 'Newsletter',
                relevance: 'LOW_SIGNAL',
                items: [],
                relationships: [],
              };
            }
            return {
              messageRowId: id,
              summary: 'Vague chat',
              relevance: 'RELEVANT',
              items: [
                {
                  itemType: 'MEETING',
                  title: 'Optional Coffee Chat',
                  proposedDate: null,
                  dateAmbiguous: true,
                  dateNote: 'Says "soon"',
                  factStatus: 'INFERRED',
                  evidenceQuote: 'Let us maybe sync soon.',
                },
              ],
              relationships: [],
            };
          }),
        });
      };

      const syncRes = await syncGmailMessages(wsId, user.user.displayName, {
        maxMessages: 5,
        fetchImpl: mockFetch,
        geminiCaller: mockGemini,
        awaitExtraction: true,
        extractionController: controller,
      });

      assert.equal(syncRes.fetchedCount, 3);
      assert.deepEqual(seenModels, ['gemini-3.5-flash-lite']);

      // Duplicate sync skips already-fetched messages
      const dupSync = await syncGmailMessages(wsId, user.user.displayName, {
        maxMessages: 5,
        fetchImpl: mockFetch,
        geminiCaller: mockGemini,
        awaitExtraction: true,
        extractionController: controller,
      });
      assert.equal(dupSync.fetchedCount, 0);
      assert.equal(dupSync.skippedDuplicates, 3);

      // Email Insights staging & cross-workspace isolation
      const insights = getEmailInsights(wsId);
      assert.equal(insights.messages.length, 3);
      assert.equal(insights.extractedItems.length, 3);
      assert.equal(insights.suggestedRelationships.length, 1);
      assert.equal(getEmailInsights(otherUser.workspace.id).messages.length, 0);

      // Reject ambiguous meeting -> zero graph mutations
      const meetingItem = insights.extractedItems.find((i) => i.title === 'Optional Coffee Chat')!;
      rejectExtractedItem(wsId, meetingItem.id, user.user.displayName);
      assert.equal(getAllNodes(wsId).length, 0);

      // Accept project & task -> persisted with Gmail provenance
      const projItem = insights.extractedItems.find((i) => i.title === 'Phoenix Launch')!;
      const taskItem = insights.extractedItems.find((i) => i.title === 'API Freeze')!;
      const accProj = acceptExtractedItem(wsId, projItem.id, undefined, user.user.displayName);
      const accTask = acceptExtractedItem(wsId, taskItem.id, undefined, user.user.displayName);
      assert.ok(accProj.node.provenance.includes('Gmail: Phoenix Launch Deadline Shift'));

      // Accept INFERRED relationship -> distinguishable from CONFIRMED
      const rel = insights.suggestedRelationships[0];
      acceptSuggestedRelationship(wsId, rel.id, undefined, user.user.displayName);
      const edges = getAllEdges(wsId);
      assert.equal(edges.length, 1);
      assert.equal(edges[0].factStatus, 'INFERRED');

      // Impact analysis + Simulator + Approvals (verify SEND_NOTIFICATION_DRAFT is UNSUPPORTED under gmail.readonly)
      const analysis = await runRippleImpactAnalysis(wsId, {
        projectId: accProj.node.id,
        newDeadlineIso: '2026-12-06T17:00',
        sourceRecord: {
          id: 'src-e2e-shift',
          workspaceId: wsId,
          sourceType: 'EMAIL',
          externalId: 'gm-e2e-1',
          sender: 'lead@maya-test.local',
          title: 'Phoenix Launch Deadline Shift',
          content: 'Moved to Dec 6',
          receivedAt: new Date().toISOString(),
          parsedEntities: {},
          isDemo: false,
          processed: true,
        },
        extractionMethod: 'GEMINI_NLU',
        extractionNote: 'E2E test',
      });
      const plans = generateWhatIfPlans(wsId, analysis);
      const approvals = selectPlanAndQueueApprovals(wsId, plans[1].id, user.user.displayName);
      const draftApproval = approvals.find((a) => a.actionType === 'SEND_NOTIFICATION_DRAFT')!;
      assert.equal(draftApproval.permissionValid, false);
      assert.equal(draftApproval.executionMode, 'UNSUPPORTED');
      assert.throws(() => executeApprovedAction(wsId, draftApproval.id), /Permission check failed/i);

      const taskApproval = approvals.find((a) => a.actionType === 'UPDATE_TASK_DUE_DATE')!;
      const executed = executeApprovedAction(wsId, taskApproval.id, 'Approved in E2E', user.user.displayName);
      assert.equal(executed.status, 'APPROVED');
      assert.equal(executed.executionMode, 'LOCAL_WORKSPACE');
      assert.ok(getAllAuditLogs(wsId).some((l) => l.approvalId === executed.id));
      console.log('PASS [1/4]: Controlled E2E mocked pipeline (OAuth -> Sync -> Extract -> Graph -> Impact -> Approval)');
    }

    // 2. Gmail token expiration (401 -> refresh_token recovery) and invalid_grant revocation
    {
      const user = createTestUser('token-exp');
      const wsId = user.workspace.id;
      const { state } = createGmailAuthUrl(user.user.id, wsId, 'http://localhost:3000');

      let refreshCalled = false;
      const expiredThenRefreshedFetch: FetchLike = async (input, init) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url === 'https://oauth2.googleapis.com/token') {
          const bodyStr = String(init?.body ?? '');
          if (bodyStr.includes('grant_type=authorization_code')) {
            return new Response(
              JSON.stringify({
                access_token: 'expired-access-token',
                refresh_token: 'valid-refresh-token',
                expires_in: 3600,
                scope: 'https://www.googleapis.com/auth/gmail.readonly',
              }),
              { status: 200 },
            );
          }
          if (bodyStr.includes('grant_type=refresh_token')) {
            refreshCalled = true;
            return new Response(
              JSON.stringify({ access_token: 'fresh-access-token', expires_in: 3600 }),
              { status: 200 },
            );
          }
        }
        if (url === 'https://gmail.googleapis.com/gmail/v1/users/me/profile') {
          return new Response(JSON.stringify({ emailAddress: 'refresh@maya-test.local', historyId: '10' }), {
            status: 200,
          });
        }
        if (url.startsWith('https://gmail.googleapis.com/gmail/v1/users/me/messages?')) {
          const auth = (init?.headers as Record<string, string>)?.Authorization ?? '';
          if (auth.includes('expired-access-token') && !refreshCalled) {
            return new Response(JSON.stringify({ error: { message: 'Expired' } }), { status: 401 });
          }
          return new Response(JSON.stringify({ messages: [] }), { status: 200 });
        }
        return new Response('{}', { status: 404 });
      };

      await handleGmailOAuthCallback({ code: 'c1', state }, expiredThenRefreshedFetch);
      await syncGmailMessages(wsId, 'Refresh Tester', {
        maxMessages: 5,
        fetchImpl: expiredThenRefreshedFetch,
      });
      assert.equal(refreshCalled, true, 'Expired access token must automatically refresh via refresh_token');

      // Now simulate revoked refresh token (invalid_grant) -> marks REVOKED
      const revokedFetch: FetchLike = async (input) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url === 'https://oauth2.googleapis.com/token') {
          return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
        }
        return new Response(JSON.stringify({ error: { message: 'Unauthorized' } }), { status: 401 });
      };
      await assert.rejects(
        () => syncGmailMessages(wsId, 'Revoked Tester', { fetchImpl: revokedFetch }),
        /refresh failed|revoked/i,
      );
      assert.equal(getGmailConnectionStatus(wsId).status, 'REVOKED');
      console.log('PASS [2/4]: Gmail token expiration auto-refresh & invalid_grant revocation verified');
    }

    // 3. Gmail API 429 rate limit handling
    {
      const user = createTestUser('gmail429');
      const wsId = user.workspace.id;
      const { state } = createGmailAuthUrl(user.user.id, wsId, 'http://localhost:3000');

      const rateLimitedFetch: FetchLike = async (input) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url === 'https://oauth2.googleapis.com/token') {
          return new Response(
            JSON.stringify({
              access_token: 'ok-token',
              refresh_token: 'ok-refresh',
              expires_in: 3600,
              scope: 'https://www.googleapis.com/auth/gmail.readonly',
            }),
            { status: 200 },
          );
        }
        if (url === 'https://gmail.googleapis.com/gmail/v1/users/me/profile') {
          return new Response(JSON.stringify({ emailAddress: 'rl@maya-test.local' }), { status: 200 });
        }
        return new Response(JSON.stringify({ error: { message: 'Rate Limit Exceeded (429)' } }), {
          status: 429,
        });
      };

      await handleGmailOAuthCallback({ code: 'c2', state }, rateLimitedFetch);
      await assert.rejects(
        () => syncGmailMessages(wsId, 'RL Tester', { fetchImpl: rateLimitedFetch }),
        /Rate Limit Exceeded|429/i,
      );
      assert.equal(getGmailMessages(wsId).length, 0);
      console.log('PASS [3/4]: Gmail API 429 rate limit handled cleanly without corrupting workspace');
    }

    // 4. Interrupted extraction / DB restart recovery
    {
      const user = createTestUser('db-interrupt');
      const wsId = user.workspace.id;
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO gmail_messages (
          id, workspace_id, gmail_message_id, thread_id, history_id, sender, recipients_json,
          subject, snippet, body_text, received_at, source_record_id, extraction_status, created_at
        ) VALUES (?, ?, ?, ?, '1', 's@maya-test.local', '[]', 'Interrupted Msg', 'S', 'Body', ?, NULL, 'PROCESSING', ?)
      `).run('gm-int-1', wsId, 'g-int-1', 'thr-int', now, now);

      const ctrl = new ExtractionQueueController({ concurrency: 1, requestsPerMinute: 10, minSpacingMs: 0 });
      const rec = ctrl.initializeOnStartup({ enqueue: false });
      assert.ok(rec.recoveredCount >= 1);
      const [msg] = getGmailMessages(wsId);
      assert.equal(msg.extractionStatus, 'PENDING');
      console.log('PASS [4/4]: Interrupted PROCESSING job recovered to PENDING cleanly');
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

    if (prevEnv.TOKEN_ENCRYPTION_KEY === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
    else process.env.TOKEN_ENCRYPTION_KEY = prevEnv.TOKEN_ENCRYPTION_KEY;
    if (prevEnv.GOOGLE_CLIENT_ID === undefined) delete process.env.GOOGLE_CLIENT_ID;
    else process.env.GOOGLE_CLIENT_ID = prevEnv.GOOGLE_CLIENT_ID;
    if (prevEnv.GOOGLE_CLIENT_SECRET === undefined) delete process.env.GOOGLE_CLIENT_SECRET;
    else process.env.GOOGLE_CLIENT_SECRET = prevEnv.GOOGLE_CLIENT_SECRET;
    if (prevEnv.GOOGLE_REDIRECT_URI === undefined) delete process.env.GOOGLE_REDIRECT_URI;
    else process.env.GOOGLE_REDIRECT_URI = prevEnv.GOOGLE_REDIRECT_URI;
    if (prevEnv.GEMINI_MODEL === undefined) delete process.env.GEMINI_MODEL;
    else process.env.GEMINI_MODEL = prevEnv.GEMINI_MODEL;
  }
}

main().catch((err) => {
  console.error('E2E GMAIL VALIDATION TEST SUITE FAILED:', err);
  process.exit(1);
});
