import { db, DEMO_WORKSPACE_ID } from './db.ts';
import {
  extractAndStageEmailBatch,
  hasConfiguredGeminiApiKey,
  isRetryableGeminiError,
  parseRetryDelayMs,
  sanitizeExtractionError,
  type ExtractableEmailMessage,
  type GeminiGenerateFn,
} from './emailContextService.ts';
import type { ExtractionPipelineSummary } from '../types/maya.ts';

export interface ExtractionQueueConfig {
  concurrency: number;
  requestsPerMinute: number;
  batchSize: number;
  maxRetries: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  windowMs: number;
  minSpacingMs?: number;
  nowFn?: () => number;
  sleepFn?: (ms: number) => Promise<void>;
  randomFn?: () => number;
}

export interface ProcessQueueResult {
  batchesExecuted: number;
  completedCount: number;
  retryingCount: number;
  failedCount: number;
  skippedCount: number;
  itemsCreated: number;
  relationshipsCreated: number;
  nextScheduledAt: string | null;
}

function parseBoundedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

export function getDefaultQueueConfig(): ExtractionQueueConfig {
  const requestsPerMinute = parseBoundedInt(process.env.GEMINI_RPM_LIMIT, 4, 1, 60);
  return {
    concurrency: parseBoundedInt(process.env.GEMINI_EXTRACTION_CONCURRENCY, 1, 1, 4),
    requestsPerMinute,
    batchSize: parseBoundedInt(process.env.GEMINI_BATCH_SIZE, 5, 1, 10),
    maxRetries: parseBoundedInt(process.env.GEMINI_EXTRACTION_MAX_RETRIES, 4, 1, 10),
    baseBackoffMs: parseBoundedInt(process.env.GEMINI_BASE_BACKOFF_MS, 5_000, 100, 60_000),
    maxBackoffMs: parseBoundedInt(process.env.GEMINI_MAX_BACKOFF_MS, 120_000, 1_000, 300_000),
    windowMs: 60_000,
  };
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export class ExtractionQueueController {
  private readonly config: Required<
    Omit<ExtractionQueueConfig, 'minSpacingMs'>
  > & { minSpacingMs: number };

  private callTimestamps: number[] = [];
  private cooldownUntilMs = 0;
  private activeWorkers = 0;
  private slotMutex: Promise<void> = Promise.resolve();
  private runningWorkspaces = new Map<string, Promise<ProcessQueueResult>>();
  private scheduledTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(overrides?: Partial<ExtractionQueueConfig>) {
    const defaults = getDefaultQueueConfig();
    const requestsPerMinute = overrides?.requestsPerMinute ?? defaults.requestsPerMinute;
    const windowMs = overrides?.windowMs ?? defaults.windowMs;
    const minSpacingMs =
      overrides?.minSpacingMs ?? Math.ceil(windowMs / Math.max(requestsPerMinute, 1));

    this.config = {
      concurrency: overrides?.concurrency ?? defaults.concurrency,
      requestsPerMinute,
      batchSize: overrides?.batchSize ?? defaults.batchSize,
      maxRetries: overrides?.maxRetries ?? defaults.maxRetries,
      baseBackoffMs: overrides?.baseBackoffMs ?? defaults.baseBackoffMs,
      maxBackoffMs: overrides?.maxBackoffMs ?? defaults.maxBackoffMs,
      windowMs,
      minSpacingMs,
      nowFn: overrides?.nowFn ?? (() => Date.now()),
      sleepFn: overrides?.sleepFn ?? defaultSleep,
      randomFn: overrides?.randomFn ?? (() => Math.random()),
    };
  }

  getSummaryConfig(): { rateLimitRpm: number; batchSize: number } {
    return {
      rateLimitRpm: this.config.requestsPerMinute,
      batchSize: this.config.batchSize,
    };
  }

  computeBackoffDelayMs(currentRetryCount: number, err?: unknown): number {
    const expMs = this.config.baseBackoffMs * Math.pow(2, Math.max(currentRetryCount, 0));
    const jitterMs = Math.round(expMs * 0.25 * this.config.randomFn());
    const apiHintMs = parseRetryDelayMs(err) ?? 0;
    return Math.min(this.config.maxBackoffMs, Math.max(expMs + jitterMs, apiHintMs));
  }

  private async acquireRateLimitAndConcurrencySlot(): Promise<void> {
    // Wait until a concurrency slot is available
    while (this.activeWorkers >= this.config.concurrency) {
      await this.config.sleepFn(25);
    }
    this.activeWorkers += 1;

    // Serialize rate-limit calculations across concurrent workers
    const releaseMutex = this.slotMutex;
    let resolveNext!: () => void;
    this.slotMutex = new Promise<void>((res) => {
      resolveNext = res;
    });

    try {
      await releaseMutex;

      while (true) {
        const now = this.config.nowFn();
        const windowStart = now - this.config.windowMs;
        this.callTimestamps = this.callTimestamps.filter((ts) => ts > windowStart);

        let waitMs = 0;

        if (this.cooldownUntilMs > now) {
          waitMs = Math.max(waitMs, this.cooldownUntilMs - now);
        }

        if (this.callTimestamps.length >= this.config.requestsPerMinute) {
          const oldestInWindow = this.callTimestamps[0];
          waitMs = Math.max(waitMs, oldestInWindow + this.config.windowMs - now + 10);
        }

        if (this.callTimestamps.length > 0 && this.config.minSpacingMs > 0) {
          const lastCall = this.callTimestamps[this.callTimestamps.length - 1];
          const elapsed = now - lastCall;
          if (elapsed < this.config.minSpacingMs) {
            waitMs = Math.max(waitMs, this.config.minSpacingMs - elapsed);
          }
        }

        if (waitMs <= 0) {
          this.callTimestamps.push(now);
          break;
        }

        await this.config.sleepFn(waitMs);
      }
    } catch (err) {
      this.activeWorkers = Math.max(0, this.activeWorkers - 1);
      resolveNext();
      throw err;
    }

    resolveNext();
  }

  private releaseConcurrencySlot(): void {
    this.activeWorkers = Math.max(0, this.activeWorkers - 1);
  }

  private claimNextBatch(workspaceId: string, nowIso: string): Array<
    ExtractableEmailMessage & { retryCount: number; maxRetries: number }
  > {
    const claimTx = db.transaction(() => {
      const rows = db
        .prepare(`
          SELECT id, gmail_message_id, sender, subject, received_at, body_text, snippet,
                 retry_count, max_retries
          FROM gmail_messages
          WHERE workspace_id = ?
            AND (
              extraction_status = 'PENDING'
              OR (
                extraction_status = 'RETRYING'
                AND (next_retry_at IS NULL OR next_retry_at <= ?)
              )
            )
          ORDER BY
            CASE WHEN extraction_status = 'PENDING' THEN 0 ELSE 1 END,
            received_at DESC
          LIMIT ?
        `)
        .all(workspaceId, nowIso, this.config.batchSize) as Array<Record<string, unknown>>;

      if (rows.length === 0) return [];

      const markProcessing = db.prepare(`
        UPDATE gmail_messages
        SET extraction_status = 'PROCESSING',
            last_attempt_at = ?
        WHERE id = ? AND workspace_id = ?
      `);

      for (const r of rows) {
        markProcessing.run(nowIso, String(r.id), workspaceId);
      }

      return rows.map((r) => ({
        messageRowId: String(r.id),
        gmailMessageId: String(r.gmail_message_id),
        sender: String(r.sender),
        subject: String(r.subject),
        receivedAt: String(r.received_at),
        bodyText: String(r.body_text || r.snippet || ''),
        retryCount: Number(r.retry_count ?? 0),
        maxRetries: Number(r.max_retries ?? this.config.maxRetries),
      }));
    });

    return claimTx();
  }

  private scheduleRetryOrFailure(
    workspaceId: string,
    msgIds: Array<{ messageRowId: string; retryCount: number; maxRetries: number }>,
    err: unknown,
    opts?: { forceRetryable?: boolean; applyGlobalCooldown?: boolean },
  ): { retryingCount: number; failedCount: number; earliestNextRetryMs: number | null } {
    const retryable = opts?.forceRetryable ?? isRetryableGeminiError(err);
    const applyGlobalCooldown = opts?.applyGlobalCooldown ?? true;
    const sanitized = sanitizeExtractionError(err);
    const nowMs = this.config.nowFn();
    let retryingCount = 0;
    let failedCount = 0;
    let earliestNextRetryMs: number | null = null;

    const updateRetry = db.prepare(`
      UPDATE gmail_messages
      SET extraction_status = 'RETRYING',
          retry_count = ?,
          next_retry_at = ?,
          extraction_error = ?
      WHERE id = ? AND workspace_id = ? AND extraction_status != 'COMPLETED'
    `);

    const updateFailed = db.prepare(`
      UPDATE gmail_messages
      SET extraction_status = 'FAILED',
          retry_count = ?,
          next_retry_at = NULL,
          extraction_error = ?
      WHERE id = ? AND workspace_id = ? AND extraction_status != 'COMPLETED'
    `);

    const tx = db.transaction(() => {
      for (const item of msgIds) {
        const nextRetryNum = item.retryCount + 1;
        const cap = Math.min(item.maxRetries || this.config.maxRetries, this.config.maxRetries);

        if (retryable && nextRetryNum <= cap) {
          const delayMs = this.computeBackoffDelayMs(item.retryCount, err);
          const nextMs = nowMs + delayMs;
          const nextIso = new Date(nextMs).toISOString();
          if (applyGlobalCooldown) {
            this.cooldownUntilMs = Math.max(this.cooldownUntilMs, nextMs);
          }
          updateRetry.run(
            nextRetryNum,
            nextIso,
            `${sanitized} Automatic retry ${nextRetryNum}/${cap} scheduled.`,
            item.messageRowId,
            workspaceId,
          );
          retryingCount += 1;
          earliestNextRetryMs =
            earliestNextRetryMs === null ? nextMs : Math.min(earliestNextRetryMs, nextMs);
        } else {
          updateFailed.run(nextRetryNum, sanitized, item.messageRowId, workspaceId);
          failedCount += 1;
        }
      }
    });

    tx();
    return { retryingCount, failedCount, earliestNextRetryMs };
  }

  private findNextRetryTimestampMs(workspaceId: string): number | null {
    const row = db
      .prepare(`
        SELECT MIN(next_retry_at) AS next_at
        FROM gmail_messages
        WHERE workspace_id = ? AND extraction_status = 'RETRYING' AND next_retry_at IS NOT NULL
      `)
      .get(workspaceId) as { next_at: string | null } | undefined;

    if (!row?.next_at) return null;
    const ms = Date.parse(row.next_at);
    return Number.isFinite(ms) ? ms : null;
  }

  private scheduleBackgroundWakeup(workspaceId: string, delayMs: number): void {
    const existing = this.scheduledTimers.get(workspaceId);
    if (existing) {
      clearTimeout(existing);
      this.scheduledTimers.delete(workspaceId);
    }

    const boundedDelay = Math.min(Math.max(delayMs, 50), 300_000);
    const timer = setTimeout(() => {
      this.scheduledTimers.delete(workspaceId);
      this.enqueueWorkspaceExtraction(workspaceId);
    }, boundedDelay);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    this.scheduledTimers.set(workspaceId, timer);
  }

  async processWorkspaceQueue(
    workspaceId: string,
    options?: {
      geminiCaller?: GeminiGenerateFn;
      awaitRetries?: boolean;
      maxIterations?: number;
    },
  ): Promise<ProcessQueueResult> {
    if (workspaceId === DEMO_WORKSPACE_ID) {
      return {
        batchesExecuted: 0,
        completedCount: 0,
        retryingCount: 0,
        failedCount: 0,
        skippedCount: 0,
        itemsCreated: 0,
        relationshipsCreated: 0,
        nextScheduledAt: null,
      };
    }

    const existingRun = this.runningWorkspaces.get(workspaceId);
    if (existingRun) {
      return existingRun;
    }

    const runPromise = this.executeWorkspaceLoop(workspaceId, options).finally(() => {
      this.runningWorkspaces.delete(workspaceId);
    });
    this.runningWorkspaces.set(workspaceId, runPromise);
    return runPromise;
  }

  private async executeWorkspaceLoop(
    workspaceId: string,
    options?: {
      geminiCaller?: GeminiGenerateFn;
      awaitRetries?: boolean;
      maxIterations?: number;
    },
  ): Promise<ProcessQueueResult> {
    const result: ProcessQueueResult = {
      batchesExecuted: 0,
      completedCount: 0,
      retryingCount: 0,
      failedCount: 0,
      skippedCount: 0,
      itemsCreated: 0,
      relationshipsCreated: 0,
      nextScheduledAt: null,
    };

    const maxIterations = options?.maxIterations ?? 100;
    let iterations = 0;

    while (iterations < maxIterations) {
      iterations += 1;
      const nowMs = this.config.nowFn();
      const nowIso = new Date(nowMs).toISOString();
      const batch = this.claimNextBatch(workspaceId, nowIso);

      if (batch.length === 0) {
        const nextRetryMs = this.findNextRetryTimestampMs(workspaceId);
        if (nextRetryMs !== null) {
          const waitMs = Math.max(0, nextRetryMs - this.config.nowFn());
          if (options?.awaitRetries && waitMs <= this.config.maxBackoffMs) {
            await this.config.sleepFn(waitMs);
            continue;
          }
          result.nextScheduledAt = new Date(nextRetryMs).toISOString();
          this.scheduleBackgroundWakeup(workspaceId, waitMs);
        }
        break;
      }

      if (!options?.geminiCaller && !hasConfiguredGeminiApiKey()) {
        const skipMsg =
          'GEMINI_API_KEY not configured on server; message stored without AI extraction.';
        const skipStmt = db.prepare(`
          UPDATE gmail_messages
          SET extraction_status = 'SKIPPED',
              extraction_error = ?,
              next_retry_at = NULL
          WHERE id = ? AND workspace_id = ?
        `);
        for (const m of batch) {
          skipStmt.run(skipMsg, m.messageRowId, workspaceId);
          result.skippedCount += 1;
        }
        break;
      }

      await this.acquireRateLimitAndConcurrencySlot();
      try {
        result.batchesExecuted += 1;
        const batchOutcome = await extractAndStageEmailBatch(
          workspaceId,
          batch,
          options?.geminiCaller,
        );

        if (batchOutcome.skippedMissingKey) {
          result.skippedCount += batch.length;
          break;
        }

        result.completedCount += batchOutcome.completedIds.length;
        result.itemsCreated += batchOutcome.itemsCreated;
        result.relationshipsCreated += batchOutcome.relationshipsCreated;

        if (batchOutcome.missingIds.length > 0) {
          const missingSet = new Set(batchOutcome.missingIds);
          const missingMeta = batch.filter((m) => missingSet.has(m.messageRowId));
          const partialErr = new Error(
            'Batch extraction omitted one or more messageRowId entries; scheduling retry.',
          );
          const scheduled = this.scheduleRetryOrFailure(workspaceId, missingMeta, partialErr, {
            forceRetryable: true,
            applyGlobalCooldown: false,
          });
          result.retryingCount += scheduled.retryingCount;
          result.failedCount += scheduled.failedCount;
        }
      } catch (err) {
        const scheduled = this.scheduleRetryOrFailure(workspaceId, batch, err);
        result.retryingCount += scheduled.retryingCount;
        result.failedCount += scheduled.failedCount;
      } finally {
        this.releaseConcurrencySlot();
      }
    }

    return result;
  }

  enqueueWorkspaceExtraction(workspaceId: string): void {
    if (workspaceId === DEMO_WORKSPACE_ID) return;
    if (this.runningWorkspaces.has(workspaceId)) return;

    void this.processWorkspaceQueue(workspaceId).catch((err) => {
      console.error(
        `[extractionQueue] Background worker error for ${workspaceId}:`,
        sanitizeExtractionError(err),
      );
    });
  }

  retryFailedForWorkspace(
    workspaceId: string,
    messageId?: string,
    options?: { enqueue?: boolean },
  ): { retriedCount: number } {
    if (workspaceId === DEMO_WORKSPACE_ID) {
      throw new Error('Email extraction retry is disabled in DEMO MODE.');
    }

    let retriedCount = 0;
    const tx = db.transaction(() => {
      const targetRows = messageId
        ? (db
            .prepare(`
              SELECT id
              FROM gmail_messages
              WHERE workspace_id = ? AND id = ? AND extraction_status IN ('FAILED', 'RETRYING', 'SKIPPED')
            `)
            .all(workspaceId, messageId) as Array<{ id: string }>)
        : (db
            .prepare(`
              SELECT id
              FROM gmail_messages
              WHERE workspace_id = ? AND extraction_status IN ('FAILED', 'RETRYING')
            `)
            .all(workspaceId) as Array<{ id: string }>);

      if (targetRows.length === 0) {
        return;
      }

      const resetStmt = db.prepare(`
        UPDATE gmail_messages
        SET extraction_status = 'PENDING',
            retry_count = 0,
            next_retry_at = NULL,
            extraction_error = NULL
        WHERE id = ? AND workspace_id = ? AND extraction_status != 'COMPLETED'
      `);

      // Clean only unreviewed PENDING staging rows if any partial artifact remained
      const cleanPendingItems = db.prepare(`
        DELETE FROM email_extracted_items
        WHERE workspace_id = ? AND message_row_id = ? AND status = 'PENDING'
      `);
      const cleanPendingRels = db.prepare(`
        DELETE FROM email_suggested_relationships
        WHERE workspace_id = ? AND message_row_id = ? AND status = 'PENDING'
      `);

      for (const row of targetRows) {
        const info = resetStmt.run(row.id, workspaceId);
        if (info.changes > 0) {
          cleanPendingItems.run(workspaceId, row.id);
          cleanPendingRels.run(workspaceId, row.id);
          retriedCount += 1;
        }
      }
    });

    tx();

    // Clear global cooldown on explicit user retry so their request starts promptly
    // once rate-limit window allows, without dropping rate-limit safety.
    if (retriedCount > 0 && options?.enqueue !== false) {
      this.enqueueWorkspaceExtraction(workspaceId);
    }

    return { retriedCount };
  }

  getWorkspaceExtractionSummary(workspaceId: string): ExtractionPipelineSummary {
    const { rateLimitRpm, batchSize } = this.getSummaryConfig();
    if (workspaceId === DEMO_WORKSPACE_ID) {
      return {
        pending: 0,
        processing: 0,
        retrying: 0,
        completed: 0,
        failed: 0,
        skipped: 0,
        rateLimitRpm,
        batchSize,
      };
    }

    const rows = db
      .prepare(`
        SELECT extraction_status, COUNT(*) AS cnt
        FROM gmail_messages
        WHERE workspace_id = ?
        GROUP BY extraction_status
      `)
      .all(workspaceId) as Array<{ extraction_status: string; cnt: number }>;

    const summary: ExtractionPipelineSummary = {
      pending: 0,
      processing: 0,
      retrying: 0,
      completed: 0,
      failed: 0,
      skipped: 0,
      rateLimitRpm,
      batchSize,
    };

    for (const r of rows) {
      const status = r.extraction_status;
      if (status === 'PENDING') summary.pending += r.cnt;
      else if (status === 'PROCESSING') summary.processing += r.cnt;
      else if (status === 'RETRYING') summary.retrying += r.cnt;
      else if (status === 'COMPLETED' || status === 'EXTRACTED') summary.completed += r.cnt;
      else if (status === 'FAILED') summary.failed += r.cnt;
      else if (status === 'SKIPPED') summary.skipped += r.cnt;
    }

    return summary;
  }
}

export const extractionQueue = new ExtractionQueueController();

export function enqueueWorkspaceExtraction(workspaceId: string): void {
  extractionQueue.enqueueWorkspaceExtraction(workspaceId);
}

export function processWorkspaceExtractionQueue(
  workspaceId: string,
  options?: {
    geminiCaller?: GeminiGenerateFn;
    awaitRetries?: boolean;
    maxIterations?: number;
  },
): Promise<ProcessQueueResult> {
  return extractionQueue.processWorkspaceQueue(workspaceId, options);
}

export function retryFailedExtractions(
  workspaceId: string,
  messageId?: string,
  options?: { enqueue?: boolean },
): { retriedCount: number } {
  return extractionQueue.retryFailedForWorkspace(workspaceId, messageId, options);
}

export function getExtractionSummary(workspaceId: string): ExtractionPipelineSummary {
  return extractionQueue.getWorkspaceExtractionSummary(workspaceId);
}
