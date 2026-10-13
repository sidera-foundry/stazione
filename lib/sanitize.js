// Remove format/invisible characters without changing ordinary Unicode text or credentials.
const INVISIBLE = /[\p{Cf}\u034f\u115f\u1160\u17b4\u17b5\u180b-\u180d\u2065\u3164\ufe00-\ufe0f\uffa0\u{e0100}-\u{e01ef}]/gu;
export const sanitizeText = (text) => String(text ?? '').replace(/\r\n?/g, '\n').replace(INVISIBLE, '');

// Explicit free-text keys: passwords, TOTP codes, tokens, recovery phrases and invite codes are untouched.
export const TEXT_FIELDS = new Set(['text', 'title', 'detail', 'summary', 'checkpoint', 'note', 'reason', 'goal',
  'name', 'activity', 'host', 'project', 'answer', 'question', 'body', 'preview', 'options', 'milestones', 'resources',
  'context', 'opinion', 'option', 'milestone', 'label', 'subject']);
export function sanitizeContent(value, field = '') {
  if (typeof value === 'string') return TEXT_FIELDS.has(field) ? sanitizeText(value) : value;
  if (Array.isArray(value)) return value.map((v) => sanitizeContent(v, field));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitizeContent(v, k)]));
  return value;
}

export function textLimit(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isInteger(v) && v > 0 && v <= 20000 ? v : fallback;
}
