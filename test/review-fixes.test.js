// Regressions from the full-code review: the context of a restricted room stays hidden (read, history and restore),
// a right step-up code clears the failure counter, and a mission closed from the panel frees the agent working on it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { TOTP, Secret } from 'otpauth';
import { setDb, pgliteDb } from '../lib/db.js';

process.env.PASSWORD_PEPPER ||= crypto.randomBytes(32).toString('base64');
process.env.DATA_ENCRYPTION_KEY ||= crypto.randomBytes(32).toString('base64');
process.env.INVITE_CODE ||= 'test-invite-code-0123456789';
process.env.HIBP_DISABLED = '1';
process.env.MAX_USERS = '10';
process.env.RECEPTION_DEFAULT = 'unrestricted';

const otp = (secret, steps = 0) => new TOTP({ secret: Secret.fromBase32(secret) }).generate({ timestamp: Date.now() + steps * 30000 });

test('review fixes: restricted context, step-up counter, missions closed from the panel', async () => {
  setDb(pgliteDb(await PGlite.create({ parsers: { 20: (v) => Number(v) } })));
  const { handleRequest } = await import('../lib/app.js');
  let issuer = null;
  const person = async (username, ip) => {
    const jar = new Map();
    const call = async (method, path, body, token) => {
      const headers = new Headers({ 'x-real-ip': ip, 'content-type': 'application/json' });
      if (token) headers.set('authorization', `Bearer ${token}`); else headers.set('origin', 'http://localhost');
      if (jar.size && !token) headers.set('cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '));
      const res = await handleRequest(new Request(`http://localhost${path}`, { method, headers, body: body && JSON.stringify(body) }));
      for (const c of res.headers.getSetCookie()) { const [k, v] = c.split(';')[0].split('='); jar.set(k, v); }
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    };
    const invite = issuer ? (await issuer('POST', '/api/invites', { role: 'member' })).body.code : process.env.INVITE_CODE;
    const start = await call('POST', '/api/auth/register/start', { invite, username, password: 'correct horse battery staple 42' });
    assert.equal((await call('POST', '/api/auth/register/confirm', { code: otp(start.body.secret) })).status, 200);
    const token = (await call('POST', '/api/tokens', { name: 'pc' })).body.token;
    issuer ??= call;
    return { call, token, secret: start.body.secret, C: (m, p, b) => call(m, p, b, token) };
  };
  const boss = await person('boss', '10.40.0.1');
  const ann = await person('ann', '10.40.0.2');

  // A restricted room with a context: ann (no role in it) sees neither the context, nor its history, nor can restore it.
  assert.equal((await boss.C('POST', '/api/claudes/heartbeat', { as: 'boss-bot', name: 'BB', join: { project: 'Vault' } })).status, 200);
  assert.equal((await boss.C('PUT', '/api/context/Vault', { as: 'boss-bot', summary: 'first version' })).status, 200);
  assert.equal((await boss.C('PUT', '/api/context/Vault', { as: 'boss-bot', summary: 'second version', version: 1 })).status, 200);
  const room = (await boss.call('GET', '/api/rooms')).body.rooms.find((r) => r.project === 'Vault');
  assert.equal((await boss.call('PUT', `/api/rooms/${room.id}/visibility`, { visibility: 'restricted' })).status, 200);
  assert.equal((await ann.call('GET', '/api/context/Vault')).status, 404);
  assert.equal((await ann.C('GET', '/api/context/Vault')).status, 404);
  assert.equal((await ann.call('GET', '/api/context/Vault/versions')).status, 404);
  assert.equal((await ann.call('POST', '/api/context/Vault/rollback', { version: 1 })).status, 404);
  assert.equal((await boss.call('GET', '/api/context/Vault')).status, 200, 'the owner still reads it');

  // Step-up: five wrong codes, then a right one, then five more wrong ones are still answered (not locked out).
  for (let i = 0; i < 5; i++) assert.equal((await boss.call('POST', '/api/auth/step-up', { code: '000000' })).status, 400);
  assert.equal((await boss.call('POST', '/api/auth/step-up', { code: otp(boss.secret, 1) })).status, 200);
  for (let i = 0; i < 5; i++) assert.equal((await boss.call('POST', '/api/auth/step-up', { code: '000000' })).status, 400, `wrong code ${i + 1} after a right one`);
  assert.equal((await boss.call('POST', '/api/auth/step-up', { code: '000000' })).status, 400);
  assert.equal((await boss.call('POST', '/api/auth/step-up', { code: '000000' })).status, 429, 'six failures in a row still lock');

  // A mission closed from the panel frees the agent that was working on it.
  assert.equal((await ann.C('POST', '/api/claudes/heartbeat', { as: 'ann-bot', name: 'AB', join: { project: 'Shop' } })).status, 200);
  const task = (await ann.C('POST', '/api/tasks', { as: 'ann-bot', title: 'Checkout page', project: 'Shop' })).body;
  assert.equal((await ann.C('POST', `/api/tasks/${task.id}/claim`, { as: 'ann-bot', project: 'Shop' })).status, 200);
  const working = () => boss.call('GET', '/api/state').then((r) => r.body.claudes.find((c) => c.id === 'ann-bot').taskId);
  assert.equal(await working(), task.id);
  assert.equal((await boss.call('PATCH', `/api/tasks/${task.id}`, { status: 'done' })).status, 200);
  assert.equal(await working(), null);
});
