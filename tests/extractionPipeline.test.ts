import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db, initializeDatabase } from '../src/server/db.ts';
import { registerUser, revokeSessionToken } from '../src/server/authService.ts';
import { encryptSecret } from '../src/server/cryptoService.ts';
import {
  isRetryableGeminiError,
  parseRetryDelayMs,
  sanitizeExtractionError,
  type GeminiGenerateFn,
} from '../src/server/emailContextService.ts';
import { ExtractionQueueController } from '../src/server/extractionQueue.ts';
import { getGmailMessages, syncGmailMessages, type FetchLike } from '../src/server/gmailService.ts';
import { getExtractedItems } from '../src/server/emailReviewService.ts';

function makeBatchResponse(messageIds: string[], titlePrefix = 'Task'): string {
  return JSON.stringify({
    results: messageIds.map((id, idx) => ({
      messageRowId: id,
      summary: `Extracted summary for ${id}`,
      relevance: 'RELEVANT',
      items: [
        {
          itemType: 'TASK',
          title: `${titlePrefix} from ${id}`,
          description: `Follow-up deliverable #${idx + 1}`,
          proposedDate: '2026-12-05',
          dateAmbiguous: false,
          dateNote: null,
          assigneeOrPerson: 'Test Owner',
          relatedProjectName: 'Pipeline Test Project',
          factStatus: 'CONFIRMED',
          evidenceQuote: `Please finish ${titlePrefix} for ${id} by Dec 5, 2026.`,
          confidenceNote: 'Explicit date and task.',
        },
      ],
      relationships: [],
    })),
  });
}

function insertTestMessage(params: {
  id: string;
  workspaceId: string;
  gmailMessageId: string;
  subject: string;
  receivedAt: string;
  status?: string;
  retryCount?: number;
  maxRetries?: number;
}): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO gmail_messages (
      id, workspace_id, gmail_message_id, thread_id, history_id, sender, recipients_json,
      subject, snippet, body_text, received_at, source_record_id, extraction_status,
      extraction_error, retry_count, max_retries, next_retry_at, last_attempt_at, extracted_at, created_at
    ) VALUES (?, ?, ?, ?, '100', 'sender@example.com', '["me@example.com"]', ?, ?, ?, ?, NULL, ?, NULL, ?, ?, NULL, NULL, NULL, ?)
  `).run(
    params.id,
    params.workspaceId,
    params.gmailMessageId,
    `thr-${params.gmailMessageId}`,
    params.subject,
    `Snippet for ${params.subject}`,
    `Full body for ${params.subject}. Please finish deliverable by Dec 5, 2026.`,
    params.receivedAt,
    params.status ?? 'PENDING',
    params.retryCount ?? 0,
    params.maxRetries ?? 4,
    now,
  );
}

function extractBatchIdsFromPrompt(contents: string): string[] {
  const matches = [...contents.matchAll(/\[messageRowId=([^\]]+)\]/g)];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const m of matches) {
    if (m[1] && !seen.has(m[1])) {
      seen.add(m[1]);
      ids.push(m[1]);
    }
  }
  return ids;
}

async function main(): Promise<void> {
  initializeDatabase();

  const createdUserIds: string[] = [];
  const createdTokens: string[] = [];

  const createTestUser = (label: string) => {
    const suffix = randomUUID().slice(0, 8);
    const session = registerUser({
      email: `test-${label}-${suffix}@maya-test.local`,
      password: 'StrongTestPassword!123',
      displayName: `Tester ${label}`,
    });
    createdUserIds.push(session.user.id);
    createdTokens.push(session.token);
    return session;
  };

  try {
    // 1. Error parsing, retryability, and sanitization unit checks
    {
      const err429Header = {
        status: 429,
        headers: new Headers({ 'Retry-After': '48' }),
        message: 'RESOURCE_EXHAUSTED with key AIzaSyFakeKeyValue1234567890',
      };
      assert.equal(isRetryableGeminiError(err429Header), true, '429 must be retryable');
      assert.equal(parseRetryDelayMs(err429Header), 48_000, 'Retry-After header must parse to 48000ms');
      const sanitized = sanitizeExtractionError(err429Header);
      assert.equal(sanitized.includes('AIzaSyFakeKey'), false, 'API key must be redacted');
      assert.ok(sanitized.includes('429 RESOURCE_EXHAUSTED'), 'Sanitized 429 message should remain clear');

      const errGoogleRetryInfo = new Error(
        '{"error":{"code":429,"message":"You exceeded your current quota. Please retry in 42.3s.","status":"RESOURCE_EXHAUSTED","details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"42s"}]}}',
      );
      assert.equal(parseRetryDelayMs(errGoogleRetryInfo), 42_000, 'Google RetryInfo retryDelay must parse');

      const err503 = Object.assign(new Error('503 UNAVAILABLE: model overloaded'), { status: 503 });
      assert.equal(isRetryableGeminiError(err503), true, '503 must be retryable');

      const err401 = Object.assign(new Error('401 UNAUTHORIZED API_KEY_INVALID'), { status: 401 });
      assert.equal(isRetryableGeminiError(err401), false, '401 must not be retried indefinitely');
      console.log('PASS [1/6]: Retry-After/retryDelay parsing, retryability, and secret sanitization');
    }

    // 2. Batching + rate limiting (virtual clock to verify exact spacing & RPM cap)
    {
      const user = createTestUser('ratelimit');
      const wsId = user.workspace.id;
      for (let i = 0; i < 10; i += 1) {
        insertTestMessage({
          id: `msg-rl-${i}`,
          workspaceId: wsId,
          gmailMessageId: `g-rl-${i}`,
          subject: `Subject ${i}`,
          receivedAt: new Date(Date.UTC(2026, 10, 20, 10, i)).toISOString(),
        });
      }

      let virtualNow = 1_700_000_000_000;
      const sleepDurations: number[] = [];
      const callTimestamps: number[] = [];
      const controller = new ExtractionQueueController({
        concurrency: 1,
        requestsPerMinute: 4,
        batchSize: 4,
        windowMs: 60_000,
        nowFn: () => virtualNow,
        sleepFn: async (ms) => {
          sleepDurations.push(ms);
          virtualNow += ms;
        },
        randomFn: () => 0.5,
      });

      const fakeGemini: GeminiGenerateFn = async ({ contents }) => {
        callTimestamps.push(virtualNow);
        const ids = extractBatchIdsFromPrompt(contents);
        return makeBatchResponse(ids, 'Batched');
      };

      const res = await controller.processWorkspaceQueue(wsId, {
        geminiCaller: fakeGemini,
        awaitRetries: true,
      });

      assert.equal(res.batchesExecuted, 3, '10 messages at batchSize=4 must execute in 3 Gemini calls');
      assert.equal(res.completedCount, 10, 'All 10 messages must complete');
      assert.equal(callTimestamps.length, 3);
      assert.ok(
        callTimestamps[1] - callTimestamps[0] >= 15_000 && callTimestamps[2] - callTimestamps[1] >= 15_000,
        'Calls must respect 15,000ms spacing for 4 RPM limit',
      );
      assert.ok(sleepDurations.some((d) => d >= 15_000), 'Rate limiter must sleep between batches');
      console.log('PASS [2/6]: Batched processing and 4 RPM sliding-window rate limiting');
    }

    // 3. 429 & 503 backoff retries, transition to FAILED on maxRetries, and Retry Failed recovery
    {
      const user = createTestUser('retries');
      const wsId = user.workspace.id;
      insertTestMessage({
        id: 'msg-retry-1',
        workspaceId: wsId,
        gmailMessageId: 'g-retry-1',
        subject: 'Retry Recovery Email',
        receivedAt: '2026-11-21T10:00:00Z',
        maxRetries: 2,
      });

      let virtualNow = 1_700_000_500_000;
      const recordedDelays: number[] = [];
      const controller = new ExtractionQueueController({
        concurrency: 1,
        requestsPerMinute: 4,
        batchSize: 5,
        maxRetries: 2,
        baseBackoffMs: 2_000,
        maxBackoffMs: 60_000,
        minSpacingMs: 1_000,
        nowFn: () => virtualNow,
        sleepFn: async (ms) => {
          recordedDelays.push(ms);
          virtualNow += ms;
        },
        randomFn: () => 0.5,
      });

      let attempt = 0;
      const flakyGemini: GeminiGenerateFn = async ({ contents }) => {
        attempt += 1;
        if (attempt === 1) {
          throw Object.assign(
            new Error('429 RESOURCE_EXHAUSTED: Please retry in 25s.'),
            { status: 429 },
          );
        }
        if (attempt === 2) {
          throw Object.assign(new Error('503 UNAVAILABLE: Model overloaded'), { status: 503 });
        }
        return makeBatchResponse(extractBatchIdsFromPrompt(contents), 'Recovered');
      };

      // First run without awaiting retries -> should mark RETRYING (not FAILED!) with next_retry_at honoring 25s
      const firstPass = await controller.processWorkspaceQueue(wsId, {
        geminiCaller: flakyGemini,
        awaitRetries: false,
      });
      assert.equal(firstPass.retryingCount, 1, 'Transient 429 must transition to RETRYING, not FAILED');
      assert.equal(firstPass.failedCount, 0);
      let [msg] = getGmailMessages(wsId);
      assert.equal(msg.extractionStatus, 'RETRYING');
      assert.equal(msg.retryCount, 1);
      assert.ok(msg.nextRetryAt, 'nextRetryAt must be persisted');
      const delayUntilRetry = Date.parse(msg.nextRetryAt!) - 1_700_000_500_000;
      assert.ok(delayUntilRetry >= 25_000, `Expected nextRetryAt >= 25000ms, got ${delayUntilRetry}ms`);

      // Advance clock past first retry -> 503 fails attempt 2 -> attempt 3 succeeds with awaitRetries=true
      virtualNow += 30_000;
      const secondPass = await controller.processWorkspaceQueue(wsId, {
        geminiCaller: flakyGemini,
        awaitRetries: true,
      });
      assert.equal(secondPass.completedCount, 1, 'Should succeed after 429 + 503 retries');
      [msg] = getGmailMessages(wsId);
      assert.equal(msg.extractionStatus, 'COMPLETED');
      assert.equal(msg.extractionError, null);
      assert.ok(msg.extractedAt);

      // Now test exhausting maxRetries -> FAILED, followed by manual retryFailedForWorkspace recovery
      insertTestMessage({
        id: 'msg-fail-1',
        workspaceId: wsId,
        gmailMessageId: 'g-fail-1',
        subject: 'Persistent Overload Email',
        receivedAt: '2026-11-22T10:00:00Z',
        maxRetries: 1,
      });
      const always503: GeminiGenerateFn = async () => {
        throw Object.assign(new Error('503 UNAVAILABLE'), { status: 503 });
      };
      virtualNow += 60_000;
      const exhaustRes = await controller.processWorkspaceQueue(wsId, {
        geminiCaller: always503,
        awaitRetries: true,
      });
      assert.equal(exhaustRes.failedCount, 1, 'Must transition to FAILED once maxRetries exceeded');

      const beforeRetryCompletedCount = getExtractedItems(wsId).length;
      const { retriedCount } = controller.retryFailedForWorkspace(wsId, undefined, { enqueue: false });
      assert.equal(retriedCount, 1, 'Only FAILED message should be re-queued, never COMPLETED ones');

      virtualNow += 60_000;
      const recoveryRes = await controller.processWorkspaceQueue(wsId, {
        geminiCaller: async ({ contents }) => makeBatchResponse(extractBatchIdsFromPrompt(contents), 'ManualRetry'),
      });
      assert.equal(recoveryRes.completedCount, 1, 'Manual retryFailed must recover failed message');
      assert.equal(
        getExtractedItems(wsId).filter((i) => i.messageRowId === 'msg-retry-1').length,
        beforeRetryCompletedCount,
        'Completed message must NOT be re-processed or duplicated on retry',
      );
      console.log('PASS [3/6]: 429/503 exponential backoff + retryDelay honoring + FAILED retry recovery');
    }

    // 4. Partial batch failure & idempotency (no duplicate items)
    {
      const user = createTestUser('partial');
      const wsId = user.workspace.id;
      insertTestMessage({
        id: 'msg-part-a',
        workspaceId: wsId,
        gmailMessageId: 'g-part-a',
        subject: 'Batch Item A',
        receivedAt: '2026-11-22T11:00:00Z',
      });
      insertTestMessage({
        id: 'msg-part-b',
        workspaceId: wsId,
        gmailMessageId: 'g-part-b',
        subject: 'Batch Item B',
        receivedAt: '2026-11-22T11:01:00Z',
      });
      insertTestMessage({
        id: 'msg-part-c',
        workspaceId: wsId,
        gmailMessageId: 'g-part-c',
        subject: 'Batch Item C',
        receivedAt: '2026-11-22T11:02:00Z',
      });

      let virtualNow = 1_700_001_000_000;
      const controller = new ExtractionQueueController({
        concurrency: 1,
        requestsPerMinute: 4,
        batchSize: 5,
        baseBackoffMs: 1_000,
        minSpacingMs: 500,
        nowFn: () => virtualNow,
        sleepFn: async (ms) => {
          virtualNow += ms;
        },
        randomFn: () => 0.5,
      });

      let callNum = 0;
      const partialGemini: GeminiGenerateFn = async ({ contents }) => {
        callNum += 1;
        const ids = extractBatchIdsFromPrompt(contents);
        if (callNum === 1) {
          // Omit the last ID to simulate partial batch omission
          return makeBatchResponse(ids.slice(0, 2), 'Partial');
        }
        return makeBatchResponse(ids, 'PartialRetry');
      };

      const res = await controller.processWorkspaceQueue(wsId, {
        geminiCaller: partialGemini,
        awaitRetries: true,
      });
      assert.equal(callNum, 2, 'Second call should only contain the 1 omitted message');
      assert.equal(res.completedCount, 3, 'All 3 messages must eventually complete');
      const items = getExtractedItems(wsId);
      assert.equal(items.length, 3, 'Each message must have exactly 1 extracted item (no duplicates)');

      // Running queue again should do 0 work
      const idempotentRes = await controller.processWorkspaceQueue(wsId, {
        geminiCaller: partialGemini,
      });
      assert.equal(idempotentRes.batchesExecuted, 0, 'COMPLETED messages must not be re-processed');
      console.log('PASS [4/6]: Partial batch failure recovery and duplicate prevention');
    }

    // 5. Decoupled Gmail Sync persistence + duplicate skip when Gemini fails
    {
      const prevEncKey = process.env.TOKEN_ENCRYPTION_KEY;
      const prevClientId = process.env.GOOGLE_CLIENT_ID;
      const prevClientSecret = process.env.GOOGLE_CLIENT_SECRET;
      process.env.TOKEN_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
      process.env.GOOGLE_CLIENT_ID = 'test-client-id';
      process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';

      try {
        const user = createTestUser('sync');
        const wsId = user.workspace.id;
        const futureExpiry = new Date(Date.now() + 3600_000).toISOString();
        const nowIso = new Date().toISOString();
        db.prepare(`
          INSERT INTO gmail_connections (
            id, workspace_id, user_id, google_email, scopes_json,
            encrypted_access_token, encrypted_refresh_token, token_expires_at,
            status, last_error, history_id, last_sync_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'CONNECTED', NULL, NULL, NULL, ?, ?)
        `).run(
          `gconn-test-${wsId}`,
          wsId,
          user.user.id,
          'sync-tester@example.com',
          JSON.stringify(['https://www.googleapis.com/auth/gmail.readonly']),
          encryptSecret('fake-access-token'),
          encryptSecret('fake-refresh-token'),
          futureExpiry,
          nowIso,
          nowIso,
        );

        const fakeGmailFetch: FetchLike = async (input) => {
          const url = String(input);
          if (url.includes('/gmail/v1/users/me/messages?')) {
            return new Response(JSON.stringify({ messages: [{ id: 'gmail-msg-101' }, { id: 'gmail-msg-102' }] }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          if (url.includes('/gmail/v1/users/me/profile')) {
            return new Response(JSON.stringify({ historyId: '5001' }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          if (url.includes('/gmail/v1/users/me/messages/gmail-msg-')) {
            const msgId = url.includes('101') ? 'gmail-msg-101' : 'gmail-msg-102';
            const bodyB64 = Buffer.from(`Project deadline for ${msgId} is Dec 10, 2026.`, 'utf8').toString('base64url');
            return new Response(
              JSON.stringify({
                id: msgId,
                threadId: `thr-${msgId}`,
                historyId: '5001',
                internalDate: String(Date.now()),
                snippet: `Deadline update ${msgId}`,
                payload: {
                  mimeType: 'text/plain',
                  headers: [
                    { name: 'Subject', value: `Subject ${msgId}` },
                    { name: 'From', value: 'lead@example.com' },
                    { name: 'To', value: 'sync-tester@example.com' },
                  ],
                  body: { data: bodyB64 },
                },
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            );
          }
          return new Response(JSON.stringify({}), { status: 404 });
        };

        let virtualNow = 1_700_002_000_000;
        const syncController = new ExtractionQueueController({
          concurrency: 1,
          requestsPerMinute: 4,
          batchSize: 5,
          maxRetries: 2,
          baseBackoffMs: 1_000,
          minSpacingMs: 500,
          nowFn: () => virtualNow,
          sleepFn: async (ms) => {
            virtualNow += ms;
          },
          randomFn: () => 0.5,
        });

        const firstSync = await syncGmailMessages(wsId, 'Tester', {
          fetchImpl: fakeGmailFetch,
          extractionController: syncController,
          geminiCaller: async () => {
            throw Object.assign(new Error('429 RESOURCE_EXHAUSTED'), { status: 429 });
          },
        });

        assert.equal(firstSync.fetchedCount, 2, 'Sync must persist both fetched emails even when Gemini throws 429');
        const storedMsgs = getGmailMessages(wsId);
        assert.equal(storedMsgs.length, 2, 'Both fetched emails must remain stored in SQLite');
        assert.ok(
          storedMsgs.every((m) => m.extractionStatus === 'RETRYING'),
          'Stored emails must be marked RETRYING after 429 rather than lost or permanently failed',
        );

        // Second sync with the same Gmail messages must skip duplicates without re-inserting
        const secondSync = await syncGmailMessages(wsId, 'Tester', {
          fetchImpl: fakeGmailFetch,
          extractionController: syncController,
          geminiCaller: async ({ contents }) => makeBatchResponse(extractBatchIdsFromPrompt(contents), 'SecondSync'),
        });
        assert.equal(secondSync.fetchedCount, 0);
        assert.equal(secondSync.skippedDuplicates, 2, 'Re-syncing same gmailMessageIds must skip duplicates');
        console.log('PASS [5/6]: Decoupled Gmail sync persistence and duplicate email skip');
      } finally {
        if (prevEncKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
        else process.env.TOKEN_ENCRYPTION_KEY = prevEncKey;
        if (prevClientId === undefined) delete process.env.GOOGLE_CLIENT_ID;
        else process.env.GOOGLE_CLIENT_ID = prevClientId;
        if (prevClientSecret === undefined) delete process.env.GOOGLE_CLIENT_SECRET;
        else process.env.GOOGLE_CLIENT_SECRET = prevClientSecret;
      }
    }

    // 6. Cross-workspace isolation & live API routes on localhost:3000
    {
      const userA = createTestUser('isoA');
      const userB = createTestUser('isoB');

      insertTestMessage({
        id: `msg-iso-a-${randomUUID().slice(0, 6)}`,
        workspaceId: userA.workspace.id,
        gmailMessageId: 'g-iso-a',
        subject: 'User A Private Failure',
        receivedAt: '2026-11-23T08:00:00Z',
        status: 'FAILED',
      });
      const msgBId = `msg-iso-b-${randomUUID().slice(0, 6)}`;
      insertTestMessage({
        id: msgBId,
        workspaceId: userB.workspace.id,
        gmailMessageId: 'g-iso-b',
        subject: 'User B Private Failure',
        receivedAt: '2026-11-23T08:05:00Z',
        status: 'FAILED',
      });

      // User A calls /api/email-insights/retry-failed trying to target User B's messageId
      const crossRes = await fetch('http://localhost:3000/api/email-insights/retry-failed', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userA.token}`,
        },
        body: JSON.stringify({ messageId: msgBId }),
      });
      assert.equal(crossRes.status, 200);
      const crossJson = (await crossRes.json()) as { retriedCount: number };
      assert.equal(crossJson.retriedCount, 0, 'User A must NEVER reset User B failed message');

      const [msgBAfter] = getGmailMessages(userB.workspace.id);
      assert.equal(msgBAfter.extractionStatus, 'FAILED', 'User B message status must remain untouched');

      // Check extractionSummary endpoint & DEMO MODE guard
      const insightsRes = await fetch('http://localhost:3000/api/email-insights', {
        headers: { Authorization: `Bearer ${userA.token}` },
      });
      assert.equal(insightsRes.status, 200);
      const insightsJson = (await insightsRes.json()) as {
        extractionSummary: { failed: number; rateLimitRpm: number; batchSize: number };
      };
      assert.equal(insightsJson.extractionSummary.failed, 1);
      assert.equal(insightsJson.extractionSummary.rateLimitRpm, 4);
      assert.equal(insightsJson.extractionSummary.batchSize, 5);

      const demoRetryRes = await fetch('http://localhost:3000/api/demo/email-insights/retry-failed', {
        method: 'POST',
      });
      assert.equal(demoRetryRes.status, 403, 'DEMO MODE must reject email-insights mutations');
      console.log('PASS [6/6]: Workspace isolation and live HTTP API route enforcement');
    }
  } finally {
    // Clean up all synthetic test users, workspaces, and sessions
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
  }
}

main().catch((err) => {
  console.error('TEST SUITE FAILED:', err);
  process.exit(1);
});
