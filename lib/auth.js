import { TOTP, Secret } from 'otpauth';
import QRCode from 'qrcode';
import { fail, parseCookies } from './http.js';
import { randomToken, sha256, isPwnedPassword, decrypt } from './crypto.js';

export const COOKIE_SESSION = '__Host-stz_s';
export const COOKIE_PENDING = '__Host-stz_p';

export const SESSION_IDLE_MS = 12 * 3600e3;
export const SESSION_ABSOLUTE_MS = 7 * 86400e3;
export const PENDING_MS = { reg: 15 * 60e3, recover: 15 * 60e3, mfa: 5 * 60e3, device: 15 * 60e3 };
export const MAX_PENDING_ATTEMPTS = 5;

export const maxUsers = () => {
  const n = Number(process.env.MAX_USERS || 2);
  return Number.isInteger(n) && n > 0 ? n : 2;
};

// ---------- audit + rate limiting ----------

export function audit(q, ctx, event, userId = null, detail = null) {
  // Persisted after the request transaction, so failures are logged even when it rolls back.
  ctx.persist('insert into audit_log (user_id, event, detail, ip_hash, at) values ($1, $2, $3, $4, $5)', [
    userId, event, detail ? JSON.stringify(detail) : null, ctx.ipHash, ctx.now,
  ]);
}

export async function isLimited(q, key, limit, windowMs, now) {
  const [r] = await q.query('select count(*)::int as n from auth_attempts where key = $1 and at > $2', [key, now - windowMs]);
  return r.n >= limit;
}

export const recordAttempt = (ctx, key) => ctx.persist('insert into auth_attempts (key, at) values ($1, $2)', [key, ctx.now]);
export const clearAttempts = (q, key) => q.query('delete from auth_attempts where key = $1', [key]);

export async function enforceLimits(q, ctx, rules) {
  for (const [key, limit, windowMs] of rules) {
    if (await isLimited(q, key, limit, windowMs, ctx.now)) {
      audit(q, ctx, 'rate_limited', null, { key: key.split(':').slice(0, 2).join(':') });
      fail(429, 'Too many attempts. Try again in a few minutes.');
    }
  }
}

// ---------- password policy (OWASP ASVS / NIST 800-63B) ----------

export async function checkPasswordPolicy(password, username) {
  if (typeof password !== 'string') fail(400, 'Invalid password');
  const pw = password.normalize('NFKC');
  if ([...pw].length < 12) fail(400, 'The password needs at least 12 characters');
  if ([...pw].length > 128) fail(400, 'The password can have at most 128 characters');
  if (username && pw.toLowerCase().includes(username.toLowerCase())) fail(400, 'The password cannot contain the username');
  const pwned = await isPwnedPassword(pw);
  if (pwned === true) fail(400, 'This password appears in known data breaches: choose another one');
  return pw;
}

// ---------- TOTP (Google Authenticator compatible) ----------

export const newTotpSecret = () => new Secret({ size: 20 }).base32;

const totpFor = (secretB32, label) =>
  new TOTP({ issuer: 'Stazione', label, algorithm: 'SHA1', digits: 6, period: 30, secret: Secret.fromBase32(secretB32) });

export async function totpEnrollment(secretB32, username) {
  const uri = totpFor(secretB32, username).toString();
  const svg = await QRCode.toString(uri, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  return { qr: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`, secret: secretB32 };
}

/** Returns the accepted time step, or null. Rejects steps at or before lastStep (replay protection). */
export function verifyTotp(secretB32, code, lastStep = 0) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code.trim())) return null;
  const delta = totpFor(secretB32, 'x').validate({ token: code.trim(), window: 1 });
  if (delta === null) return null;
  const step = Math.floor(Date.now() / 30000) + delta;
  return step > lastStep ? step : null;
}

export const decryptTotp = (enc, userId) => decrypt(enc, `totp:${userId}`);

// ---------- sessions ----------

export async function createSession(q, userId, kind, now) {
  const token = randomToken('', 32);
  const ttl = kind === 'session' ? SESSION_ABSOLUTE_MS : PENDING_MS[kind];
  await q.query(
    'insert into sessions (id_hash, user_id, kind, created_at, last_seen, expires_at, public_id) values ($1, $2, $3, $4, $4, $5, $6)',
    [sha256(token), userId, kind, now, now + ttl, randomToken('ss_', 16)],
  );
  return { token, maxAgeSec: Math.floor(ttl / 1000) };
}

export async function loadPending(q, ctx, kinds) {
  const token = parseCookies(ctx.headers.get('cookie'))[COOKIE_PENDING];
  if (!token) fail(401, 'Session expired: start again');
  const [row] = await q.query('select * from sessions where id_hash = $1', [sha256(token)]);
  if (!row || !kinds.includes(row.kind) || row.expires_at < ctx.now || row.attempts >= MAX_PENDING_ATTEMPTS) {
    if (row) ctx.persist('delete from sessions where id_hash = $1', [row.id_hash]);
    fail(401, 'Session expired: start again');
  }
  return row;
}

/** Resolve the caller: a human (session cookie) or a Claude (Bearer API token). */
export async function authenticate(q, ctx) {
  const auth = ctx.headers.get('authorization') || '';
  if (auth.startsWith('Bearer ')) {
    const token = auth.slice(7).trim();
    if (!/^stz_[A-Za-z0-9_-]{40,60}$/.test(token)) return null;
    const [t] = await q.query(
      `select t.id, t.user_id, t.expires_at, t.revoked_at, t.suspended_at, t.restrictions, t.last_used_at, u.username
         from api_tokens t join users u on u.id = t.user_id
        where t.token_hash = $1 and u.status = 'active'`,
      [sha256(token)],
    );
    if (!t || t.revoked_at || t.suspended_at || t.expires_at < ctx.now) return null;
    if (!t.last_used_at || ctx.now - t.last_used_at > 5 * 60e3) {
      await q.query('update api_tokens set last_used_at = $1 where id = $2', [ctx.now, t.id]);
    }
    return { type: 'claude', userId: t.user_id, username: t.username, tokenId: t.id, restrictions: t.restrictions };
  }
  const token = parseCookies(ctx.headers.get('cookie'))[COOKIE_SESSION];
  if (!token) return null;
  const [s] = await q.query(
    `select s.*, u.username from sessions s join users u on u.id = s.user_id
      where s.id_hash = $1 and s.kind = 'session' and u.status = 'active'`,
    [sha256(token)],
  );
  if (!s) return null;
  const [org] = await q.query("select settings from orgs where id='default'");
  if (org.settings.requireKnownDevice) {
    const cookie = parseCookies(ctx.headers.get('cookie'))['__Host-stz_d'];
    const [device] = cookie && s.device_id ? await q.query("select id from devices where id=$1 and user_id=$2 and cookie_hash=$3 and status='approved' and expires_at>$4", [s.device_id, s.user_id, sha256(cookie), ctx.now]) : [];
    if (!device) return null;
  }
  if (s.expires_at < ctx.now || ctx.now - s.last_seen > SESSION_IDLE_MS) {
    await q.query('delete from sessions where id_hash = $1', [s.id_hash]);
    return null;
  }
  if (ctx.now - s.last_seen > 5 * 60e3) await q.query('update sessions set last_seen = $1 where id_hash = $2', [ctx.now, s.id_hash]);
  return { type: 'human', userId: s.user_id, username: s.username, sessionHash: s.id_hash };
}
