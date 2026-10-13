process.env.RECEPTION_DEFAULT = 'unrestricted'; // Legacy behaviour fixtures; reception.test.js covers manual defaults.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { TOTP, Secret } from 'otpauth';
import { setDb, pgliteDb } from '../lib/db.js';

process.env.PASSWORD_PEPPER ||= crypto.randomBytes(32).toString('base64');
process.env.DATA_ENCRYPTION_KEY ||= crypto.randomBytes(32).toString('base64');
process.env.INVITE_CODE = 'test-bootstrap-invite-0123456789';
process.env.MAX_USERS = '10';
process.env.HIBP_DISABLED = '1';

test('invites: atomic reservation and consumption, revocation, roles, bootstrap and saved user limit', async () => {
  const pg = await PGlite.create({ parsers: { 20: (v) => Number(v) } }); setDb(pgliteDb(pg));
  const { handleRequest } = await import('../lib/app.js');
  let sequence = 0;
  const client = (token) => {
    const jar = new Map(), ip = `10.90.0.${++sequence}`;
    return async (method, path, body) => {
      const headers = new Headers({ 'x-real-ip': ip, 'content-type': 'application/json' });
      if (token) headers.set('authorization', `Bearer ${token}`);
      else { headers.set('origin', 'http://localhost'); headers.set('cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; ')); }
      const res = await handleRequest(new Request(`http://localhost${path}`, { method, headers, body: body && JSON.stringify(body) }));
      for (const c of res.headers.getSetCookie()) { const [k, v] = c.split(';')[0].split('='); jar.set(k, v); }
      return { status: res.status, body: await res.json() };
    };
  };
  const start = (c, username, invite) => c('POST', '/api/auth/register/start', { username, invite, password: 'correct horse battery staple 42' });
  const confirm = (c, secret) => c('POST', '/api/auth/register/confirm', { code: new TOTP({ secret: Secret.fromBase32(secret) }).generate() });
  const boss = client(), second = client();
  assert.equal((await boss('GET', '/api/auth/status')).body.registrationOpen, true);
  const boot = await start(boss, 'boss', process.env.INVITE_CODE); assert.equal(boot.status, 200);
  assert.equal((await start(second, 'extraowner', process.env.INVITE_CODE)).status, 403, 'bootstrap is reserved atomically');
  assert.equal((await confirm(boss, boot.body.secret)).status, 200);
  assert.equal((await start(second, 'extraowner', process.env.INVITE_CODE)).status, 403, 'bootstrap ends after the first owner');
  const tok = (await boss('POST', '/api/tokens', { name: 'bot' })).body.token;
  assert.equal((await client(tok)('POST', '/api/invites', { role: 'owner' })).status, 403, 'agent tokens never mint invites');
  const invite = async (role = 'member', issuer = boss) => {
    const r = await issuer('POST', '/api/invites', { role }); assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body;
  };
  assert.equal((await boss('POST', '/api/invites', { role: 'member', hours: 721 })).status, 400);
  const i = await invite('guest'), guest = client();
  assert.ok(i.code.length >= 40); assert.match(i.link, /^\/register\?invite=/);
  const pending = await start(guest, 'guest', i.code); assert.equal(pending.status, 200);
  assert.equal((await start(second, 'duplicate', i.code)).status, 403, 'one reservation per code');
  assert.equal((await confirm(guest, pending.body.secret)).status, 200);
  assert.equal((await guest('GET', '/api/me')).body.role, 'guest');
  assert.equal((await start(second, 'reuse', i.code)).status, 403, 'used once');
  const stored = (await pg.query('select * from invites where id = $1', [i.id])).rows[0];
  assert.notEqual(stored.code_hash, i.code); assert.equal(stored.code_hash.length, 64);
  assert.ok(!JSON.stringify((await boss('GET', '/api/invites')).body).includes(i.code), 'code never reappears in a listing');
  assert.equal((await guest('POST', '/api/invites', { role: 'member' })).status, 403);

  const revoke = await invite(), revokee = client(), reserved = await start(revokee, 'revokee', revoke.code);
  assert.equal(reserved.status, 200);
  assert.equal((await boss('POST', `/api/invites/${revoke.id}/revoke`, {})).status, 200);
  assert.equal((await confirm(revokee, reserved.body.secret)).status, 403, 'revocation prevents in-progress confirmation');
  const expired = await invite();
  await pg.query('update invites set expires_at = $2 where id = $1', [expired.id, Date.now() - 1]);
  assert.equal((await start(client(), 'expired', expired.code)).status, 403);

  const retry = await invite(), firstTry = client();
  assert.equal((await start(firstTry, 'abandoned', retry.code)).status, 200);
  await pg.query("update users set pending_expires_at = $1 where username = 'abandoned'", [Date.now() - 1]);
  await pg.query('update invites set reserved_until = $2 where id = $1', [retry.id, Date.now() - 1]);
  const retryPerson = client(), retried = await start(retryPerson, 'lead', retry.code);
  assert.equal(retried.status, 200, 'expired reservations release their invite');
  assert.equal((await confirm(retryPerson, retried.body.secret)).status, 200);
  const people = (await boss('GET', '/api/people')).body.people;
  const leadId = people.find((p) => p.username === 'lead').id;
  await boss('PUT', `/api/people/${leadId}/role`, { role: 'lead' });
  assert.equal((await retryPerson('POST', '/api/invites', { role: 'admin' })).status, 403);
  assert.equal((await retryPerson('POST', '/api/invites', { role: 'owner' })).status, 403);
  const leadInvite = await invite('member', retryPerson);
  await boss('PUT', `/api/people/${leadId}/role`, { role: 'guest' });
  assert.equal((await start(client(), 'invalidissuer', leadInvite.code)).status, 403, 'issuer authority is rechecked');

  assert.equal((await boss('PUT', '/api/organization/user-limit', { limit: 12 })).status, 200);
  process.env.MAX_USERS = '1'; setDb(pgliteDb(pg));
  assert.equal((await boss('GET', '/api/organization')).body.userLimit, 12, 'restart does not overwrite saved settings');
  assert.equal((await boss('PUT', '/api/organization/user-limit', { limit: 1 })).status, 409, 'existing people cannot be excluded');
  const occupied = (await boss('GET', '/api/organization')).body.occupiedSeats;
  await boss('PUT', '/api/organization/user-limit', { limit: occupied + 1 });
  const a = await invite(), b = await invite();
  const outcomes = await Promise.all([start(client(), 'lastseatone', a.code), start(client(), 'lastseattwo', b.code)]);
  assert.deepEqual(outcomes.map((r) => r.status).sort(), [200, 403], 'concurrent starts cannot exceed the user limit');
  await pg.close();
});
