import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const PLACEHOLDER_KEYS = new Set([
  '',
  'MY_32_BYTE_TOKEN_ENCRYPTION_KEY',
  'CHANGE_ME',
  'REPLACE_ME',
]);

function decodeStrictBase64Key(raw: string): Buffer | null {
  if (!/^[A-Za-z0-9+/]{42,44}={0,2}$/.test(raw) || raw.length % 4 !== 0) {
    return null;
  }
  const decoded = Buffer.from(raw, 'base64');
  if (decoded.length !== 32 || decoded.toString('base64') !== raw) {
    return null;
  }
  return decoded;
}

export function resolveEncryptionKey(rawOverride?: string): Buffer | null {
  const raw = (rawOverride ?? process.env.TOKEN_ENCRYPTION_KEY ?? '').trim();
  if (PLACEHOLDER_KEYS.has(raw)) {
    return null;
  }

  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, 'hex');
  }

  return decodeStrictBase64Key(raw);
}

export function isTokenEncryptionConfigured(): boolean {
  return resolveEncryptionKey() !== null;
}

export function assertProductionEncryptionKeyConfigured(): void {
  if (process.env.NODE_ENV !== 'production') return;
  if (!isTokenEncryptionConfigured()) {
    throw new Error(
      '[crypto] Fatal: TOKEN_ENCRYPTION_KEY must be configured in production as exactly 64 hex characters or a valid 32-byte base64 string.',
    );
  }
}

export function encryptSecret(plaintext: string): string {
  const key = resolveEncryptionKey();
  if (!key) {
    throw new Error(
      'TOKEN_ENCRYPTION_KEY environment variable is required to encrypt OAuth tokens at rest.',
    );
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `v1:${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptSecret(payload: string): string {
  const key = resolveEncryptionKey();
  if (!key) {
    throw new Error(
      'TOKEN_ENCRYPTION_KEY environment variable is required to decrypt stored OAuth tokens.',
    );
  }
  const parts = payload.split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('Unsupported encrypted token format.');
  }
  const [, ivHex, tagHex, dataHex] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(tagHex, 'hex');
  const ciphertext = Buffer.from(dataHex, 'hex');

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}
