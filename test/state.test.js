process.env.RECEPTION_DEFAULT = 'unrestricted'; // Legacy behaviour fixtures; reception.test.js covers manual defaults.
// /api/state: astronaut roles; read messages older than 30 days become a one-line summary; ?room= and ?as= download only one room.
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

test('state: old read messages are archived, room filter keeps one room', async () => {
  const pg = await PGlite.create({ parsers: { 20: (v) => Number(v) } });
  setDb(pgliteDb(pg));
  const { handleRequest } = await import('../lib/app.js');
  const jar = new Map();
  const call = async (method, path, body, token) => {
    const headers = new Headers({ 'x-real-ip': '10.8.0.2', 'content-type': 'application/json' });
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
  const hello = (as, join) => C('POST', '/api/claudes/heartbeat', { as, name: as, new: true, join });

  const pl = (await hello('pl', { bridge: true })).body;
  const cat = (await hello('cat', { project: 'Web Shop' })).body;
  await C('POST', '/api/messages', { as: 'pl', to: 'cat', text: 'new for cat', project: 'stazione' });
  await C('POST', '/api/messages', { as: 'cat', to: '*', text: 'hello cat room', project: 'Web Shop' });
  await C('POST', '/api/tasks', { as: 'cat', title: 'cat mission', project: 'Web Shop' });
  await C('POST', '/api/tasks', { as: 'pl', title: 'bridge mission', project: 'stazione' });

  // Two messages from 40 days ago: one read by cat, one never read (it stays visible).
  const old = Date.now() - 40 * 86400e3;
  await pg.query(`insert into messages (from_claude, to_target, text, project, room, created_at) values
    ('pl', 'cat', 'old read', '', $1, $2), ('pl', 'nobody', 'old unread', '', $1, $2)`, [cat.room.id, old]);
  await pg.query('update claudes set inbox_read_at = $2 where id = $1', ['cat', old + 1]);

  const all = (await C('GET', '/api/state')).body;
  const texts = all.messages.map((m) => m.text);
  assert.ok(!texts.includes('old read'), 'old read message is out of the state');
  assert.ok(texts.includes('old unread'), 'old unread message stays');
  assert.equal(all.archived.count, 1);
  assert.match(all.archived.summary, /1 read message archived/);

  // Only the Web Shop room: its crew, missions and room messages; other rooms become a count.
  for (const q of [`room=${cat.room.id}`, 'as=cat']) {
    const s = (await C('GET', `/api/state?${q}`)).body;
    assert.deepEqual(s.claudes.map((c) => c.id), ['cat'], q);
    assert.deepEqual(s.tasks.map((t) => t.title), ['cat mission'], q);
    assert.ok(s.messages.every((m) => m.room === cat.room.id || m.to === 'cat' || m.to === '**'), q);
    assert.ok(s.messages.some((m) => m.text === 'hello cat room'), q);
    assert.equal(s.otherRooms[pl.room.id], 1, q);
  }
  assert.equal((await C('GET', '/api/state?room=nope')).status, 404);

  // Role of the astronaut: chosen on the heartbeat, kept afterwards, shown in the state.
  assert.equal((await C('POST', '/api/claudes/heartbeat', { as: 'cat', role: 'pirate' })).status, 400);
  await C('POST', '/api/claudes/heartbeat', { as: 'cat', role: 'design' });
  await C('POST', '/api/claudes/heartbeat', { as: 'cat', status: 'working' });
  const s = (await C('GET', '/api/state')).body;
  assert.equal(s.claudes.find((c) => c.id === 'cat').role, 'design');
  assert.equal(s.claudes.find((c) => c.id === 'pl').role, 'general');

  // Recaps: written by a Claude for its room, shown in the state (and in the room filter); no sensitive data.
  assert.equal((await C('POST', '/api/recaps', { as: 'cat', title: 'Today', text: 'Checkout redone, the test is missing' })).status, 200);
  assert.equal((await C('POST', '/api/recaps', { as: 'cat', title: 'x', text: 'password: hunter2hunter2' })).status, 422);
  assert.deepEqual((await C('GET', `/api/state?room=${cat.room.id}`)).body.recaps.map((r) => r.title), ['Today']);
  assert.equal((await C('GET', `/api/state?room=${pl.room.id}`)).body.recaps.length, 0);

  // A human releases the locks of their own Claudes (e.g. out of tokens); the Claude is told; others' are untouched.
  await C('POST', '/api/locks', { as: 'cat', project: 'Web Shop', resources: ['src/a', 'src/b'], ttl: 30 });
  assert.equal((await C('POST', '/api/locks/release-human', { owner: 'cat' })).status, 403, 'a Claude token cannot use it');
  const rel = (await call('POST', '/api/locks/release-human', { owner: 'cat', resource: 'src/a' })).body;
  assert.deepEqual(rel.released.map((l) => l.resource), ['src/a']);
  assert.deepEqual((await C('GET', '/api/state')).body.locks.filter((l) => l.owner === 'cat').map((l) => l.resource), ['src/b']);
  assert.ok((await C('GET', '/api/inbox?as=cat')).body.messages.some((m) => m.text.includes('released your lock on src/a from the panel')));
  await call('POST', '/api/locks/release-human', { owner: 'cat' });

  // Priority and deadline: validated, shown in the state, changeable and clearable.
  const urg = (await C('POST', '/api/tasks', { as: 'cat', title: 'urgent', priority: 'high', due: '2026-10-05' })).body.id;
  assert.equal((await C('POST', '/api/tasks', { as: 'cat', title: 'x', due: '2026-02-30' })).status, 400, 'not a real day');
  assert.equal((await C('POST', '/api/tasks', { as: 'cat', title: 'x', priority: 'asap' })).status, 400);
  const tOf = async () => (await C('GET', '/api/state')).body.tasks.find((t) => t.id === urg);
  assert.deepEqual([(await tOf()).priority, (await tOf()).due], ['high', '2026-10-05']);
  await C('PATCH', `/api/tasks/${urg}`, { as: 'cat', priority: 'low', due: '' });
  assert.deepEqual([(await tOf()).priority, (await tOf()).due], ['low', null]);
  assert.equal((await C('POST', '/api/tasks', { as: 'cat', title: 'normal' })).status, 200);

  // Silent session with a mission: reported once to its human on Telegram, again only after it came back and went quiet.
  const { sweepSilent } = await import('../lib/silent.js');
  const { db } = await import('../lib/db.js');
  const mission = (await C('POST', '/api/tasks', { as: 'cat', title: 'long job' })).body.id;
  await C('POST', `/api/tasks/${mission}/claim`, { as: 'cat' });
  await pg.query("update users set telegram_chat_id = 4242 where username = 'boss'");
  const later = Date.now() + 21 * 60e3;
  assert.deepEqual(await sweepSilent(await db(), later, true), ['cat'], 'silent for 21 min with a mission');
  assert.deepEqual(await sweepSilent(await db(), later + 60e3, true), [], 'not repeated');
  const back = later + 5 * 60e3; // on the same (simulated) clock: it comes back...
  await pg.query("update claudes set last_seen = $1 where id = 'cat'", [back]);
  assert.deepEqual(await sweepSilent(await db(), back + 60e3, true), [], 'alive: nothing');
  assert.deepEqual(await sweepSilent(await db(), back + 21 * 60e3, true), ['cat'], '...and goes silent again');
  await pg.query('update users set telegram_chat_id = null');

  // Telegram commands: short replies built from what the panel shows.
  const { commandReply } = await import('../lib/tgcommands.js');
  const [boss] = await pg.query("select id from users where username = 'boss'").then((r) => r.rows);
  const dbq = await db();
  assert.match(await commandReply(dbq, boss.id, '/status', Date.now()), /Station status[\s\S]*Missions: \d+ to assign/);
  const miss = await commandReply(dbq, boss.id, '/missions@StazioneBot', Date.now());
  assert.match(miss.split('\n')[1], /urgent|long job|mission/, 'one line per mission');
  assert.match(await commandReply(dbq, boss.id, '/recaps', Date.now()), /Today/);
  assert.equal(await commandReply(dbq, boss.id, 'hello', Date.now()), null);

  // Daily digest: sent once per local day to whoever has Telegram linked, never twice, and it can be switched off.
  process.env.TIMEZONE = 'Europe/Rome'; // a zone with summer time, to test the day boundaries
  const { sweepDigest, buildDigest, localDay } = await import('../lib/digest.js');
  assert.deepEqual([localDay(Date.UTC(2026, 6, 1, 22, 30)).day, localDay(Date.UTC(2026, 6, 1, 22, 30)).hour], ['2026-07-02', 0], 'summer time: UTC+2');
  assert.equal(localDay(Date.UTC(2026, 0, 10, 12)).start, Date.UTC(2026, 0, 9, 23), 'winter day starts at 23:00 UTC');
  await pg.query("update users set telegram_chat_id = 4242 where username = 'boss'");
  const evening = localDay(Date.now()).start + 21 * 3600e3;
  assert.deepEqual(await sweepDigest(dbq, evening, true), [boss.id]);
  assert.deepEqual(await sweepDigest(dbq, evening + 3600e3, true), [], 'once a day');
  assert.deepEqual(await sweepDigest(dbq, evening + 12 * 3600e3, true), [], 'next morning: that day was already sent');
  assert.deepEqual(await sweepDigest(dbq, evening + 24 * 3600e3, true), [boss.id], 'next evening');
  assert.match(await commandReply(dbq, boss.id, '/digest off', Date.now()), /no more evening digest/);
  assert.deepEqual(await sweepDigest(dbq, evening + 48 * 3600e3, true), [], 'switched off');
  await pg.query('update users set telegram_chat_id = null');
  await C('PATCH', `/api/tasks/${urg}`, { as: 'cat', status: 'done' });
  const today = localDay(Date.now());
  assert.match(await buildDigest(dbq, boss.id, today.start, today.end, Date.now(), 'Today so far'), /Today so far[\s\S]*1 mission closed[\s\S]*Still open/);
  assert.match(await commandReply(dbq, boss.id, '/today', Date.now()), /Still open/);

  // Logbook: recaps, closed missions and decisions of one room, newest first; nothing from other rooms.
  await C('PATCH', `/api/tasks/${mission}`, { as: 'cat', status: 'done', note: 'finished' });
  await C('POST', '/api/decisions', { as: 'cat', project: 'Web Shop', text: 'A single endpoint' });
  const diary = (await C('GET', `/api/journal?room=${cat.room.id}`)).body;
  assert.deepEqual(new Set(diary.items.map((i) => i.type)), new Set(['recap', 'mission', 'decision']));
  assert.ok(diary.items.every((x, i, a) => !i || a[i - 1].at >= x.at), 'newest first');
  assert.ok(!(await C('GET', '/api/journal?room=bridge')).body.items.some((i) => i.title === 'Today'), 'other rooms stay out');
  assert.equal((await C('GET', '/api/journal?room=nope')).status, 404);

  // Statistics: missions closed per session and per room, average time from claim to done, one room or all.
  const st1 = (await C('POST', '/api/tasks', { as: 'cat', title: 'for the statistics' })).body.id;
  await C('POST', `/api/tasks/${st1}/claim`, { as: 'cat' });
  await C('PATCH', `/api/tasks/${st1}`, { as: 'cat', status: 'done' });
  await pg.query("update tasks set claimed_at = updated_at - 3600000 where owner_claude = 'cat' and status = 'done'"); // each took an hour
  const stats = (await C('GET', '/api/stats')).body;
  const catStats = stats.sessions.find((x) => x.id === 'cat');
  assert.ok(catStats.closed >= 2 && catStats.closed7 >= 2, 'both closed missions counted');
  assert.ok(catStats.avgMinutes >= 59 && catStats.avgMinutes <= 61, 'claim → done, about an hour');
  assert.ok(stats.rooms.some((r) => r.name === 'Web Shop' && r.closed >= 2));
  assert.ok(stats.closedAt.length >= 2);
  assert.deepEqual((await C('GET', `/api/stats?room=${pl.room.id}`)).body.sessions.filter((x) => x.id === 'cat'), [], 'other rooms stay out');
  assert.equal((await C('GET', '/api/stats?room=nope')).status, 404);

  // Opinion: free answer from the human, delivered to the Claude as a message; yes/no is refused.
  const par = (await C('POST', '/api/asks', { as: 'cat', kind: 'opinion', text: 'One endpoint or two?' })).body;
  assert.equal((await call('POST', `/api/asks/${par.id}`, { approve: true })).status, 400);
  assert.equal((await call('GET', '/api/asks')).body.asks[0].kind, 'opinion');
  assert.equal((await call('POST', `/api/asks/${par.id}`, { answer: 'Just one' })).status, 200);
  const inbox = (await C('GET', '/api/inbox?as=cat')).body.messages;
  assert.ok(inbox.some((m) => m.text.includes('OPINION: Just one')));
});
