import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const PLACEHOLDER_KEYS = new Set([
  '',
  'MY_32_BYTE_TOKEN_ENCRYPTION_KEY',
  'CHANGE_ME',
  'REPLACE_ME',
]);

function resolveEncryptionKey(): Buffer | null {
  const raw = process.env.TOKEN_ENCRYPTION_KEY?.trim() ?? '';
  if (PLACEHOLDER_KEYS.has(raw)) {
    return null;
  }

  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, 'hex');
  }

  try {
    const b64 = Buffer.from(raw, 'base64');
    if (b64.length === 32) {
      return b64;
    }
  } catch {
    // Fall through to SHA-256 key derivation
  }

  return createHash('sha256').update(raw, 'utf8').digest();
}

export function isTokenEncryptionConfigured(): boolean {
  return resolveEncryptionKey() !== null;
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
