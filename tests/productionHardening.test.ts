import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  DEMO_WORKSPACE_ID,
  db,
  initializeDatabase,
  resolveSqliteDatabaseCandidates,
} from '../src/server/db.ts';
import { registerUser, revokeSessionToken } from '../src/server/authService.ts';
import { AuthRateLimiter, getSafeClientIp } from '../src/server/authRateLimiter.ts';
import { resolveEncryptionKey } from '../src/server/cryptoService.ts';
import {
  executeApprovedAction,
  selectPlanAndQueueApprovals,
  validatePermissionForScope,
} from '../src/server/permissionsAndExecution.ts';
import { getAllAuditLogs, recordAuditLog } from '../src/server/graphService.ts';

async function main(): Promise<void> {
  initializeDatabase();

  const createdUserIds: string[] = [];
  const createdTokens: string[] = [];

  const createTestUser = (label: string) => {
    const suffix = randomUUID().slice(0, 8);
    const session = registerUser({
      email: `hardening-${label}-${suffix}@maya-test.local`,
      password: 'StrongHardeningPassword!123',
      displayName: `Hardening ${label}`,
    });
    createdUserIds.push(session.user.id);
    createdTokens.push(session.token);
    return session;
  };

  try {
    // 1. Read-only Gmail scope cannot enable compose
    {
      const user = createTestUser('ro-compose');
      const wsId = user.workspace.id;
      const now = new Date().toISOString();

      db.prepare(`
        INSERT INTO gmail_connections (
          id, workspace_id, user_id, google_email, scopes_json,
          encrypted_access_token, encrypted_refresh_token, token_expires_at,
          status, last_error, history_id, last_sync_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, 'CONNECTED', NULL, NULL, NULL, ?, ?)
      `).run(
        `gconn-${randomUUID().slice(0, 8)}`,
        wsId,
        user.user.id,
        'readonly-tester@maya-test.local',
        JSON.stringify(['https://www.googleapis.com/auth/gmail.readonly']),
        now,
        now,
      );

      const perm = validatePermissionForScope(wsId, 'gmail.compose');
      assert.equal(perm.valid, false, 'gmail.readonly must NEVER enable gmail.compose');
      assert.equal(perm.executionMode, 'UNSUPPORTED');
      assert.ok(perm.reason.includes('gmail.readonly'));
      console.log('PASS [1/7]: Read-only Gmail scope cannot enable gmail.compose');
    }

    // 2. Missing compose scope cannot execute Gmail draft creation
    {
      const user = createTestUser('no-draft-exec');
      const wsId = user.workspace.id;
      const now = new Date().toISOString();
      const analysisId = `imp-${randomUUID().slice(0, 8)}`;
      const planId = `plan-${randomUUID().slice(0, 8)}`;

      db.prepare(`
        INSERT INTO impact_analyses (
          id, workspace_id, change_event_json, direct_impacts_json, downstream_impacts_json,
          unaffected_items_json, explanation_summary, ai_narrative, ai_status, created_at
        ) VALUES (?, ?, '{}', '[]', '[]', '[]', 'Test summary', NULL, 'SKIPPED', ?)
      `).run(analysisId, wsId, now);

      db.prepare(`
        INSERT INTO what_if_plans (
          id, workspace_id, analysis_id, option_key, title, strategy_summary,
          proposed_changes_json, tasks_affected_json, meetings_affected_json,
          potential_conflicts_json, advantages_json, tradeoffs_json, requires_confirmation_json, status
        ) VALUES (?, ?, ?, 'B', 'Option B', 'Test', ?, '[]', '[]', '[]', '[]', '[]', '[]', 'PROPOSED')
      `).run(
        planId,
        wsId,
        analysisId,
        JSON.stringify([
          {
            actionType: 'SEND_NOTIFICATION_DRAFT',
            targetNodeId: 'person-1',
            targetTitle: 'Notify stakeholders',
            field: 'notification',
            beforeValue: 'None',
            afterValue: 'Draft update',
            permissionScope: 'gmail.compose',
            requiresConfirmation: true,
            rationale: 'Notify stakeholders',
          },
        ]),
      );

      const approvals = selectPlanAndQueueApprovals(wsId, planId, user.user.displayName);
      assert.equal(approvals.length, 1);
      assert.equal(approvals[0].permissionValid, false);
      assert.equal(approvals[0].executionMode, 'UNSUPPORTED');

      assert.throws(
        () => executeApprovedAction(wsId, approvals[0].id, 'Attempt execute', user.user.displayName),
        /Permission check failed/i,
      );
      console.log('PASS [2/7]: Missing compose scope cannot execute SEND_NOTIFICATION_DRAFT');
    }

    // 3. Simulated actions in DEMO mode are explicitly classified SIMULATED_DEMO and never reported as Gmail execution
    {
      const now = new Date().toISOString();
      const analysisId = `imp-demo-${randomUUID().slice(0, 8)}`;
      const planId = `plan-demo-${randomUUID().slice(0, 8)}`;

      db.prepare(`
        INSERT INTO impact_analyses (
          id, workspace_id, change_event_json, direct_impacts_json, downstream_impacts_json,
          unaffected_items_json, explanation_summary, ai_narrative, ai_status, created_at
        ) VALUES (?, ?, '{}', '[]', '[]', '[]', 'Demo summary', NULL, 'SKIPPED', ?)
      `).run(analysisId, DEMO_WORKSPACE_ID, now);

      db.prepare(`
        INSERT INTO what_if_plans (
          id, workspace_id, analysis_id, option_key, title, strategy_summary,
          proposed_changes_json, tasks_affected_json, meetings_affected_json,
          potential_conflicts_json, advantages_json, tradeoffs_json, requires_confirmation_json, status
        ) VALUES (?, ?, ?, 'B', 'Demo Option B', 'Test', ?, '[]', '[]', '[]', '[]', '[]', '[]', 'PROPOSED')
      `).run(
        planId,
        DEMO_WORKSPACE_ID,
        analysisId,
        JSON.stringify([
          {
            actionType: 'SEND_NOTIFICATION_DRAFT',
            targetNodeId: 'person-ananya',
            targetTitle: 'Notify Ananya Rao',
            field: 'notification',
            beforeValue: 'None',
            afterValue: 'Simulated draft',
            permissionScope: 'gmail.compose',
            requiresConfirmation: true,
            rationale: 'Demo notification',
          },
        ]),
      );

      const approvals = selectPlanAndQueueApprovals(DEMO_WORKSPACE_ID, planId, 'Demo Presenter');
      assert.equal(approvals[0].executionMode, 'SIMULATED_DEMO');
      const executed = executeApprovedAction(
        DEMO_WORKSPACE_ID,
        approvals[0].id,
        undefined,
        'Demo Presenter',
      );
      assert.equal(executed.executionMode, 'SIMULATED_DEMO');
      const logs = getAllAuditLogs(DEMO_WORKSPACE_ID);
      const match = logs.find((l) => l.approvalId === executed.id);
      assert.ok(match);
      assert.ok(match.summary.includes('Simulated notification draft only'));
      assert.ok(match.summary.includes('no email sent or drafted in Gmail'));

      // Clean up synthetic demo test rows
      db.prepare('DELETE FROM approvals WHERE id = ?').run(executed.id);
      db.prepare('DELETE FROM what_if_plans WHERE id = ?').run(planId);
      db.prepare('DELETE FROM impact_analyses WHERE id = ?').run(analysisId);
      db.prepare('DELETE FROM audit_logs WHERE approval_id = ?').run(executed.id);
      recordAuditLog(DEMO_WORKSPACE_ID, {
        actionType: 'TEST_CLEANUP',
        targetLabel: 'Demo test cleanup',
        status: 'SYSTEM',
        executionMode: 'INTERNAL',
        summary: 'Cleaned synthetic demo approval test row.',
        actor: 'Test Suite',
      });
      console.log('PASS [3/7]: Simulated actions are labeled SIMULATED_DEMO and never claim real Gmail execution');
    }

    // 4 & 5. HttpOnly cookie session recovery on /api/auth/me, CSRF protection, and unauthorized access rejection
    {
      const baseUrl = 'http://127.0.0.1:3000';
      const unauthMe = await fetch(`${baseUrl}/api/auth/me`);
      assert.equal(unauthMe.status, 401, 'Unauthenticated /api/auth/me must return 401');

      const email = `cookie-test-${randomUUID().slice(0, 8)}@maya-test.local`;
      const regRes = await fetch(`${baseUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          password: 'CookieTestPassword!123',
          displayName: 'Cookie Tester',
        }),
      });
      assert.equal(regRes.status, 201);
      const regJson = (await regRes.json()) as { user: { id: string; email: string } };
      createdUserIds.push(regJson.user.id);

      const setCookies = regRes.headers.getSetCookie();
      const sessionCookie = setCookies.find((c) => c.startsWith('maya_session='));
      const csrfCookie = setCookies.find((c) => c.startsWith('maya_csrf='));
      assert.ok(sessionCookie, 'Register must set maya_session cookie');
      assert.ok(sessionCookie.includes('HttpOnly'), 'maya_session must be HttpOnly');
      assert.ok(sessionCookie.includes('SameSite=Lax'), 'maya_session must set SameSite=Lax');
      assert.ok(csrfCookie, 'Register must set maya_csrf cookie');

      const sessionPair = sessionCookie.split(';')[0];
      const csrfPair = csrfCookie.split(';')[0];
      const csrfValue = csrfPair.split('=')[1];
      const cookieHeader = `${sessionPair}; ${csrfPair}`;

      // Simulate browser refresh: call /api/auth/me with cookie only (no Authorization header)
      const meRes = await fetch(`${baseUrl}/api/auth/me`, {
        headers: { Cookie: cookieHeader },
      });
      assert.equal(meRes.status, 200, 'Browser refresh /api/auth/me with cookie must succeed');
      const meJson = (await meRes.json()) as { user: { email: string } };
      assert.equal(meJson.user.email, email);

      // Cookie-authenticated POST without X-CSRF-Token must fail with 403
      const noCsrfPost = await fetch(`${baseUrl}/api/graph/nodes`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookieHeader,
        },
        body: JSON.stringify({ type: 'TASK', title: 'Should be blocked by CSRF' }),
      });
      assert.equal(noCsrfPost.status, 403, 'Cookie-authenticated mutation without X-CSRF-Token must be 403');

      // Cookie-authenticated POST with valid X-CSRF-Token must succeed
      const withCsrfPost = await fetch(`${baseUrl}/api/graph/nodes`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookieHeader,
          'X-CSRF-Token': csrfValue,
        },
        body: JSON.stringify({ type: 'TASK', title: 'CSRF-verified task' }),
      });
      assert.equal(withCsrfPost.status, 201, 'Cookie-authenticated mutation with valid X-CSRF-Token must succeed');
      const createdNode = (await withCsrfPost.json()) as { id: string };
      db.prepare('DELETE FROM nodes WHERE id = ?').run(createdNode.id);

      // Logout revokes session and subsequent /api/auth/me returns 401
      const logoutRes = await fetch(`${baseUrl}/api/auth/logout`, {
        method: 'POST',
        headers: {
          Cookie: cookieHeader,
          'X-CSRF-Token': csrfValue,
        },
      });
      assert.equal(logoutRes.status, 200);

      const postLogoutMe = await fetch(`${baseUrl}/api/auth/me`, {
        headers: { Cookie: cookieHeader },
      });
      assert.equal(postLogoutMe.status, 401, 'Revoked session cookie must return 401');
      console.log('PASS [4/7]: Cookie session recovery on /api/auth/me + CSRF protection + logout revocation');

      // Cross-workspace unauthorized access check
      const userB = createTestUser('unauth-b');
      const userA = createTestUser('unauth-a');
      const nodeRes = await fetch(`${baseUrl}/api/graph/nodes`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userB.token}`,
        },
        body: JSON.stringify({ type: 'PROJECT', title: 'User B Secret Project' }),
      });
      assert.equal(nodeRes.status, 201);
      const bNode = (await nodeRes.json()) as { id: string };

      const crossDelete = await fetch(`${baseUrl}/api/graph/nodes/${bNode.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${userA.token}` },
      });
      assert.equal(crossDelete.status, 404, 'User A must not delete User B node');
      db.prepare('DELETE FROM nodes WHERE id = ?').run(bNode.id);
      console.log('PASS [5/7]: Unauthorized and cross-workspace access rejected');
    }

    // 6. Production database path failure stops startup (no silent os.tmpdir() fallback)
    {
      const invalidProdPath = path.join('Z:\\nonexistent_maya_dir_xyz', 'prod.db');
      const prodResolved = resolveSqliteDatabaseCandidates({
        configuredPath: invalidProdPath,
        nodeEnv: 'production',
      });
      assert.equal(prodResolved.allowTempFallback, false);
      assert.deepEqual(prodResolved.candidates, [path.resolve(invalidProdPath)]);

      const prodDefaultResolved = resolveSqliteDatabaseCandidates({
        configuredPath: '',
        nodeEnv: 'production',
        cwd: 'Z:\\nonexistent_maya_cwd_xyz',
      });
      assert.equal(prodDefaultResolved.allowTempFallback, false);
      assert.equal(prodDefaultResolved.candidates.length, 1);

      let threwOnStartup = false;
      try {
        execFileSync(
          'npx',
          ['tsx', '-e', "import './src/server/db.ts';"],
          {
            cwd: process.cwd(),
            env: {
              ...process.env,
              NODE_ENV: 'production',
              MAYA_DB_PATH: invalidProdPath,
            },
            shell: true,
            stdio: 'pipe',
          },
        );
      } catch {
        threwOnStartup = true;
      }
      assert.equal(threwOnStartup, true, 'Production startup must fail explicitly on invalid MAYA_DB_PATH');
      console.log('PASS [6/7]: Production invalid MAYA_DB_PATH stops startup without os.tmpdir() fallback');
    }

    // 7. Development behavior remains compatible (allows documented dev-only fallback when MAYA_DB_PATH unset)
    {
      const devResolved = resolveSqliteDatabaseCandidates({
        configuredPath: '',
        nodeEnv: 'development',
        cwd: process.cwd(),
      });
      assert.equal(devResolved.allowTempFallback, true);
      assert.equal(devResolved.candidates.length, 2);
      console.log('PASS [7/12]: Development SQLite fallback remains compatible');
    }

    // 8. TOKEN_ENCRYPTION_KEY validation (strict 32-byte hex/base64, rejects weak/placeholder/malformed)
    {
      const validHex = randomBytes(32).toString('hex');
      const validB64 = randomBytes(32).toString('base64');
      assert.equal(resolveEncryptionKey(validHex)?.length, 32);
      assert.equal(resolveEncryptionKey(validB64)?.length, 32);

      for (const bad of [
        '',
        'MY_32_BYTE_TOKEN_ENCRYPTION_KEY',
        'CHANGE_ME',
        'short-weak-passphrase',
        'a'.repeat(63),
        'g'.repeat(64),
        randomBytes(16).toString('base64'),
        'not-canonical-base64-with-32-bytes-if-decoded!!',
      ]) {
        assert.equal(resolveEncryptionKey(bad), null, `Must reject weak/malformed key: ${bad.slice(0, 12)}`);
      }

      let prodStartupFailed = false;
      try {
        execFileSync(
          process.execPath,
          ['node_modules/tsx/dist/cli.mjs', '-e', "import { assertProductionEncryptionKeyConfigured } from './src/server/cryptoService.ts'; assertProductionEncryptionKeyConfigured();"],
          {
            cwd: process.cwd(),
            env: { ...process.env, NODE_ENV: 'production', TOKEN_ENCRYPTION_KEY: 'weak-arbitrary-string' },
            stdio: 'pipe',
          },
        );
      } catch {
        prodStartupFailed = true;
      }
      assert.equal(prodStartupFailed, true, 'Production startup check must reject weak TOKEN_ENCRYPTION_KEY');
      console.log('PASS [8/12]: TOKEN_ENCRYPTION_KEY strict 32-byte validation & production startup rejection');
    }

    // 9. AuthRateLimiter & safe client IP resolution
    {
      let now = 1_700_000_000_000;
      const limiter = new AuthRateLimiter({ windowMs: 60_000, maxRequests: 2, nowFn: () => now });
      assert.equal(limiter.consume('login:1.2.3.4').allowed, true);
      assert.equal(limiter.consume('login:1.2.3.4').allowed, true);
      const blocked = limiter.consume('login:1.2.3.4');
      assert.equal(blocked.allowed, false);
      assert.ok(blocked.retryAfterSeconds >= 1);

      now += 61_000;
      assert.equal(limiter.consume('login:1.2.3.4').allowed, true, 'Window expiry must reset quota');

      const prevTrust = process.env.TRUST_PROXY;
      try {
        delete process.env.TRUST_PROXY;
        assert.equal(
          getSafeClientIp({ ip: '9.9.9.9', socket: { remoteAddress: '::ffff:127.0.0.1' } as never }),
          '127.0.0.1',
          'Must ignore forwarded req.ip when TRUST_PROXY is not enabled',
        );
        process.env.TRUST_PROXY = 'true';
        assert.equal(
          getSafeClientIp({ ip: '9.9.9.9', socket: { remoteAddress: '::ffff:127.0.0.1' } as never }),
          '9.9.9.9',
        );
      } finally {
        if (prevTrust === undefined) delete process.env.TRUST_PROXY;
        else process.env.TRUST_PROXY = prevTrust;
      }
      console.log('PASS [9/12]: AuthRateLimiter sliding window and safe client IP resolution');
    }

    // 10. Live HTTP /api/auth/login rate limiting (429 + Retry-After, no email enumeration)
    {
      const baseUrl = 'http://127.0.0.1:3000';
      const maxAttempts = Number(process.env.AUTH_LOGIN_MAX_ATTEMPTS ?? 12) || 12;
      let got429 = false;
      let retryAfterHeader = '';
      for (let i = 0; i <= maxAttempts + 2; i += 1) {
        const res = await fetch(`${baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: `nonexistent-${i}@maya-test.local`,
            password: 'WrongPassword!123',
          }),
        });
        if (res.status === 429) {
          got429 = true;
          retryAfterHeader = res.headers.get('retry-after') ?? '';
          const body = (await res.json()) as { error: string };
          assert.ok(body.error.includes('Too many'));
          assert.equal(body.error.includes('@'), false, '429 response must not leak email');
          break;
        }
      }
      assert.equal(got429, true, 'Repeated login attempts must trigger HTTP 429');
      assert.ok(Number(retryAfterHeader) >= 1, '429 response must include Retry-After header');
      console.log('PASS [10/12]: Live /api/auth/login rate limiting enforces HTTP 429');
    }

    // 11. HTTP security headers
    {
      const res = await fetch('http://127.0.0.1:3000/api/demo/dashboard');
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
      assert.equal(res.headers.get('x-frame-options'), 'DENY');
      assert.ok(res.headers.get('permissions-policy')?.includes('camera=()'));
      const csp = res.headers.get('content-security-policy') ?? '';
      assert.ok(csp.includes("default-src 'self'"));
      assert.ok(csp.includes('https://accounts.google.com/gsi/client'));
      assert.ok(csp.includes("frame-ancestors 'none'"));
      assert.equal(res.headers.get('x-powered-by'), null);
      console.log('PASS [11/12]: HTTP security headers verified');
    }

    // 12. GET /healthz verifies SQLite connectivity without leaking details
    {
      const res = await fetch('http://127.0.0.1:3000/healthz');
      assert.equal(res.status, 200);
      const body = (await res.json()) as Record<string, unknown>;
      assert.deepEqual(body, { status: 'ok', database: 'ok' });
      console.log('PASS [12/13]: GET /healthz returns minimal ok status');
    }

    // 13. Malformed JSON returns clean 400 JSON + DEMO workflow endpoints work end-to-end
    {
      const badJsonRes = await fetch('http://127.0.0.1:3000/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{bad-json',
      });
      assert.equal(badJsonRes.status, 400);
      const badJsonBody = (await badJsonRes.json()) as { error: string };
      assert.equal(badJsonBody.error, 'Invalid JSON request body.');

      const demoRun = await fetch('http://127.0.0.1:3000/api/demo/run', { method: 'POST' });
      assert.equal(demoRun.status, 200);
      const demoData = (await demoRun.json()) as {
        analysis: { directImpacts: unknown[]; downstreamImpacts: unknown[] };
        plans: unknown[];
      };
      assert.ok(demoData.analysis.directImpacts.length >= 1);
      assert.equal(demoData.plans.length, 2);

      const demoReset = await fetch('http://127.0.0.1:3000/api/demo/reset', { method: 'POST' });
      assert.equal(demoReset.status, 200);
      console.log('PASS [13/13]: Malformed JSON error handler and DEMO workflow HTTP endpoints verified');
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
  }
}

main().catch((err) => {
  console.error('PRODUCTION HARDENING TEST SUITE FAILED:', err);
  process.exit(1);
});
