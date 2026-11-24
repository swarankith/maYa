import { randomUUID } from 'node:crypto';
import { DEMO_WORKSPACE_ID, db } from './db.ts';
import {
  extractEmailBatch,
  hasConfiguredGeminiApiKey,
  type GeminiGenerateFn,
  type QueuedEmailPayload,
} from './emailContextService.ts';
import { recordAuditLog } from './graphService.ts';
import type { EmailExtractionQueueSummary } from '../types/maya.ts';

export interface ExtractionQueueConfig {
  concurrency: number;
  requestsPerMinute: number;
  batchSize: number;
  maxBatchChars: number;
  maxRetries: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  nowFn?: () => number;
  sleepFn?: (ms: number) => Promise<void>;
  randomFn?: () => number;
  geminiCaller?: GeminiGenerateFn;
}

function parsePositiveInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.round(parsed), min), max);
}

export function getDefaultExtractionQueueConfig(): ExtractionQueueConfig {
  return {
    concurrency: parsePositiveInt(process.env.GEMINI_EXTRACTION_CONCURRENCY, 1, 1, 5),
    requestsPerMinute: parsePositiveInt(process.env.GEMINI_EXTRACTION_RPM, 4, 1, 60),
    batchSize: parsePositiveInt(process.env.GEMINI_EXTRACTION_BATCH_SIZE, 4, 1, 10),
    maxBatchChars: parsePositiveInt(process.env.GEMINI_EXTRACTION_MAX_BATCH_CHARS, 12000, 2000, 40000),
    maxRetries: parsePositiveInt(process.env.GEMINI_EXTRACTION_MAX_RETRIES, 4, 0, 10),
    baseBackoffMs: parsePositiveInt(process.env.GEMINI_EXTRACTION_BASE_BACKOFF_MS, 15000, 500, 120000),
    maxBackoffMs: 10 * 60 * 1000,
  };
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Sliding-window + cooldown-aware rate limiter so outbound Gemini calls stay within
 * configured RPM limits (default 4 RPM < 5 RPM free-tier ceiling) even across concurrent tasks.
 */
export class SlidingWindowRateLimiter {
  private readonly timestamps: number[] = [];
  private cooldownUntilMs = 0;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly requestsPerMinute: number,
    private readonly windowMs = 60_000,
    private readonly nowFn: () => number = () => Date.now(),
    private readonly sleepFn: (ms: number) => Promise<void> = defaultSleep,
  ) {}

  noteCooldown(delayMs: number): void {
    if (!Number.isFinite(delayMs) || delayMs <= 0) return;
    const candidate = this.nowFn() + delayMs;
    if (candidate > this.cooldownUntilMs) {
      this.cooldownUntilMs = candidate;
    }
  }

  async acquireSlot(): Promise<void> {
    const run = this.chain.then(async () => {
      // Wait for explicit server cooldown first (e.g., 429 retryDelay)
      while (true) {
        const now = this.nowFn();
        if (this.cooldownUntilMs > now) {
          await this.sleepFn(this.cooldownUntilMs - now);
          continue;
        }

        // Prune timestamps outside the rolling 60s window
        while (this.timestamps.length > 0 && now - this.timestamps[0] >= this.windowMs) {
          this.timestamps.shift();
        }

        if (this.timestamps.length < this.requestsPerMinute) {
          this.timestamps.push(now);
          return;
        }

        const oldest = this.timestamps[0];
        const waitMs = Math.max(25, this.windowMs - (now - oldest) + 25);
        await this.sleepFn(waitMs);
      }
    });

    this.chain = run.catch(() => {});
    return run;
  }
}

export function computeRetryBackoffMs(
  attempt: number,
  baseBackoffMs: number,
  maxBackoffMs: number,
  serverRetryDelayMs: number | null,
  randomFn: () => number = Math.random,
): number {
  const safeAttempt = Math.max(1, attempt);
  const expDelay = baseBackoffMs * Math.pow(2, safeAttempt - 1);
  const jitter = Math.round(expDelay * 0.25 * Math.min(Math.max(randomFn(), 0), 1));
  const computed = expDelay + jitter;
  const effective = serverRetryDelayMs !== null ? Math.max(computed, serverRetryDelayMs + jitter) : computed;
  return Math.min(effective, maxBackoffMs);
}

const activeWorkspaceWorkers = new Map<string, Promise<void>>();
const retryTimersByWorkspace = new Map<string, ReturnType<typeof setTimeout>>();

let globalLimiter: SlidingWindowRateLimiter | null = null;
let globalLimiterRpm = 0;

function getGlobalRateLimiter(cfg: ExtractionQueueConfig): SlidingWindowRateLimiter {
  if (!globalLimiter || globalLimiterRpm !== cfg.requestsPerMinute) {
    globalLimiter = new SlidingWindowRateLimiter(cfg.requestsPerMinute, 60_000, cfg.nowFn, cfg.sleepFn);
    globalLimiterRpm = cfg.requestsPerMinute;
  }
  return globalLimiter;
}

function clearRetryTimer(workspaceId: string): void {
  const existing = retryTimersByWorkspace.get(workspaceId);
  if (existing) {
    clearTimeout(existing);
    retryTimersByWorkspace.delete(workspaceId);
  }
}

function scheduleRetryTimerIfNeeded(workspaceId: string, nowMs: number = Date.now()): void {
  clearRetryTimer(workspaceId);
  if (workspaceId === DEMO_WORKSPACE_ID) return;

  const row = db
    .prepare(
      `SELECT MIN(next_retry_at) AS next_due
       FROM gmail_messages
       WHERE workspace_id = ? AND extraction_status = 'RETRYING' AND next_retry_at IS NOT NULL`,
    )
    .get(workspaceId) as { next_due: string | null } | undefined;

  if (!row?.next_due) return;
  const dueMs = Date.parse(row.next_due);
  if (!Number.isFinite(dueMs)) return;

  const delayMs = Math.max(250, Math.min(dueMs - nowMs, 30 * 60 * 1000));
  const timer = setTimeout(() => {
    retryTimersByWorkspace.delete(workspaceId);
    kickWorkspaceExtraction(workspaceId);
  }, delayMs);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
  retryTimersByWorkspace.set(workspaceId, timer);
}

export function getExtractionQueueSummary(workspaceId: string): EmailExtractionQueueSummary {
  const cfg = getDefaultExtractionQueueConfig();
  if (workspaceId === DEMO_WORKSPACE_ID) {
    return {
      pending: 0,
      processing: 0,
      retrying: 0,
      completed: 0,
      failed: 0,
      skipped: 0,
      total: 0,
      isWorkerActive: false,
      requestsPerMinuteLimit: cfg.requestsPerMinute,
      nextRetryAt: null,
    };
  }

  const rows = db
    .prepare(
      `SELECT extraction_status, COUNT(*) AS cnt, MIN(next_retry_at) AS min_retry
       FROM gmail_messages
       WHERE workspace_id = ?
       GROUP BY extraction_status`,
    )
    .all(workspaceId) as Array<{ extraction_status: string; cnt: number; min_retry: string | null }>;

  let pending = 0;
  let processing = 0;
  let retrying = 0;
  let completed = 0;
  let failed = 0;
  let skipped = 0;
  let nextRetryAt: string | null = null;

  for (const r of rows) {
    const count = Number(r.cnt ?? 0);
    switch (r.extraction_status) {
      case 'PENDING':
        pending += count;
        break;
      case 'PROCESSING':
        processing += count;
        break;
      case 'RETRYING':
        retrying += count;
        if (r.min_retry && (!nextRetryAt || r.min_retry < nextRetryAt)) {
          nextRetryAt = r.min_retry;
        }
        break;
      case 'COMPLETED':
      case 'EXTRACTED':
        completed += count;
        break;
      case 'FAILED':
        failed += count;
        break;
      case 'SKIPPED':
        skipped += count;
        break;
      default:
        break;
    }
  }

  return {
    pending,
    processing,
    retrying,
    completed,
    failed,
    skipped,
    total: pending + processing + retrying + completed + failed + skipped,
    isWorkerActive: activeWorkspaceWorkers.has(workspaceId),
    requestsPerMinuteLimit: cfg.requestsPerMinute,
    nextRetryAt,
  };
}

interface ClaimedBatchMessage extends QueuedEmailPayload {
  attempts: number;
}

function claimNextBatch(
  workspaceId: string,
  batchSize: number,
  maxBatchChars: number,
  nowIso: string,
  batchId: string,
): ClaimedBatchMessage[] {
  const claimTx = db.transaction((): ClaimedBatchMessage[] => {
    const candidates = db
      .prepare(
        `SELECT id, gmail_message_id, sender, subject, received_at, body_text, snippet, extraction_attempts
         FROM gmail_messages
         WHERE workspace_id = ?
           AND (
             extraction_status = 'PENDING'
             OR (extraction_status = 'RETRYING' AND (next_retry_at IS NULL OR next_retry_at <= ?))
           )
         ORDER BY
           CASE WHEN extraction_status = 'PENDING' THEN 0 ELSE 1 END,
           received_at DESC
         LIMIT ?`,
      )
      .all(workspaceId, nowIso, Math.max(batchSize * 2, 10)) as Array<{
      id: string;
      gmail_message_id: string;
      sender: string;
      subject: string;
      received_at: string;
      body_text: string;
      snippet: string;
      extraction_attempts: number;
    }>;

    if (candidates.length === 0) return [];

    const selected: ClaimedBatchMessage[] = [];
    let accumulatedChars = 0;

    for (const row of candidates) {
      const text = (row.body_text || row.snippet || '').trim();
      const entryCost = text.length + row.subject.length + row.sender.length + 200;
      if (selected.length > 0 && (selected.length >= batchSize || accumulatedChars + entryCost > maxBatchChars)) {
        break;
      }
      accumulatedChars += entryCost;
      selected.push({
        messageRowId: row.id,
        gmailMessageId: row.gmail_message_id,
        sender: row.sender,
        subject: row.subject,
        receivedAt: row.received_at,
        bodyText: text,
        attempts: Number(row.extraction_attempts ?? 0) + 1,
      });
    }

    const markProcessing = db.prepare(`
      UPDATE gmail_messages
      SET extraction_status = 'PROCESSING',
          extraction_attempts = ?,
          last_attempt_at = ?,
          next_retry_at = NULL,
          batch_id = ?
      WHERE id = ? AND workspace_id = ?
    `);

    for (const msg of selected) {
      markProcessing.run(msg.attempts, nowIso, batchId, msg.messageRowId, workspaceId);
    }

    return selected;
  });

  return claimTx();
}

function markMessageRetryOrFailure(
  workspaceId: string,
  msg: ClaimedBatchMessage,
  retryable: boolean,
  errorMessage: string,
  retryDelayMs: number | null,
  cfg: ExtractionQueueConfig,
): 'RETRYING' | 'FAILED' {
  const nowFn = cfg.nowFn ?? Date.now;
  const maxRetries = cfg.maxRetries;
  // attempts is 1 on initial try; allow up to `maxRetries` retries (total 1 + maxRetries attempts)
  if (retryable && msg.attempts <= maxRetries) {
    const backoffMs = computeRetryBackoffMs(
      msg.attempts,
      cfg.baseBackoffMs,
      cfg.maxBackoffMs,
      retryDelayMs,
      cfg.randomFn ?? Math.random,
    );
    const nextRetryAt = new Date(nowFn() + backoffMs).toISOString();
    db.prepare(`
      UPDATE gmail_messages
      SET extraction_status = 'RETRYING',
          extraction_error = ?,
          next_retry_at = ?
      WHERE id = ? AND workspace_id = ?
    `).run(errorMessage, nextRetryAt, msg.messageRowId, workspaceId);
    return 'RETRYING';
  }

  db.prepare(`
    UPDATE gmail_messages
    SET extraction_status = 'FAILED',
        extraction_error = ?,
        next_retry_at = NULL
    WHERE id = ? AND workspace_id = ?
  `).run(errorMessage, msg.messageRowId, workspaceId);
  return 'FAILED';
}

async function processSingleBatchWithRateLimit(
  workspaceId: string,
  batch: ClaimedBatchMessage[],
  batchId: string,
  cfg: ExtractionQueueConfig,
  limiter: SlidingWindowRateLimiter,
  runCounts: { completed: number; retrying: number; failed: number; skipped: number; apiCalls: number },
): Promise<void> {
  if (!cfg.geminiCaller && !hasConfiguredGeminiApiKey()) {
    const result = await extractEmailBatch(workspaceId, batch, batchId, undefined);
    if (result.noApiKey) {
      runCounts.skipped += batch.length;
      return;
    }
  }

  await limiter.acquireSlot();
  runCounts.apiCalls += 1;

  const result = await extractEmailBatch(workspaceId, batch, batchId, cfg.geminiCaller);
  if (result.noApiKey) {
    runCounts.skipped += batch.length;
    return;
  }

  // If a multi-email batch suffered a schema/JSON parse failure, fall back to processing items
  // individually so one malformed email never fails valid sibling emails.
  if (result.error && result.error.isSchemaOrParseError && batch.length > 1) {
    for (const singleMsg of batch) {
      const singleBatchId = `batch-split-${randomUUID().slice(0, 8)}`;
      await limiter.acquireSlot();
      runCounts.apiCalls += 1;

      const singleRes = await extractEmailBatch(workspaceId, [singleMsg], singleBatchId, cfg.geminiCaller);
      const outcome = singleRes.outcomes.get(singleMsg.messageRowId);
      if (outcome?.status === 'COMPLETED') {
        runCounts.completed += 1;
      } else if (singleRes.error) {
        if (singleRes.error.isRateLimit && singleRes.error.retryDelayMs) {
          limiter.noteCooldown(singleRes.error.retryDelayMs);
        }
        const finalState = markMessageRetryOrFailure(
          workspaceId,
          singleMsg,
          singleRes.error.retryable,
          singleRes.error.sanitizedMessage,
          singleRes.error.retryDelayMs,
          cfg,
        );
        if (finalState === 'RETRYING') runCounts.retrying += 1;
        else runCounts.failed += 1;
      } else {
        const finalState = markMessageRetryOrFailure(
          workspaceId,
          singleMsg,
          false,
          'Extraction returned no valid output for this message.',
          null,
          cfg,
        );
        if (finalState === 'RETRYING') runCounts.retrying += 1;
        else runCounts.failed += 1;
      }
    }
    return;
  }

  if (result.error) {
    if (result.error.isRateLimit) {
      limiter.noteCooldown(result.error.retryDelayMs ?? cfg.baseBackoffMs);
    }

    for (const msg of batch) {
      const finalState = markMessageRetryOrFailure(
        workspaceId,
        msg,
        result.error.retryable,
        result.error.sanitizedMessage,
        result.error.retryDelayMs,
        cfg,
      );
      if (finalState === 'RETRYING') runCounts.retrying += 1;
      else runCounts.failed += 1;
    }
    return;
  }

  // Partial or full batch completion: evaluate each email independently
  for (const msg of batch) {
    const outcome = result.outcomes.get(msg.messageRowId);
    if (outcome?.status === 'COMPLETED') {
      runCounts.completed += 1;
    } else if (outcome?.status === 'MISSING_IN_BATCH') {
      const finalState = markMessageRetryOrFailure(
        workspaceId,
        msg,
        true,
        'Batch response omitted this email; scheduled isolated retry.',
        1000,
        cfg,
      );
      if (finalState === 'RETRYING') runCounts.retrying += 1;
      else runCounts.failed += 1;
    } else if (outcome?.status === 'SKIPPED') {
      runCounts.skipped += 1;
    }
  }
}

/**
 * Drains all currently due (PENDING + due RETRYING) extraction jobs for a workspace
 * under strict concurrency, batching, and RPM rate limits.
 */
export async function drainWorkspaceExtractionQueue(
  workspaceId: string,
  overrides?: Partial<ExtractionQueueConfig> & { rateLimiter?: SlidingWindowRateLimiter },
): Promise<{
  completed: number;
  retrying: number;
  failed: number;
  skipped: number;
  apiCalls: number;
}> {
  if (workspaceId === DEMO_WORKSPACE_ID) {
    return { completed: 0, retrying: 0, failed: 0, skipped: 0, apiCalls: 0 };
  }

  const baseCfg = getDefaultExtractionQueueConfig();
  const cfg: ExtractionQueueConfig = {
    ...baseCfg,
    ...overrides,
  };
  const nowFn = cfg.nowFn ?? Date.now;
  const limiter = overrides?.rateLimiter ?? getGlobalRateLimiter(cfg);
  const runCounts = { completed: 0, retrying: 0, failed: 0, skipped: 0, apiCalls: 0 };

  const workerLoop = async () => {
    while (true) {
      const nowIso = new Date(nowFn()).toISOString();
      const batchId = `batch-${randomUUID().slice(0, 8)}`;
      const batch = claimNextBatch(workspaceId, cfg.batchSize, cfg.maxBatchChars, nowIso, batchId);
      if (batch.length === 0) {
        break;
      }
      await processSingleBatchWithRateLimit(workspaceId, batch, batchId, cfg, limiter, runCounts);
    }
  };

  const concurrency = Math.max(1, cfg.concurrency);
  await Promise.all(Array.from({ length: concurrency }, () => workerLoop()));

  scheduleRetryTimerIfNeeded(workspaceId, nowFn());
  return runCounts;
}

/**
 * Starts non-blocking background extraction for a workspace if not already active.
 */
export function kickWorkspaceExtraction(
  workspaceId: string,
  overrides?: Partial<ExtractionQueueConfig>,
): boolean {
  if (workspaceId === DEMO_WORKSPACE_ID) return false;
  if (activeWorkspaceWorkers.has(workspaceId)) {
    return false;
  }

  const promise: Promise<void> = drainWorkspaceExtractionQueue(workspaceId, overrides)
    .then(() => undefined)
    .catch((err: unknown) => {
      console.error(
        `[maYa queue] Extraction worker error for workspace ${workspaceId}:`,
        err instanceof Error ? err.message : 'Unknown worker error',
      );
    })
    .finally(() => {
      activeWorkspaceWorkers.delete(workspaceId);
      scheduleRetryTimerIfNeeded(workspaceId);
    });

  activeWorkspaceWorkers.set(workspaceId, promise);
  return true;
}

export async function awaitWorkspaceExtractionIdle(workspaceId: string): Promise<void> {
  const active = activeWorkspaceWorkers.get(workspaceId);
  if (active) {
    await active;
  }
}

/**
 * Resets FAILED (and optionally overdue/waiting RETRYING) messages in a workspace to PENDING
 * without creating duplicates, then triggers the rate-limited extraction queue.
 */
export function retryFailedExtractions(
  workspaceId: string,
  actorName: string,
  options?: {
    includeRetrying?: boolean;
    startQueue?: boolean;
    queueOverrides?: Partial<ExtractionQueueConfig>;
  },
): { resetCount: number; queueSummary: EmailExtractionQueueSummary } {
  if (workspaceId === DEMO_WORKSPACE_ID) {
    throw new Error('DEMO MODE cannot retry personal Gmail extractions.');
  }

  clearRetryTimer(workspaceId);
  const includeRetrying = options?.includeRetrying ?? true;

  const result = includeRetrying
    ? db
        .prepare(
          `UPDATE gmail_messages
           SET extraction_status = 'PENDING',
               extraction_error = NULL,
               next_retry_at = NULL,
               extraction_attempts = CASE WHEN extraction_status = 'FAILED' THEN 0 ELSE extraction_attempts END
           WHERE workspace_id = ?
             AND extraction_status IN ('FAILED', 'RETRYING', 'SKIPPED')`,
        )
        .run(workspaceId)
    : db
        .prepare(
          `UPDATE gmail_messages
           SET extraction_status = 'PENDING',
               extraction_error = NULL,
               next_retry_at = NULL,
               extraction_attempts = 0
           WHERE workspace_id = ?
             AND extraction_status = 'FAILED'`,
        )
        .run(workspaceId);

  const resetCount = result.changes;
  if (resetCount > 0) {
    recordAuditLog(workspaceId, {
      actionType: 'EMAIL_EXTRACTION_RETRY_REQUESTED',
      targetLabel: `${resetCount} Email Message(s)`,
      status: 'SYSTEM',
      executionMode: 'LOCAL_WORKSPACE',
      summary: `Re-queued ${resetCount} failed or deferred Gmail message(s) for rate-limited context extraction.`,
      details: { resetCount, includeRetrying },
      actor: actorName,
    });
  }

  if (options?.startQueue !== false) {
    kickWorkspaceExtraction(workspaceId, options?.queueOverrides);
  }

  return {
    resetCount,
    queueSummary: getExtractionQueueSummary(workspaceId),
  };
}

/**
 * Recovers any interrupted PROCESSING messages back to PENDING at boot and schedules pending/retrying work.
 */
export function initializeExtractionQueueOnStartup(): void {
  const recovered = db
    .prepare(
      `UPDATE gmail_messages
       SET extraction_status = 'PENDING', next_retry_at = NULL
       WHERE extraction_status = 'PROCESSING'`,
    )
    .run();

  if (recovered.changes > 0) {
    console.log(`[maYa queue] Recovered ${recovered.changes} interrupted extraction job(s) to PENDING.`);
  }

  const workspacesWithWork = db
    .prepare(
      `SELECT DISTINCT workspace_id
       FROM gmail_messages
       WHERE extraction_status IN ('PENDING', 'RETRYING')
         AND workspace_id != ?`,
    )
    .all(DEMO_WORKSPACE_ID) as Array<{ workspace_id: string }>;

  for (const ws of workspacesWithWork) {
    kickWorkspaceExtraction(ws.workspace_id);
  }
}
