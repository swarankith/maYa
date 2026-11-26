import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db, initializeDatabase } from '../src/server/db.ts';
import { registerUser, revokeSessionToken } from '../src/server/authService.ts';
import { encryptSecret } from '../src/server/cryptoService.ts';
import {
  DEFAULT_GEMINI_MODEL,
  EMAIL_EXTRACTED_ITEM_TYPES,
  EMAIL_RELEVANCE_VALUES,
  extractAndStageEmailBatch,
  GeminiSchemaValidationError,
  getConfiguredGeminiModel,
  isRetryableGeminiError,
  normalizeIsoProposedDate,
  parseAndValidateBatchEmailExtraction,
  parseAndValidateEmailExtraction,
  parseRetryDelayMs,
  sanitizeExtractionError,
  type GeminiGenerateFn,
} from '../src/server/emailContextService.ts';
import { ExtractionQueueController } from '../src/server/extractionQueue.ts';
import { GeminiQuotaCoordinator } from '../src/server/geminiRateLimiter.ts';
import { extractChangeFromText, generateExplainableNarrative } from '../src/server/geminiService.ts';
import { getGmailMessages, syncGmailMessages, type FetchLike } from '../src/server/gmailService.ts';
import { getExtractedItems } from '../src/server/emailReviewService.ts';
import type { ContextNode, ImpactAnalysisResult } from '../src/types/maya.ts';

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
  const createdQuotaKeys: string[] = [];

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
      console.log('PASS [1/13]: Retry-After/retryDelay parsing, retryability, and secret sanitization');
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
      console.log('PASS [2/13]: Batched processing and 4 RPM sliding-window rate limiting');
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
      console.log('PASS [3/13]: 429/503 exponential backoff + retryDelay honoring + FAILED retry recovery');
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
      console.log('PASS [4/13]: Partial batch failure recovery and duplicate prevention');
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
        console.log('PASS [5/13]: Decoupled Gmail sync persistence and duplicate email skip');
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
      console.log('PASS [6/13]: Workspace isolation and live HTTP API route enforcement');
    }

    // 7. Malformed-JSON batch-splitting fallback (concurrency=1 safe, isolates bad email)
    {
      const user = createTestUser('splitjson');
      const wsId = user.workspace.id;
      insertTestMessage({
        id: 'msg-split-good-1',
        workspaceId: wsId,
        gmailMessageId: 'g-split-good-1',
        subject: 'Valid Email 1',
        receivedAt: '2026-11-24T09:00:00Z',
        maxRetries: 1,
      });
      insertTestMessage({
        id: 'msg-split-bad',
        workspaceId: wsId,
        gmailMessageId: 'g-split-bad',
        subject: 'Malformed Email',
        receivedAt: '2026-11-24T09:01:00Z',
        maxRetries: 1,
      });
      insertTestMessage({
        id: 'msg-split-good-2',
        workspaceId: wsId,
        gmailMessageId: 'g-split-good-2',
        subject: 'Valid Email 2',
        receivedAt: '2026-11-24T09:02:00Z',
        maxRetries: 1,
      });

      let virtualNow = 1_700_003_000_000;
      const controller = new ExtractionQueueController({
        concurrency: 1,
        requestsPerMinute: 4,
        batchSize: 5,
        maxRetries: 1,
        baseBackoffMs: 500,
        maxBackoffMs: 5_000,
        minSpacingMs: 250,
        nowFn: () => virtualNow,
        sleepFn: async (ms) => {
          virtualNow += ms;
        },
        randomFn: () => 0.5,
      });

      let geminiCalls = 0;
      const splitGemini: GeminiGenerateFn = async ({ contents }) => {
        geminiCalls += 1;
        const ids = extractBatchIdsFromPrompt(contents);
        if (ids.includes('msg-split-bad')) {
          return '{not-valid-json';
        }
        return makeBatchResponse(ids, 'SplitOK');
      };

      const pass1 = await controller.processWorkspaceQueue(wsId, {
        geminiCaller: splitGemini,
        awaitRetries: false,
      });
      assert.equal(geminiCalls, 4, '1 failed batch call + 3 isolated fallback calls expected');
      assert.equal(pass1.completedCount, 2, 'Both valid sibling emails must complete despite bad sibling');
      assert.equal(pass1.retryingCount, 1, 'Only the malformed email should transition to RETRYING');

      // Exhaust maxRetries on the bad email alone
      virtualNow += 10_000;
      const pass2 = await controller.processWorkspaceQueue(wsId, {
        geminiCaller: splitGemini,
        awaitRetries: true,
      });
      assert.equal(pass2.failedCount, 1, 'Bad email must eventually transition to FAILED independently');

      const msgs = getGmailMessages(wsId);
      const statusById = new Map(msgs.map((m) => [m.id, m.extractionStatus]));
      assert.equal(statusById.get('msg-split-good-1'), 'COMPLETED');
      assert.equal(statusById.get('msg-split-good-2'), 'COMPLETED');
      assert.equal(statusById.get('msg-split-bad'), 'FAILED');
      console.log('PASS [7/13]: Malformed-JSON batch-splitting isolates bad email without deadlocking');
    }

    // 8. Startup recovery resets PROCESSING -> PENDING idempotently without duplicate workers/timers
    {
      const user = createTestUser('startup');
      const wsId = user.workspace.id;
      insertTestMessage({
        id: 'msg-stuck-proc',
        workspaceId: wsId,
        gmailMessageId: 'g-stuck-proc',
        subject: 'Interrupted Processing Email',
        receivedAt: '2026-11-24T10:00:00Z',
        status: 'PROCESSING',
      });

      const bootController = new ExtractionQueueController({
        concurrency: 1,
        requestsPerMinute: 4,
        batchSize: 5,
      });

      const firstInit = bootController.initializeOnStartup({ enqueue: false });
      assert.ok(firstInit.recoveredCount >= 1, 'Interrupted PROCESSING message must be recovered to PENDING');
      const [recoveredMsg] = getGmailMessages(wsId);
      assert.equal(recoveredMsg.extractionStatus, 'PENDING');
      assert.equal(recoveredMsg.nextRetryAt, null);

      // Second call must be a strict no-op (prevents duplicate startup workers/timers)
      const secondInit = bootController.initializeOnStartup({ enqueue: true });
      assert.equal(secondInit.recoveredCount, 0);
      assert.equal(secondInit.workspacesScheduled, 0);
      console.log('PASS [8/13]: Idempotent startup recovery resets PROCESSING rows safely');
    }

    // 9. Competing Gemini features share one quota & concurrency limit without bypassing spacing
    {
      const user = createTestUser('compete');
      const wsId = user.workspace.id;
      insertTestMessage({
        id: 'msg-compete-1',
        workspaceId: wsId,
        gmailMessageId: 'g-compete-1',
        subject: 'Competing Quota Email 1',
        receivedAt: '2026-11-24T11:00:00Z',
      });

      let virtualNow = 1_700_004_000_000;
      const sharedLimiter = new GeminiQuotaCoordinator({
        concurrency: 1,
        requestsPerMinute: 4,
        windowMs: 60_000,
        minSpacingMs: 15_000,
        defaultRateLimitCooldownMs: 5_000,
        persistToDb: false,
        nowFn: () => virtualNow,
        sleepFn: async (ms) => {
          virtualNow += ms;
        },
        randomFn: () => 0.5,
      });

      const controller = new ExtractionQueueController({
        batchSize: 5,
        rateLimiter: sharedLimiter,
      });

      const callTimes: number[] = [];
      let inFlight = 0;
      let maxInFlight = 0;

      const sampleProjects: ContextNode[] = [
        {
          id: 'proj-comp',
          workspaceId: wsId,
          type: 'PROJECT',
          title: 'AI Research Project',
          subtitle: '',
          status: 'Active',
          date: '2026-11-27',
          ownerId: null,
          projectId: null,
          metadata: {},
          provenance: 'Test',
          factStatus: 'CONFIRMED',
          isDemo: false,
          createdAt: '2026-11-24T00:00:00Z',
          updatedAt: '2026-11-24T00:00:00Z',
        },
      ];

      const sampleAnalysis: Omit<ImpactAnalysisResult, 'aiNarrative' | 'aiStatus'> = {
        id: 'imp-comp',
        workspaceId: wsId,
        changeEvent: {
          id: 'chg-comp',
          projectId: 'proj-comp',
          projectTitle: 'AI Research Project',
          targetNodeId: 'dl-comp',
          targetNodeTitle: 'Submission Deadline',
          fieldChanged: 'deadline',
          originalValue: '2026-11-27',
          newValue: '2026-11-25T17:00',
          sourceRecordId: 'src-comp',
          sourceRecordTitle: 'Schedule Shift',
          extractionMethod: 'GEMINI_NLU',
          extractionConfidenceNote: 'Test',
          detectedAt: '2026-11-24T11:00:00Z',
        },
        directImpacts: [],
        downstreamImpacts: [],
        unaffectedItems: [],
        explanationSummary: 'Moved to Wednesday',
        createdAt: '2026-11-24T11:00:00Z',
      };

      const trackedBatchGemini: GeminiGenerateFn = async ({ contents }) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        callTimes.push(virtualNow);
        await Promise.resolve();
        inFlight -= 1;
        return makeBatchResponse(extractBatchIdsFromPrompt(contents), 'Competing');
      };

      const trackedChangeGemini = async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        callTimes.push(virtualNow);
        await Promise.resolve();
        inFlight -= 1;
        return JSON.stringify({
          projectTitleMatch: 'AI Research Project',
          fieldChanged: 'deadline',
          originalDateHint: 'Friday',
          newDateIso: '2026-11-25',
          newTimeHint: '17:00',
          summary: 'Moved to Wednesday',
        });
      };

      const trackedNarrativeGemini = async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        callTimes.push(virtualNow);
        await Promise.resolve();
        inFlight -= 1;
        return 'Confirmed deadline shift briefing.';
      };

      const [queueRes, changeRes, narrativeRes] = await Promise.all([
        controller.processWorkspaceQueue(wsId, {
          geminiCaller: trackedBatchGemini,
          awaitRetries: true,
        }),
        extractChangeFromText('Urgent Update', 'Moved to Wednesday', sampleProjects, {
          rateLimiter: sharedLimiter,
          geminiCaller: trackedChangeGemini,
          maxInteractiveWaitMs: Infinity,
        }),
        generateExplainableNarrative(sampleAnalysis, {
          rateLimiter: sharedLimiter,
          geminiCaller: trackedNarrativeGemini,
          maxInteractiveWaitMs: Infinity,
        }),
      ]);

      assert.equal(queueRes.completedCount, 1);
      assert.equal(changeRes.usedGemini, true);
      assert.equal(narrativeRes.aiStatus, 'USED');
      assert.equal(maxInFlight, 1, 'Shared concurrency=1 must serialize competing Gemini features');
      assert.equal(callTimes.length, 3, 'All 3 competing features must execute through shared limiter');
      assert.ok(
        callTimes[1] - callTimes[0] >= 15_000 && callTimes[2] - callTimes[1] >= 15_000,
        `Competing calls must respect 15,000ms shared RPM spacing, got ${JSON.stringify(callTimes)}`,
      );
      console.log('PASS [9/13]: Competing Gemini features strictly share concurrency and RPM limits');
    }

    // 10. 429 retryDelay longer than queue maxBackoffMs is NOT truncated early
    {
      const user = createTestUser('long429');
      const wsId = user.workspace.id;
      insertTestMessage({
        id: 'msg-long-429',
        workspaceId: wsId,
        gmailMessageId: 'g-long-429',
        subject: 'Long Quota Cooldown Email',
        receivedAt: '2026-11-24T12:00:00Z',
        maxRetries: 3,
      });

      let virtualNow = 1_700_005_000_000;
      const sharedLimiter = new GeminiQuotaCoordinator({
        concurrency: 1,
        requestsPerMinute: 4,
        minSpacingMs: 1_000,
        defaultRateLimitCooldownMs: 2_000,
        persistToDb: false,
        nowFn: () => virtualNow,
        sleepFn: async (ms) => {
          virtualNow += ms;
        },
        randomFn: () => 0.5,
      });

      const controller = new ExtractionQueueController({
        batchSize: 5,
        maxRetries: 3,
        baseBackoffMs: 2_000,
        maxBackoffMs: 30_000, // Deliberately shorter than upstream 180s retryDelay
        rateLimiter: sharedLimiter,
      });

      let calls = 0;
      const pass1 = await controller.processWorkspaceQueue(wsId, {
        geminiCaller: async () => {
          calls += 1;
          throw Object.assign(
            new Error(
              '{"error":{"code":429,"message":"RESOURCE_EXHAUSTED","details":[{"retryDelay":"180s"}]}}',
            ),
            { status: 429 },
          );
        },
        awaitRetries: false,
      });

      assert.equal(calls, 1);
      assert.equal(pass1.retryingCount, 1);
      const [msg] = getGmailMessages(wsId);
      assert.equal(msg.extractionStatus, 'RETRYING');
      const scheduledDelayMs = Date.parse(msg.nextRetryAt!) - 1_700_005_000_000;
      assert.ok(
        scheduledDelayMs >= 180_000,
        `Upstream 180s 429 retryDelay must NOT be truncated by maxBackoffMs=30s (got ${scheduledDelayMs}ms)`,
      );
      assert.ok(
        sharedLimiter.getCooldownRemainingMs() >= 180_000,
        'Shared limiter cooldown must honor full 180s upstream delay',
      );
      console.log('PASS [10/13]: 429 retryDelay longer than queue maxBackoffMs is fully respected');
    }

    // 11. 503 UNAVAILABLE uses safe backoff and succeeds on subsequent retry in geminiService & queue
    {
      let virtualNow = 1_700_006_000_000;
      const sleepLog: number[] = [];
      const sharedLimiter = new GeminiQuotaCoordinator({
        concurrency: 1,
        requestsPerMinute: 10,
        minSpacingMs: 500,
        defaultRateLimitCooldownMs: 2_000,
        persistToDb: false,
        nowFn: () => virtualNow,
        sleepFn: async (ms) => {
          sleepLog.push(ms);
          virtualNow += ms;
        },
        randomFn: () => 0.5,
      });

      let attempts = 0;
      const res = await extractChangeFromText(
        'Review Moved',
        'Project review moved to Thursday.',
        [],
        {
          rateLimiter: sharedLimiter,
          maxTransientRetries: 2,
          base503BackoffMs: 1_500,
          maxInteractiveWaitMs: 30_000,
          geminiCaller: async () => {
            attempts += 1;
            if (attempts === 1) {
              throw Object.assign(new Error('503 UNAVAILABLE: overloaded'), { status: 503 });
            }
            return JSON.stringify({
              projectTitleMatch: 'AI Research Project',
              fieldChanged: 'deadline',
              originalDateHint: 'Friday',
              newDateIso: '2026-11-26',
              newTimeHint: '17:00',
              summary: 'Moved to Thursday after 503 recovery.',
            });
          },
        },
      );

      assert.equal(attempts, 2, '503 error must trigger safe retry');
      assert.equal(res.usedGemini, true, 'Subsequent retry after 503 must succeed');
      assert.ok(
        sleepLog.some((d) => d >= 1_500),
        `503 retry must wait safe backoff before retrying, got ${JSON.stringify(sleepLog)}`,
      );
      console.log('PASS [11/13]: 503 UNAVAILABLE waits safe backoff and succeeds on retry');
    }

    // 12. Server restart restores persistent cooldown from SQLite and blocks immediate re-execution
    {
      const testQuotaKey = `test-restart-${randomUUID().slice(0, 8)}`;
      createdQuotaKeys.push(testQuotaKey);

      const user = createTestUser('restartcd');
      const wsId = user.workspace.id;
      insertTestMessage({
        id: 'msg-restart-cd',
        workspaceId: wsId,
        gmailMessageId: 'g-restart-cd',
        subject: 'Pending Across Restart',
        receivedAt: '2026-11-24T13:00:00Z',
        status: 'PROCESSING',
      });

      let virtualNow = 1_700_007_000_000;
      const preRestartLimiter = new GeminiQuotaCoordinator({
        concurrency: 1,
        requestsPerMinute: 4,
        minSpacingMs: 1_000,
        defaultRateLimitCooldownMs: 5_000,
        persistToDb: true,
        dbStateKey: testQuotaKey,
        nowFn: () => virtualNow,
        sleepFn: async (ms) => {
          virtualNow += ms;
        },
      });

      preRestartLimiter.recordQuotaError(
        Object.assign(new Error('429 RESOURCE_EXHAUSTED: Please retry in 120s.'), { status: 429 }),
      );
      assert.ok(preRestartLimiter.getCooldownRemainingMs() >= 120_000);

      // Simulate fresh server restart 10 seconds later with new instances wired to the same SQLite key
      virtualNow += 10_000;
      const postRestartLimiter = new GeminiQuotaCoordinator({
        concurrency: 1,
        requestsPerMinute: 4,
        minSpacingMs: 1_000,
        defaultRateLimitCooldownMs: 5_000,
        persistToDb: true,
        dbStateKey: testQuotaKey,
        nowFn: () => virtualNow,
        sleepFn: async (ms) => {
          virtualNow += ms;
        },
      });
      const postRestartQueue = new ExtractionQueueController({
        rateLimiter: postRestartLimiter,
      });

      postRestartQueue.initializeOnStartup({ enqueue: false });
      const remainingAfterRestart = postRestartLimiter.getCooldownRemainingMs();
      assert.ok(
        remainingAfterRestart >= 109_000 && remainingAfterRestart <= 110_000,
        `Restored cooldown should reflect remaining ~110s after restart, got ${remainingAfterRestart}ms`,
      );

      let postRestartGeminiCalls = 0;
      const restartPass = await postRestartQueue.processWorkspaceQueue(wsId, {
        geminiCaller: async ({ contents }) => {
          postRestartGeminiCalls += 1;
          return makeBatchResponse(extractBatchIdsFromPrompt(contents), 'ShouldNotRunYet');
        },
        awaitRetries: false,
      });

      assert.equal(
        postRestartGeminiCalls,
        0,
        'Restarted queue must NOT fire Gemini before restored cooldown expires',
      );
      assert.ok(restartPass.nextScheduledAt, 'Restarted queue must schedule wakeup at cooldown expiry');
      console.log('PASS [12/13]: Server restart restores active global cooldown from SQLite');
    }

    // 13. Zero requests proceed before active cooldown expires; succeed once cooldown expires
    {
      const user = createTestUser('cdguard');
      const wsId = user.workspace.id;
      insertTestMessage({
        id: 'msg-cd-guard',
        workspaceId: wsId,
        gmailMessageId: 'g-cd-guard',
        subject: 'Cooldown Guard Email',
        receivedAt: '2026-11-24T14:00:00Z',
      });

      let virtualNow = 1_700_008_000_000;
      const limiter = new GeminiQuotaCoordinator({
        concurrency: 1,
        requestsPerMinute: 4,
        minSpacingMs: 1_000,
        defaultRateLimitCooldownMs: 5_000,
        persistToDb: false,
        nowFn: () => virtualNow,
        sleepFn: async (ms) => {
          virtualNow += ms;
        },
      });
      const controller = new ExtractionQueueController({ rateLimiter: limiter });

      limiter.applyCooldownDelayMs(120_000, '429 RESOURCE_EXHAUSTED', 429);

      let apiCallsBeforeExpiry = 0;
      // Attempt at T + 10s
      virtualNow += 10_000;
      const changeEarly = await extractChangeFromText('Urgent', 'Deadline moved to Friday.', [], {
        rateLimiter: limiter,
        maxInteractiveWaitMs: 25_000,
        geminiCaller: async () => {
          apiCallsBeforeExpiry += 1;
          return '{}';
        },
      });
      const narrativeEarly = await generateExplainableNarrative(
        {
          id: 'imp-cd',
          workspaceId: wsId,
          changeEvent: {
            id: 'chg-cd',
            projectId: 'p1',
            projectTitle: 'Proj',
            targetNodeId: 'dl-cd',
            targetNodeTitle: 'Deadline',
            fieldChanged: 'deadline',
            originalValue: '2026-11-27',
            newValue: '2026-11-25',
            sourceRecordId: 'src-cd',
            sourceRecordTitle: 'Urgent',
            extractionMethod: 'DETERMINISTIC_PARSER',
            extractionConfidenceNote: 'Cooldown fallback',
            detectedAt: '2026-11-24T14:00:00Z',
          },
          directImpacts: [],
          downstreamImpacts: [],
          unaffectedItems: [],
          explanationSummary: 'Summary',
          createdAt: '2026-11-24T14:00:00Z',
        },
        {
          rateLimiter: limiter,
          maxInteractiveWaitMs: 25_000,
          geminiCaller: async () => {
            apiCallsBeforeExpiry += 1;
            return 'Should not execute';
          },
        },
      );
      await controller.processWorkspaceQueue(wsId, {
        geminiCaller: async ({ contents }) => {
          apiCallsBeforeExpiry += 1;
          return makeBatchResponse(extractBatchIdsFromPrompt(contents));
        },
        awaitRetries: false,
      });

      // Attempt again at T + 119s (still 1s before expiry)
      virtualNow = 1_700_008_000_000 + 119_000;
      const queueStillBlocked = await controller.processWorkspaceQueue(wsId, {
        geminiCaller: async ({ contents }) => {
          apiCallsBeforeExpiry += 1;
          return makeBatchResponse(extractBatchIdsFromPrompt(contents));
        },
        awaitRetries: false,
      });

      assert.equal(changeEarly.usedGemini, false);
      assert.equal(narrativeEarly.aiStatus, 'UNAVAILABLE');
      assert.equal(queueStillBlocked.batchesExecuted, 0);
      assert.equal(apiCallsBeforeExpiry, 0, 'ZERO Gemini requests may proceed before cooldown expires');

      // Advance past cooldown expiry (T + 120s) -> request now executes cleanly
      virtualNow = 1_700_008_000_000 + 120_000;
      let callsAfterExpiry = 0;
      const queueAfter = await controller.processWorkspaceQueue(wsId, {
        geminiCaller: async ({ contents }) => {
          callsAfterExpiry += 1;
          return makeBatchResponse(extractBatchIdsFromPrompt(contents), 'PostCooldown');
        },
        awaitRetries: false,
      });
      assert.equal(callsAfterExpiry, 1);
      assert.equal(queueAfter.completedCount, 1);
      console.log('PASS [13/19]: Zero requests execute prior to cooldown expiry; resume once expired');
    }

    // 14. Valid Gemini structured output verifies prompt enums + responseSchema enums + LOW_SIGNAL
    {
      const user = createTestUser('validstruct');
      const wsId = user.workspace.id;
      insertTestMessage({
        id: 'msg-valid-rel',
        workspaceId: wsId,
        gmailMessageId: 'g-valid-rel',
        subject: 'Sprint Deadline Update',
        receivedAt: '2026-11-24T15:00:00Z',
      });
      insertTestMessage({
        id: 'msg-valid-low',
        workspaceId: wsId,
        gmailMessageId: 'g-valid-low',
        subject: 'Weekly Newsletter Digest',
        receivedAt: '2026-11-24T14:55:00Z',
      });

      let capturedInstruction = '';
      let capturedSchema: Record<string, unknown> | undefined;

      const batchOut = await extractAndStageEmailBatch(
        wsId,
        [
          {
            messageRowId: 'msg-valid-rel',
            gmailMessageId: 'g-valid-rel',
            sender: 'Lead <lead@org.test>',
            subject: 'Sprint Deadline Update',
            receivedAt: '2026-11-24T15:00:00Z',
            bodyText: 'Final sprint review is scheduled for 2026-12-01.',
          },
          {
            messageRowId: 'msg-valid-low',
            gmailMessageId: 'g-valid-low',
            sender: 'Digest <news@example.com>',
            subject: 'Weekly Newsletter Digest',
            receivedAt: '2026-11-24T14:55:00Z',
            bodyText: 'Top industry links this week.',
          },
        ],
        async ({ systemInstruction, responseSchema }) => {
          capturedInstruction = systemInstruction;
          capturedSchema = responseSchema as Record<string, unknown>;
          return JSON.stringify({
            results: [
              {
                messageRowId: 'msg-valid-rel',
                summary: 'Sprint review scheduled on Dec 1.',
                relevance: 'RELEVANT',
                items: [
                  {
                    itemType: 'MEETING',
                    title: 'Final Sprint Review',
                    description: 'Scheduled final review.',
                    proposedDate: '2026-12-01',
                    dateAmbiguous: false,
                    dateNote: null,
                    assigneeOrPerson: 'Lead',
                    relatedProjectName: null,
                    factStatus: 'CONFIRMED',
                    evidenceQuote: 'Final sprint review is scheduled for 2026-12-01.',
                    confidenceNote: 'Exact date stated.',
                  },
                ],
                relationships: [],
              },
              {
                messageRowId: 'msg-valid-low',
                summary: 'Automated newsletter digest.',
                relevance: 'LOW_SIGNAL',
                items: [],
                relationships: [],
              },
            ],
          });
        },
      );

      assert.equal(batchOut.completedIds.length, 2);
      assert.equal(batchOut.invalidEntries.length, 0);
      for (const relVal of EMAIL_RELEVANCE_VALUES) {
        assert.ok(capturedInstruction.includes(relVal), `Prompt must document relevance=${relVal}`);
      }
      for (const itemVal of EMAIL_EXTRACTED_ITEM_TYPES) {
        assert.ok(capturedInstruction.includes(itemVal), `Prompt must document itemType=${itemVal}`);
      }
      const resultProps = (
        ((capturedSchema?.properties as Record<string, unknown>)?.results as Record<string, unknown>)
          ?.items as Record<string, unknown>
      )?.properties as Record<string, unknown>;
      assert.deepEqual((resultProps.relevance as Record<string, unknown>).enum, [...EMAIL_RELEVANCE_VALUES]);
      assert.equal((resultProps.relevance as Record<string, unknown>).format, 'enum');

      const itemProps = (
        ((resultProps.items as Record<string, unknown>).items as Record<string, unknown>).properties
      ) as Record<string, unknown>;
      assert.deepEqual((itemProps.itemType as Record<string, unknown>).enum, [...EMAIL_EXTRACTED_ITEM_TYPES]);
      assert.equal((itemProps.itemType as Record<string, unknown>).format, 'enum');

      // Re-running idempotently on already COMPLETED messages does not duplicate items
      const rerunOut = await extractAndStageEmailBatch(
        wsId,
        [
          {
            messageRowId: 'msg-valid-rel',
            gmailMessageId: 'g-valid-rel',
            sender: 'Lead <lead@org.test>',
            subject: 'Sprint Deadline Update',
            receivedAt: '2026-11-24T15:00:00Z',
            bodyText: 'Final sprint review is scheduled for 2026-12-01.',
          },
        ],
        async () =>
          JSON.stringify({
            results: [
              {
                messageRowId: 'msg-valid-rel',
                summary: 'Sprint review scheduled on Dec 1.',
                relevance: 'RELEVANT',
                items: [
                  {
                    itemType: 'MEETING',
                    title: 'Final Sprint Review',
                    dateAmbiguous: false,
                    factStatus: 'CONFIRMED',
                    evidenceQuote: 'Final sprint review is scheduled for 2026-12-01.',
                  },
                ],
                relationships: [],
              },
            ],
          }),
      );
      assert.equal(rerunOut.itemsCreated, 0, 'Idempotent re-run must not duplicate items');
      assert.equal(getExtractedItems(wsId).length, 1);
      console.log('PASS [14/19]: Valid structured output, prompt/schema enum alignment, and idempotency');
    }

    // 15. Invalid relevance enum fails cleanly, is non-retryable, and yields rich diagnostic
    {
      const user = createTestUser('badrel');
      const wsId = user.workspace.id;
      insertTestMessage({
        id: 'msg-bad-rel',
        workspaceId: wsId,
        gmailMessageId: 'g-bad-rel',
        subject: 'Ambiguous Relevance Email',
        receivedAt: '2026-11-24T15:05:00Z',
        maxRetries: 4,
      });

      assert.throws(
        () =>
          parseAndValidateEmailExtraction(
            JSON.stringify({
              summary: 'Test',
              relevance: 'MEDIUM_SIGNAL',
              items: [],
              relationships: [],
            }),
          ),
        (err: unknown) => {
          assert.ok(err instanceof GeminiSchemaValidationError);
          assert.equal(err.invalidField, 'relevance');
          assert.equal(isRetryableGeminiError(err), false);
          assert.ok(err.message.includes('RELEVANT') && err.message.includes('LOW_SIGNAL'));
          assert.ok(err.message.includes('Retryable: no'));
          return true;
        },
      );

      const controller = new ExtractionQueueController({
        concurrency: 1,
        requestsPerMinute: 10,
        batchSize: 5,
        maxRetries: 4,
        minSpacingMs: 0,
      });

      let calls = 0;
      const res = await controller.processWorkspaceQueue(wsId, {
        geminiCaller: async () => {
          calls += 1;
          return JSON.stringify({
            results: [
              {
                messageRowId: 'msg-bad-rel',
                summary: 'Should fail relevance enum',
                relevance: 'MEDIUM_SIGNAL',
                items: [],
                relationships: [],
              },
            ],
          });
        },
        awaitRetries: true,
      });

      assert.equal(calls, 1, 'Deterministic relevance enum mismatch must NOT retry 4 times');
      assert.equal(res.retryingCount, 0);
      assert.equal(res.failedCount, 1);
      const [msg] = getGmailMessages(wsId);
      assert.equal(msg.extractionStatus, 'FAILED');
      assert.equal(msg.nextRetryAt, null);
      assert.ok(msg.extractionError?.includes('msg-bad-rel'));
      assert.ok(msg.extractionError?.includes('relevance'));
      assert.ok(msg.extractionError?.includes('RELEVANT'));
      assert.ok(msg.extractionError?.includes('Retryable: no'));
      console.log('PASS [15/19]: Invalid relevance enum isolated as non-retryable FAILED with diagnostic');
    }

    // 16. Invalid itemType enum fails cleanly as non-retryable without coercing unknown labels
    {
      const user = createTestUser('baditem');
      const wsId = user.workspace.id;
      insertTestMessage({
        id: 'msg-bad-itemtype',
        workspaceId: wsId,
        gmailMessageId: 'g-bad-itemtype',
        subject: 'Unknown Item Type Email',
        receivedAt: '2026-11-24T15:10:00Z',
        maxRetries: 4,
      });

      assert.throws(
        () =>
          parseAndValidateBatchEmailExtraction(
            JSON.stringify({
              results: [
                {
                  messageRowId: 'msg-bad-itemtype',
                  summary: 'Bad itemType',
                  relevance: 'RELEVANT',
                  items: [
                    {
                      itemType: 'ACTION_ITEM',
                      title: 'Follow up with vendor',
                      dateAmbiguous: false,
                      factStatus: 'CONFIRMED',
                      evidenceQuote: 'Please follow up with vendor.',
                    },
                  ],
                  relationships: [],
                },
              ],
            }),
          ),
        (err: unknown) => {
          assert.ok(err instanceof GeminiSchemaValidationError);
          assert.equal(err.messageRowId, 'msg-bad-itemtype');
          assert.ok(err.invalidField.endsWith('itemType'));
          assert.equal(isRetryableGeminiError(err), false);
          return true;
        },
      );

      const controller = new ExtractionQueueController({
        concurrency: 1,
        requestsPerMinute: 10,
        batchSize: 5,
        maxRetries: 4,
        minSpacingMs: 0,
      });

      let calls = 0;
      const res = await controller.processWorkspaceQueue(wsId, {
        geminiCaller: async () => {
          calls += 1;
          return JSON.stringify({
            results: [
              {
                messageRowId: 'msg-bad-itemtype',
                summary: 'Invalid itemType',
                relevance: 'RELEVANT',
                items: [
                  {
                    itemType: 'ACTION_ITEM',
                    title: 'Follow up with vendor',
                    dateAmbiguous: false,
                    factStatus: 'CONFIRMED',
                    evidenceQuote: 'Please follow up with vendor.',
                  },
                ],
                relationships: [],
              },
            ],
          });
        },
        awaitRetries: true,
      });

      assert.equal(calls, 1, 'Deterministic itemType mismatch must NOT enter retry loop');
      assert.equal(res.failedCount, 1);
      assert.equal(getExtractedItems(wsId).length, 0, 'Invalid item must never be staged');
      const [msg] = getGmailMessages(wsId);
      assert.equal(msg.extractionStatus, 'FAILED');
      assert.ok(msg.extractionError?.includes('itemType'));
      assert.ok(msg.extractionError?.includes('PLAN_CHANGE'));
      assert.ok(msg.extractionError?.includes('Retryable: no'));
      console.log('PASS [16/19]: Invalid itemType enum rejected as non-retryable without silent coercion');
    }

    // 17. One invalid email inside an otherwise valid batch preserves valid siblings cleanly
    {
      const user = createTestUser('partialschema');
      const wsId = user.workspace.id;
      insertTestMessage({
        id: 'msg-sib-invalid',
        workspaceId: wsId,
        gmailMessageId: 'g-sib-invalid',
        subject: 'Invalid Enum Email',
        receivedAt: '2026-11-24T15:20:00Z',
      });
      insertTestMessage({
        id: 'msg-sib-valid-1',
        workspaceId: wsId,
        gmailMessageId: 'g-sib-valid-1',
        subject: 'Valid Sibling One',
        receivedAt: '2026-11-24T15:19:00Z',
      });
      insertTestMessage({
        id: 'msg-sib-valid-2',
        workspaceId: wsId,
        gmailMessageId: 'g-sib-valid-2',
        subject: 'Valid Sibling Two',
        receivedAt: '2026-11-24T15:18:00Z',
      });

      const controller = new ExtractionQueueController({
        concurrency: 1,
        requestsPerMinute: 10,
        batchSize: 5,
        maxRetries: 3,
        minSpacingMs: 0,
      });

      let geminiCalls = 0;
      const res = await controller.processWorkspaceQueue(wsId, {
        geminiCaller: async () => {
          geminiCalls += 1;
          return JSON.stringify({
            results: [
              {
                messageRowId: 'msg-sib-invalid',
                summary: 'Invalid entry',
                relevance: 'HIGH_PRIORITY',
                items: [],
                relationships: [],
              },
              {
                messageRowId: 'msg-sib-valid-1',
                summary: 'Valid entry 1',
                relevance: 'RELEVANT',
                items: [
                  {
                    itemType: 'TASK',
                    title: 'Valid Sibling Task 1',
                    dateAmbiguous: false,
                    factStatus: 'CONFIRMED',
                    evidenceQuote: 'Complete Valid Sibling Task 1.',
                  },
                ],
                relationships: [],
              },
              {
                messageRowId: 'msg-sib-valid-2',
                summary: 'Valid entry 2',
                relevance: 'LOW_SIGNAL',
                items: [],
                relationships: [],
              },
            ],
          });
        },
        awaitRetries: true,
      });

      assert.equal(geminiCalls, 1, 'Valid sibling results must be preserved in a single batch call');
      assert.equal(res.completedCount, 2, 'Both valid siblings must complete');
      assert.equal(res.failedCount, 1, 'Only the invalid email must fail');
      assert.equal(res.retryingCount, 0, 'Invalid schema entry must not retry');

      const statusById = new Map(getGmailMessages(wsId).map((m) => [m.id, m]));
      assert.equal(statusById.get('msg-sib-valid-1')?.extractionStatus, 'COMPLETED');
      assert.equal(statusById.get('msg-sib-valid-2')?.extractionStatus, 'COMPLETED');
      assert.equal(statusById.get('msg-sib-invalid')?.extractionStatus, 'FAILED');
      assert.ok(statusById.get('msg-sib-invalid')?.extractionError?.includes('msg-sib-invalid'));
      assert.equal(getExtractedItems(wsId).length, 1);
      console.log('PASS [17/19]: Partial batch schema failure isolates bad entry and preserves valid siblings');
    }

    // 18. Missing optional fields are normalized cleanly while missing mandatory evidenceQuote fails
    {
      const validMissingOptional = parseAndValidateEmailExtraction(
        JSON.stringify({
          relevance: 'RELEVANT',
          summary: null,
          items: [
            {
              itemType: 'DEADLINE',
              title: 'Architecture Review Freeze',
              description: null,
              proposedDate: '',
              dateAmbiguous: null,
              dateNote: undefined,
              assigneeOrPerson: null,
              relatedProjectName: '',
              factStatus: 'CONFIRMED',
              evidenceQuote: 'Architecture review freeze is coming up.',
              confidenceNote: null,
            },
          ],
          relationships: [
            {
              sourceTitle: 'Architecture Review Freeze',
              targetTitle: 'Core Platform',
              relationshipType: 'BELONGS_TO',
              rationale: 'Deadline applies to Core Platform.',
              evidenceQuote: 'Architecture review freeze for Core Platform.',
              factStatus: 'INFERRED',
            },
          ],
        }),
      );
      assert.equal(validMissingOptional.summary, '');
      assert.equal(validMissingOptional.items[0].description, '');
      assert.equal(validMissingOptional.items[0].proposedDate, null);
      assert.equal(validMissingOptional.items[0].dateAmbiguous, false);
      assert.equal(validMissingOptional.relationships[0].sourceType, 'ENTITY');

      const user = createTestUser('noevidence');
      const wsId = user.workspace.id;
      insertTestMessage({
        id: 'msg-no-evidence',
        workspaceId: wsId,
        gmailMessageId: 'g-no-evidence',
        subject: 'Missing Evidence Quote',
        receivedAt: '2026-11-24T15:25:00Z',
      });

      const controller = new ExtractionQueueController({
        concurrency: 1,
        requestsPerMinute: 10,
        batchSize: 5,
        maxRetries: 3,
        minSpacingMs: 0,
      });

      const res = await controller.processWorkspaceQueue(wsId, {
        geminiCaller: async () =>
          JSON.stringify({
            results: [
              {
                messageRowId: 'msg-no-evidence',
                summary: 'Missing evidence quote',
                relevance: 'RELEVANT',
                items: [
                  {
                    itemType: 'TASK',
                    title: 'Unsupported Task',
                    dateAmbiguous: false,
                    factStatus: 'CONFIRMED',
                    evidenceQuote: '   ',
                  },
                ],
                relationships: [],
              },
            ],
          }),
        awaitRetries: true,
      });

      assert.equal(res.completedCount, 0);
      assert.equal(res.failedCount, 1);
      assert.equal(getExtractedItems(wsId).length, 0);
      const [msg] = getGmailMessages(wsId);
      assert.equal(msg.extractionStatus, 'FAILED');
      assert.ok(msg.extractionError?.includes('evidenceQuote'));
      console.log('PASS [18/19]: Missing optional fields handled cleanly; missing mandatory evidenceQuote rejected');
    }

    // 19. 503 UNAVAILABLE remains retryable and recovers independently of schema validation errors
    {
      const user = createTestUser('503vsschema');
      const wsId = user.workspace.id;
      insertTestMessage({
        id: 'msg-503-recover',
        workspaceId: wsId,
        gmailMessageId: 'g-503-recover',
        subject: 'Temporary 503 Email',
        receivedAt: '2026-11-24T15:30:00Z',
        maxRetries: 2,
      });

      let virtualNow = 1_700_009_000_000;
      const controller = new ExtractionQueueController({
        concurrency: 1,
        requestsPerMinute: 10,
        batchSize: 1,
        maxRetries: 2,
        baseBackoffMs: 500,
        maxBackoffMs: 2_000,
        minSpacingMs: 100,
        nowFn: () => virtualNow,
        sleepFn: async (ms) => {
          virtualNow += ms;
        },
        randomFn: () => 0.5,
      });

      let attempts = 0;
      const pass1 = await controller.processWorkspaceQueue(wsId, {
        geminiCaller: async ({ contents }) => {
          attempts += 1;
          if (attempts === 1) {
            throw Object.assign(new Error('503 UNAVAILABLE: temporary model overload'), { status: 503 });
          }
          return makeBatchResponse(extractBatchIdsFromPrompt(contents), 'Recovered503');
        },
        awaitRetries: false,
      });

      assert.equal(attempts, 1);
      assert.equal(pass1.retryingCount, 1, '503 error must remain retryable (RETRYING)');
      assert.equal(pass1.failedCount, 0);

      virtualNow += 5_000;
      const pass2 = await controller.processWorkspaceQueue(wsId, {
        geminiCaller: async ({ contents }) =>
          makeBatchResponse(extractBatchIdsFromPrompt(contents), 'Recovered503'),
        awaitRetries: false,
      });
      assert.equal(pass2.completedCount, 1, '503 email must recover cleanly on retry');
      console.log('PASS [19/19]: 503 UNAVAILABLE remains retryable separately from schema validation errors');
    }

    // 20. GEMINI_MODEL env configuration & default GA model fallback
    {
      const prevModel = process.env.GEMINI_MODEL;
      try {
        delete process.env.GEMINI_MODEL;
        assert.equal(getConfiguredGeminiModel(), DEFAULT_GEMINI_MODEL);
        assert.equal(DEFAULT_GEMINI_MODEL, 'gemini-3.5-flash-lite');

        process.env.GEMINI_MODEL = 'gemini-3.8-flash';
        assert.equal(getConfiguredGeminiModel(), 'gemini-3.8-flash');

        const seenModels: string[] = [];
        const user = createTestUser('modelcfg');
        insertTestMessage({
          id: 'msg-model-cfg',
          workspaceId: user.workspace.id,
          gmailMessageId: 'g-model-cfg',
          subject: 'Model Config Check',
          receivedAt: '2026-11-25T10:00:00Z',
        });

        await extractAndStageEmailBatch(
          user.workspace.id,
          [
            {
              messageRowId: 'msg-model-cfg',
              gmailMessageId: 'g-model-cfg',
              sender: 'lead@example.com',
              subject: 'Model Config Check',
              receivedAt: '2026-11-25T10:00:00Z',
              bodyText: 'Finish release checklist by 2026-12-03.',
            },
          ],
          async ({ model, contents }) => {
            seenModels.push(model);
            return makeBatchResponse(extractBatchIdsFromPrompt(contents), 'ModelCfg');
          },
        );

        await extractChangeFromText(
          'Deadline update',
          'Move deadline to 2026-11-26',
          [],
          {
            geminiCaller: async ({ model }) => {
              seenModels.push(model);
              return JSON.stringify({
                projectTitleMatch: 'Demo',
                fieldChanged: 'deadline',
                originalDateHint: '2026-11-27',
                newDateIso: '2026-11-26',
                summary: 'Moved deadline.',
              });
            },
          },
        );

        const dummyAnalysis: Omit<ImpactAnalysisResult, 'aiNarrative' | 'aiStatus'> = {
          id: 'imp-model-test',
          workspaceId: user.workspace.id,
          changeEvent: {
            id: 'chg-1',
            projectId: 'p-1',
            projectTitle: 'Demo',
            targetNodeId: 'd-1',
            targetNodeTitle: 'Deadline',
            fieldChanged: 'deadline',
            originalValue: '2026-11-27',
            newValue: '2026-11-26',
            sourceRecordId: 'src-1',
            sourceRecordTitle: 'Msg',
            extractionMethod: 'GEMINI_NLU',
            extractionConfidenceNote: 'test',
            detectedAt: '2026-11-25T10:00:00Z',
          },
          directImpacts: [],
          downstreamImpacts: [],
          unaffectedItems: [],
          explanationSummary: 'Test summary',
          createdAt: '2026-11-25T10:00:00Z',
        };

        await generateExplainableNarrative(dummyAnalysis, {
          geminiCaller: async ({ model }) => {
            seenModels.push(model);
            return 'Concise briefing.';
          },
        });

        assert.deepEqual(seenModels, [
          'gemini-3.8-flash',
          'gemini-3.8-flash',
          'gemini-3.8-flash',
        ]);
        console.log('PASS [20/24]: GEMINI_MODEL configuration and default GA fallback verified across all call sites');
      } finally {
        if (prevModel === undefined) delete process.env.GEMINI_MODEL;
        else process.env.GEMINI_MODEL = prevModel;
      }
    }

    // 21. Safe enum normalization (case/whitespace/hyphen) without coercing unknown labels
    {
      const normalized = parseAndValidateEmailExtraction(
        JSON.stringify({
          summary: 'Plan shifted to Dec 2',
          relevance: ' relevant ',
          items: [
            {
              itemType: 'plan-change',
              title: 'Move launch review',
              proposedDate: '2026-12-02',
              dateAmbiguous: false,
              factStatus: 'confirmed',
              evidenceQuote: 'Let us move launch review to Dec 2.',
            },
          ],
          relationships: [
            {
              sourceTitle: 'Move launch review',
              targetTitle: 'Launch Project',
              relationshipType: 'belongs to',
              rationale: 'Part of Launch Project',
              evidenceQuote: 'Move launch review for Launch Project.',
              factStatus: 'inferred',
            },
          ],
        }),
      );
      assert.equal(normalized.relevance, 'RELEVANT');
      assert.equal(normalized.items[0].itemType, 'PLAN_CHANGE');
      assert.equal(normalized.items[0].factStatus, 'CONFIRMED');
      assert.equal(normalized.relationships[0].relationshipType, 'BELONGS_TO');
      assert.equal(normalized.relationships[0].factStatus, 'INFERRED');

      const lowSignal = parseAndValidateEmailExtraction(
        JSON.stringify({
          summary: 'Weekly digest',
          relevance: 'low-signal',
          items: [],
          relationships: [],
        }),
      );
      assert.equal(lowSignal.relevance, 'LOW_SIGNAL');
      console.log('PASS [21/24]: Safe enum normalization handles case/whitespace/hyphen variants');
    }

    // 22. ISO timestamps with optional seconds and timezone normalize cleanly
    {
      assert.equal(normalizeIsoProposedDate('2026-12-01T15:00:00Z'), '2026-12-01T15:00');
      assert.equal(normalizeIsoProposedDate('2026-12-01T15:30:00+05:30'), '2026-12-01T10:00');
      assert.equal(normalizeIsoProposedDate('2026-12-01 09:45:12'), '2026-12-01T09:45');

      const parsed = parseAndValidateEmailExtraction(
        JSON.stringify({
          summary: 'Meeting scheduled',
          relevance: 'RELEVANT',
          items: [
            {
              itemType: 'MEETING',
              title: 'Sync with Design',
              proposedDate: '2026-12-01T15:00:00.000Z',
              dateAmbiguous: false,
              factStatus: 'CONFIRMED',
              evidenceQuote: 'Meeting at 2026-12-01T15:00:00Z.',
            },
          ],
          relationships: [],
        }),
      );
      assert.equal(parsed.items[0].proposedDate, '2026-12-01T15:00');
      console.log('PASS [22/24]: ISO timestamps with seconds and timezone offsets normalized cleanly');
    }

    // 23. Single-object response recovery preserves source email reference & zero fabricated dates
    {
      const user = createTestUser('singleobj');
      const wsId = user.workspace.id;
      insertTestMessage({
        id: 'msg-single-obj',
        workspaceId: wsId,
        gmailMessageId: 'g-single-obj',
        subject: 'Ambiguous Follow-up',
        receivedAt: '2026-11-25T11:00:00Z',
      });

      const controller = new ExtractionQueueController({
        concurrency: 1,
        requestsPerMinute: 10,
        batchSize: 1,
        maxRetries: 2,
        minSpacingMs: 0,
      });

      const res = await controller.processWorkspaceQueue(wsId, {
        geminiCaller: async () =>
          JSON.stringify({
            summary: 'Ambiguous timing',
            relevance: 'RELEVANT',
            items: [
              {
                itemType: 'TASK',
                title: 'Prepare Q4 notes',
                proposedDate: null,
                dateAmbiguous: true,
                dateNote: 'Says "soon" with no calendar date.',
                factStatus: 'CONFIRMED',
                evidenceQuote: 'Please prepare Q4 notes soon.',
              },
            ],
            relationships: [],
          }),
        awaitRetries: true,
      });

      assert.equal(res.completedCount, 1);
      const staged = getExtractedItems(wsId);
      assert.equal(staged.length, 1);
      assert.equal(staged[0].messageRowId, 'msg-single-obj');
      assert.equal(staged[0].gmailMessageId, 'g-single-obj');
      assert.equal(staged[0].proposedDate, null, 'Ambiguous date must remain null, never fabricated');
      assert.equal(staged[0].dateAmbiguous, true);
      console.log('PASS [23/24]: Single-object recovery preserves source references and never fabricates dates');
    }

    // 24. Malformed non-ISO proposedDate is rejected cleanly without inventing a date
    {
      assert.throws(
        () =>
          parseAndValidateEmailExtraction(
            JSON.stringify({
              summary: 'Bad date format',
              relevance: 'RELEVANT',
              items: [
                {
                  itemType: 'DEADLINE',
                  title: 'Submit report',
                  proposedDate: 'next Friday',
                  dateAmbiguous: false,
                  factStatus: 'CONFIRMED',
                  evidenceQuote: 'Submit report next Friday.',
                },
              ],
              relationships: [],
            }),
          ),
        (err: unknown) => {
          assert.ok(err instanceof GeminiSchemaValidationError);
          assert.ok(err.invalidField.endsWith('proposedDate'));
          assert.equal(isRetryableGeminiError(err), false);
          return true;
        },
      );
      console.log('PASS [24/24]: Malformed non-ISO proposedDate rejected cleanly without fabricating dates');
    }
  } finally {
    for (const qKey of createdQuotaKeys) {
      try {
        db.prepare('DELETE FROM gemini_quota_state WHERE id = ?').run(qKey);
      } catch {
        // ignore
      }
    }
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
