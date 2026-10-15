// Easier setup: a station without its settings sends people to /setup (names only, never values); a new token comes
// with a single-use connection code that the connect script trades for it, once, within 15 minutes; the admin console
// warns when the database sits far from the functions; the public demo answers reads only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { TOTP, Secret } from 'otpauth';
import { setDb, pgliteDb } from '../lib/db.js';
import { setupMissing } from '../lib/config.js';
import { regionCheck } from '../lib/region.js';

process.env.PASSWORD_PEPPER ||= crypto.randomBytes(32).toString('base64');
process.env.DATA_ENCRYPTION_KEY ||= crypto.randomBytes(32).toString('base64');
process.env.INVITE_CODE ||= 'test-invite-code-0123456789';
process.env.HIBP_DISABLED = '1';
process.env.MAX_USERS = '10';

test('setup: the missing settings are named, the station refuses until they are there', async () => {
  const good = { DATABASE_URL: 'postgres://u:p@h/db', PASSWORD_PEPPER: crypto.randomBytes(32).toString('base64'), DATA_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64') };
  assert.deepEqual(setupMissing(good), []);
  assert.deepEqual(setupMissing({ ...good, PASSWORD_PEPPER: 'short' }), ['PASSWORD_PEPPER']);
  assert.deepEqual(setupMissing({}), ['DATABASE_URL', 'PASSWORD_PEPPER', 'DATA_ENCRYPTION_KEY']);

  const { handleRequest } = await import('../lib/app.js');
  const saved = process.env.DATA_ENCRYPTION_KEY;
  delete process.env.DATA_ENCRYPTION_KEY;
  try {
    const res = await handleRequest(new Request('http://localhost/api/me'));
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.code, 'setup_required');
    assert.ok(body.missing.includes('DATA_ENCRYPTION_KEY'));
    assert.ok(!JSON.stringify(body).includes(process.env.PASSWORD_PEPPER), 'values never leave the server');
  } finally { process.env.DATA_ENCRYPTION_KEY = saved; }

  // The setup page makes the secrets in the browser and sends nothing but the status request.
  const js = readFileSync(new URL('../public/js/setup.js', import.meta.url), 'utf8');
  assert.match(js, /crypto\.getRandomValues/);
  assert.equal([...js.matchAll(/fetch\(/g)].length, 1);
});

test('connect: a new token comes with a code that works once, and not after the token is revoked', async () => {
  setDb(pgliteDb(await PGlite.create({ parsers: { 20: (v) => Number(v) } })));
  const { handleRequest } = await import('../lib/app.js');
  const jar = new Map();
  const call = async (method, p, body, { cookie = true, ip = '10.40.0.1', token } = {}) => {
    const headers = new Headers({ 'x-real-ip': ip, 'content-type': 'application/json' });
    if (token) headers.set('authorization', `Bearer ${token}`);
    if (cookie && !token) { headers.set('origin', 'http://localhost'); if (jar.size) headers.set('cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; ')); }
    const res = await handleRequest(new Request(`http://localhost${p}`, { method, headers, body: body && JSON.stringify(body) }));
    if (cookie) for (const c of res.headers.getSetCookie()) { const [k, v] = c.split(';')[0].split('='); jar.set(k, v); }
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const start = await call('POST', '/api/auth/register/start', { invite: process.env.INVITE_CODE, username: 'owner', password: 'correct horse battery staple 42' });
  await call('POST', '/api/auth/register/confirm', { code: new TOTP({ secret: Secret.fromBase32(start.body.secret) }).generate() });

  const made = await call('POST', '/api/tokens', { name: 'office pc' });
  assert.equal(made.status, 200);
  assert.match(made.body.connectCode, /^stzc_[A-Za-z0-9_-]{24}$/);
  assert.ok(made.body.connectExpiresAt - Date.now() <= 15 * 60e3);

  // The script, from another computer and without any cookie, gets the token once.
  const claim = (code, ip = '10.40.0.9') => call('POST', '/api/connect/claim', { code }, { cookie: false, ip });
  const first = await claim(made.body.connectCode);
  assert.equal(first.status, 200);
  assert.equal(first.body.token, made.body.token);
  assert.equal(first.body.name, 'office pc');
  assert.equal((await call('POST', '/api/claudes/heartbeat', { as: 'atlas', name: 'Atlas' }, { token: first.body.token })).status, 200);
  assert.equal((await claim(made.body.connectCode)).status, 404, 'a code works only once');
  assert.equal((await claim('stzc_nottherightcodeatall000')).status, 404);

  // Revoking the token throws its code away too.
  const other = await call('POST', '/api/tokens', { name: 'laptop' });
  assert.equal((await call('DELETE', `/api/tokens/${other.body.id}`)).status, 200);
  assert.equal((await claim(other.body.connectCode)).status, 404);

  // Guessing is slowed down per network.
  let last;
  for (let i = 0; i < 12; i++) last = await claim(`stzc_wrongguess${String(i).padStart(13, '0')}`, '10.40.0.66');
  assert.equal(last.status, 429);

  // The served scripts never print the token, and take only the station's address and the code.
  for (const f of ['connect.ps1', 'connect.sh']) {
    const s = readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8');
    assert.match(s, /\/api\/connect\/claim/);
    const shown = s.split('\n').filter((l) => /(Write-Host|\bSay\b|\becho\b|\bprintf\b)/.test(l) && /\$(claim\.token|TOKEN)\b/.test(l) && !l.includes('>'));
    assert.deepEqual(shown, [], `${f} must not show the token (only write it to its safe place)`);
  }
});

test('region: the console warns when the database is far from the functions', () => {
  const neon = (r) => `postgres://u:p@ep-cool-name-123.${r}.aws.neon.tech/db?sslmode=require`;
  assert.deepEqual(regionCheck({ VERCEL_REGION: 'iad1', DATABASE_URL: neon('eu-central-1') }), { functions: 'iad1', database: 'eu-central-1', suggested: 'fra1' });
  assert.equal(regionCheck({ VERCEL_REGION: 'fra1', DATABASE_URL: neon('eu-central-1') }), null);
  assert.equal(regionCheck({ VERCEL_REGION: 'fra1', DATABASE_URL: 'postgres://u:p@db.example.com/db' }), null, 'not Neon: nothing to say');
  assert.equal(regionCheck({ DATABASE_URL: neon('eu-central-1') }), null, 'not on Vercel');
  assert.ok(!JSON.stringify(regionCheck({ VERCEL_REGION: 'iad1', DATABASE_URL: neon('eu-central-1') })).includes('u:p'), 'only region names');
});
