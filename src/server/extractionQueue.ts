import { db, DEMO_WORKSPACE_ID } from './db.ts';
import {
  extractAndStageEmailBatch,
  extractHttpStatus,
  hasConfiguredGeminiApiKey,
  isRetryableGeminiError,
  isSchemaValidationError,
  sanitizeExtractionError,
  type BatchEntryValidationFailure,
  type ExtractableEmailMessage,
  type GeminiGenerateFn,
} from './emailContextService.ts';
import {
  GeminiCooldownActiveError,
  GeminiQuotaCoordinator,
  sharedGeminiLimiter,
} from './geminiRateLimiter.ts';
import type { ExtractionPipelineSummary } from '../types/maya.ts';

function isParseOrStructureBatchError(err: unknown): boolean {
  if (isSchemaValidationError(err)) return false;
  const msg = (err instanceof Error ? err.message : String(err)).toUpperCase();
  return (
    msg.includes('MALFORMED JSON') ||
    msg.includes('EMPTY EXTRACTION RESPONSE') ||
    msg.includes('MISSING "RESULTS" ARRAY')
  );
}

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
  rateLimiter?: GeminiQuotaCoordinator;
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
    Omit<ExtractionQueueConfig, 'minSpacingMs' | 'rateLimiter'>
  > & { minSpacingMs: number };

  readonly rateLimiter: GeminiQuotaCoordinator;
  private runningWorkspaces = new Map<string, Promise<ProcessQueueResult>>();
  private scheduledTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private startupInitialized = false;

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

    if (overrides?.rateLimiter) {
      this.rateLimiter = overrides.rateLimiter;
    } else if (
      overrides &&
      (overrides.concurrency !== undefined ||
        overrides.requestsPerMinute !== undefined ||
        overrides.windowMs !== undefined ||
        overrides.minSpacingMs !== undefined ||
        overrides.nowFn !== undefined ||
        overrides.sleepFn !== undefined ||
        overrides.randomFn !== undefined ||
        overrides.baseBackoffMs !== undefined)
    ) {
      this.rateLimiter = new GeminiQuotaCoordinator({
        concurrency: this.config.concurrency,
        requestsPerMinute: this.config.requestsPerMinute,
        windowMs: this.config.windowMs,
        minSpacingMs: this.config.minSpacingMs,
        defaultRateLimitCooldownMs: this.config.baseBackoffMs,
        persistToDb: false,
        nowFn: this.config.nowFn,
        sleepFn: this.config.sleepFn,
        randomFn: this.config.randomFn,
      });
    } else {
      this.rateLimiter = sharedGeminiLimiter;
    }
  }

  getSummaryConfig(): { rateLimitRpm: number; batchSize: number } {
    const quota = this.rateLimiter.getQuotaSummary();
    return {
      rateLimitRpm: quota.requestsPerMinute,
      batchSize: this.config.batchSize,
    };
  }

  computeBackoffDelayMs(currentRetryCount: number, err?: unknown): number {
    return this.rateLimiter.computeSafeBackoffMs(
      currentRetryCount,
      this.config.baseBackoffMs,
      this.config.maxBackoffMs,
      err,
    );
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
            this.rateLimiter.applyCooldownUntilMs(nextMs, sanitized, extractHttpStatus(err));
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

  private markSchemaValidationFailures(
    workspaceId: string,
    batch: Array<ExtractableEmailMessage & { retryCount: number; maxRetries: number }>,
    invalidEntries: BatchEntryValidationFailure[],
  ): number {
    if (invalidEntries.length === 0) return 0;

    const retryCountById = new Map(batch.map((m) => [m.messageRowId, m.retryCount]));
    const updateFailed = db.prepare(`
      UPDATE gmail_messages
      SET extraction_status = 'FAILED',
          retry_count = ?,
          next_retry_at = NULL,
          extraction_error = ?
      WHERE id = ? AND workspace_id = ? AND extraction_status != 'COMPLETED'
    `);

    let failedCount = 0;
    const tx = db.transaction(() => {
      for (const entry of invalidEntries) {
        const currentRetries = retryCountById.get(entry.messageRowId) ?? 0;
        const sanitizedDiag = sanitizeExtractionError(entry.diagnosticMessage);
        const info = updateFailed.run(
          currentRetries + 1,
          sanitizedDiag,
          entry.messageRowId,
          workspaceId,
        );
        if (info.changes > 0) {
          failedCount += 1;
          console.warn(`[extractionQueue] ${sanitizedDiag}`);
        }
      }
    });

    tx();
    return failedCount;
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

    const boundedDelay = Math.min(Math.max(delayMs, 50), 1_800_000);
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
      const cooldownWaitMs = this.rateLimiter.getCooldownRemainingMs();
      if (!options?.awaitRetries && cooldownWaitMs > 0) {
        const wakeAt = nowMs + cooldownWaitMs;
        result.nextScheduledAt = new Date(wakeAt).toISOString();
        this.scheduleBackgroundWakeup(workspaceId, cooldownWaitMs);
        break;
      }

      const nowIso = new Date(nowMs).toISOString();
      const batch = this.claimNextBatch(workspaceId, nowIso);

      if (batch.length === 0) {
        const nextRetryMs = this.findNextRetryTimestampMs(workspaceId);
        const cooldownUntilMs = this.rateLimiter.getCooldownUntilMs();
        const wakeAtMs =
          nextRetryMs !== null && cooldownUntilMs > 0
            ? Math.max(nextRetryMs, cooldownUntilMs)
            : nextRetryMs ?? (cooldownUntilMs > 0 ? cooldownUntilMs : null);

        if (wakeAtMs !== null) {
          const waitMs = Math.max(0, wakeAtMs - this.config.nowFn());
          if (options?.awaitRetries && waitMs <= 1_800_000) {
            await this.config.sleepFn(waitMs);
            continue;
          }
          result.nextScheduledAt = new Date(wakeAtMs).toISOString();
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

      let batchErr: unknown = null;
      try {
        const batchOutcome = await this.rateLimiter.runWithQuota(async () => {
          result.batchesExecuted += 1;
          return extractAndStageEmailBatch(workspaceId, batch, options?.geminiCaller);
        });

        if (batchOutcome.skippedMissingKey) {
          result.skippedCount += batch.length;
          break;
        }

        result.completedCount += batchOutcome.completedIds.length;
        result.itemsCreated += batchOutcome.itemsCreated;
        result.relationshipsCreated += batchOutcome.relationshipsCreated;

        if (batchOutcome.invalidEntries.length > 0) {
          result.failedCount += this.markSchemaValidationFailures(
            workspaceId,
            batch,
            batchOutcome.invalidEntries,
          );
        }

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
        batchErr = err;
      }

      if (batchErr !== null) {
        if (batchErr instanceof GeminiCooldownActiveError) {
          const wakeAt = batchErr.cooldownUntilMs;
          result.nextScheduledAt = new Date(wakeAt).toISOString();
          this.scheduleBackgroundWakeup(workspaceId, batchErr.remainingMs);
          break;
        }
        if (batch.length > 1 && isParseOrStructureBatchError(batchErr)) {
          await this.processSplitBatchFallback(workspaceId, batch, options, result);
        } else {
          const isSchemaErr = isSchemaValidationError(batchErr);
          const scheduled = this.scheduleRetryOrFailure(workspaceId, batch, batchErr, {
            forceRetryable: isSchemaErr ? false : undefined,
            applyGlobalCooldown: !isSchemaErr,
          });
          result.retryingCount += scheduled.retryingCount;
          result.failedCount += scheduled.failedCount;
        }
      }
    }

    return result;
  }

  private async processSplitBatchFallback(
    workspaceId: string,
    batch: Array<ExtractableEmailMessage & { retryCount: number; maxRetries: number }>,
    options:
      | {
          geminiCaller?: GeminiGenerateFn;
          awaitRetries?: boolean;
          maxIterations?: number;
        }
      | undefined,
    result: ProcessQueueResult,
  ): Promise<void> {
    for (let i = 0; i < batch.length; i += 1) {
      const singleMsg = batch[i];

      if (!options?.geminiCaller && !hasConfiguredGeminiApiKey()) {
        const remaining = batch.slice(i);
        const skipMsg =
          'GEMINI_API_KEY not configured on server; message stored without AI extraction.';
        const skipStmt = db.prepare(`
          UPDATE gmail_messages
          SET extraction_status = 'SKIPPED',
              extraction_error = ?,
              next_retry_at = NULL
          WHERE id = ? AND workspace_id = ? AND extraction_status != 'COMPLETED'
        `);
        for (const m of remaining) {
          const info = skipStmt.run(skipMsg, m.messageRowId, workspaceId);
          if (info.changes > 0) {
            result.skippedCount += 1;
          }
        }
        return;
      }

      try {
        const singleOutcome = await this.rateLimiter.runWithQuota(async () => {
          result.batchesExecuted += 1;
          return extractAndStageEmailBatch(workspaceId, [singleMsg], options?.geminiCaller);
        });

        if (singleOutcome.skippedMissingKey) {
          result.skippedCount += 1;
          continue;
        }

        result.completedCount += singleOutcome.completedIds.length;
        result.itemsCreated += singleOutcome.itemsCreated;
        result.relationshipsCreated += singleOutcome.relationshipsCreated;

        if (singleOutcome.invalidEntries.length > 0) {
          result.failedCount += this.markSchemaValidationFailures(
            workspaceId,
            [singleMsg],
            singleOutcome.invalidEntries,
          );
        }

        if (singleOutcome.missingIds.length > 0) {
          const missingErr = new Error(
            'Isolated extraction omitted messageRowId; scheduling retry.',
          );
          const scheduled = this.scheduleRetryOrFailure(workspaceId, [singleMsg], missingErr, {
            forceRetryable: true,
            applyGlobalCooldown: false,
          });
          result.retryingCount += scheduled.retryingCount;
          result.failedCount += scheduled.failedCount;
        }
      } catch (singleErr) {
        const isSchemaErr = isSchemaValidationError(singleErr);
        const isParseErr = isParseOrStructureBatchError(singleErr);
        const scheduled = this.scheduleRetryOrFailure(workspaceId, [singleMsg], singleErr, {
          forceRetryable: isSchemaErr ? false : isParseErr ? true : undefined,
          applyGlobalCooldown: !isSchemaErr && !isParseErr,
        });
        result.retryingCount += scheduled.retryingCount;
        result.failedCount += scheduled.failedCount;

        // If an isolated fallback call hit a rate-limit or transient server overload,
        // stop hammering the API and defer remaining emails in this batch cleanly.
        if (!isSchemaErr && !isParseErr && isRetryableGeminiError(singleErr) && i + 1 < batch.length) {
          const remaining = batch.slice(i + 1);
          const deferred = this.scheduleRetryOrFailure(workspaceId, remaining, singleErr, {
            applyGlobalCooldown: true,
          });
          result.retryingCount += deferred.retryingCount;
          result.failedCount += deferred.failedCount;
          break;
        }
      }
    }
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

    // Re-queue into workspace extraction; active global 429 cooldown remains enforced.
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
  initializeOnStartup(options?: { enqueue?: boolean }): {
    recoveredCount: number;
    workspacesScheduled: number;
  } {
    if (this.startupInitialized) {
      return { recoveredCount: 0, workspacesScheduled: 0 };
    }
    this.startupInitialized = true;
    this.rateLimiter.restoreFromDb(true);

    const recovered = db
      .prepare(`
        UPDATE gmail_messages
        SET extraction_status = 'PENDING',
            next_retry_at = NULL
        WHERE extraction_status = 'PROCESSING'
          AND workspace_id != ?
      `)
      .run(DEMO_WORKSPACE_ID);

    const recoveredCount = Number(recovered.changes ?? 0);
    if (recoveredCount > 0) {
      console.log(
        `[extractionQueue] Recovered ${recoveredCount} interrupted PROCESSING extraction job(s) to PENDING.`,
      );
    }

    if (options?.enqueue === false) {
      return { recoveredCount, workspacesScheduled: 0 };
    }

    const workspacesWithWork = db
      .prepare(`
        SELECT DISTINCT workspace_id
        FROM gmail_messages
        WHERE extraction_status IN ('PENDING', 'RETRYING')
          AND workspace_id != ?
      `)
      .all(DEMO_WORKSPACE_ID) as Array<{ workspace_id: string }>;

    let workspacesScheduled = 0;
    for (const row of workspacesWithWork) {
      const wsId = row.workspace_id;
      if (!this.runningWorkspaces.has(wsId) && !this.scheduledTimers.has(wsId)) {
        this.enqueueWorkspaceExtraction(wsId);
        workspacesScheduled += 1;
      }
    }

    return { recoveredCount, workspacesScheduled };
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

export function initializeExtractionQueueOnStartup(options?: { enqueue?: boolean }): {
  recoveredCount: number;
  workspacesScheduled: number;
} {
  return extractionQueue.initializeOnStartup(options);
}
