process.env.RECEPTION_DEFAULT = 'unrestricted'; // Legacy behaviour fixtures; reception.test.js covers manual defaults.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { setDb, pgliteDb, db } from '../lib/db.js';
import { createSession } from '../lib/auth.js';
import { sha256, hashIp } from '../lib/crypto.js';
import { buildDigest } from '../lib/digest.js';
import { commandReply } from '../lib/tgcommands.js';
import { TOTP, Secret } from 'otpauth';

process.env.PASSWORD_PEPPER ||= crypto.randomBytes(32).toString('base64');
process.env.DATA_ENCRYPTION_KEY ||= crypto.randomBytes(32).toString('base64');
process.env.HIBP_DISABLED = '1'; process.env.MAX_USERS = '10';

test('room access: no hidden content or counts, effective roles, revoked agents, categories and room invites', async () => {
  const pg = await PGlite.create({ parsers: { 20: (v) => Number(v) } }); setDb(pgliteDb(pg));
  const q = await db(), { handleRequest } = await import('../lib/app.js');
  let sequence = 0;
  const client = (token, cookie) => {
    const jar = new Map(cookie ? [['__Host-stz_s', cookie]] : []), ip = `10.80.0.${++sequence}`;
    return async (method, path, body) => {
      const headers = new Headers({ origin: 'http://localhost', 'x-real-ip': ip, 'content-type': 'application/json' });
      if (token) headers.set('authorization', `Bearer ${token}`); else headers.set('cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '));
      const res = await handleRequest(new Request(`http://localhost${path}`, { method, headers, body: body && JSON.stringify(body) }));
      for (const c of res.headers.getSetCookie()) { const [k, v] = c.split(';')[0].split('='); jar.set(k, v); }
      return { status: res.status, body: await res.json() };
    };
  };
  const human = async (id, role) => {
    await q.query("insert into users (id, username, password_hash, status, created_at, updated_at) values ($1, $1, 'fixture', 'active', $2, $2)", [id, Date.now()]);
    await q.query("insert into memberships (user_id, org_id, role_id, updated_at) values ($1, 'default', $2, $3)", [id, role, Date.now()]);
    const session = await createSession(q, id, 'session', Date.now());
    await q.query('update sessions set admin_until=$2,ip_hash=$3 where id_hash=$1', [sha256(session.token), Date.now() + 300000, hashIp(`10.80.0.${sequence + 1}`)]);
    return client(null, session.token);
  };
  const boss = await human('boss', 'owner'), outside = await human('outside', 'member'), inside = await human('inside', 'guest');
  const bot = client((await boss('POST', '/api/tokens', { name: 'boss bot' })).body.token);
  const open = (await boss('POST', '/api/rooms', { name: 'Public work' })).body.room;
  const hidden = (await boss('POST', '/api/rooms', { name: 'Private work' })).body.room;
  assert.equal(hidden.visibility, 'open', 'migration and creation preserve open visibility');
  assert.equal((await boss('PUT', `/api/rooms/${hidden.id}/visibility`, { visibility: 'restricted' })).status, 200);
  await boss('PUT', `/api/people/inside/rooms/${hidden.id}/role`, { role: 'lead' });
  await bot('POST', '/api/claudes/heartbeat', { as: 'private-bot', name: 'Private bot', join: { project: hidden.project } });
  await bot('POST', '/api/claudes/heartbeat', { as: 'public-bot', name: 'Public bot', join: { project: open.project } });
  const mission = (await bot('POST', '/api/tasks', { as: 'private-bot', title: 'Private mission marker' })).body.id;
  await bot('POST', `/api/tasks/${mission}/claim`, { as: 'private-bot' });
  await bot('PATCH', `/api/tasks/${mission}`, { as: 'private-bot', status: 'done' });
  await bot('POST', '/api/recaps', { as: 'private-bot', title: 'Private recap marker', text: 'Private body marker' });
  await bot('PUT', `/api/context/${encodeURIComponent(hidden.project)}`, { as: 'private-bot', summary: 'Private context marker' });
  await bot('POST', '/api/messages', { as: 'private-bot', to: '**', text: 'Private broadcast marker' });
  const poll = (await bot('POST', '/api/polls', { as: 'private-bot', text: 'Private poll marker?', options: ['Yes', 'No'] })).body.id;
  await bot('POST', `/api/polls/${poll}/vote`, { as: 'private-bot', choice: 1, reason: 'Private vote marker' });

  const state = (await outside('GET', '/api/state')).body;
  assert.ok(!JSON.stringify(state).includes('Private'), JSON.stringify(state));
  assert.equal((await outside('GET', `/api/state?room=${hidden.id}`)).status, 404);
  assert.equal((await outside('GET', `/api/context/${encodeURIComponent(hidden.project)}`)).status, 404);
  assert.equal((await outside('GET', `/api/polls/${poll}`)).status, 404);
  assert.equal((await outside('POST', `/api/polls/${poll}/vote`, { choice: 1 })).status, 404);
  assert.equal((await outside('PATCH', `/api/tasks/${mission}`, { status: 'open', room: open.id })).status, 404);
  assert.equal((await outside('POST', '/api/tasks', { title: 'Spoofed scope', project: hidden.project, room: open.id })).status, 404);
  assert.equal((await outside('GET', `/api/journal?room=${hidden.id}`)).status, 404);
  assert.equal((await outside('GET', '/api/stats')).body.closedAt.length, 0);
  assert.ok(!JSON.stringify((await outside('GET', '/api/rooms')).body).includes(hidden.id));
  const digest = await buildDigest(q, 'outside', 0, Date.now() + 1000, Date.now(), 'Digest');
  assert.ok(!String(digest).includes('Private'));
  for (const cmd of ['/status', '/missions', '/recaps', '/today', '/polls']) assert.ok(!(await commandReply(q, 'outside', cmd, Date.now())).includes('Private'), cmd);
  assert.match(await commandReply(q, 'outside', `/vote ${poll} 1`, Date.now()), /Room not found/);

  assert.equal((await inside('GET', `/api/state?room=${hidden.id}`)).body.me.role, 'lead');
  assert.equal((await inside('POST', '/api/tasks', { project: hidden.project, title: 'Lead assigned mission', priority: 'high' })).status, 200);
  assert.equal((await inside('POST', '/api/tasks', { project: open.project, title: 'Not a lead here' })).status, 403);
  assert.match(await commandReply(q, 'inside', '/mission Private work: A scoped mission', Date.now()), /launched/);
  const leadInvite = await inside('POST', '/api/invites', { role: 'guest', roomRoles: [{ room: hidden.id, role: 'member' }] });
  assert.equal(leadInvite.status, 201, 'a room lead may invite only within their room and organization powers');
  assert.equal((await inside('GET', '/api/invites')).body.invites[0].id, leadInvite.body.id);
  assert.equal((await inside('POST', `/api/invites/${leadInvite.body.id}/revoke`, {})).status, 200);
  assert.equal((await inside('POST', '/api/invites', { role: 'member', roomRoles: [{ room: hidden.id, role: 'member' }] })).status, 403, 'room authority cannot grant organization permissions');
  // A room role never grants organization administration.
  await boss('PUT', `/api/people/inside/rooms/${hidden.id}/role`, { role: 'admin' });
  assert.equal((await inside('POST', '/api/roles', { room: hidden.id, name: 'Unauthorized role', permissions: [] })).status, 403);
  assert.equal((await inside('POST', '/api/rooms', { room: hidden.id, name: 'Unauthorized room' })).status, 403);
  await boss('PUT', `/api/people/inside/rooms/${hidden.id}/role`, { role: 'lead' });

  const categories = (await inside('GET', `/api/idea-categories?room=${hidden.id}`)).body.categories;
  assert.equal(categories[0].name, 'General');
  const category = (await inside('POST', '/api/idea-categories', { room: hidden.id, name: 'Leads only', viewRoles: ['lead'], writeRoles: ['lead'] })).body.id;
  const note = (await inside('POST', '/api/notes', { room: hidden.id, category, text: 'Private idea marker' })).body.id;
  assert.equal((await inside('GET', `/api/notes?room=${hidden.id}`)).body.total, 1);
  assert.equal((await boss('GET', `/api/notes?room=${hidden.id}`)).body.total, 0, 'categories honor roles even for owners');
  assert.equal((await outside('POST', `/api/notes/${note}/pin`, { pinned: true })).status, 404);
  assert.equal((await outside('GET', '/api/notes')).body.total, 0);
  assert.equal((await bot('GET', `/api/notes?room=${hidden.id}`)).status, 403, 'agents never see ideas');
  const guestToken = (await outside('POST', '/api/tokens', { name: 'outside bot' })).body.token;
  const outsiderBot = client(guestToken);
  assert.equal((await outsiderBot('POST', '/api/claudes/heartbeat', { as: 'outsider-bot', name: 'Outside', join: { project: hidden.project } })).status, 404);
  // Existing agents lose access on the next request after an assignment is removed.
  await boss('PUT', '/api/people/outside/rooms/' + hidden.id + '/role', { role: 'member' });
  assert.equal((await outsiderBot('POST', '/api/claudes/heartbeat', { as: 'outsider-bot', name: 'Outside', join: { project: hidden.project } })).status, 200);
  await boss('PUT', '/api/people/outside/rooms/' + hidden.id + '/role', { role: 'guest' });
  assert.equal((await outsiderBot('POST', '/api/messages', { as: 'outsider-bot', to: '*', text: 'No permission', project: open.project })).status, 403, 'metadata cannot bypass the effective room role');
  assert.equal((await outsiderBot('POST', '/api/recaps', { as: 'outsider-bot', title: 'No permission', text: 'No permission', project: open.project })).status, 403);
  await boss('PUT', '/api/people/outside/rooms/' + hidden.id + '/role', { role: null });
  assert.equal((await outsiderBot('GET', '/api/inbox?as=outsider-bot')).status, 404);
  assert.equal((await outsiderBot('POST', '/api/messages', { as: 'outsider-bot', to: '*', text: 'No longer allowed' })).status, 404);

  const invite = await boss('POST', '/api/invites', { role: 'guest', roomRoles: [{ room: hidden.id, role: 'member' }] });
  const newcomer = client(), enrollment = await newcomer('POST', '/api/auth/register/start', { username: 'newcomer', invite: invite.body.code, password: 'correct horse battery staple 42' });
  assert.equal(enrollment.status, 200, JSON.stringify(enrollment.body));
  assert.equal((await newcomer('POST', '/api/auth/register/confirm', { code: new TOTP({ secret: Secret.fromBase32(enrollment.body.secret) }).generate() })).status, 200);
  assert.equal((await newcomer('GET', `/api/state?room=${hidden.id}`)).body.me.role, 'member');
  assert.equal((await boss('POST', `/api/rooms/${hidden.id}/merge`, { into: open.id })).status, 409, 'cannot widen visibility by merging');
  await pg.close();
});
