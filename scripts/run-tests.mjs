import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const rootDir = process.cwd();
const tempDbPath = path.join(os.tmpdir(), `maya_test_${randomUUID().slice(0, 8)}.db`);
const testEnv = {
  ...process.env,
  MAYA_DB_PATH: tempDbPath,
  NODE_ENV: 'production',
  TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
  AUTH_LOGIN_MAX_ATTEMPTS: process.env.AUTH_LOGIN_MAX_ATTEMPTS ?? '12',
};

function cleanupTempDb() {
  for (const suffix of ['', '-shm', '-wal']) {
    const p = `${tempDbPath}${suffix}`;
    try {
      if (fs.existsSync(p)) fs.rmSync(p, { force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

async function waitForHealth(url, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // wait for server bind
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function runTsxTest(relPath) {
  const tsxCli = path.join(rootDir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const res = spawnSync(process.execPath, [tsxCli, relPath], {
    cwd: rootDir,
    env: testEnv,
    stdio: 'inherit',
  });
  return res.status ?? 1;
}

async function main() {
  cleanupTempDb();

  const serverProc = spawn(process.execPath, ['server.ts'], {
    cwd: rootDir,
    env: testEnv,
    stdio: 'inherit',
  });

  let exitCode = 1;
  try {
    const ready = await waitForHealth('http://127.0.0.1:3000/healthz');
    if (!ready) {
      console.error('[run-tests] Server did not become healthy on http://127.0.0.1:3000/healthz');
      process.exitCode = 1;
      return;
    }

    const code1 = runTsxTest('tests/productionHardening.test.ts');
    if (code1 !== 0) {
      exitCode = code1;
      return;
    }

    const code2 = runTsxTest('tests/intelligenceAndIntegrity.test.ts');
    if (code2 !== 0) {
      exitCode = code2;
      return;
    }

    const code3 = runTsxTest('tests/e2eGmailValidation.test.ts');
    if (code3 !== 0) {
      exitCode = code3;
      return;
    }

    const code4 = runTsxTest('tests/extractionPipeline.test.ts');
    exitCode = code4;
  } finally {
    if (!serverProc.killed) {
      serverProc.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 300));
    }
    cleanupTempDb();
    process.exitCode = exitCode;
  }
}

main().catch((err) => {
  console.error('[run-tests] Fatal error:', err);
  cleanupTempDb();
  process.exit(1);
});
