// Every text the panel shows in English must have its Italian entry in public/js/i18n.js: the keys used in the
// modules (__('...') and __`...${x}...`) and the static text of the HTML pages. A missing entry would show English
// to an Italian reader, so it fails here instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { IT, __, lang } from '../public/js/i18n.js';

const dir = new URL('../public/', import.meta.url);
const read = (p) => readFileSync(new URL(p, dir), 'utf8');

/** Keys used in a module: quoted __('...') calls and __`...` tags, where each ${...} becomes {0}, {1}... */
function keysOf(s) {
  const keys = [];
  for (const m of s.matchAll(/__\(\s*'((?:\\.|[^'\\])*)'|__\(\s*"((?:\\.|[^"\\])*)"/g)) keys.push((m[1] ?? m[2]).replace(/\\(.)/g, '$1'));
  for (let i = s.indexOf('__`'); i !== -1; i = s.indexOf('__`', i + 3)) {
    let j = i + 3, depth = 0, key = '', n = 0;
    for (; j < s.length; j++) {
      const c = s[j];
      if (depth) { if (c === '{') depth++; else if (c === '}') depth--; else if (c === '`') j = s.indexOf('`', j + 1); continue; }
      if (c === '`') break;
      if (c === '\\') { key += s[++j]; continue; }
      if (c === '$' && s[j + 1] === '{') { key += `{${n++}}`; depth = 1; j++; continue; }
      key += c;
    }
    keys.push(key);
  }
  return keys;
}

// Static texts that read the same in both languages.
const SAME = new Set(['STAZIONE', 'Stazione', 'FX', 'Account', 'Username', 'Password', 'AVATAR', 'Avatar', '×', '—', '·', '+', '/link', 'Telegram', 'Robot', 'Offline', 'In comms', 'Stazione · Account', 'LOG', 'STAZIONE_TOKEN', '2 · GOOGLE AUTHENTICATOR', 'src/inventory, api:/items']);

test('every module text has an Italian translation', () => {
  const missing = [];
  for (const f of readdirSync(new URL('js/', dir))) {
    if (f.endsWith('.js') && f !== 'i18n.js') for (const k of keysOf(read(`js/${f}`))) if (!(k in IT)) missing.push(`${f}: ${k}`);
  }
  assert.deepEqual(missing, []);
});

test('every static HTML text has an Italian translation', () => {
  const missing = [];
  for (const f of [...readdirSync(dir).filter((x) => x.endsWith('.html')), '../lib/admin-page.html']) {
    const html = read(f).replace(/<script[\s\S]*?<\/script>|<svg[\s\S]*?<\/svg>|<div class="secret-box"[^>]*>(?!\[)[^<]*<\/div>/g, '');
    const texts = [...html.matchAll(/>([^<]+)</g)].map((m) => m[1].replace(/\s+/g, ' ').trim());
    const attrs = [...html.matchAll(/\b(?:placeholder|title|aria-label|alt)="([^"]*)"/g)].map((m) => m[1].replace(/&#10;/g, '\n'));
    for (const t of [...texts, ...attrs]) if (t && /[a-z]/i.test(t) && !SAME.has(t) && !(t.replace(/&quot;/g, '"') in IT)) missing.push(`${f}: ${t}`);
  }
  assert.deepEqual(missing, []);
});

test('placeholders are filled and kept in the translation', () => {
  assert.equal(__`${3} min ago`, lang === 'it' ? '3 min fa' : '3 min ago'); // no stored choice in Node: the system language decides
  for (const [en, it] of Object.entries(IT)) {
    const ph = (s) => (s.match(/\{\d+\}/g) || []).sort().join();
    assert.equal(ph(it), ph(en), en);
  }
});
