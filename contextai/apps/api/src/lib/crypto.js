import crypto from 'crypto';

function key() {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw || raw.length < 16) throw new Error('ENCRYPTION_KEY (min 16 chars) must be set to store integration credentials');
  return crypto.createHash('sha256').update(raw).digest();
}

export function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64')).join('.');
}

export function decrypt(payload) {
  if (!payload) return {};
  const [iv, tag, data] = payload.split('.').map((s) => Buffer.from(s, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8'));
}

export const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

export function generateKeyPair() {
  return {
    publicKey: 'pk_' + crypto.randomBytes(16).toString('hex'),
    secretKey: 'sk_' + crypto.randomBytes(32).toString('hex'),
  };
}

export function verifyHmac(secret, body, signature) {
  if (!secret || !signature) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
