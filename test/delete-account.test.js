// Deleting an account: by the person (password and a fresh authenticator code) or by an owner. The person can no
// longer sign in, their tokens stop working, their astronauts and roles go, their name is free again, and the last
// owner always stays.
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

const PASSWORD = 'correct horse battery staple 42';
const otp = (secret, steps = 0) => new TOTP({ secret: Secret.fromBase32(secret) }).generate({ timestamp: Date.now() + steps * 30000 });

test('accounts can be deleted by their owner or by an owner of the station', async () => {
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
      for (const c of res.headers.getSetCookie()) { const [k, v] = c.split(';')[0].split('='); if (/Max-Age=0/.test(c)) jar.delete(k); else jar.set(k, v); }
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    };
    const invite = issuer ? (await issuer('POST', '/api/invites', { role: 'member' })).body.code : process.env.INVITE_CODE;
    const start = await call('POST', '/api/auth/register/start', { invite, username, password: PASSWORD });
    const secret = start.body.secret;
    assert.equal((await call('POST', '/api/auth/register/confirm', { code: otp(secret) })).status, 200);
    const me = (await call('GET', '/api/state')).body.me;
    const token = (await call('POST', '/api/tokens', { name: 'pc' })).body.token;
    issuer ??= call;
    return { call, me, token, secret, C: (m, p, b) => call(m, p, b, token) };
  };

  const boss = await person('boss', '10.30.0.1');
  const ann = await person('ann', '10.30.0.2');
  const gus = await person('gus', '10.30.0.3');
  const people = async () => (await boss.call('GET', '/api/people')).body.people;
  const id = async (name) => (await people()).find((p) => p.username === name)?.id;

  // Ann has an astronaut holding a mission and a lock.
  assert.equal((await ann.C('POST', '/api/claudes/heartbeat', { as: 'ann-pc', name: 'Ann PC', join: { project: 'Shop' } })).status, 200);
  const task = (await ann.C('POST', '/api/tasks', { as: 'ann-pc', title: 'Checkout page', project: 'Shop' })).body;
  assert.equal((await ann.C('POST', `/api/tasks/${task.id}/claim`, { as: 'ann-pc', project: 'Shop' })).status, 200);
  assert.equal((await ann.C('POST', '/api/locks', { as: 'ann-pc', project: 'Shop', resources: ['src/checkout'], taskId: task.id })).status, 200);

  // Self-deletion needs the username, the password and a fresh authenticator code.
  assert.equal((await ann.call('POST', '/api/account/delete', { confirm: 'gus', password: PASSWORD, code: otp(ann.secret, 1) })).status, 400);
  assert.equal((await ann.call('POST', '/api/account/delete', { confirm: 'ann', password: 'wrong password here!', code: otp(ann.secret, 1) })).status, 401);
  assert.equal((await ann.call('POST', '/api/account/delete', { confirm: 'ann', password: PASSWORD, code: '000000' })).status, 401);
  assert.equal((await ann.C('POST', '/api/account/delete', { confirm: 'ann', password: PASSWORD, code: otp(ann.secret, 1) })).status, 403, 'an agent token cannot delete its human');
  assert.equal((await ann.call('POST', '/api/account/delete', { confirm: 'ann', password: PASSWORD, code: otp(ann.secret, 1) })).status, 200);

  // Ann is gone: session, token, sign-in, astronaut, lock; the mission is open again; the name is free.
  assert.equal((await ann.call('GET', '/api/state')).status, 401);
  assert.equal((await ann.C('GET', '/api/state')).status, 401);
  assert.equal((await ann.call('POST', '/api/auth/login', { username: 'ann', password: PASSWORD })).status, 401);
  assert.equal(await id('ann'), undefined);
  const state = (await boss.call('GET', '/api/state')).body;
  assert.ok(!state.claudes.some((c) => c.id === 'ann-pc'));
  assert.ok(!state.locks.some((l) => l.owner === 'ann-pc'));
  assert.equal(state.tasks.find((t) => t.id === task.id).status, 'open');
  assert.ok(!state.users.some((u) => u.username === 'ann'));
  const again = await person('ann', '10.30.0.4');
  assert.equal(again.me.username, 'ann', 'the username can be used again');

  // Only an owner deletes others, never themselves through this route, and never the last owner.
  const gusId = await id('gus');
  assert.equal((await again.call('POST', `/api/people/${gusId}/delete`, {})).status, 403);
  await boss.call('PUT', `/api/people/${await id('ann')}/role`, { role: 'admin' });
  assert.equal((await again.call('POST', `/api/admin/people/${gusId}/delete`, {})).status, 403, 'an admin cannot delete accounts');
  assert.equal((await boss.call('POST', `/api/people/${boss.me.userId}/delete`, {})).status, 400);
  assert.equal((await boss.call('POST', `/api/people/${gusId}/delete`, {})).status, 200);
  assert.equal((await gus.call('GET', '/api/state')).status, 401);
  assert.equal((await gus.C('GET', '/api/state')).status, 401);
  assert.equal((await boss.call('POST', '/api/account/delete', { confirm: 'boss', password: PASSWORD, code: otp(boss.secret, 1) })).status, 409, 'the last owner stays');

  // Both deletions are in the audit log.
  const audit = (await boss.call('GET', '/api/admin/audit?event=account_deleted')).body.entries;
  assert.equal(audit.length, 2);
});
