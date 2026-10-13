import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { db, setDb, pgliteDb } from '../lib/db.js';
import { createSession } from '../lib/auth.js';
import { sha256, hashIp } from '../lib/crypto.js';

process.env.RECEPTION_DEFAULT = 'unrestricted';
delete process.env.TELEGRAM_BOT_TOKEN;
process.env.PASSWORD_PEPPER = crypto.randomBytes(32).toString('base64');
process.env.DATA_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
process.env.HIBP_DISABLED = '1';

test('approval rules and token restrictions enforce independent humans and current access', async t => {
  const pg = await PGlite.create({ parsers: { 20: Number } }); setDb(pgliteDb(pg));
  const originalFetch = globalThis.fetch;
  try {
    const q = await db(), { handleRequest } = await import('../lib/app.js');
    const client = (cookie, token, ip = '10.0.0.1') => async (method, path, body) => {
      const headers = new Headers({ origin: 'http://localhost', 'x-real-ip': ip, 'content-type': 'application/json' });
      if (cookie) headers.set('cookie', `__Host-stz_s=${cookie}`);
      if (token) headers.set('authorization', `Bearer ${token}`);
      const r = await handleRequest(new Request(`http://localhost${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
      return { status: r.status, body: await r.json() };
    };
    const people = {};
    for (const [id, role] of [['boss','owner'],['admin','admin'],['sender','member'],['lead','guest'],['other','member']]) {
      await q.query("insert into users (id,username,password_hash,status,created_at,updated_at) values ($1,$1,'fixture','active',$2,$2)", [id, Date.now()]);
      await q.query("insert into memberships (user_id,org_id,role_id,updated_at) values ($1,'default',$2,$3)", [id, role, Date.now()]);
      const { token: cookie } = await createSession(q, id, 'session', Date.now());
      await q.query('update sessions set admin_until=$2,ip_hash=$3 where id_hash=$1', [sha256(cookie), Date.now() + 300000, hashIp('10.0.0.1')]);
      people[id] = { human: client(cookie), cookie };
      if (role !== 'guest') {
        const issued = await people[id].human('POST', '/api/tokens', { name: 'Fixture agent' });
        assert.equal(issued.status, 200, JSON.stringify(issued.body));
        Object.assign(people[id], { agent: client(null, issued.body.token), token: issued.body.token, tokenId: issued.body.id });
      }
    }
    const boss = people.boss.human, lead = people.lead.human, sender = people.sender.human, agent = people.sender.agent;
    assert.equal((await agent('POST', '/api/claudes/heartbeat', { as: 'writer', name: 'Writer', join: { project: 'Workshop', git: 'https://github.com/example/workshop' } })).status, 200);
    assert.equal((await people.other.agent('POST', '/api/claudes/heartbeat', { as: 'elsewhere', name: 'Other', join: { project: 'Elsewhere' } })).status, 200);
    const [room] = await q.query("select id from rooms where project='Workshop'");
    const [otherRoom] = await q.query("select id from rooms where project='Elsewhere'");
    await q.query("insert into room_roles (room_id,user_id,role_id) values ($1,'lead','lead')", [room.id]);
    const rule = value => boss('PUT', `/api/rooms/${room.id}/approval-rule`, { rule: value });
    const ask = async kind => {
      const r = await agent('POST', '/api/asks', { as: 'writer', text: 'Change the fixture', project: 'Workshop', kind });
      assert.equal(r.status, 202, JSON.stringify(r.body)); return r.body.id;
    };
    const secure = async () => {
      const r = await agent('POST', '/api/messages', { as: 'writer', to: '*', text: 'Confidential fixture', sensitive: true, reason: 'Fixture disclosure', project: 'Workshop' });
      assert.equal(r.status, 202, JSON.stringify(r.body)); return r.body.secureId;
    };
    await t.test('owner, room and inherited organization rules; opinion cannot authorize an action', async () => {
      const own = await ask();
      assert.equal((await lead('POST', `/api/asks/${own}`, { approve: true })).status, 404);
      assert.equal((await boss('POST', `/api/asks/${own}`, { approve: true })).status, 404);
      assert.equal((await sender('POST', `/api/asks/${own}`, { answer: 'Not an approval' })).status, 400);
      assert.equal((await sender('POST', `/api/asks/${own}`, { approve: true })).body.status, 'approved');
      assert.equal((await rule('room')).status, 200);
      const id = await ask();
      assert.equal((await sender('GET', '/api/asks')).body.asks.length, 0);
      assert.ok((await lead('GET', '/api/asks')).body.asks.some(a => a.id === id));
      assert.equal((await lead('GET', '/api/state')).body.pendingAsks, 1);
      assert.equal((await sender('POST', `/api/asks/${id}`, { approve: true })).status, 404);
      assert.equal((await lead('POST', `/api/asks/${id}`, { approve: true })).body.status, 'approved');
      const secret = await secure();
      assert.equal((await sender('POST', `/api/secure/${secret}/reveal`, {})).status, 404);
      assert.equal((await lead('POST', `/api/secure/${secret}/reveal`, {})).body.text, 'Confidential fixture');
      assert.equal((await lead('GET', '/api/approvals')).body.approvals[0].id, secret);
      assert.equal((await lead('POST', `/api/approvals/${secret}`, { policy: 'deny' })).body.status, 'denied');
      const opinion = await ask('opinion');
      assert.equal((await lead('POST', `/api/asks/${opinion}`, { answer: 'An opinion' })).status, 404);
      assert.equal((await sender('POST', `/api/asks/${opinion}`, { answer: 'An opinion' })).body.status, 'answered');
      assert.equal((await boss('PUT', '/api/organization/approval-rule', { rule: 'two' })).status, 200);
      assert.equal((await rule(null)).status, 200);
      assert.equal((await sender('GET', '/api/asks')).body.asks.length, 0);
    });
    await t.test('two distinct matching approvals; duplicate, rejection, revocation and timeout', async () => {
      const secret = await secure();
      const first = await sender('POST', `/api/approvals/${secret}`, { policy: 'plain' });
      assert.equal(first.body.status, 'pending'); assert.equal(first.body.review.approvals, 1);
      assert.equal((await sender('POST', `/api/approvals/${secret}`, { policy: 'plain' })).status, 409);
      const { token: secondCookie } = await createSession(q, 'sender', 'session', Date.now());
      assert.equal((await client(secondCookie)('POST', `/api/approvals/${secret}`, { policy: 'plain' })).status, 409);
      assert.equal((await lead('POST', `/api/approvals/${secret}`, { policy: 'permanent' })).status, 409);
      assert.equal((await people.other.human('POST', `/api/approvals/${secret}`, { policy: 'plain' })).status, 404);
      const [waiting] = await q.query('select ciphertext,status from secure_items where id=$1', [secret]);
      assert.ok(waiting.ciphertext); assert.equal(waiting.status, 'pending');
      assert.equal((await lead('POST', `/api/approvals/${secret}`, { policy: 'plain' })).body.status, 'released');
      const rejected = await ask();
      assert.equal((await sender('POST', `/api/asks/${rejected}`, { approve: true })).body.status, 'pending');
      assert.equal((await lead('POST', `/api/asks/${rejected}`, { approve: false })).body.status, 'rejected');
      const revoked = await ask();
      assert.equal((await lead('POST', `/api/asks/${revoked}`, { approve: true })).body.status, 'pending');
      await q.query("delete from room_roles where user_id='lead' and room_id=$1", [room.id]);
      const afterRevocation = await sender('POST', `/api/asks/${revoked}`, { approve: true });
      assert.equal(afterRevocation.body.status, 'pending'); assert.equal(afterRevocation.body.review.approvals, 1);
      assert.equal((await boss('POST', `/api/asks/${revoked}`, { approve: true })).body.status, 'approved');
      await q.query("insert into room_roles (room_id,user_id,role_id) values ($1,'lead','lead')", [room.id]);
      const expired = await secure();
      assert.equal((await sender('POST', `/api/approvals/${expired}`, { policy: 'plain' })).body.status, 'pending');
      await q.query('update secure_items set approval_expires_at=$2 where id=$1', [expired, Date.now() - 1000]);
      assert.equal((await lead('POST', `/api/approvals/${expired}`, { policy: 'plain' })).status, 410);
      await sender('GET', '/api/approvals');
      assert.equal((await q.query('select ciphertext from secure_items where id=$1', [expired]))[0].ciphertext, null);
    });
    await t.test('token caps survive room roles, live changes, aliases and unscoped reads', async () => {
      const hiddenTask = await people.other.agent('POST', '/api/tasks', { as: 'elsewhere', title: 'Hidden mission', project: 'Elsewhere' });
      assert.equal(hiddenTask.status, 200);
      const limited = await sender('POST', '/api/tokens', { name: 'Limited', restrictions: { rooms: [room.id], readOnly: true, ips: ['10.0.0.0/24'] } });
      assert.equal(limited.status, 200, JSON.stringify(limited.body));
      const read = client(null, limited.body.token);
      assert.equal((await read('POST', '/api/claudes/heartbeat', { as: 'reader', name: 'Reader', join: { project: 'Alias', git: 'https://github.com/example/workshop' } })).status, 200);
      assert.equal((await q.query('select keys from rooms where id=$1', [room.id]))[0].keys.includes('n:alias'), false, 'read-only hello cannot teach an alias');
      assert.equal((await read('POST', '/api/claudes/heartbeat', { as: 'new-room', name: 'Reader', join: { project: 'Forbidden new room' } })).status, 403);
      const state = await read('GET', '/api/state'); assert.equal(state.status, 200);
      assert.deepEqual(state.body.rooms.map(r => r.id), [room.id]); assert.ok(!JSON.stringify(state.body).includes('Hidden mission'));
      assert.deepEqual(state.body.rooms[0].permissions, ['station.view']);
      assert.deepEqual((await read('GET', '/api/rooms')).body.rooms[0].permissions, ['station.view']);
      assert.equal((await agent('POST', '/api/messages', { as: 'writer', to: 'reader', text: 'Allowed room message' })).status, 200);
      assert.ok(JSON.stringify((await read('GET', '/api/inbox?as=reader&recent=10')).body).includes('Allowed room message'));
      assert.equal((await read('GET', `/api/journal?room=${room.id}`)).status, 200);
      assert.equal((await read('GET', `/api/journal?room=${otherRoom.id}`)).status, 404);
      assert.ok(!JSON.stringify((await read('GET', '/api/stats')).body).includes('Elsewhere'));
      const globalPoll = await boss('POST', '/api/polls', { text: 'Global hidden poll', options: ['A','B'] });
      assert.equal(globalPoll.status, 200, JSON.stringify(globalPoll.body));
      assert.ok(!JSON.stringify((await read('GET', '/api/polls')).body).includes('Global hidden poll'));
      assert.equal((await read('GET', `/api/polls/${globalPoll.body.id}`)).status, 404);
      assert.equal((await read('PATCH', `/api/tasks/${hiddenTask.body.id}`, { as: 'reader', status: 'done' })).status, 404);
      assert.equal((await read('GET', '/api/context/Elsewhere')).status, 404);
      assert.equal((await read('GET', `/api/state?room=${otherRoom.id}`)).status, 404);
      assert.equal((await read('POST', '/api/inbox/read', { as: 'reader', upTo: Date.now() - 1 })).status, 200);
      for (const [path, body] of [['/api/messages', { as: 'reader', to: '*', text: 'No writes' }], ['/api/tasks', { as: 'reader', title: 'No writes', project: 'Workshop' }], ['/api/locks', { as: 'reader', project: 'Workshop', resources: ['fixture'] }], ['/api/asks', { as: 'reader', text: 'No writes' }], ['/api/polls', { as: 'reader', text: 'No writes', options: ['A','B'] }]]) {
        assert.equal((await read('POST', path, body)).status, 403, path);
      }
      assert.equal((await client(null, limited.body.token, '10.1.0.1')('GET', '/api/state')).status, 403);
      assert.equal((await client(null, limited.body.token, '::ffff:10.0.0.1')('GET', '/api/state')).status, 200);
      const edit = restrictions => sender('PUT', `/api/tokens/${limited.body.id}`, { restrictions });
      assert.equal((await edit({ rooms: [], readOnly: true })).status, 200);
      assert.equal((await read('GET', '/api/state')).body.rooms.length, 0);
      assert.equal((await read('GET', '/api/state?as=reader')).status, 404);
      assert.equal((await edit({ rooms: [room.id], noPolls: true, noContext: true })).status, 200);
      assert.equal((await read('POST', '/api/messages', { as: 'reader', to: '*', text: 'Allowed write' })).status, 200);
      assert.equal((await read('POST', '/api/polls', { as: 'reader', text: 'No voting', options: ['A','B'] })).status, 403);
      assert.equal((await read('PUT', '/api/context/Workshop', { as: 'reader', summary: 'No context', version: 0 })).status, 403);
      await q.query("update memberships set role_id='guest' where user_id='sender'");
      assert.equal((await read('POST', '/api/messages', { as: 'reader', to: '*', text: 'Denied after revocation' })).status, 403);
      await q.query("update memberships set role_id='member' where user_id='sender'");
      assert.equal((await edit({ unsupported: true })).status, 400);
      assert.equal((await edit({ ips: ['not an IP'] })).status, 400);
      assert.equal((await edit({ rooms: ['missing'] })).status, 404);
      assert.equal((await edit({ readOnly: 'yes' })).status, 400);
      assert.equal((await people.other.human('PUT', `/api/tokens/${limited.body.id}`, { restrictions: {} })).status, 404);
      const listing = await sender('GET', '/api/tokens'); assert.ok(listing.body.tokens.some(t => t.restrictions.noPolls));
      assert.ok(!JSON.stringify(listing.body).includes(limited.body.token)); assert.ok(!JSON.stringify(listing.body).includes('token_hash'));
      assert.equal((await people.admin.human('PUT', `/api/admin/tokens/${people.boss.tokenId}`, { restrictions: {} })).status, 403);
      assert.equal((await boss('PUT', `/api/admin/tokens/${limited.body.id}`, { restrictions: { readOnly: true } })).status, 200);
    });
    await t.test('Telegram shares two-human decisions and keeps first-vote controls', async () => {
      const calls = []; let messageId = 100;
      process.env.TELEGRAM_BOT_TOKEN = 'fixture'; process.env.TELEGRAM_WEBHOOK_SECRET = 'fixture-secret';
      await q.query("update users set telegram_chat_id=case id when 'sender' then 101 when 'lead' then 102 else null end");
      globalThis.fetch = async (url, opts) => { calls.push({ method: String(url).split('/').pop(), data: JSON.parse(opts.body) }); return new Response(JSON.stringify({ ok: true, result: { message_id: ++messageId } }), { headers: { 'content-type': 'application/json' } }); };
      const id = await ask();
      assert.equal(calls.filter(c => c.method === 'sendMessage').length, 2);
      const callback = async from => {
        const r = await handleRequest(new Request('http://localhost/api/telegram/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'fixture-secret' }, body: JSON.stringify({ callback_query: { id: String(from), from: { id: from }, message: { chat: { id: from }, message_id: 101 }, data: `ok:${id}:y` } }) }));
        assert.equal(r.status, 200);
      };
      calls.length = 0; await callback(101);
      assert.equal((await q.query('select status from asks where id=$1', [id]))[0].status, 'pending');
      assert.equal(calls.filter(c => c.method === 'editMessageReplyMarkup').length, 0);
      await callback(101); assert.equal(calls.filter(c => c.method === 'editMessageReplyMarkup').length, 0);
      await callback(102);
      assert.equal((await q.query('select status from asks where id=$1', [id]))[0].status, 'approved');
      assert.equal(calls.filter(c => c.method === 'editMessageReplyMarkup').length, 2);
      delete process.env.TELEGRAM_BOT_TOKEN; delete process.env.TELEGRAM_WEBHOOK_SECRET;
    });
  } finally { globalThis.fetch = originalFetch; delete process.env.TELEGRAM_BOT_TOKEN; delete process.env.TELEGRAM_WEBHOOK_SECRET; await pg.close(); setDb(null); }
});
