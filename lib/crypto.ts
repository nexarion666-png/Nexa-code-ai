const encoder = new TextEncoder();

function getSecret() {
  const secret = process.env.PROVIDER_KEY_ENCRYPTION_SECRET;
  if (!secret || secret.length < 32) throw new Error('PROVIDER_KEY_ENCRYPTION_SECRET must be at least 32 characters.');
  return secret;
}

async function keyFromSecret() {
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(getSecret()));
  return crypto.subtle.importKey('raw', hash, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

function bytesToBase64(bytes: Uint8Array) {
  return Buffer.from(bytes).toString('base64');
}

function base64ToBytes(value: string) {
  return new Uint8Array(Buffer.from(value, 'base64'));
}

export async function encryptSecret(value: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await keyFromSecret();
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(value));
  return `${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(encrypted))}`;
}

export async function decryptSecret(value: string) {
  const [ivPart, cipherPart] = value.split('.');
  if (!ivPart || !cipherPart) throw new Error('Invalid encrypted provider key.');
  const key = await keyFromSecret();
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(ivPart) }, key, base64ToBytes(cipherPart));
  return new TextDecoder().decode(plain);
}
