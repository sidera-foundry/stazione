// Heuristic detector for data that must not travel between Claude instances without a human's approval.
// It errs on the side of caution: a false positive costs one tap on Telegram, a false negative leaks data.

function luhn(digits) {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

function ibanValid(raw) {
  const s = raw.replace(/\s+/g, '').toUpperCase();
  if (s.length < 15 || s.length > 34) return false;
  const moved = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const v = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of v) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem === 1;
}

function entropy(s) {
  const f = new Map();
  for (const ch of s) f.set(ch, (f.get(ch) || 0) + 1);
  let e = 0;
  for (const n of f.values()) { const p = n / s.length; e -= p * Math.log2(p); }
  return e;
}

const RULES = [
  { type: 'private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { type: 'AWS key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { type: 'GitHub token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/g },
  { type: 'API key (sk-)', re: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g },
  { type: 'Stripe key', re: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { type: 'Google key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { type: 'Slack token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { type: 'Telegram bot token', re: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g },
  { type: 'Stazione token', re: /\bstz_[A-Za-z0-9_-]{20,}/g },
  { type: 'JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { type: 'URL with credentials', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@[^\s]+/gi },
  {
    type: 'password or secret',
    re: /\b(?:pass(?:word)?|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|auth)\b["']?\s*[:=]\s*["']?[^\s"',;]{6,}/gi,
  },
  {
    type: 'payment card',
    re: /\b(?:\d[ -]?){13,19}\b/g,
    // Issuer prefixes + Luhn, so timestamps and ids don't trip it.
    check: (m) => { const d = m.replace(/\D/g, ''); return /^(?:4|5[1-5]|2[2-7]|3[47]|6(?:011|5))/.test(d) && luhn(d); },
  },
  { type: 'IBAN', re: /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]){11,30}\b/g, check: ibanValid },
  { type: 'Italian tax code', re: /\b[A-Z]{6}\d{2}[A-EHLMPR-T]\d{2}[A-Z]\d{3}[A-Z]\b/gi },
  { type: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { type: 'phone number', re: /(?:\+|\b00)\d{1,3}[\s.-]?\d{2,4}[\s.-]?\d{3,4}[\s.-]?\d{3,4}\b|\b3\d{2}[\s.-]?\d{3}[\s.-]?\d{3,4}\b/g },
];

/** @returns {{type: string, match: string, index: number}[]} */
export function detectSensitive(text) {
  const s = String(text || '');
  const found = [];
  const seen = new Set();
  const add = (type, match, index) => {
    const key = `${index}:${match}`;
    if (!seen.has(key)) { seen.add(key); found.push({ type, match, index }); }
  };
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    for (const m of s.matchAll(rule.re)) {
      if (!rule.check || rule.check(m[0])) add(rule.type, m[0], m.index);
    }
  }
  const envLines = s.split('\n').filter((l) => /^\s*(?:export\s+)?[A-Z][A-Z0-9_]{2,}\s*=\s*\S+/.test(l));
  if (envLines.length >= 3) add('block of .env variables', envLines[0].trim(), s.indexOf(envLines[0]));
  for (const m of s.matchAll(/[A-Za-z0-9+/_=-]{32,}/g)) {
    const w = m[0];
    if (/[A-Za-z]/.test(w) && /\d/.test(w) && entropy(w) > 4.3) add('high-entropy string', w, m.index);
  }
  return found;
}

const mask = (m) => (m.length <= 6 ? '•'.repeat(m.length) : `${m.slice(0, 3)}…[${m.length} characters]`);

/** Text with every finding masked, safe to show in Telegram or on the board. */
export function maskedPreview(text, findings, max = 300) {
  let s = String(text || '');
  const sorted = [...findings].sort((a, b) => b.match.length - a.match.length);
  for (const f of sorted) s = s.split(f.match).join(mask(f.match));
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export const findingTypes = (findings) => [...new Set(findings.map((f) => f.type))];
