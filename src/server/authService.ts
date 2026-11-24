import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { db, seedWorkspaceIntegrations } from './db.ts';
import type { AuthSessionResponse, UserProfile, WorkspaceInfo } from '../types/maya.ts';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, hashHex] = parts;
  const derived = scryptSync(password, salt, 64);
  const storedBuf = Buffer.from(hashHex, 'hex');
  if (derived.length !== storedBuf.length) return false;
  return timingSafeEqual(derived, storedBuf);
}

function hashSessionToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function createSessionForUser(user: UserProfile, workspace: WorkspaceInfo): AuthSessionResponse {
  const rawToken = randomBytes(32).toString('hex');
  const tokenHash = hashSessionToken(rawToken);
  const sessionId = `ses-${randomUUID().slice(0, 12)}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);

  db.prepare(`
    INSERT INTO sessions (id, token_hash, user_id, workspace_id, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(sessionId, tokenHash, user.id, workspace.id, now.toISOString(), expiresAt.toISOString());

  return { token: rawToken, user, workspace };
}

export function registerUser(input: {
  email: string;
  password: string;
  displayName?: string;
}): AuthSessionResponse {
  const email = normalizeEmail(input.email);
  const password = input.password;
  const displayName = (input.displayName ?? '').trim() || email.split('@')[0] || 'maYa User';

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('Please enter a valid email address.');
  }
  if (!password || password.length < 8) {
    throw new Error('Password must be at least 8 characters long.');
  }

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email) as
    | { id: string }
    | undefined;
  if (existing) {
    throw new Error('An account with this email already exists.');
  }

  const now = new Date().toISOString();
  const userId = `usr-${randomUUID().slice(0, 12)}`;
  const workspaceId = `ws-${randomUUID().slice(0, 12)}`;
  const passwordHash = hashPassword(password);

  const user: UserProfile = {
    id: userId,
    email,
    displayName,
    createdAt: now,
  };

  const workspace: WorkspaceInfo = {
    id: workspaceId,
    ownerUserId: userId,
    name: `${displayName}'s Personal Workspace`,
    kind: 'PERSONAL',
    createdAt: now,
  };

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO users (id, email, display_name, password_hash, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(user.id, user.email, user.displayName, passwordHash, user.createdAt);

    db.prepare(`
      INSERT INTO workspaces (id, owner_user_id, name, kind, created_at)
      VALUES (?, ?, ?, 'PERSONAL', ?)
    `).run(workspace.id, workspace.ownerUserId, workspace.name, workspace.createdAt);

    seedWorkspaceIntegrations(workspace.id);

    db.prepare(`
      INSERT INTO audit_logs (
        id, workspace_id, approval_id, action_type, target_label, status, execution_mode,
        summary, details_json, actor, timestamp
      ) VALUES (?, ?, NULL, ?, ?, 'SYSTEM', 'INTERNAL', ?, ?, ?, ?)
    `).run(
      `audit-${randomUUID().slice(0, 8)}`,
      workspace.id,
      'WORKSPACE_CREATED',
      workspace.name,
      'Initialized empty private personal workspace with zero demo records.',
      JSON.stringify({ workspaceId: workspace.id, ownerUserId: user.id }),
      displayName,
      now,
    );
  });

  tx();
  return createSessionForUser(user, workspace);
}

export function loginUser(input: { email: string; password: string }): AuthSessionResponse {
  const email = normalizeEmail(input.email);
  const password = input.password;

  if (!email || !password) {
    throw new Error('Email and password are required.');
  }

  const userRow = db.prepare('SELECT * FROM users WHERE email = ?').get(email) as
    | Record<string, unknown>
    | undefined;

  if (!userRow || !verifyPassword(password, String(userRow.password_hash))) {
    throw new Error('Invalid email or password.');
  }

  const user: UserProfile = {
    id: String(userRow.id),
    email: String(userRow.email),
    displayName: String(userRow.display_name),
    createdAt: String(userRow.created_at),
  };

  const wsRow = db
    .prepare("SELECT * FROM workspaces WHERE owner_user_id = ? AND kind = 'PERSONAL' LIMIT 1")
    .get(user.id) as Record<string, unknown> | undefined;

  if (!wsRow) {
    throw new Error('Personal workspace not found for this account.');
  }

  const workspace: WorkspaceInfo = {
    id: String(wsRow.id),
    ownerUserId: String(wsRow.owner_user_id),
    name: String(wsRow.name),
    kind: 'PERSONAL',
    createdAt: String(wsRow.created_at),
  };

  return createSessionForUser(user, workspace);
}

export function verifySessionToken(
  rawToken: string | undefined,
): { user: UserProfile; workspace: WorkspaceInfo } | null {
  if (!rawToken) return null;
  const tokenHash = hashSessionToken(rawToken);
  const nowIso = new Date().toISOString();

  const row = db
    .prepare(`
      SELECT
        u.id AS u_id, u.email AS u_email, u.display_name AS u_name, u.created_at AS u_created,
        w.id AS w_id, w.owner_user_id AS w_owner, w.name AS w_name, w.kind AS w_kind, w.created_at AS w_created,
        s.expires_at AS s_expires
      FROM sessions s
      JOIN users u ON s.user_id = u.id
      JOIN workspaces w ON s.workspace_id = w.id
      WHERE s.token_hash = ? AND w.kind = 'PERSONAL' AND w.owner_user_id = u.id
    `)
    .get(tokenHash) as Record<string, unknown> | undefined;

  if (!row) return null;
  if (String(row.s_expires) <= nowIso) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
    return null;
  }

  return {
    user: {
      id: String(row.u_id),
      email: String(row.u_email),
      displayName: String(row.u_name),
      createdAt: String(row.u_created),
    },
    workspace: {
      id: String(row.w_id),
      ownerUserId: String(row.w_owner),
      name: String(row.w_name),
      kind: 'PERSONAL',
      createdAt: String(row.w_created),
    },
  };
}

export function revokeSessionToken(rawToken: string | undefined): void {
  if (!rawToken) return;
  const tokenHash = hashSessionToken(rawToken);
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
}
