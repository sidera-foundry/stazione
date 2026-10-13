process.env.RECEPTION_DEFAULT = 'unrestricted'; // Legacy behaviour fixtures; reception.test.js covers manual defaults.
// F1: a mission created with "to" can be claimed only by that Claude, and only it gets the announcement.
// Also: asks for drastic actions answered from the panel.
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

test('assigned mission: only the assignee is told and can claim it', async () => {
  setDb(pgliteDb(await PGlite.create({ parsers: { 20: (v) => Number(v) } })));
  const { handleRequest } = await import('../lib/app.js');
  const jar = new Map();
  const call = async (method, path, body, token) => {
    const headers = new Headers({ 'x-real-ip': '10.7.0.1', 'content-type': 'application/json' });
    if (token) headers.set('authorization', `Bearer ${token}`); else headers.set('origin', 'http://localhost');
    if (jar.size && !token) headers.set('cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '));
    const res = await handleRequest(new Request(`http://localhost${path}`, { method, headers, body: body && JSON.stringify(body) }));
    for (const c of res.headers.getSetCookie()) { const [k, v] = c.split(';')[0].split('='); jar.set(k, v); }
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const start = await call('POST', '/api/auth/register/start', { invite: process.env.INVITE_CODE, username: 'boss', password: 'correct horse battery staple 42' });
  await call('POST', '/api/auth/register/confirm', { code: new TOTP({ secret: Secret.fromBase32(start.body.secret) }).generate() });
  const tok = (await call('POST', '/api/tokens', { name: 'x' })).body.token;
  const C = (m, p, b) => call(m, p, b, tok);
  for (const as of ['aa', 'bb']) await C('POST', '/api/claudes/heartbeat', { as, name: as });

  const ghost = await C('POST', '/api/tasks', { as: 'aa', title: 'x', to: 'ghost' });
  assert.equal(ghost.status, 404, JSON.stringify(ghost.body));
  const { id } = (await C('POST', '/api/tasks', { as: 'aa', title: 'Only for bb', to: 'bb' })).body;
  assert.equal((await C('GET', '/api/inbox?as=bb')).body.messages.at(-1).to, 'bb');
  const other = await C('POST', `/api/tasks/${id}/claim`, { as: 'aa' });
  assert.equal(other.status, 409);
  assert.equal(other.body.assignee, 'bb');
  const mine = await C('POST', `/api/tasks/${id}/claim`, { as: 'bb' });
  assert.equal(mine.status, 200);
  assert.equal(mine.body.task.assignee, 'bb');

  // Asks answered from the panel: counted in /api/state, listed, approved, and the Claude is told.
  const ask = await C('POST', '/api/asks', { as: 'aa', text: 'I delete the project tmp folder', project: 'x' });
  assert.equal(ask.status, 202, JSON.stringify(ask.body));
  assert.equal((await call('GET', '/api/state')).body.pendingAsks, 1);
  assert.equal((await call('GET', '/api/asks')).body.asks[0].id, ask.body.id);
  assert.equal((await call('POST', `/api/asks/${ask.body.id}`, { approve: true })).body.status, 'approved');
  assert.equal((await call('GET', '/api/state')).body.pendingAsks, 0);
  assert.match((await C('GET', '/api/inbox?as=aa')).body.messages.at(-1).text, /APPROVED/);
});
