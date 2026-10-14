process.env.RECEPTION_DEFAULT = 'unrestricted'; // Legacy behaviour fixtures; reception.test.js covers manual defaults.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { setDb, pgliteDb, db } from '../lib/db.js';
import { createSession } from '../lib/auth.js';
import { sha256, hashIp } from '../lib/crypto.js';
import { ADMIN_IDLE_MS, ADMIN_ABSOLUTE_MS } from '../lib/admin.js';
import { PERMISSIONS } from '../lib/permissions.js';
import { IT } from '../public/js/i18n.js';

process.env.PASSWORD_PEPPER ||= crypto.randomBytes(32).toString('base64');
process.env.DATA_ENCRYPTION_KEY ||= crypto.randomBytes(32).toString('base64');
process.env.MAX_USERS = '10';

test('admin: protected page and APIs, short session, delegated checks, audit and safe token metadata', async () => {
  const pg = await PGlite.create({ parsers: { 20: (v) => Number(v) } }); setDb(pgliteDb(pg));
  const q = await db(), { handleRequest } = await import('../lib/app.js');
  const sessionTokens = new Map();
  const client = (token, cookie, origin = 'http://localhost') => async (method, route, body) => {
    const headers = new Headers({ origin, 'content-type': 'application/json' });
    if (token) headers.set('authorization', `Bearer ${token}`); if (cookie) headers.set('cookie', `__Host-stz_s=${cookie}`);
    const res = await handleRequest(new Request(`http://localhost${route}`, { method, headers, body: body && JSON.stringify(body) }));
    const text = await res.text(); return { status: res.status, headers: res.headers, body: res.headers.get('content-type').startsWith('text/html') ? text : JSON.parse(text) };
  };
  const human = async (id, role) => {
    await q.query("insert into users (id, username, password_hash, status, created_at, updated_at) values ($1, $1, 'fixture', 'active', $2, $2)", [id, Date.now()]);
    await q.query("insert into memberships (user_id, org_id, role_id, updated_at) values ($1, 'default', $2, $3)", [id, role, Date.now()]);
    const session = await createSession(q, id, 'session', Date.now());
    // These fixtures represent a recently MFA-confirmed sign-in; dedicated security tests cover missing confirmation.
    await q.query('update sessions set admin_until=$2,ip_hash=$3 where id_hash=$1', [sha256(session.token), Date.now() + 300000, hashIp('local')]);
    sessionTokens.set(id, session.token); return client(null, session.token);
  };
  const owner = await human('owner', 'owner'), admin = await human('admin', 'admin'), member = await human('member', 'member');
  const token = (await owner('POST', '/api/tokens', { name: 'Owner machine' })).body.token, bot = client(token), anon = client();
  for (const route of ['/api/admin/page', '/api/admin/session', '/api/admin/overview', '/api/admin/people', '/api/admin/roles', '/api/admin/invites', '/api/admin/audit', '/api/admin/tokens']) {
    for (const c of [anon, member, bot]) assert.equal((await c('GET', route)).status, 404, route);
  }
  assert.equal((await anon('POST', '/api/admin/overview', {})).status, 404);
  const page = await owner('GET', '/api/admin/page'); assert.equal(page.status, 200);
  assert.match(page.body, /Admin console/); assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal((await owner('GET', '/api/admin/session')).body.idleMinutes, 15);
  assert.equal((await owner('GET', '/api/admin/overview')).status, 200);
  const role = await owner('POST', '/api/admin/roles', { name: 'Read console', permissions: ['station.view', 'admin.console'] });
  assert.equal(role.status, 201);
  assert.equal((await owner('PUT', '/api/admin/people/member/role', { role: role.body.id })).status, 200);
  assert.equal((await member('GET', '/api/admin/session')).status, 200);
  assert.equal((await member('GET', '/api/admin/audit')).status, 403, 'console does not grant audit rights');
  assert.equal((await member('POST', '/api/admin/roles', { name: 'Elevated', permissions: ['admin.roles'] })).status, 403);
  assert.equal((await admin('PUT', '/api/admin/people/owner/role', { role: 'member' })).status, 403);
  assert.equal((await owner('PUT', '/api/admin/people/owner/role', { role: 'member' })).status, 409, 'last owner stays protected');
  const invite = await owner('POST', '/api/admin/invites', { role: 'member', label: 'Office', hours: 48 }); assert.equal(invite.status, 201);
  assert.ok(!JSON.stringify((await owner('GET', '/api/admin/invites')).body).includes(invite.body.code));
  assert.equal((await owner('POST', `/api/admin/invites/${invite.body.id}/revoke`, {})).status, 200);
  const list = await owner('GET', '/api/admin/tokens'); assert.equal(list.status, 200);
  assert.ok(!JSON.stringify(list.body).includes(token)); assert.ok(!JSON.stringify(list.body).includes(sha256(token)));
  assert.equal((await admin('POST', `/api/admin/tokens/${list.body.tokens[0].id}/revoke`, {})).status, 403);
  assert.equal((await owner('POST', `/api/admin/tokens/${list.body.tokens[0].id}/revoke`, {})).status, 200);
  assert.equal((await bot('GET', '/api/state')).status, 401);
  assert.equal((await client(null, sessionTokens.get('owner'), 'https://other.invalid')('POST', '/api/admin/invites', { role: 'member' })).status, 403);
  const audit = await owner('GET', '/api/admin/audit?event=invite_revoked&user=owner');
  assert.equal(audit.status, 200); assert.equal(audit.body.entries.length, 1); assert.equal(audit.body.entries[0].event, 'invite_revoked');
  assert.ok(!JSON.stringify(audit.body).includes(invite.body.code));
  assert.equal((await owner('GET', '/api/admin/audit?from=100&to=1')).status, 400);

  const ownerHash = sha256(sessionTokens.get('owner'));
  await q.query('update sessions set admin_last_seen = $2 where id_hash = $1', [ownerHash, Date.now() - ADMIN_IDLE_MS - 100]);
  const expired = await owner('GET', '/api/admin/session');
  assert.equal(expired.status, 403); assert.equal(expired.body.code, 'step_up_required', 'expiry asks to confirm, not to sign in again');
  assert.equal((await owner('GET', '/api/admin/page')).status, 200, 'the console page (no data) still loads to ask');
  assert.equal((await owner('GET', '/api/state')).status, 200, 'regular session is separate from admin expiry');
  const fresh = await createSession(q, 'owner', 'session', Date.now()), refreshed = client(null, fresh.token);
  assert.equal((await refreshed('GET', '/api/admin/session')).status, 200, 'new login reopens admin');
  await q.query('update sessions set admin_started_at = $2, admin_last_seen = $3 where id_hash = $1', [sha256(fresh.token), Date.now() - ADMIN_ABSOLUTE_MS - 100, Date.now()]);
  assert.equal((await refreshed('GET', '/api/admin/overview')).status, 403, 'absolute expiry despite activity');
  assert.equal((await admin('POST', '/api/admin/logout', {})).status, 200);
  assert.equal((await admin('GET', '/api/admin/session')).status, 403);
  assert.equal((await admin('POST', '/api/invites', { role: 'member' })).body.code, 'step_up_required', 'closing admin also clears confirmation on panel endpoints');
  await q.query('update sessions set admin_started_at=null,admin_last_seen=null,admin_until=$2 where id_hash=$1', [ownerHash, Date.now() + 300000]);
  await owner('PUT', '/api/people/member/role', { role: 'guest' });
  assert.equal((await member('GET', '/api/admin/session')).status, 404, 'revocation is immediate');

  const { createServer } = await import('../lib/server.js');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), server = createServer({ root, hsts: false });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const route of ['/admin', '/admin/', '/admin.html']) assert.equal((await fetch(base + route)).status, 404, 'no static-page bypass');
    assert.equal((await fetch(base + '/admin-page.html')).status, 404);
    const session = await createSession(q, 'owner', 'session', Date.now());
    const response = await fetch(base + '/admin', { headers: { cookie: `__Host-stz_s=${session.token}` } });
    assert.equal(response.status, 200); assert.match(await response.text(), /Admin console/);
  } finally { await new Promise((done) => server.close(done)); }
  for (const label of Object.values(PERMISSIONS)) assert.ok(label in IT, label);
  await pg.close();
});
