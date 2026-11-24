import { randomBytes, randomUUID } from 'node:crypto';
import { DEMO_WORKSPACE_ID, db } from './db.ts';
import { decryptSecret, encryptSecret, isTokenEncryptionConfigured } from './cryptoService.ts';
import type { GeminiGenerateFn } from './emailContextService.ts';
import {
  enqueueWorkspaceExtraction,
  processWorkspaceExtractionQueue,
  type ExtractionQueueController,
} from './extractionQueue.ts';
import { recordAuditLog, upsertSourceRecord } from './graphService.ts';
import type {
  ExtractionStatus,
  GmailConnectionStatus,
  GmailMessageSummary,
  GmailSyncResult,
  SourceRecord,
} from '../types/maya.ts';

export const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const MAX_BODY_CHARS = 12_000;
const DEFAULT_SYNC_BATCH = 15;
const MAX_SYNC_BATCH = 25;

export type FetchLike = typeof fetch;

const PLACEHOLDER_CLIENT_IDS = new Set(['', 'MY_GOOGLE_CLIENT_ID']);
const PLACEHOLDER_CLIENT_SECRETS = new Set(['', 'MY_GOOGLE_CLIENT_SECRET']);

function getOAuthCredentials(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim() ?? '';
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim() ?? '';
  if (PLACEHOLDER_CLIENT_IDS.has(clientId) || PLACEHOLDER_CLIENT_SECRETS.has(clientSecret)) {
    return null;
  }
  return { clientId, clientSecret };
}

export const ADMIN_OAUTH_CONFIG_ERROR =
  'Gmail integration is currently unavailable because the application administrator has not configured centralized Google OAuth credentials on the server.';

export class AdminConfigurationError extends Error {
  constructor(message = ADMIN_OAUTH_CONFIG_ERROR) {
    super(message);
    this.name = 'AdminConfigurationError';
  }
}

export function isGmailOAuthConfigured(): boolean {
  return getOAuthCredentials() !== null && isTokenEncryptionConfigured();
}

export function getEffectiveCallbackUrl(originHint?: string): string {
  const configured = process.env.GOOGLE_REDIRECT_URI?.trim();
  if (
    configured &&
    !configured.startsWith('MY_APP_URL') &&
    (configured.startsWith('https://') || configured.startsWith('http://'))
  ) {
    return configured;
  }

  const appUrl = process.env.APP_URL?.trim();
  if (
    appUrl &&
    appUrl !== 'MY_APP_URL' &&
    (appUrl.startsWith('https://') || appUrl.startsWith('http://'))
  ) {
    return `${appUrl.replace(/\/+$/, '')}/api/integrations/gmail/callback`;
  }

  if (originHint && (originHint.startsWith('https://') || originHint.startsWith('http://'))) {
    return `${originHint.replace(/\/+$/, '')}/api/integrations/gmail/callback`;
  }

  return 'http://localhost:3000/api/integrations/gmail/callback';
}

function assertPersonalWorkspace(workspaceId: string): void {
  if (!workspaceId || workspaceId === DEMO_WORKSPACE_ID) {
    throw new Error('Real Gmail OAuth connections are disabled in DEMO MODE.');
  }
}

export function getGmailConnectionStatus(
  workspaceId: string,
  _originHint?: string,
): GmailConnectionStatus {
  const serviceAvailable = isGmailOAuthConfigured();
  const unavailableReason = serviceAvailable ? null : ADMIN_OAUTH_CONFIG_ERROR;

  if (workspaceId === DEMO_WORKSPACE_ID) {
    return {
      workspaceId,
      serviceAvailable: false,
      unavailableReason: 'Gmail integration is disabled in DEMO MODE.',
      status: 'DISCONNECTED',
      googleEmail: null,
      scopes: [],
      lastSyncAt: null,
      hasHistoryBaseline: false,
      lastError: null,
      readOnly: true,
    };
  }

  const row = db
    .prepare('SELECT * FROM gmail_connections WHERE workspace_id = ?')
    .get(workspaceId) as Record<string, unknown> | undefined;

  if (!row) {
    return {
      workspaceId,
      serviceAvailable,
      unavailableReason,
      status: 'DISCONNECTED',
      googleEmail: null,
      scopes: [],
      lastSyncAt: null,
      hasHistoryBaseline: false,
      lastError: null,
      readOnly: true,
    };
  }

  return {
    workspaceId,
    serviceAvailable,
    unavailableReason,
    status: String(row.status) as GmailConnectionStatus['status'],
    googleEmail: row.google_email ? String(row.google_email) : null,
    scopes: JSON.parse(String(row.scopes_json ?? '[]')) as string[],
    lastSyncAt: row.last_sync_at ? String(row.last_sync_at) : null,
    hasHistoryBaseline: Boolean(row.history_id),
    lastError: row.last_error ? String(row.last_error) : null,
    readOnly: true,
  };
}

export function createGmailAuthUrl(
  userId: string,
  workspaceId: string,
  originHint?: string,
): { authUrl: string; clientId: string; state: string } {
  assertPersonalWorkspace(workspaceId);
  const creds = getOAuthCredentials();
  if (!creds || !isTokenEncryptionConfigured()) {
    throw new AdminConfigurationError();
  }

  const redirectUri = getEffectiveCallbackUrl(originHint);
  const state = randomBytes(32).toString('hex');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + OAUTH_STATE_TTL_MS);

  // Prune stale states opportunistically
  db.prepare('DELETE FROM oauth_states WHERE expires_at <= ?').run(now.toISOString());

  db.prepare(`
    INSERT INTO oauth_states (state, user_id, workspace_id, redirect_uri, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(state, userId, workspaceId, redirectUri, now.toISOString(), expiresAt.toISOString());

  const params = new URLSearchParams({
    client_id: creds.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GMAIL_READONLY_SCOPE,
    access_type: 'offline',
    prompt: 'select_account consent',
    include_granted_scopes: 'true',
    state,
  });

  return {
    authUrl: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
    clientId: creds.clientId,
    state,
  };
}

async function exchangeCodeAndSaveConnection(
  params: {
    code: string;
    redirectUri: string;
    userId: string;
    workspaceId: string;
  },
  fetchImpl: FetchLike = fetch,
): Promise<{ ok: boolean; email?: string; workspaceId?: string; error?: string }> {
  const creds = getOAuthCredentials();
  if (!creds || !isTokenEncryptionConfigured()) {
    return { ok: false, error: ADMIN_OAUTH_CONFIG_ERROR };
  }

  const tokenRes = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: params.code,
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      redirect_uri: params.redirectUri,
      grant_type: 'authorization_code',
    }),
  });

  const tokenJson = (await tokenRes.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    error?: string;
    error_description?: string;
  };

  if (!tokenRes.ok || !tokenJson.access_token) {
    return {
      ok: false,
      error: tokenJson.error_description || tokenJson.error || 'Failed to exchange OAuth code for tokens.',
    };
  }

  // Fetch verified Gmail profile email using only gmail.readonly
  const profileRes = await fetchImpl('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
    headers: { Authorization: `Bearer ${tokenJson.access_token}` },
  });

  if (!profileRes.ok) {
    return { ok: false, error: 'Connected OAuth token could not read Gmail profile.' };
  }

  const profileJson = (await profileRes.json()) as {
    emailAddress?: string;
    historyId?: string;
  };
  const googleEmail = (profileJson.emailAddress ?? '').trim().toLowerCase() || null;

  const existingConn = db
    .prepare('SELECT id, google_email, encrypted_refresh_token FROM gmail_connections WHERE workspace_id = ?')
    .get(params.workspaceId) as
    | { id: string; google_email: string | null; encrypted_refresh_token: string | null }
    | undefined;

  const encryptedAccessToken = encryptSecret(tokenJson.access_token);
  const sameGoogleAccount = Boolean(existingConn?.google_email && existingConn.google_email === googleEmail);
  const encryptedRefreshToken = tokenJson.refresh_token
    ? encryptSecret(tokenJson.refresh_token)
    : sameGoogleAccount
      ? existingConn?.encrypted_refresh_token ?? null
      : null;

  const expiresInSec = typeof tokenJson.expires_in === 'number' ? tokenJson.expires_in : 3600;
  const tokenExpiresAt = new Date(Date.now() + expiresInSec * 1000).toISOString();
  const grantedScopes = tokenJson.scope
    ? tokenJson.scope.split(/\s+/).filter(Boolean)
    : [GMAIL_READONLY_SCOPE];
  const nowIso = new Date().toISOString();

  const tx = db.transaction(() => {
    const connId = existingConn?.id ?? `gconn-${randomUUID().slice(0, 10)}`;
    if (existingConn) {
      db.prepare(`
        UPDATE gmail_connections
        SET user_id = ?, google_email = ?, scopes_json = ?,
            encrypted_access_token = ?, encrypted_refresh_token = ?,
            token_expires_at = ?, status = 'CONNECTED', last_error = NULL, updated_at = ?
        WHERE workspace_id = ?
      `).run(
        params.userId,
        googleEmail,
        JSON.stringify(grantedScopes),
        encryptedAccessToken,
        encryptedRefreshToken,
        tokenExpiresAt,
        nowIso,
        params.workspaceId,
      );
    } else {
      db.prepare(`
        INSERT INTO gmail_connections (
          id, workspace_id, user_id, google_email, scopes_json,
          encrypted_access_token, encrypted_refresh_token, token_expires_at,
          status, last_error, history_id, last_sync_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'CONNECTED', NULL, NULL, NULL, ?, ?)
      `).run(
        connId,
        params.workspaceId,
        params.userId,
        googleEmail,
        JSON.stringify(grantedScopes),
        encryptedAccessToken,
        encryptedRefreshToken,
        tokenExpiresAt,
        nowIso,
        nowIso,
      );
    }

    db.prepare(`
      UPDATE integrations
      SET status = 'CONNECTED', granted_scopes_json = ?
      WHERE workspace_id = ? AND service_key = 'gmail'
    `).run(JSON.stringify(grantedScopes), params.workspaceId);

    recordAuditLog(params.workspaceId, {
      actionType: 'GMAIL_CONNECTED',
      targetLabel: googleEmail ?? 'Gmail Account',
      status: 'SYSTEM',
      executionMode: 'LOCAL_WORKSPACE',
      summary: `Connected Gmail read-only integration for ${googleEmail ?? 'Google account'} with encrypted server-side token storage.`,
      details: { scopes: grantedScopes, readOnly: true },
      actor: googleEmail ?? params.userId,
    });
  });

  tx();

  return { ok: true, email: googleEmail ?? undefined, workspaceId: params.workspaceId };
}

function consumeOAuthState(
  stateRaw: string | undefined,
  expectedOwner?: { userId: string; workspaceId: string },
):
  | { ok: true; userId: string; workspaceId: string; redirectUri: string }
  | { ok: false; error: string } {
  const state = (stateRaw ?? '').trim();
  if (!state) {
    return { ok: false, error: 'Missing OAuth state parameter.' };
  }

  const stateRow = db
    .prepare('SELECT * FROM oauth_states WHERE state = ?')
    .get(state) as Record<string, unknown> | undefined;

  if (!stateRow) {
    return { ok: false, error: 'Invalid or already consumed OAuth state.' };
  }

  // Single-use CSRF state: delete immediately upon lookup
  db.prepare('DELETE FROM oauth_states WHERE state = ?').run(state);

  const nowIso = new Date().toISOString();
  if (String(stateRow.expires_at) <= nowIso) {
    return { ok: false, error: 'OAuth authorization session expired. Please try connecting again.' };
  }

  const userId = String(stateRow.user_id);
  const workspaceId = String(stateRow.workspace_id);
  const redirectUri = String(stateRow.redirect_uri);
  assertPersonalWorkspace(workspaceId);

  if (
    expectedOwner &&
    (userId !== expectedOwner.userId || workspaceId !== expectedOwner.workspaceId)
  ) {
    return {
      ok: false,
      error: 'OAuth state does not belong to the authenticated user or workspace.',
    };
  }

  return { ok: true, userId, workspaceId, redirectUri };
}

export async function exchangeGmailCode(
  params: {
    code?: string;
    state?: string;
    userId: string;
    workspaceId: string;
  },
  fetchImpl: FetchLike = fetch,
): Promise<{ ok: boolean; email?: string; workspaceId?: string; error?: string }> {
  assertPersonalWorkspace(params.workspaceId);

  const stateResult = consumeOAuthState(params.state, {
    userId: params.userId,
    workspaceId: params.workspaceId,
  });
  if (!stateResult.ok) {
    return stateResult;
  }

  const code = (params.code ?? '').trim();
  if (!code) {
    return { ok: false, error: 'Missing authorization code from Google.' };
  }

  return exchangeCodeAndSaveConnection(
    {
      code,
      // Google Identity Services initCodeClient popup flow exchanges codes with redirect_uri='postmessage'
      redirectUri: 'postmessage',
      userId: stateResult.userId,
      workspaceId: stateResult.workspaceId,
    },
    fetchImpl,
  );
}

export async function handleGmailOAuthCallback(
  params: { code?: string; state?: string; error?: string },
  fetchImpl: FetchLike = fetch,
): Promise<{ ok: boolean; email?: string; workspaceId?: string; error?: string }> {
  const stateResult = consumeOAuthState(params.state);
  if (!stateResult.ok) {
    return stateResult;
  }

  if (params.error) {
    return { ok: false, error: `Google authorization cancelled or denied: ${params.error}` };
  }

  const code = (params.code ?? '').trim();
  if (!code) {
    return { ok: false, error: 'Missing authorization code from Google.' };
  }

  return exchangeCodeAndSaveConnection(
    {
      code,
      redirectUri: stateResult.redirectUri,
      userId: stateResult.userId,
      workspaceId: stateResult.workspaceId,
    },
    fetchImpl,
  );
}

function markConnectionRevoked(workspaceId: string, reason: string): void {
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE gmail_connections
      SET status = 'REVOKED', encrypted_access_token = NULL, last_error = ?, updated_at = ?
      WHERE workspace_id = ?
    `).run(reason, now, workspaceId);

    db.prepare(`
      UPDATE integrations
      SET status = 'DISCONNECTED'
      WHERE workspace_id = ? AND service_key = 'gmail'
    `).run(workspaceId);

    recordAuditLog(workspaceId, {
      actionType: 'GMAIL_ACCESS_REVOKED',
      targetLabel: 'Gmail Connection',
      status: 'SYSTEM',
      executionMode: 'LOCAL_WORKSPACE',
      summary: `Gmail access expired or revoked: ${reason}`,
      details: { reason },
      actor: 'maYa OAuth Policy',
    });
  });
  tx();
}

export async function getValidGmailAccessToken(
  workspaceId: string,
  fetchImpl: FetchLike = fetch,
  forceRefresh = false,
): Promise<{ accessToken: string; googleEmail: string | null; historyId: string | null }> {
  assertPersonalWorkspace(workspaceId);
  const row = db
    .prepare('SELECT * FROM gmail_connections WHERE workspace_id = ?')
    .get(workspaceId) as Record<string, unknown> | undefined;

  if (!row || String(row.status) !== 'CONNECTED') {
    throw new Error('Gmail is not connected for this workspace.');
  }

  const googleEmail = row.google_email ? String(row.google_email) : null;
  const historyId = row.history_id ? String(row.history_id) : null;
  const expiresAtMs = row.token_expires_at ? Date.parse(String(row.token_expires_at)) : 0;

  if (
    !forceRefresh &&
    row.encrypted_access_token &&
    Number.isFinite(expiresAtMs) &&
    expiresAtMs > Date.now() + 60_000
  ) {
    return {
      accessToken: decryptSecret(String(row.encrypted_access_token)),
      googleEmail,
      historyId,
    };
  }

  if (!row.encrypted_refresh_token) {
    markConnectionRevoked(workspaceId, 'No refresh token stored; please reconnect Gmail.');
    throw new Error('Gmail refresh token missing or expired. Please reconnect your Gmail account.');
  }

  const creds = getOAuthCredentials();
  if (!creds || !isTokenEncryptionConfigured()) {
    throw new AdminConfigurationError();
  }

  const refreshToken = decryptSecret(String(row.encrypted_refresh_token));
  const refreshRes = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  const refreshJson = (await refreshRes.json()) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };

  if (!refreshRes.ok || !refreshJson.access_token) {
    const errText = refreshJson.error_description || refreshJson.error || 'Token refresh failed';
    if (refreshRes.status === 400 || refreshRes.status === 401 || refreshJson.error === 'invalid_grant') {
      markConnectionRevoked(workspaceId, errText);
    } else {
      db.prepare('UPDATE gmail_connections SET last_error = ?, updated_at = ? WHERE workspace_id = ?').run(
        errText,
        new Date().toISOString(),
        workspaceId,
      );
    }
    throw new Error(`Gmail token refresh failed: ${errText}`);
  }

  const encryptedNewAccess = encryptSecret(refreshJson.access_token);
  const newExpiresAt = new Date(
    Date.now() + (typeof refreshJson.expires_in === 'number' ? refreshJson.expires_in : 3600) * 1000,
  ).toISOString();

  db.prepare(`
    UPDATE gmail_connections
    SET encrypted_access_token = ?, token_expires_at = ?, last_error = NULL, updated_at = ?
    WHERE workspace_id = ?
  `).run(encryptedNewAccess, newExpiresAt, new Date().toISOString(), workspaceId);

  return {
    accessToken: refreshJson.access_token,
    googleEmail,
    historyId,
  };
}

export async function disconnectGmail(
  workspaceId: string,
  actorName: string,
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  assertPersonalWorkspace(workspaceId);
  const row = db
    .prepare('SELECT * FROM gmail_connections WHERE workspace_id = ?')
    .get(workspaceId) as Record<string, unknown> | undefined;

  if (row) {
    let tokenToRevoke: string | null = null;
    try {
      if (row.encrypted_refresh_token) {
        tokenToRevoke = decryptSecret(String(row.encrypted_refresh_token));
      } else if (row.encrypted_access_token) {
        tokenToRevoke = decryptSecret(String(row.encrypted_access_token));
      }
    } catch {
      tokenToRevoke = null;
    }

    if (tokenToRevoke) {
      try {
        await fetchImpl('https://oauth2.googleapis.com/revoke', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: tokenToRevoke }),
        });
      } catch {
        // Proceed with local scrub even if upstream revoke network call fails
      }
    }
  }

  const now = new Date().toISOString();
  const prevEmail = row?.google_email ? String(row.google_email) : 'Gmail Account';

  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE gmail_connections
      SET status = 'DISCONNECTED', google_email = NULL, scopes_json = '[]',
          encrypted_access_token = NULL, encrypted_refresh_token = NULL,
          token_expires_at = NULL, history_id = NULL, last_error = NULL, updated_at = ?
      WHERE workspace_id = ?
    `).run(now, workspaceId);

    db.prepare(`
      UPDATE integrations
      SET status = 'DISCONNECTED', granted_scopes_json = '[]'
      WHERE workspace_id = ? AND service_key = 'gmail'
    `).run(workspaceId);

    recordAuditLog(workspaceId, {
      actionType: 'GMAIL_DISCONNECTED',
      targetLabel: prevEmail,
      status: 'SYSTEM',
      executionMode: 'LOCAL_WORKSPACE',
      summary: `Disconnected Gmail integration for ${prevEmail} and cleared encrypted tokens.`,
      details: { workspaceId },
      actor: actorName,
    });
  });

  tx();
}

function decodeBase64Url(data: string): string {
  const normalized = data.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized, 'base64').toString('utf8');
}

/**
 * Safely converts raw HTML email content into clean plain text without executing or preserving active markup.
 */
export function stripHtmlToSafeText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6])\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

interface GmailPayloadPart {
  mimeType?: string;
  filename?: string;
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: GmailPayloadPart[];
  headers?: Array<{ name?: string; value?: string }>;
}

/**
 * Traverses Gmail MIME parts without downloading attachments.
 * Prefers text/plain; falls back to stripped plain text from text/html.
 */
export function extractSafePlainBody(payload?: GmailPayloadPart): string {
  if (!payload) return '';
  const plainChunks: string[] = [];
  const htmlChunks: string[] = [];

  const visit = (part: GmailPayloadPart) => {
    // Never fetch or decode binary/file attachments
    if (part.filename && part.filename.length > 0) return;
    if (part.body?.attachmentId) return;

    const mime = (part.mimeType ?? '').toLowerCase();
    if (mime === 'text/plain' && part.body?.data) {
      plainChunks.push(decodeBase64Url(part.body.data));
    } else if (mime === 'text/html' && part.body?.data) {
      htmlChunks.push(stripHtmlToSafeText(decodeBase64Url(part.body.data)));
    }
    if (Array.isArray(part.parts)) {
      for (const child of part.parts) visit(child);
    }
  };

  visit(payload);
  const chosen = plainChunks.length > 0 ? plainChunks.join('\n\n') : htmlChunks.join('\n\n');
  return chosen.trim().slice(0, MAX_BODY_CHARS);
}

function getHeader(headers: Array<{ name?: string; value?: string }> | undefined, key: string): string {
  if (!headers) return '';
  const found = headers.find((h) => (h.name ?? '').toLowerCase() === key.toLowerCase());
  return (found?.value ?? '').trim();
}

async function gmailApiGet<T>(
  workspaceId: string,
  url: string,
  fetchImpl: FetchLike,
): Promise<{ status: number; data: T }> {
  let tokenState = await getValidGmailAccessToken(workspaceId, fetchImpl, false);
  let res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${tokenState.accessToken}` },
  });

  if (res.status === 401) {
    tokenState = await getValidGmailAccessToken(workspaceId, fetchImpl, true);
    res = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${tokenState.accessToken}` },
    });
    if (res.status === 401) {
      markConnectionRevoked(workspaceId, 'Gmail rejected authorization token (401).');
      throw new Error('Gmail authorization expired or was revoked. Please reconnect.');
    }
  }

  const text = await res.text();
  let json: unknown = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = {};
  }
  return { status: res.status, data: json as T };
}

export async function syncGmailMessages(
  workspaceId: string,
  actorName: string,
  options?: {
    maxMessages?: number;
    query?: string;
    fetchImpl?: FetchLike;
    geminiCaller?: GeminiGenerateFn;
    awaitExtraction?: boolean;
    extractionController?: ExtractionQueueController;
  },
): Promise<GmailSyncResult> {
  assertPersonalWorkspace(workspaceId);
  const fetchImpl = options?.fetchImpl ?? fetch;
  const maxMessages = Math.min(Math.max(options?.maxMessages ?? DEFAULT_SYNC_BATCH, 1), MAX_SYNC_BATCH);
  const searchQuery = options?.query?.trim() || 'in:inbox';

  const conn = await getValidGmailAccessToken(workspaceId, fetchImpl, false);

  let syncMode: GmailSyncResult['syncMode'] = 'MESSAGE_LIST';
  const candidateIds: string[] = [];

  // Attempt incremental sync when we have an existing historyId baseline
  if (conn.historyId) {
    let pageToken: string | undefined;
    let historyExpired = false;
    do {
      const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/history');
      url.searchParams.set('startHistoryId', conn.historyId);
      url.searchParams.set('historyTypes', 'messageAdded');
      if (pageToken) url.searchParams.set('pageToken', pageToken);

      const histRes = await gmailApiGet<{
        history?: Array<{ messagesAdded?: Array<{ message?: { id?: string } }> }>;
        nextPageToken?: string;
        historyId?: string;
        error?: { message?: string };
      }>(workspaceId, url.toString(), fetchImpl);

      if (histRes.status === 404) {
        historyExpired = true;
        break;
      }
      if (histRes.status >= 400) {
        throw new Error(histRes.data.error?.message || `Gmail history sync failed (${histRes.status})`);
      }

      syncMode = 'HISTORY_INCREMENTAL';
      for (const h of histRes.data.history ?? []) {
        for (const ma of h.messagesAdded ?? []) {
          if (ma.message?.id && !candidateIds.includes(ma.message.id)) {
            candidateIds.push(ma.message.id);
          }
        }
      }
      pageToken = histRes.data.nextPageToken;
    } while (pageToken && candidateIds.length < maxMessages);

    if (historyExpired) {
      candidateIds.length = 0;
      syncMode = 'MESSAGE_LIST';
    }
  }

  // Initial or fallback paginated message listing
  if (syncMode === 'MESSAGE_LIST') {
    let pageToken: string | undefined;
    do {
      const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
      url.searchParams.set('maxResults', String(Math.min(10, maxMessages - candidateIds.length)));
      url.searchParams.set('q', searchQuery);
      if (pageToken) url.searchParams.set('pageToken', pageToken);

      const listRes = await gmailApiGet<{
        messages?: Array<{ id?: string }>;
        nextPageToken?: string;
        error?: { message?: string };
      }>(workspaceId, url.toString(), fetchImpl);

      if (listRes.status >= 400) {
        throw new Error(listRes.data.error?.message || `Gmail message list failed (${listRes.status})`);
      }

      for (const m of listRes.data.messages ?? []) {
        if (m.id && !candidateIds.includes(m.id)) {
          candidateIds.push(m.id);
        }
      }
      pageToken = listRes.data.nextPageToken;
    } while (pageToken && candidateIds.length < maxMessages);
  }

  // Refresh latest historyId from profile for incremental future syncs
  let latestHistoryId = conn.historyId;
  const profileRes = await gmailApiGet<{ historyId?: string }>(
    workspaceId,
    'https://gmail.googleapis.com/gmail/v1/users/me/profile',
    fetchImpl,
  );
  if (profileRes.status < 400 && profileRes.data.historyId) {
    latestHistoryId = profileRes.data.historyId;
  }

  let fetchedCount = 0;
  let skippedDuplicates = 0;
  const errors: string[] = [];

  for (const gmailMsgId of candidateIds.slice(0, maxMessages)) {
    // Duplicate prevention per workspace using unique (workspace_id, gmail_message_id)
    const existing = db
      .prepare('SELECT id FROM gmail_messages WHERE workspace_id = ? AND gmail_message_id = ?')
      .get(workspaceId, gmailMsgId) as { id: string } | undefined;

    if (existing) {
      skippedDuplicates += 1;
      continue;
    }

    const msgUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(gmailMsgId)}?format=full`;
    const msgRes = await gmailApiGet<{
      id?: string;
      threadId?: string;
      historyId?: string;
      internalDate?: string;
      snippet?: string;
      payload?: GmailPayloadPart;
      error?: { message?: string };
    }>(workspaceId, msgUrl, fetchImpl);

    if (msgRes.status >= 400 || !msgRes.data.id) {
      errors.push(`Message ${gmailMsgId}: ${msgRes.data.error?.message || `HTTP ${msgRes.status}`}`);
      continue;
    }

    const headers = msgRes.data.payload?.headers;
    const subject = getHeader(headers, 'Subject') || '(No Subject)';
    const sender = getHeader(headers, 'From') || 'Unknown Sender';
    const toHeader = getHeader(headers, 'To');
    const ccHeader = getHeader(headers, 'Cc');
    const recipients = [toHeader, ccHeader]
      .filter(Boolean)
      .join(',')
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean);

    const internalMs = msgRes.data.internalDate ? Number(msgRes.data.internalDate) : Date.now();
    const receivedAt = Number.isFinite(internalMs)
      ? new Date(internalMs).toISOString()
      : new Date().toISOString();

    const bodyText = extractSafePlainBody(msgRes.data.payload) || (msgRes.data.snippet ?? '').trim();
    const snippet = (msgRes.data.snippet ?? bodyText.slice(0, 180)).trim();
    const messageRowId = `gms-${randomUUID().slice(0, 10)}`;
    const sourceRecordId = `src-gmail-${randomUUID().slice(0, 10)}`;
    const now = new Date().toISOString();

    const sourceRecord: SourceRecord = {
      id: sourceRecordId,
      workspaceId,
      sourceType: 'EMAIL',
      externalId: gmailMsgId,
      sender,
      title: subject,
      content: bodyText || snippet,
      receivedAt,
      parsedEntities: {
        gmailMessageId: gmailMsgId,
        threadId: msgRes.data.threadId ?? gmailMsgId,
        recipients,
      },
      isDemo: false,
      processed: true,
    };

    upsertSourceRecord(workspaceId, sourceRecord);

    db.prepare(`
      INSERT INTO gmail_messages (
        id, workspace_id, gmail_message_id, thread_id, history_id, sender, recipients_json,
        subject, snippet, body_text, received_at, source_record_id, extraction_status,
        extraction_error, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', NULL, ?)
    `).run(
      messageRowId,
      workspaceId,
      gmailMsgId,
      msgRes.data.threadId ?? gmailMsgId,
      msgRes.data.historyId ?? null,
      sender,
      JSON.stringify(recipients),
      subject,
      snippet,
      bodyText,
      receivedAt,
      sourceRecordId,
      now,
    );

    fetchedCount += 1;
  }

  let extractedItemsCreated = 0;
  let suggestedRelationshipsCreated = 0;

  if (options?.awaitExtraction || options?.geminiCaller || options?.extractionController) {
    const controller = options?.extractionController;
    const queueRes = controller
      ? await controller.processWorkspaceQueue(workspaceId, {
          geminiCaller: options?.geminiCaller,
          awaitRetries: options?.awaitExtraction ?? false,
        })
      : await processWorkspaceExtractionQueue(workspaceId, {
          geminiCaller: options?.geminiCaller,
          awaitRetries: options?.awaitExtraction ?? false,
        });
    extractedItemsCreated = queueRes.itemsCreated;
    suggestedRelationshipsCreated = queueRes.relationshipsCreated;
  } else {
    // Decoupled background processing: fetched emails stay persisted in SQLite even if Gemini is busy
    enqueueWorkspaceExtraction(workspaceId);
  }

  const queuedRow = db
    .prepare(`
      SELECT COUNT(*) AS cnt
      FROM gmail_messages
      WHERE workspace_id = ? AND extraction_status IN ('PENDING', 'PROCESSING', 'RETRYING')
    `)
    .get(workspaceId) as { cnt: number };
  const queuedForExtraction = Number(queuedRow?.cnt ?? 0);

  const lastSyncAt = new Date().toISOString();
  db.prepare(`
    UPDATE gmail_connections
    SET history_id = ?, last_sync_at = ?, last_error = ?, updated_at = ?
    WHERE workspace_id = ?
  `).run(latestHistoryId, lastSyncAt, errors[0] ?? null, lastSyncAt, workspaceId);

  db.prepare(`
    UPDATE integrations
    SET last_sync_at = ?
    WHERE workspace_id = ? AND service_key = 'gmail'
  `).run(lastSyncAt, workspaceId);

  recordAuditLog(workspaceId, {
    actionType: 'GMAIL_SYNC_COMPLETED',
    targetLabel: conn.googleEmail ?? 'Gmail Inbox',
    status: 'SYSTEM',
    executionMode: 'LOCAL_WORKSPACE',
    summary: `Synced ${fetchedCount} new message(s) (${skippedDuplicates} duplicate(s) skipped) via ${syncMode}; ${queuedForExtraction} queued for AI extraction, ${extractedItemsCreated} insight(s) and ${suggestedRelationshipsCreated} relationship proposal(s) staged.`,
    details: {
      fetchedCount,
      skippedDuplicates,
      queuedForExtraction,
      extractedItemsCreated,
      suggestedRelationshipsCreated,
      syncMode,
      errors,
    },
    actor: actorName,
  });

  return {
    fetchedCount,
    skippedDuplicates,
    queuedForExtraction,
    extractedItemsCreated,
    suggestedRelationshipsCreated,
    syncMode,
    lastSyncAt,
    errors,
  };
}

export function getGmailMessages(workspaceId: string): GmailMessageSummary[] {
  if (workspaceId === DEMO_WORKSPACE_ID) return [];
  const rows = db
    .prepare('SELECT * FROM gmail_messages WHERE workspace_id = ? ORDER BY received_at DESC')
    .all(workspaceId) as Record<string, unknown>[];

  return rows.map((row) => {
    const rawStatus = String(row.extraction_status ?? 'PENDING');
    const extractionStatus: ExtractionStatus =
      rawStatus === 'EXTRACTED' ? 'COMPLETED' : (rawStatus as ExtractionStatus);
    return {
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      gmailMessageId: String(row.gmail_message_id),
      threadId: String(row.thread_id),
      sender: String(row.sender),
      recipients: JSON.parse(String(row.recipients_json ?? '[]')) as string[],
      subject: String(row.subject),
      snippet: String(row.snippet ?? ''),
      bodyText: String(row.body_text ?? ''),
      receivedAt: String(row.received_at),
      sourceRecordId: row.source_record_id ? String(row.source_record_id) : null,
      extractionStatus,
      extractionError: row.extraction_error ? String(row.extraction_error) : null,
      retryCount: Number(row.retry_count ?? 0),
      maxRetries: Number(row.max_retries ?? 4),
      nextRetryAt: row.next_retry_at ? String(row.next_retry_at) : null,
      lastAttemptAt: row.last_attempt_at ? String(row.last_attempt_at) : null,
      extractedAt: row.extracted_at ? String(row.extracted_at) : null,
      createdAt: String(row.created_at),
    };
  });
}
