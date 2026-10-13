process.env.RECEPTION_DEFAULT = 'unrestricted'; // Legacy behaviour fixtures; reception.test.js covers manual defaults.
// Polls: a room votes, the majority becomes a decision, a tie goes to the humans, other rooms stay out.
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

test('votes: majority decides, ties go to the humans, rooms stay separate', async () => {
  setDb(pgliteDb(await PGlite.create({ parsers: { 20: (v) => Number(v) } })));
  const { handleRequest } = await import('../lib/app.js');
  const { db } = await import('../lib/db.js');
  const jar = new Map();
  const call = async (method, path, body, token) => {
    const headers = new Headers({ 'x-real-ip': '10.9.0.1', 'content-type': 'application/json' });
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
  for (const [as, join] of [['aa', { project: 'Storefront' }], ['bb', { project: 'Storefront' }], ['cc', { project: 'Storefront' }], ['zz', { project: 'Other' }]]) {
    await C('POST', '/api/claudes/heartbeat', { as, name: as, join });
  }
  const texts = (as) => C('GET', `/api/inbox?as=${as}`).then((r) => r.body.messages.map((m) => m.text).join('\n'));

  // Opening: 2-5 different options; the room is told, the other rooms are not.
  assert.equal((await C('POST', '/api/polls', { as: 'aa', text: 'Which engine do we use?', options: ['one'] })).status, 400);
  const v = (await C('POST', '/api/polls', { as: 'aa', text: 'Which engine do we use?', options: ['Old', 'New'] })).body.id;
  assert.match(v, /^V-/);
  assert.match(await texts('bb'), new RegExp(`Poll ${v}`));
  assert.doesNotMatch(await texts('zz'), /Poll/);

  // Voting: a reason is required, other rooms cannot vote, a vote can be changed, one ballot per session.
  assert.equal((await C('POST', `/api/polls/${v}/vote`, { as: 'bb', choice: 2 })).status, 400, 'no reason');
  assert.equal((await C('POST', `/api/polls/${v}/vote`, { as: 'zz', choice: 2, reason: 'just passing by' })).status, 403);
  assert.equal((await C('POST', `/api/polls/${v}/vote`, { as: 'bb', choice: 3, reason: 'does not exist' })).status, 400);
  await C('POST', `/api/polls/${v}/vote`, { as: 'aa', choice: 1, reason: 'it is already proven' });
  await C('POST', `/api/polls/${v}/vote`, { as: 'bb', choice: 1, reason: 'changing my mind at once' });
  const open = await C('POST', `/api/polls/${v}/vote`, { as: 'bb', choice: 2, reason: 'it is faster' });
  assert.equal(open.body.status, 'open', 'cc has not voted yet');
  // The last active session votes: it closes at once, the majority is recorded as a decision and everybody is told.
  const last = await C('POST', `/api/polls/${v}/vote`, { as: 'cc', choice: 2, reason: 'less code to maintain' });
  assert.equal(last.body.status, 'closed');
  const st = (await call('GET', '/api/state')).body;
  const poll = st.polls.find((p) => p.id === v);
  assert.equal(poll.winner, 'New');
  assert.deepEqual(poll.counts, [1, 2]);
  assert.ok(st.decisions.some((d) => d.text.includes(v) && d.text.includes('New')));
  assert.match(await texts('aa'), /CLOSED.*New/);
  assert.equal((await C('POST', `/api/polls/${v}/vote`, { as: 'aa', choice: 2, reason: 'too late' })).status, 409);

  // A tie at the deadline goes to the humans; only a human can then settle it.
  const t = (await C('POST', '/api/polls', { as: 'aa', text: 'Red or blue for the menu?', options: ['Red', 'Blue'] })).body.id;
  await (await db()).query('update claudes set last_seen = $1 where id = $2', [Date.now() - 20 * 60e3, 'cc']); // cc is away: it does not hold the vote
  await C('POST', `/api/polls/${t}/vote`, { as: 'aa', choice: 1, reason: 'it reads better' });
  const tie = await C('POST', `/api/polls/${t}/vote`, { as: 'bb', choice: 2, reason: 'it is the logo colour' });
  assert.equal(tie.body.status, 'tie');
  assert.equal((await C('POST', `/api/polls/${t}/close`, { as: 'aa' })).status, 409);
  assert.equal((await call('POST', `/api/polls/${t}/close`, {})).status, 400, 'a human must choose');
  const settled = await call('POST', `/api/polls/${t}/close`, { choice: 2 });
  assert.equal(settled.body.winner, 'Blue');
  assert.match(await texts('aa'), /Blue.*boss \(human\)/);

  // Deadline with a clear majority: closed by the sweep on the next call. Only the opener may close early.
  const d = (await C('POST', '/api/polls', { as: 'bb', text: 'Do we keep music in the menu?', options: ['Yes', 'No'], all: true })).body.id;
  assert.match(await texts('zz'), new RegExp(d), 'a station-wide vote reaches every room');
  await C('POST', `/api/polls/${d}/vote`, { as: 'zz', choice: 1, reason: 'it sets the mood' });
  assert.equal((await C('POST', `/api/polls/${d}/close`, { as: 'aa' })).status, 403);
  await (await db()).query('update polls set expires_at = $1 where id = $2', [Date.now() - 1000, d]);
  assert.equal((await C('GET', `/api/polls/${d}`)).body.winner, 'Yes');
  // Humans vote from the panel too.
  const h = (await C('POST', '/api/polls', { as: 'aa', text: 'Do we release on Friday?', options: ['Yes', 'No'] })).body.id;
  assert.equal((await call('POST', `/api/polls/${h}/vote`, { choice: 1 })).status, 200);
  assert.equal((await C('GET', `/api/polls/${h}`)).body.ballots[0].voter, 'human:boss');

  // A human opens a vote from the panel, in one room; the room is told, the others are not.
  const storefront = (await call('GET', '/api/state')).body.rooms.find((r) => r.name === 'Storefront');
  const hp = await call('POST', '/api/polls', { text: 'What do we call the product?', options: ['Atlas', 'Orbit'], room: storefront.id });
  assert.equal(hp.status, 200, JSON.stringify(hp.body));
  assert.match(await texts('bb'), new RegExp(hp.body.id));
  assert.doesNotMatch(await texts('zz'), new RegExp(hp.body.id));
  assert.equal((await C('GET', `/api/polls/${hp.body.id}`)).body.by, 'human:boss');

  // Project page: goal and milestones of a room, set by the humans or by that room's sessions; the room is told.
  const set = await call('PUT', `/api/rooms/${storefront.id}/project`, { goal: 'First version by October', milestones: [{ text: 'Login' }, { text: 'Catalog', done: true }] });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.match(await texts('aa'), /Project of the Storefront room updated.*First version.*milestones 1\/2 done, next: Login/);
  assert.equal((await C('PUT', `/api/rooms/${storefront.id}/project`, { as: 'zz', goal: 'x' })).status, 403, 'another room cannot');
  assert.equal((await C('PUT', `/api/rooms/${storefront.id}/project`, { as: 'aa', milestones: [{ text: 'Login', done: true }, { text: 'Catalog', done: true }] })).status, 200);
  const page = (await call('GET', '/api/state')).body.rooms.find((r) => r.id === storefront.id);
  assert.deepEqual([page.goal, page.milestones.filter((m) => m.done).length], ['First version by October', 2]);

  // Telegram: missions and votes from the phone.
  const { commandReply } = await import('../lib/tgcommands.js');
  const dbq = await db();
  const [boss] = await dbq.query("select id from users where username = 'boss'");
  const now = () => Date.now();
  assert.match(await commandReply(dbq, boss.id, '/mission storefront: Redo the menu', now()), /launched in the Storefront room/);
  assert.match(await texts('aa'), /New mission T-.*Redo the menu/);
  assert.match(await commandReply(dbq, boss.id, '/mission', now()), /Rooms:/);
  const opened = await commandReply(dbq, boss.id, '/poll Music in the menu? | Yes | No', now());
  const tv = opened.match(/V-[A-Z0-9-]+/)[0];
  assert.match(await commandReply(dbq, boss.id, '/polls', now()), new RegExp(tv));
  assert.match(await commandReply(dbq, boss.id, `/vote ${tv} 2`, now()), /Vote recorded: No/);
  assert.match(await commandReply(dbq, boss.id, `/vote ${tv} 9`, now()), /⚠️/, 'a wrong option is answered, not thrown');
});
