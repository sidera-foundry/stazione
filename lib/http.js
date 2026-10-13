import { sanitizeText, TEXT_FIELDS } from './sanitize.js';

export class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export const fail = (status, message, extra) => {
  throw new HttpError(status, message, extra);
};

// ---------- input validation (allow-lists, explicit bounds) ----------

export function str(v, name, { min = 0, max = 500, pattern, trim = true } = {}) {
  if (v == null) v = '';
  if (typeof v !== 'string') fail(400, `The field "${name}" must be text`);
  const cleaned = TEXT_FIELDS.has(name) ? sanitizeText(v) : v;
  const s = trim ? cleaned.trim() : cleaned;
  if (s.length < min) fail(400, min === 1 ? `The field "${name}" is required` : `The field "${name}" needs at least ${min} characters`);
  if (s.length > max) fail(400, `The field "${name}" exceeds ${max} characters`);
  if (pattern && s.length && !pattern.test(s)) fail(400, `The field "${name}" contains characters that are not allowed`);
  // Reject control characters except tab/newline.
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(s)) fail(400, `The field "${name}" contains control characters`);
  return s;
}

export function int(v, name, { min, max, def }) {
  if (v == null || v === '') {
    if (def !== undefined) return def;
    fail(400, `The field "${name}" is required`);
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) fail(400, `The field "${name}" must be an integer between ${min} and ${max}`);
  return n;
}

export function strList(v, name, { maxItems = 20, maxLen = 200 } = {}) {
  if (v == null) return [];
  if (typeof v === 'string') v = v.split(',');
  if (!Array.isArray(v)) fail(400, `The field "${name}" must be a list`);
  if (v.length > maxItems) fail(400, `The field "${name}" allows at most ${maxItems} items`);
  return [...new Set(v.map((x) => str(x, name, { max: maxLen })).filter(Boolean))];
}

export const oneOf = (v, name, allowed) => {
  if (!allowed.includes(v)) fail(400, `Invalid value for "${name}"`);
  return v;
};

export const INSTANCE_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
export const USERNAME_RE = /^[a-z0-9][a-z0-9_.-]{2,31}$/;
export const TASK_ID_RE = /^T-[A-Z0-9-]{3,40}$/;
export const PROJECT_MAX = 80;

// ---------- cookies ----------

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* malformed: ignored */ }
  }
  return out;
}

export const setCookie = (name, value, maxAgeSec) =>
  `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSec}`;

export const clearCookie = (name) => `${name}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

// ---------- responses ----------

export const API_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
};

export function json(status, body, cookies = []) {
  const headers = new Headers(API_HEADERS);
  for (const c of cookies) headers.append('set-cookie', c);
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers });
}
