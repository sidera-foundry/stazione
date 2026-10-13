process.env.RECEPTION_DEFAULT = 'unrestricted'; // Legacy behaviour fixtures; reception.test.js covers manual defaults.
// Rooms: one astronaut per session, each bound for life to the room of its project; the Bridge manages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { TOTP, Secret } from 'otpauth';
import { setDb, pgliteDb } from '../lib/db.js';
import { normGit } from '../lib/routes/rooms.js';

process.env.PASSWORD_PEPPER ||= crypto.randomBytes(32).toString('base64');
process.env.DATA_ENCRYPTION_KEY ||= crypto.randomBytes(32).toString('base64');
process.env.INVITE_CODE ||= 'test-invite-code-0123456789';
process.env.HIBP_DISABLED = '1';

test('git remotes are recognised in every form', () => {
  for (const u of ['https://github.com/Bob/web-shop.git', 'git@github.com:Bob/web-shop.git', 'https://tok@github.com/bob/web-shop/', 'ssh://git@github.com/bob/web-shop']) {
    assert.equal(normGit(u), 'github.com/bob/web-shop', u);
  }
});

test('rooms: sessions get their own id, stay in their room, and "*" stays in the room', async () => {
  setDb(pgliteDb(await PGlite.create({ parsers: { 20: (v) => Number(v) } })));
  const { handleRequest } = await import('../lib/app.js');
  const jar = new Map();
  const call = async (method, path, body, token) => {
    const headers = new Headers({ 'x-real-ip': '10.8.0.1', 'content-type': 'application/json' });
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
  const hello = (as, join, extra = {}) => C('POST', '/api/claudes/heartbeat', { as, name: as, new: true, join, ...extra });

  // Two sessions from the same base id get different ids; the first joins the Bridge.
  const bridge = await hello('db', { bridge: true });
  assert.equal(bridge.body.id, 'db');
  assert.equal(bridge.body.room.kind, 'bridge');
  const cat1 = await hello('db', { project: 'Web Shop', key: 'ext-4815' }, { host: 'home-pc' });
  assert.equal(cat1.body.id, 'db-2', 'second live session of the same base gets its own astronaut');
  assert.equal(cat1.body.room.name, 'Web Shop');
  // Another PC with a differently written name, or only the external key, lands in the same room.
  assert.equal((await hello('bob', { project: 'web-shop' })).body.room.id, cat1.body.room.id);
  assert.equal((await hello('bob', { project: 'Online store', key: 'ext-4815' })).body.room.id, cat1.body.room.id);
  const other = await hello('zz', { project: 'Other Project', git: 'git@github.com:a/other.git' });
  assert.notEqual(other.body.room.id, cat1.body.room.id);
  assert.equal((await hello('zz', { project: 'Different name', git: 'https://github.com/a/other' })).body.room.id, other.body.room.id, 'same repo = same room');

  // An id is never handed to another session, however long it has been silent: only forget frees it.
  const dbx = await (await import('../lib/db.js')).db();
  await dbx.query("update claudes set last_seen = $1 where id = 'db-2'", [Date.now() - 365 * 86400e3]);
  const fresh = await hello('db', { project: 'Web Shop' });
  assert.notEqual(fresh.body.id, 'db-2', 'a year of silence is not enough to take its place');
  await dbx.query("update claudes set last_seen = $1 where id = 'db-2'", [Date.now()]);
  // The human removes an astronaut from the panel: only their own, only when silent; the id is free again.
  await dbx.query('update claudes set last_seen = $1 where id = $2', [Date.now() - 20 * 60e3, fresh.body.id]);
  assert.equal((await call('POST', '/api/claudes/db-2/forget-human', {})).status, 409, 'active: not removable');
  const removed = await call('POST', `/api/claudes/${fresh.body.id}/forget-human`, {});
  assert.equal(removed.body.forgotten, fresh.body.id, JSON.stringify(removed.body));
  assert.equal((await hello('db', { project: 'Web Shop' })).body.id, fresh.body.id, 'freed id is given again');
  await dbx.query('delete from claudes where id = $1', [fresh.body.id]);

  // A new session does not inherit the whole message history.
  assert.equal((await C('GET', '/api/inbox?as=db-2')).body.messages.length, 0);
  // The Bridge opens a room before anyone enters it; asking again (any spelling) returns the same room.
  const opened = await C('POST', '/api/rooms', { as: 'db', name: 'Product Site', goal: 'Landing page' });
  assert.equal(opened.status, 201);
  assert.equal(opened.body.room.goal, 'Landing page');
  const again = await C('POST', '/api/rooms', { as: 'db', name: 'product-site' });
  assert.deepEqual([again.status, again.body.created, again.body.room.id], [200, false, opened.body.room.id]);
  assert.equal((await C('POST', '/api/rooms', { as: 'db-2', name: 'Another' })).status, 403, 'only the Bridge opens rooms');
  assert.equal((await hello('site', { project: 'Product Site' })).body.room.id, opened.body.room.id, 'a session then enters it');

  // Bound for life: the same session cannot move to another project.
  const move = await C('POST', '/api/claudes/heartbeat', { as: 'db-2', name: 'x', join: { project: 'Other Project' } });
  assert.equal(move.status, 409);

  // Missions: created in the own room, claimed only there; the Bridge can create them anywhere.
  const own = await C('POST', '/api/tasks', { as: 'db-2', title: 'Search bar' });
  assert.equal(own.status, 200);
  assert.equal((await C('POST', '/api/tasks', { as: 'db-2', title: 'x', project: 'Other Project' })).status, 403);
  const fromBridge = await C('POST', '/api/tasks', { as: 'db', title: 'Shopping cart', project: 'web shop' });
  assert.equal(fromBridge.status, 200, JSON.stringify(fromBridge.body));
  assert.equal((await C('POST', `/api/tasks/${fromBridge.body.id}/claim`, { as: 'zz-2' })).status, 403, 'other room cannot claim');
  assert.equal((await C('POST', `/api/tasks/${fromBridge.body.id}/claim`, { as: 'db' })).status, 403, 'the Bridge does not execute project missions');
  assert.equal((await C('POST', `/api/tasks/${fromBridge.body.id}/claim`, { as: 'db-2' })).status, 200);
  assert.equal((await C('POST', '/api/tasks', { as: 'db', title: 'x', project: 'Web Shop', to: 'zz-2' })).status, 409, 'assignee must be in the room');
  // The announcement reached only the Web Shop room.
  const announced = (as) => C('GET', `/api/inbox?as=${as}`).then((r) => r.body.messages.some((m) => m.text.includes(fromBridge.body.id)));
  assert.equal(await announced('bob-2'), true);
  assert.equal(await announced('zz-2'), false);

  // Locks only in the own room, on the canonical project name.
  assert.equal((await C('POST', '/api/locks', { as: 'db-2', project: 'Other Project', resources: ['a'] })).status, 403);
  const lock = await C('POST', '/api/locks', { as: 'db-2', project: 'web shop', resources: ['src/catalog'] });
  assert.equal(lock.body.project, 'Web Shop');

  // "*" stays in the room, "**" reaches the whole station.
  await C('POST', '/api/messages', { as: 'zz-2', to: '*', text: 'only Other Project' });
  await C('POST', '/api/messages', { as: 'zz-2', to: '**', text: 'to the whole station' });
  const texts = (await C('GET', '/api/inbox?as=db-2')).body.messages.map((m) => m.text);
  assert.ok(!texts.includes('only Other Project'));
  assert.ok(texts.includes('to the whole station'));

  // Old sessions can be removed by their own user once silent, never while active, never yourself.
  assert.equal((await C('POST', '/api/claudes/db-2/forget', { as: 'db' })).status, 409, 'still active');
  assert.equal((await C('POST', '/api/claudes/db/forget', { as: 'db' })).status, 400, 'not yourself');
  await C('POST', '/api/claudes/heartbeat', { as: 'old', name: 'Old' });
  // Pretend it went silent 20 minutes ago.
  const { db } = await import('../lib/db.js');
  await (await db()).query('update claudes set last_seen = $2 where id = $1', ['old', Date.now() - 20 * 60e3]);
  const gone = await C('POST', '/api/claudes/old/forget', { as: 'db' });
  assert.equal(gone.body.forgotten, 'old', JSON.stringify(gone.body));
  assert.ok(!(await call('GET', '/api/state')).body.claudes.some((c) => c.id === 'old'));

  // A session that went silent (e.g. out of tokens) does not block the room: its locks stop counting after 15 min,
  // its mission can be taken over after 30 min.
  const t2 = (await C('POST', '/api/tasks', { as: 'bob-2', title: 'Job left half done' })).body.id;
  await C('POST', `/api/tasks/${t2}/claim`, { as: 'bob-2' });
  await C('POST', '/api/locks', { as: 'bob-2', project: 'Web Shop', resources: ['src/search'] });
  assert.equal((await C('POST', '/api/locks', { as: 'db-2', project: 'Web Shop', resources: ['src/search'] })).status, 409, 'alive: blocked');
  assert.equal((await C('POST', `/api/tasks/${t2}/claim`, { as: 'db-2' })).status, 409, 'alive: not taken over');
  await C('PATCH', `/api/tasks/${t2}`, { as: 'bob-2', checkpoint: 'Search done, the price filter is missing' });
  await (await db()).query('update claudes set last_seen = $2 where id = $1', ['bob-2', Date.now() - 31 * 60e3]);
  assert.equal((await C('POST', '/api/locks', { as: 'db-2', project: 'Web Shop', resources: ['src/search'] })).status, 200, 'silent: lock released');
  const taken = await C('POST', `/api/tasks/${t2}/claim`, { as: 'db-2' });
  assert.equal(taken.status, 200, 'silent: mission taken over');
  assert.match(taken.body.task.checkpoint, /the price filter is missing/, 'whoever takes over sees where it stopped');

  // The wait loop keeps locks alive only while the Claude itself is active: its polls do not count as activity.
  await C('GET', '/api/inbox?as=db-2&wait=1');
  assert.ok((await C('POST', '/api/locks/renew', { as: 'db-2', auto: true })).body.renewed.length > 0, 'active: renewed');
  await (await db()).query('update claudes set last_active = $2 where id = $1', ['db-2', Date.now() - 61 * 60e3]);
  await C('GET', '/api/inbox?as=db-2&wait=1');
  assert.ok((await C('POST', '/api/locks/renew', { as: 'db-2', auto: true })).body.skipped, 'idle model: not renewed');
  // A mission without a project belongs to the Bridge.
  const loose = (await call('POST', '/api/tasks', { title: 'Remove the locks' })).body.id;
  assert.equal((await C('POST', `/api/tasks/${loose}/claim`, { as: 'db' })).status, 200);
  assert.equal((await C('POST', `/api/tasks/${loose}/claim`, { as: 'zz-2' })).status, 403, 'only the Bridge takes missions without a project');

  // After a stop, the last messages can be read again even if already marked read.
  assert.ok((await C('GET', '/api/inbox?as=db-2&recent=3')).body.messages.length > 0);

  // A room opened by mistake is merged into the right one: astronauts and missions move, the name is learnt.
  const dup = await hello('dup', { project: 'Project Other' });
  const dupTask = (await C('POST', '/api/tasks', { as: 'dup', title: 'In the wrong room' })).body.id;
  assert.equal((await C('POST', `/api/rooms/${dup.body.room.id}/merge`, { as: 'zz', into: other.body.room.id })).status, 403, 'only the Bridge');
  const merged = await C('POST', `/api/rooms/${dup.body.room.id}/merge`, { as: 'db', into: other.body.room.id });
  assert.equal(merged.status, 200, JSON.stringify(merged.body));
  const after = (await call('GET', '/api/state')).body;
  assert.ok(!after.rooms.some((r) => r.id === dup.body.room.id), 'the duplicate is gone');
  assert.equal(after.claudes.find((c) => c.id === 'dup').room, other.body.room.id);
  assert.equal(after.tasks.find((t) => t.id === dupTask).project, 'Other Project');
  assert.equal((await hello('dup2', { project: 'project other' })).body.room.id, other.body.room.id, 'the old name now leads to the right room');

  // The board knows rooms, and where each astronaut is.
  const st = (await call('GET', '/api/state')).body;
  assert.ok(st.rooms.some((r) => r.kind === 'bridge'));
  assert.equal(st.rooms.find((r) => r.name === 'Web Shop').type, 'general', 'an external key alone keeps it general');
  assert.equal(st.rooms.find((r) => r.name === 'Other Project').type, 'code', 'a git remote makes it a code room');
  assert.equal(st.claudes.find((c) => c.id === 'db-2').host, 'home-pc');
  // An astronaut can be given its own colour; only a real #rrggbb is accepted, "" goes back to the automatic one.
  assert.equal((await C('POST', '/api/claudes/heartbeat', { as: 'db-2', color: 'purple' })).status, 400);
  await C('POST', '/api/claudes/heartbeat', { as: 'db-2', color: '#BF00FF' });
  const colourOf = async () => (await call('GET', '/api/state')).body.claudes.find((c) => c.id === 'db-2').color;
  assert.equal(await colourOf(), '#bf00ff');
  await C('POST', '/api/claudes/heartbeat', { as: 'db-2' });
  assert.equal(await colourOf(), '#bf00ff', 'a plain beat keeps it');
  await C('POST', '/api/claudes/heartbeat', { as: 'db-2', color: '' });
  assert.equal(await colourOf(), null);
});
