process.env.RECEPTION_DEFAULT = 'unrestricted'; // Legacy behaviour fixtures; reception.test.js covers manual defaults.
// Roles and permissions: the first person is the owner, later ones are members; a Claude has the permissions of its
// human and never more; roles are assigned and edited without anyone gaining what they do not hold; the last owner stays.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { TOTP, Secret } from 'otpauth';
import { setDb, pgliteDb } from '../lib/db.js';
import { SCHEMA } from '../lib/schema.js';

process.env.PASSWORD_PEPPER ||= crypto.randomBytes(32).toString('base64');
process.env.DATA_ENCRYPTION_KEY ||= crypto.randomBytes(32).toString('base64');
process.env.INVITE_CODE ||= 'test-invite-code-0123456789';
process.env.HIBP_DISABLED = '1';
process.env.MAX_USERS = '10';

test('permissions: roles, Claudes capped by their human, safe role changes', async () => {
  setDb(pgliteDb(await PGlite.create({ parsers: { 20: (v) => Number(v) } })));
  const { handleRequest } = await import('../lib/app.js');
  let inviteIssuer = null;
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
    const invite = inviteIssuer ? (await inviteIssuer('POST', '/api/invites', { role: 'member' })).body.code : process.env.INVITE_CODE;
    const start = await call('POST', '/api/auth/register/start', { invite, username, password: 'correct horse battery staple 42' });
    await call('POST', '/api/auth/register/confirm', { code: new TOTP({ secret: Secret.fromBase32(start.body.secret) }).generate() });
    const me = (await call('GET', '/api/state')).body.me;
    const token = (await call('POST', '/api/tokens', { name: 'pc' })).body?.token;
    inviteIssuer ??= call;
    return { call, me, token, C: (m, p, b) => call(m, p, b, token) };
  };

  const boss = await person('boss', '10.20.0.1');
  const ann = await person('ann', '10.20.0.2');
  const gus = await person('gus', '10.20.0.3');
  assert.equal(boss.me.role, 'owner', 'the first person owns the station');
  assert.equal(ann.me.role, 'member', 'later ones start as members');
  assert.ok(boss.me.permissions.includes('admin.roles') && !ann.me.permissions.includes('admin.roles'));
  assert.deepEqual((await ann.call('GET', '/api/me')).body.permissions, ann.me.permissions, 'account pages see the same permissions');

  // Roles are listed with the permission catalog; only people.manage sees the people.
  const roles = (await ann.call('GET', '/api/roles')).body;
  assert.deepEqual(roles.roles.map((r) => r.id).slice(0, 5), ['owner', 'admin', 'lead', 'member', 'guest']);
  assert.ok(roles.permissions.length >= 20);
  assert.equal((await ann.call('GET', '/api/people')).status, 403);
  const people = (await boss.call('GET', '/api/people')).body.people;
  const id = (name) => people.find((p) => p.username === name).id;

  // A member cannot change roles; the owner can. Nobody grants what they do not hold; the last owner stays.
  assert.equal((await ann.call('PUT', `/api/people/${id('gus')}/role`, { role: 'guest' })).status, 403);
  assert.equal((await boss.call('PUT', `/api/people/${id('gus')}/role`, { role: 'guest' })).status, 200);
  assert.equal((await boss.call('PUT', `/api/people/${id('boss')}/role`, { role: 'admin' })).status, 409, 'the last owner cannot step down');
  assert.equal((await boss.call('PUT', `/api/people/${id('ann')}/role`, { role: 'admin' })).status, 200);
  assert.equal((await ann.call('PUT', `/api/people/${id('boss')}/role`, { role: 'member' })).status, 403, 'an admin does not touch owners');
  assert.equal((await ann.call('PUT', `/api/people/${id('ann')}/role`, { role: 'owner' })).status, 403, 'nor makes owners');
  assert.equal((await ann.call('PUT', `/api/roles/admin`, { permissions: [] })).status, 403, 'only an owner edits the admin role');
  assert.equal((await boss.call('PUT', `/api/roles/owner`, { permissions: [] })).status, 400);

  // Custom roles: created, edited, deleted when unused; a lead cannot hand out admin powers.
  const reviewer = await boss.call('POST', '/api/roles', { name: 'Reviewer', permissions: ['station.view', 'polls.vote', 'nonsense'] });
  assert.equal(reviewer.status, 201);
  assert.deepEqual(reviewer.body.permissions, ['station.view', 'polls.vote'], 'unknown permissions are dropped');
  await boss.call('PUT', `/api/people/${id('ann')}/role`, { role: 'lead' });
  assert.equal((await ann.call('POST', '/api/roles', { name: 'x', permissions: ['admin.security'] })).status, 403, 'a lead has no admin.roles');
  assert.equal((await ann.call('PUT', `/api/people/${id('gus')}/role`, { role: 'admin' })).status, 403, 'a lead cannot grant what it lacks');
  await boss.call('PUT', `/api/people/${id('gus')}/role`, { role: reviewer.body.id });
  assert.equal((await boss.call('DELETE', `/api/roles/${reviewer.body.id}`)).status, 409, 'in use');
  await boss.call('PUT', `/api/people/${id('gus')}/role`, { role: 'guest' });
  assert.equal((await boss.call('DELETE', `/api/roles/${reviewer.body.id}`)).status, 200);
  assert.equal((await boss.call('DELETE', '/api/roles/guest')).status, 400, 'built-in roles stay');

  // A guest reads but does nothing: no tokens, so no Claude at all.
  assert.equal((await gus.call('POST', '/api/tokens', { name: 'x' })).status, 403);
  assert.equal((await gus.call('GET', '/api/state')).status, 200);
  assert.equal((await gus.call('POST', '/api/tasks', { title: 'x' })).status, 403);
  assert.equal((await gus.call('GET', '/api/notes')).status, 403, 'ideas are a permission');
  // A guest's Claude made before the change is capped too: read only.
  await boss.call('PUT', `/api/people/${id('gus')}/role`, { role: 'member' });
  const gusTok = (await gus.call('POST', '/api/tokens', { name: 'pc' })).body.token;
  const G = (m, p, b) => gus.call(m, p, b, gusTok);
  await G('POST', '/api/claudes/heartbeat', { as: 'gusbot', name: 'Gus bot', new: true, join: { project: 'Web Shop' } });
  const gusPoll = (await G('POST', '/api/polls', { as: 'gusbot', text: 'Ship the update?', options: ['Yes', 'No'] })).body.id;
  await boss.call('PUT', `/api/people/${id('gus')}/role`, { role: 'guest' });
  assert.equal((await G('POST', '/api/claudes/heartbeat', { as: 'gusbot', status: 'idle' })).status, 200, 'it may still say hello');
  assert.equal((await G('POST', `/api/polls/${gusPoll}/close`, { as: 'gusbot' })).status, 403, 'an old opener token loses write access on demotion');
  assert.equal((await G('POST', `/api/polls/${gusPoll}/vote`, { as: 'gusbot', choice: 1, reason: 'Ready to ship' })).status, 403);
  assert.equal((await G('POST', '/api/tasks', { as: 'gusbot', title: 'x' })).status, 403);
  assert.equal((await G('POST', '/api/messages', { as: 'gusbot', to: '*', text: 'hi' })).status, 403);
  assert.equal((await G('POST', '/api/locks', { as: 'gusbot', project: 'Web Shop', resources: ['a'] })).status, 403);
  assert.equal((await G('POST', '/api/asks', { as: 'gusbot', text: 'May I delete the build folder?' })).status, 202, 'asking a human is always allowed');

  // The Bridge: only the Claudes of people who may open and merge rooms.
  const lead = await person('lea', '10.20.0.4');
  assert.equal((await lead.C('POST', '/api/claudes/heartbeat', { as: 'leabot', name: 'Lea bot', new: true, join: { bridge: true } })).status, 403);
  assert.equal((await boss.C('POST', '/api/claudes/heartbeat', { as: 'bossbot', name: 'Boss bot', new: true, join: { bridge: true } })).status, 200);
  assert.equal((await lead.C('POST', '/api/claudes/heartbeat', { as: 'leabot', name: 'Lea bot', new: true, join: { project: 'Web Shop' } })).status, 200);
  // A member creates missions but does not assign them or set their priority; their Claude works on them.
  assert.equal((await lead.C('POST', '/api/tasks', { as: 'leabot', title: 'Cart', priority: 'high' })).status, 403);
  const t = (await lead.C('POST', '/api/tasks', { as: 'leabot', title: 'Cart' })).body.id;
  assert.equal((await lead.C('POST', `/api/tasks/${t}/claim`, { as: 'leabot' })).status, 200);
  assert.equal((await lead.C('PATCH', `/api/tasks/${t}`, { as: 'leabot', checkpoint: 'half done' })).status, 200);
  assert.equal((await lead.call('PATCH', `/api/tasks/${t}`, { status: 'done' })).status, 403, 'a member does not manage missions from the panel');
  assert.equal((await boss.call('PATCH', `/api/tasks/${t}`, { priority: 'high' })).status, 200);
  assert.equal((await lead.C('POST', '/api/rooms', { as: 'leabot', name: 'New room' })).status, 403);

  // Telegram answers with the same permissions.
  const { commandReply } = await import('../lib/tgcommands.js');
  const dbq = await (await import('../lib/db.js')).db();
  assert.match(await commandReply(dbq, id('gus'), '/mission Write the docs', Date.now()), /does not allow/);
  assert.match(await commandReply(dbq, id('boss'), '/status', Date.now()), /Station status/);
  const deputy = await person('deputy', '10.20.0.5');
  const deputyId = (await boss.call('GET', '/api/people')).body.people.find((p) => p.username === 'deputy').id;
  await boss.call('PUT', `/api/people/${deputyId}/role`, { role: 'owner' });
  const demotions = await Promise.all([
    boss.call('PUT', `/api/people/${id('boss')}/role`, { role: 'member' }),
    deputy.call('PUT', `/api/people/${deputyId}/role`, { role: 'member' }),
  ]);
  assert.deepEqual(demotions.map((r) => r.status).sort(), [200, 409], 'simultaneous demotions leave one owner');
});

test('migration: people who existed before roles all become owners, once', async () => {
  const pg = await PGlite.create({ parsers: { 20: (v) => Number(v) } });
  await pg.exec(SCHEMA.replace(/create table if not exists migrations[^;]*;/, '')); // an old station: no migrations table yet
  await pg.exec('drop table if exists memberships');
  const now = Date.now();
  for (const u of ['old1', 'old2']) {
    await pg.query("insert into users (id, username, password_hash, status, created_at, updated_at) values ($1, $1, 'x', 'active', $2, $2)", [u, now]);
  }
  await pg.exec(SCHEMA); // the new schema arrives
  setDb(pgliteDb(pg));
  const { db } = await import('../lib/db.js');
  await db();
  const rows = (await pg.query('select user_id, role_id from memberships order by user_id')).rows;
  assert.deepEqual(rows, [{ user_id: 'old1', role_id: 'owner' }, { user_id: 'old2', role_id: 'owner' }]);
  await pg.query("insert into users (id, username, password_hash, status, created_at, updated_at) values ('new1', 'new1', 'x', 'active', $1, $1)", [now]);
  setDb(pgliteDb(pg)); // a restart: the migration does not run again
  await db();
  assert.equal((await pg.query("select count(*)::int as n from memberships where user_id = 'new1'")).rows[0].n, 0);
});
