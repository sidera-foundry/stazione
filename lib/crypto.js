import crypto from 'node:crypto';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';

// OWASP Password Storage Cheat Sheet: Argon2id, m=19 MiB, t=2, p=1 (+ pepper kept outside the DB).
const ARGON2ID = 2;
const ARGON_OPTS = { algorithm: ARGON2ID, memoryCost: 19456, timeCost: 2, parallelism: 1 };

function keyFromEnv(name) {
  const raw = process.env[name];
  const key = raw ? Buffer.from(raw, 'base64') : null;
  if (!key || key.length < 32) throw new Error(`${name} is missing or shorter than 32 bytes`);
  return key;
}

const pepper = () => keyFromEnv('PASSWORD_PEPPER');
const dataKey = () => keyFromEnv('DATA_ENCRYPTION_KEY').subarray(0, 32);

export function assertSecretsConfigured() {
  pepper();
  dataKey();
}

/** Hash a password or recovery phrase (NFKC-normalized so Unicode input is stable). */
export async function hashSecret(plain) {
  return argonHash(plain.normalize('NFKC'), { ...ARGON_OPTS, secret: pepper() });
}

export async function verifySecret(stored, plain) {
  if (!stored) return false;
  try {
    return await argonVerify(stored, plain.normalize('NFKC'), { secret: pepper() });
  } catch {
    return false;
  }
}

let dummyHash = null;
/** Burn the same time as a real verification when the account does not exist. */
export async function verifyDummy(plain) {
  if (!dummyHash) dummyHash = await hashSecret(crypto.randomBytes(16).toString('hex'));
  await verifySecret(dummyHash, plain);
  return false;
}

export const randomToken = (prefix = '', bytes = 32) => prefix + crypto.randomBytes(bytes).toString('base64url');
export const randomId = () => crypto.randomUUID();
export const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

/** Constant-time string comparison (hash both sides so lengths always match). */
export function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y) && String(a).length === String(b).length;
}

/** Keyed hash for IP addresses: lets us rate-limit without storing raw IPs. */
export function hashIp(ip) {
  const k = crypto.createHmac('sha256', dataKey()).update('ip-hash-v1').digest();
  return crypto.createHmac('sha256', k).update(String(ip || 'unknown')).digest('hex').slice(0, 32);
}

/** AES-256-GCM with associated data binding the ciphertext to its record. */
export function encrypt(plaintext, aad) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', dataKey(), iv);
  c.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

export function decrypt(payload, aad) {
  const [v, iv, tag, ct] = String(payload).split('.');
  if (v !== 'v1') throw new Error('Unknown ciphertext version');
  const d = crypto.createDecipheriv('aes-256-gcm', dataKey(), Buffer.from(iv, 'base64url'));
  d.setAAD(Buffer.from(aad, 'utf8'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}

/** Have I Been Pwned k-anonymity check: only the first 5 hex chars of SHA-1 leave the server. */
export async function isPwnedPassword(password) {
  if (process.env.HIBP_DISABLED === '1') return false;
  const h = crypto.createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
  try {
    const res = await fetch(`https://api.pwnedpasswords.com/range/${h.slice(0, 5)}`, {
      headers: { 'Add-Padding': 'true', 'User-Agent': 'stazione' },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const suffix = h.slice(5);
    return (await res.text()).split('\n').some((line) => {
      const [s, count] = line.trim().split(':');
      return s === suffix && Number(count) > 0;
    });
  } catch {
    return null; // service unreachable: the caller decides
  }
}
