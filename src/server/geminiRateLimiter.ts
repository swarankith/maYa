import { db } from './db.ts';
import {
  extractHttpStatus,
  isOverload503GeminiError,
  isRateLimitGeminiError,
  isRetryableGeminiError,
  parseRetryDelayMs,
  sanitizeExtractionError,
} from './emailContextService.ts';

export interface GeminiQuotaConfig {
  concurrency: number;
  requestsPerMinute: number;
  windowMs: number;
  minSpacingMs: number;
  defaultRateLimitCooldownMs: number;
  maxCooldownMs: number;
  persistToDb: boolean;
  dbStateKey: string;
  nowFn: () => number;
  sleepFn: (ms: number) => Promise<void>;
  randomFn: () => number;
}

export class GeminiCooldownActiveError extends Error {
  readonly remainingMs: number;
  readonly cooldownUntilMs: number;
  readonly cooldownUntilIso: string;

  constructor(remainingMs: number, cooldownUntilMs: number) {
    const secs = Math.max(1, Math.ceil(remainingMs / 1000));
    const untilIso = new Date(cooldownUntilMs).toISOString();
    super(`Gemini shared quota cooldown active (~${secs}s remaining until ${untilIso}).`);
    this.name = 'GeminiCooldownActiveError';
    this.remainingMs = remainingMs;
    this.cooldownUntilMs = cooldownUntilMs;
    this.cooldownUntilIso = untilIso;
  }
}

function parseBoundedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

export function getDefaultGeminiQuotaConfig(): GeminiQuotaConfig {
  const requestsPerMinute = parseBoundedInt(process.env.GEMINI_RPM_LIMIT, 4, 1, 60);
  const windowMs = 60_000;
  return {
    concurrency: parseBoundedInt(process.env.GEMINI_EXTRACTION_CONCURRENCY, 1, 1, 4),
    requestsPerMinute,
    windowMs,
    minSpacingMs: Math.ceil(windowMs / Math.max(requestsPerMinute, 1)),
    defaultRateLimitCooldownMs: parseBoundedInt(process.env.GEMINI_BASE_BACKOFF_MS, 5_000, 100, 120_000),
    maxCooldownMs: 1_800_000,
    persistToDb: true,
    dbStateKey: 'project-default',
    nowFn: () => Date.now(),
    sleepFn: (ms) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }),
    randomFn: () => Math.random(),
  };
}

export interface RecordedQuotaOutcome {
  isRateLimit: boolean;
  isOverload503: boolean;
  retryable: boolean;
  apiRetryDelayMs: number | null;
  cooldownUntilMs: number | null;
  sanitizedMessage: string;
}

/**
 * Shared project-level Gemini rate-limit, concurrency, and persistent cooldown coordinator.
 * Ensures all Gemini call sites (Gmail extraction, change-event NLU, impact narratives)
 * share one quota budget and never fire requests before an active cooldown expires.
 */
export class GeminiQuotaCoordinator {
  private readonly config: GeminiQuotaConfig;
  private callTimestamps: number[] = [];
  private cooldownUntilMs = 0;
  private restoredFromDb = false;

  private activeRequests = 0;
  private concurrencyWaiters: Array<() => void> = [];
  private slotMutex: Promise<void> = Promise.resolve();

  constructor(overrides?: Partial<GeminiQuotaConfig>) {
    const defaults = getDefaultGeminiQuotaConfig();
    const requestsPerMinute = overrides?.requestsPerMinute ?? defaults.requestsPerMinute;
    const windowMs = overrides?.windowMs ?? defaults.windowMs;
    const minSpacingMs =
      overrides?.minSpacingMs ?? Math.ceil(windowMs / Math.max(requestsPerMinute, 1));

    this.config = {
      concurrency: Math.max(1, overrides?.concurrency ?? defaults.concurrency),
      requestsPerMinute: Math.max(1, requestsPerMinute),
      windowMs: Math.max(100, windowMs),
      minSpacingMs: Math.max(0, minSpacingMs),
      defaultRateLimitCooldownMs: overrides?.defaultRateLimitCooldownMs ?? defaults.defaultRateLimitCooldownMs,
      maxCooldownMs: overrides?.maxCooldownMs ?? defaults.maxCooldownMs,
      persistToDb: overrides?.persistToDb ?? defaults.persistToDb,
      dbStateKey: overrides?.dbStateKey ?? defaults.dbStateKey,
      nowFn: overrides?.nowFn ?? defaults.nowFn,
      sleepFn: overrides?.sleepFn ?? defaults.sleepFn,
      randomFn: overrides?.randomFn ?? defaults.randomFn,
    };
  }

  getQuotaSummary(): {
    concurrency: number;
    requestsPerMinute: number;
    minSpacingMs: number;
    cooldownUntilMs: number;
    cooldownRemainingMs: number;
  } {
    this.ensureRestored();
    const now = this.config.nowFn();
    const activeCooldown = this.cooldownUntilMs > now ? this.cooldownUntilMs : 0;
    return {
      concurrency: this.config.concurrency,
      requestsPerMinute: this.config.requestsPerMinute,
      minSpacingMs: this.config.minSpacingMs,
      cooldownUntilMs: activeCooldown,
      cooldownRemainingMs: activeCooldown > 0 ? activeCooldown - now : 0,
    };
  }

  now(): number {
    return this.config.nowFn();
  }

  sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return this.config.sleepFn(ms);
  }

  random(): number {
    return this.config.randomFn();
  }

  restoreFromDb(force = false): void {
    if (!this.config.persistToDb) {
      this.restoredFromDb = true;
      return;
    }
    if (this.restoredFromDb && !force) return;

    try {
      const row = db
        .prepare('SELECT cooldown_until_ms FROM gemini_quota_state WHERE id = ?')
        .get(this.config.dbStateKey) as { cooldown_until_ms: number } | undefined;

      this.restoredFromDb = true;
      if (row && Number.isFinite(row.cooldown_until_ms)) {
        const now = this.config.nowFn();
        if (row.cooldown_until_ms > now && row.cooldown_until_ms > this.cooldownUntilMs) {
          this.cooldownUntilMs = Math.min(row.cooldown_until_ms, now + this.config.maxCooldownMs);
        }
      }
    } catch {
      // Table may not be initialized yet at module import time; retry lazily on first call.
    }
  }

  private ensureRestored(): void {
    if (!this.restoredFromDb) {
      this.restoreFromDb(false);
    }
  }

  private persistCooldownToDb(untilMs: number, reason: string, statusCode: number | null): void {
    if (!this.config.persistToDb) return;
    try {
      db.prepare(`
        INSERT INTO gemini_quota_state (
          id, cooldown_until_ms, cooldown_reason, last_error_code, updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          cooldown_until_ms = MAX(gemini_quota_state.cooldown_until_ms, excluded.cooldown_until_ms),
          cooldown_reason = excluded.cooldown_reason,
          last_error_code = excluded.last_error_code,
          updated_at = excluded.updated_at
      `).run(
        this.config.dbStateKey,
        untilMs,
        reason.slice(0, 240),
        statusCode,
        new Date(this.config.nowFn()).toISOString(),
      );
    } catch {
      // Do not crash caller if DB is not initialized yet.
    }
  }

  getCooldownRemainingMs(): number {
    this.ensureRestored();
    const now = this.config.nowFn();
    return Math.max(0, this.cooldownUntilMs - now);
  }

  getCooldownUntilMs(): number {
    this.ensureRestored();
    const now = this.config.nowFn();
    return this.cooldownUntilMs > now ? this.cooldownUntilMs : 0;
  }

  applyCooldownDelayMs(delayMs: number, reason: string, statusCode: number | null = null): number {
    this.ensureRestored();
    const now = this.config.nowFn();
    const bounded = Math.min(Math.max(Math.round(delayMs), 0), this.config.maxCooldownMs);
    if (bounded <= 0) return this.cooldownUntilMs;
    const candidateUntil = now + bounded;
    if (candidateUntil > this.cooldownUntilMs) {
      this.cooldownUntilMs = candidateUntil;
      this.persistCooldownToDb(candidateUntil, reason, statusCode);
    }
    return this.cooldownUntilMs;
  }

  applyCooldownUntilMs(targetUntilMs: number, reason: string, statusCode: number | null = null): number {
    this.ensureRestored();
    const now = this.config.nowFn();
    const boundedUntil = Math.min(targetUntilMs, now + this.config.maxCooldownMs);
    if (boundedUntil > this.cooldownUntilMs && boundedUntil > now) {
      this.cooldownUntilMs = boundedUntil;
      this.persistCooldownToDb(boundedUntil, reason, statusCode);
    }
    return this.cooldownUntilMs;
  }

  computeSafeBackoffMs(
    retryIndex: number,
    baseBackoffMs: number,
    maxBackoffMs: number,
    err?: unknown,
  ): number {
    const expMs = baseBackoffMs * Math.pow(2, Math.max(retryIndex, 0));
    const jitterMs = Math.round(expMs * 0.25 * this.config.randomFn());
    const boundedExp = Math.min(maxBackoffMs, expMs + jitterMs);
    const apiHintMs = parseRetryDelayMs(err) ?? 0;
    // Never retry earlier than an explicit upstream 429 retryDelay/Retry-After hint.
    return apiHintMs > 0 ? Math.max(boundedExp, apiHintMs) : boundedExp;
  }

  recordQuotaError(err: unknown): RecordedQuotaOutcome {
    const isRateLimit = isRateLimitGeminiError(err);
    const isOverload503 = !isRateLimit && isOverload503GeminiError(err);
    const retryable = isRetryableGeminiError(err);
    const apiRetryDelayMs = parseRetryDelayMs(err);
    const sanitizedMessage = sanitizeExtractionError(err);
    const statusCode = extractHttpStatus(err) ?? (isRateLimit ? 429 : isOverload503 ? 503 : null);

    let cooldownUntilMs: number | null = null;
    if (isRateLimit || isOverload503) {
      const delayMs = Math.max(apiRetryDelayMs ?? 0, this.config.defaultRateLimitCooldownMs);
      cooldownUntilMs = this.applyCooldownDelayMs(delayMs, sanitizedMessage, statusCode);
    }

    return {
      isRateLimit,
      isOverload503,
      retryable,
      apiRetryDelayMs,
      cooldownUntilMs,
      sanitizedMessage,
    };
  }

  private async acquireConcurrencyPermit(): Promise<void> {
    if (this.activeRequests < this.config.concurrency) {
      this.activeRequests += 1;
      return;
    }

    await new Promise<void>((resolve) => {
      this.concurrencyWaiters.push(resolve);
    });
    this.activeRequests += 1;
  }

  releaseSlot(): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
    const next = this.concurrencyWaiters.shift();
    if (next) {
      next();
    }
  }

  async acquireSlot(options?: { maxWaitMs?: number }): Promise<void> {
    this.ensureRestored();

    if (options?.maxWaitMs !== undefined) {
      const immediateRemaining = Math.max(0, this.cooldownUntilMs - this.config.nowFn());
      if (immediateRemaining > options.maxWaitMs) {
        throw new GeminiCooldownActiveError(immediateRemaining, this.cooldownUntilMs);
      }
    }

    await this.acquireConcurrencyPermit();

    const previousMutex = this.slotMutex;
    let releaseMutex!: () => void;
    this.slotMutex = new Promise<void>((res) => {
      releaseMutex = res;
    });

    try {
      await previousMutex;

      while (true) {
        this.ensureRestored();
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

        if (options?.maxWaitMs !== undefined && waitMs > options.maxWaitMs) {
          const until = Math.max(this.cooldownUntilMs, now + waitMs);
          throw new GeminiCooldownActiveError(waitMs, until);
        }

        await this.config.sleepFn(waitMs);
      }
    } catch (err) {
      this.releaseSlot();
      throw err;
    } finally {
      releaseMutex();
    }
  }

  async runWithQuota<T>(
    fn: () => Promise<T>,
    options?: { maxWaitMs?: number; recordQuotaErrors?: boolean },
  ): Promise<T> {
    await this.acquireSlot({ maxWaitMs: options?.maxWaitMs });
    try {
      return await fn();
    } catch (err) {
      if (options?.recordQuotaErrors !== false) {
        this.recordQuotaError(err);
      }
      throw err;
    } finally {
      this.releaseSlot();
    }
  }
}

export const sharedGeminiLimiter = new GeminiQuotaCoordinator();
