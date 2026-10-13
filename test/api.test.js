process.env.RECEPTION_DEFAULT = 'unrestricted'; // Legacy behaviour fixtures; reception.test.js covers manual defaults.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PGlite } from '@electric-sql/pglite';
import { TOTP, Secret } from 'otpauth';
import { setDb, pgliteDb } from '../lib/db.js';

process.env.PASSWORD_PEPPER = crypto.randomBytes(32).toString('base64');
process.env.DATA_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
process.env.INVITE_CODE = 'test-invite-code-0123456789';
process.env.HIBP_DISABLED = '1';
process.env.MAX_USERS = '2';
process.env.CRON_SECRET = 'cron-secret-for-tests';

const ORIGIN = 'http://localhost';
const run = promisify(execFile);
let handleRequest;

before(async () => {
  setDb(pgliteDb(await PGlite.create({ parsers: { 20: (v) => Number(v) } })));
  ({ handleRequest } = await import('../lib/app.js'));
});

/** Minimal client with a cookie jar, like a browser; or a Bearer token, like a Claude. */
function client({ token, origin = ORIGIN, ip = '10.0.0.1' } = {}) {
  const jar = new Map();
  return async (method, path, body) => {
    const headers = new Headers({ 'x-real-ip': ip });
    if (origin) headers.set('origin', origin);
    if (token) headers.set('authorization', `Bearer ${token}`);
    if (jar.size) headers.set('cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '));
    if (body !== undefined) headers.set('content-type', 'application/json');
    const res = await handleRequest(new Request(`${ORIGIN}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const [k, v] = pair.split('=');
      if (/Max-Age=0/.test(c)) jar.delete(k); else jar.set(k, v);
    }
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
  };
}

const code = (secret, offsetSteps = 0) =>
  new TOTP({ secret: Secret.fromBase32(secret) }).generate({ timestamp: Date.now() + offsetSteps * 30000 });

async function register(username, password = 'correct horse battery staple 42') {
  const c = client({ ip: `10.1.0.${username.length}` });
  const invite = S.a ? (await S.a.c('POST', '/api/invites', { role: 'member' })).body.code : process.env.INVITE_CODE;
  const start = await c('POST', '/api/auth/register/start', { invite, username, password });
  assert.equal(start.status, 200, JSON.stringify(start.body));
  assert.match(start.body.qr, /^data:image\/svg\+xml;base64,/);
  const done = await c('POST', '/api/auth/register/confirm', { code: code(start.body.secret) });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.recoveryPhrase.split(' ').length, 12);
  return { c, secret: start.body.secret, phrase: done.body.recoveryPhrase, password };
}

const S = {};

test('registration: invite required, weak password rejected, max two users', async () => {
  const anon = client();
  let r = await anon('POST', '/api/auth/register/start', { invite: 'wrong', username: 'x-user', password: 'a very long password indeed' });
  assert.equal(r.status, 403);
  r = await anon('POST', '/api/auth/register/start', { invite: process.env.INVITE_CODE, username: 'shorty', password: 'short' });
  assert.equal(r.status, 400);
  S.a = await register('alice');
  S.b = await register('partner');
  r = await client({ ip: '10.9.9.9' })('POST', '/api/auth/register/start', { invite: process.env.INVITE_CODE, username: 'third', password: 'another long password 123' });
  assert.equal(r.status, 403);
  assert.match(r.body.error, /Registration closed/);
});

test('login needs password then TOTP; replayed code is rejected', async () => {
  const c = client({ ip: '10.2.0.1' });
  let r = await c('POST', '/api/auth/login', { username: 'alice', password: 'wrong password here' });
  assert.equal(r.status, 401);
  assert.equal(r.body.error, 'Invalid credentials');
  r = await c('POST', '/api/auth/login', { username: 'alice', password: S.a.password });
  assert.equal(r.body.next, 'totp');
  r = await c('GET', '/api/state');
  assert.equal(r.status, 401, 'no session before TOTP');
  r = await c('POST', '/api/auth/login/totp', { code: code(S.a.secret) });
  assert.equal(r.status, 401, 'code used at registration cannot be replayed');
  r = await c('POST', '/api/auth/login/totp', { code: code(S.a.secret, 1) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await c('GET', '/api/state');
  assert.equal(r.status, 200);
  assert.equal(r.body.me.username, 'alice');
});

test('rate limiting: sixth wrong password for a user is refused', async () => {
  const c = client({ ip: '10.3.0.1' });
  for (let i = 0; i < 5; i++) assert.equal((await c('POST', '/api/auth/login', { username: 'partner', password: `nope-${i}-xxxxxxxx` })).status, 401);
  const r = await c('POST', '/api/auth/login', { username: 'partner', password: S.b.password });
  assert.equal(r.status, 429);
});

test('CSRF: cookie-authenticated write from another origin is refused', async () => {
  const r = await S.a.c('POST', '/api/tokens', { name: 'x' });
  assert.equal(r.status, 200);
  const evil = client({ origin: 'https://evil.example' });
  const r2 = await evil('POST', '/api/auth/login', { username: 'alice', password: S.a.password });
  assert.equal(r2.status, 403);
});

test('tokens: humans mint them, Claudes cannot reach human routes', async () => {
  const ta = await S.a.c('POST', '/api/tokens', { name: 'PC Alice', days: 30 });
  assert.match(ta.body.token, /^stz_/);
  S.tokA = ta.body.token;
  S.tokB = (await S.b.c('POST', '/api/tokens', { name: 'Partner PC' })).body.token;
  const claude = client({ token: S.tokA, origin: null });
  assert.equal((await claude('POST', '/api/tokens', { name: 'self-mint' })).status, 403);
  assert.equal((await claude('GET', '/api/approvals')).status, 403);
  assert.equal((await client({ token: 'stz_' + 'A'.repeat(43), origin: null })('GET', '/api/state')).status, 401);
});

test('instances, missions and atomic claim', async () => {
  const A = client({ token: S.tokA, origin: null });
  const B = client({ token: S.tokB, origin: null });
  S.A = A; S.B = B;
  assert.equal((await A('POST', '/api/claudes/heartbeat', { as: 'alice-pc', name: 'Alice', status: 'idle' })).body.registered, true);
  assert.equal((await B('POST', '/api/claudes/heartbeat', { as: 'partner', name: 'Partner' })).status, 200);
  assert.equal((await B('POST', '/api/claudes/heartbeat', { as: 'alice-pc', name: 'Impostor' })).status, 403);
  const t = await A('POST', '/api/tasks', { as: 'alice-pc', title: 'Inventory', project: 'Web Shop', resources: ['src/inventory'] });
  S.task = t.body.id;
  const announce = (await B('GET', '/api/inbox?as=partner')).body.messages.find((m) => m.text.includes(S.task));
  assert.equal(announce?.to, '*', 'new mission is broadcast so waiting Claudes wake up');
  assert.ok(!(await A('GET', '/api/inbox?as=alice-pc')).body.messages.some((m) => m.text.includes(S.task)), 'creator is not woken by its own mission');
  assert.equal((await A('POST', `/api/tasks/${S.task}/claim`, { as: 'alice-pc' })).status, 200);
  const r = await B('POST', `/api/tasks/${S.task}/claim`, { as: 'partner' });
  assert.equal(r.status, 409);
  assert.equal(r.body.owner, 'alice-pc');
});

test('locks: overlapping paths conflict, all-or-nothing, release works', async () => {
  const { A, B } = S;
  let r = await A('POST', '/api/locks', { as: 'alice-pc', project: 'Web Shop', resources: ['src/checkout'], reason: 'refactor', ttlMinutes: 30 });
  assert.equal(r.status, 200);
  r = await B('POST', '/api/locks', { as: 'partner', project: 'Web Shop', resources: ['src/ui', 'src/checkout/cart.ts'], reason: 'fix' });
  assert.equal(r.status, 409);
  assert.equal(r.body.conflicts[0].owner, 'alice-pc');
  const st = await S.a.c('GET', '/api/state');
  assert.ok(!st.body.locks.some((l) => l.resource === 'src/ui'), 'no partial lock taken');
  r = await B('POST', '/api/locks', { as: 'partner', project: 'Other Project', resources: ['src/checkout'] });
  assert.equal(r.status, 200, 'same path in another project is independent');
  r = await B('POST', '/api/locks', { as: 'partner', project: 'Backend', resources: ['Services.Billing'] });
  assert.equal(r.status, 200);
  r = await A('POST', '/api/locks', { as: 'alice-pc', project: 'Backend', resources: ['Services.Billing.Invoice'] });
  assert.equal(r.status, 409, 'dotted instance paths overlap too');
  await A('POST', '/api/locks/release', { as: 'alice-pc', project: 'Web Shop' });
  r = await B('POST', '/api/locks', { as: 'partner', project: 'Web Shop', resources: ['src/checkout/cart.ts'] });
  assert.equal(r.status, 200);
  // A human may release only their own Claudes' locks from the panel.
  r = await S.a.c('POST', '/api/locks/release-human', { owner: 'partner' });
  assert.deepEqual(r.body.released, [], "another user's Claude is never touched");
  assert.ok((await S.a.c('GET', '/api/state')).body.locks.some((l) => l.owner === 'partner' && l.resource === 'src/checkout/cart.ts'));
});

test('messages: plain delivery and inbox', async () => {
  const r = await S.A('POST', '/api/messages', { as: 'alice-pc', to: 'partner', text: 'I changed the signature of POST /orders', project: 'Backend' });
  assert.equal(r.body.status, 'delivered');
  const inbox = await S.B('GET', '/api/inbox?as=partner');
  assert.equal(inbox.body.messages.at(-1).text, 'I changed the signature of POST /orders');
  // Quiet messages (and news for the whole station) are delivered but marked quiet: they do not wake a waiting Claude.
  await S.A('POST', '/api/messages', { as: 'alice-pc', to: 'partner', text: 'For your information', quiet: true });
  await S.A('POST', '/api/messages', { as: 'alice-pc', to: '**', text: 'News for everyone' });
  await S.A('POST', '/api/messages', { as: 'alice-pc', to: '**', text: 'Urgent for everyone', urgent: true });
  const quiet = Object.fromEntries((await S.B('GET', '/api/inbox?as=partner')).body.messages.map((m) => [m.text, !!m.quiet]));
  assert.deepEqual([quiet['For your information'], quiet['News for everyone'], quiet['Urgent for everyone']], [true, true, false]);
});

test('sensitive data is held, cannot be read before approval, and policies behave', async () => {
  const secretText = 'The key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';
  let r = await S.A('POST', '/api/messages', { as: 'alice-pc', to: 'partner', text: secretText, reason: 'needed for the tests' });
  assert.equal(r.status, 202);
  assert.equal(r.body.status, 'pending_approval');
  const id = r.body.secureId;
  const inbox = await S.B('GET', '/api/inbox?as=partner');
  const held = inbox.body.messages.find((m) => m.secure?.id === id);
  assert.ok(!held.text.includes('sk-ant'), 'recipient sees only a placeholder');
  assert.equal((await S.B('GET', `/api/secure/${id}?as=partner`)).status, 403);
  // Neither the recipient's human nor any Claude can approve; only the sender's owner, as a human.
  assert.equal((await S.b.c('POST', `/api/approvals/${id}`, { policy: 'once_claude' })).status, 404);
  assert.equal((await S.A('POST', `/api/approvals/${id}`, { policy: 'once_claude' })).status, 403);
  const pending = await S.a.c('GET', '/api/approvals');
  assert.ok(pending.body.approvals[0].preview.includes('sk-'));
  assert.ok(!pending.body.approvals[0].preview.includes('abcdefghijklmnop'), 'preview is masked');
  assert.equal((await S.a.c('POST', `/api/approvals/${id}`, { policy: 'once_claude' })).status, 200);
  r = await S.B('GET', `/api/secure/${id}?as=partner`);
  assert.equal(r.body.text, secretText);
  assert.equal(r.body.consumed, true);
  assert.equal((await S.B('GET', `/api/secure/${id}?as=partner`)).status, 403, 'once means once');

  // once_human: only the partner (human) sees it, once; Claudes cannot.
  r = await S.A('POST', '/api/messages', { as: 'alice-pc', to: 'partner', text: 'IBAN IT60X0542811101000000123456', reason: 'bank transfer' });
  const id2 = r.body.secureId;
  await S.a.c('POST', `/api/approvals/${id2}`, { policy: 'once_human' });
  assert.equal((await S.B('GET', `/api/secure/${id2}?as=partner`)).status, 403);
  r = await S.b.c('POST', `/api/secure/${id2}/reveal`, {});
  assert.equal(r.status, 200);
  assert.match(r.body.text, /IT60X0542811101000000123456/);
  assert.equal((await S.b.c('POST', `/api/secure/${id2}/reveal`, {})).status, 404);

  // deny wipes it; explicit sensitive flag works even without detected patterns.
  r = await S.A('POST', '/api/messages', { as: 'alice-pc', to: '*', text: 'nothing detectable', sensitive: true });
  assert.equal(r.status, 202);
  await S.a.c('POST', `/api/approvals/${r.body.secureId}`, { policy: 'deny' });
  assert.equal((await S.B('GET', `/api/secure/${r.body.secureId}?as=partner`)).status, 403);

  // plain: false positive, delivered as a normal message.
  r = await S.A('POST', '/api/messages', { as: 'alice-pc', to: 'partner', text: 'Write to noreply@example.com for the logs' });
  await S.a.c('POST', `/api/approvals/${r.body.secureId}`, { policy: 'plain' });
  const last = (await S.B('GET', '/api/inbox?as=partner')).body.messages.at(-1);
  assert.equal(last.text, 'Write to noreply@example.com for the logs');
});

test('sensitive data cannot sneak in through tasks, decisions or context', async () => {
  let r = await S.A('POST', '/api/tasks', { as: 'alice-pc', title: 'use password=Hunter2Hunter2' });
  assert.equal(r.status, 422);
  r = await S.A('PUT', '/api/context/Backend', { as: 'alice-pc', summary: 'DB: postgres://admin:s3cret@db.example.com/prod' });
  assert.equal(r.status, 422);
  r = await S.A('PUT', '/api/context/Backend', { as: 'alice-pc', summary: 'Structure: Services.Billing handles the invoices' });
  assert.equal(r.body.version, 1);
  r = await S.B('PUT', '/api/context/Backend', { as: 'partner', summary: 'overwriting', version: 0 });
  assert.equal(r.status, 409, 'optimistic concurrency on context');
});

test('CLI: start/finish in one call, compact output, wait --mark-read', async () => {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const r = await handleRequest(new Request(`${ORIGIN}${req.url}`, { method: req.method, headers: req.headers, body }));
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const env = { ...process.env, STAZIONE_URL: `http://127.0.0.1:${server.address().port}`, STAZIONE_TOKEN: S.tokA };
  const cli = async (...args) => {
    const { stdout } = await run(process.execPath, ['client/stazione.mjs', ...args], { env }).catch((e) => e);
    assert.equal(stdout.trim().split('\n').length, 1, 'one compact line');
    return JSON.parse(stdout);
  };
  try {
    let r = await cli('start', '--as', 'alice-pc', '--title', 'Client test', '--project', 'CLI', '--lock', 'src/a,src/b');
    const id = r.task.id;
    assert.deepEqual(r.locked.untrustedContent.fields.resources.value, ['src/a', 'src/b']);
    const st = (await S.A('GET', '/api/state')).body;
    assert.equal(st.claudes.find((c) => c.id === 'alice-pc').taskId, id);
    assert.equal(st.tasks.find((t) => t.id === id).owner, 'alice-pc');

    r = await cli('status', '--as', 'alice-pc', '--project', 'CLI');
    assert.equal(r.me.owner, undefined, 'no noise fields');
    assert.equal(r.tasksActive[0].id, id);

    r = await cli('finish', id, '--as', 'alice-pc', '--project', 'CLI', '--note', 'done');
    assert.equal(r.task.status, 'done');
    assert.deepEqual(r.released.sort(), ['CLI:src/a', 'CLI:src/b']);
    assert.equal((await S.A('GET', '/api/state')).body.claudes.find((c) => c.id === 'alice-pc').taskId, null);

    await S.B('POST', '/api/messages', { as: 'partner', to: 'alice-pc', text: 'wake up' });
    r = await cli('wait', '--as', 'alice-pc', '--mark-read');
    assert.equal(r.messages.at(-1).untrustedContent.fields.text.value, 'wake up');
    assert.equal(r.messages.at(-1).untrustedContent.fields.text.trustLevel, 'claude');
    r = await cli('inbox', '--as', 'alice-pc');
    assert.equal(r.messages, undefined, 'wait --mark-read already marked them');

    await S.B('POST', '/api/messages', { as: 'partner', to: 'alice-pc', text: 'question while you work' });
    r = await cli('beat', '--as', 'alice-pc', '--activity', 'working');
    assert.equal(r.newMessages.at(-1).untrustedContent.fields.text.value, 'question while you work', 'any command brings new messages');
    r = await cli('beat', '--as', 'alice-pc');
    assert.equal(r.newMessages, undefined, 'and marks them read');
  } finally {
    server.close();
  }
});

test('asks: a drastic action waits for its own human, the answer wakes the Claude', async () => {
  let r = await S.A('POST', '/api/asks', { as: 'alice-pc', text: 'Delete the legacy/ folder', project: 'Backend' });
  assert.equal(r.status, 202);
  const id = r.body.id;
  assert.equal((await S.A('POST', '/api/asks', { as: 'alice-pc', text: 'password=Hunter2Hunter2' })).status, 422, 'no secrets in asks');
  assert.equal((await S.A('GET', `/api/asks/${id}`)).body.status, 'pending');
  assert.equal((await S.b.c('POST', `/api/asks/${id}`, { approve: true })).status, 404, "the other human cannot answer");
  assert.equal((await S.B('GET', `/api/asks/${id}`)).status, 404, "nor can the other human's Claude read it");
  assert.equal((await S.a.c('GET', '/api/asks')).body.asks[0].id, id);
  r = await S.a.c('POST', `/api/asks/${id}`, { approve: true });
  assert.equal(r.body.status, 'approved');
  assert.equal((await S.a.c('POST', `/api/asks/${id}`, { approve: false })).status, 409, 'answered once');
  const inbox = (await S.A('GET', '/api/inbox?as=alice-pc')).body.messages;
  assert.match(inbox.at(-1).text, new RegExp(`Request ${id} APPROVED`));
  assert.equal(inbox.at(-1).from, 'human:alice');
});

test('avatar: each human picks one from the fixed list, shown in /api/state', async () => {
  assert.equal((await S.a.c('GET', '/api/state')).body.me.avatar, 'astronaut', 'default');
  assert.equal((await S.a.c('POST', '/api/avatar', { avatar: 'cat' })).status, 200);
  assert.equal((await S.a.c('GET', '/api/state')).body.me.avatar, 'cat');
  assert.equal((await S.a.c('POST', '/api/avatar', { avatar: '<img src=x>' })).status, 400, 'only keys from the list');
  assert.equal((await S.A('POST', '/api/avatar', { avatar: 'robot' })).status, 403, 'a Claude cannot change it');
});

test('ideas board: shared by the humans, invisible to the Claudes', async () => {
  const r = await S.a.c('POST', '/api/notes', { text: 'Secret idea: cinema room' });
  assert.equal(r.status, 200);
  let seen = (await S.b.c('GET', '/api/notes')).body.notes;
  assert.equal(seen[0].text, 'Secret idea: cinema room');
  assert.equal(seen[0].mine, false);
  assert.equal((await S.b.c('POST', `/api/notes/${r.body.id}/pin`, { pinned: true })).body.pinned, true, 'either human can pin');
  assert.equal((await S.b.c('POST', `/api/notes/${r.body.id}/delete`, {})).status, 404, 'only the author deletes');
  // The agents never see it: no route for them, nothing in the state they read.
  assert.equal((await S.A('GET', '/api/notes')).status, 403);
  assert.equal((await S.A('POST', '/api/notes', { text: 'x' })).status, 403);
  assert.ok(!JSON.stringify((await S.A('GET', '/api/state')).body).includes('cinema room'));
  assert.equal((await S.a.c('POST', '/api/notes/abc/pin', { pinned: true })).status, 404, 'a bad id is not found, not a 500');
  assert.equal((await S.a.c('POST', '/api/notes/1e3/delete', {})).status, 404);
  assert.equal((await S.a.c('GET', '/api/notes')).body.total, 1);
  assert.equal((await S.a.c('GET', '/api/me')).body.username, (await S.a.c('GET', '/api/state')).body.me.username);
  assert.equal((await S.A('GET', '/api/me')).status, 403);
  assert.equal((await S.a.c('POST', `/api/notes/${r.body.id}/delete`, {})).status, 200);
  seen = (await S.a.c('GET', '/api/notes')).body.notes;
  assert.equal(seen.length, 0);
});

test('log: commits and deploy info need a login', async () => {
  assert.equal((await client()('GET', '/api/log')).status, 401);
  const r = await S.A('GET', '/api/log');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.commits));
  assert.ok('deploy' in r.body);
});

test('recovery phrase resets password and TOTP, revoking old sessions and tokens', async () => {
  const c = client({ ip: '10.4.0.1' });
  let r = await c('POST', '/api/auth/recover/start', { username: 'alice', phrase: 'wrong words '.repeat(6), newPassword: 'a new and very long password 2026' });
  assert.equal(r.status, 401);
  r = await c('POST', '/api/auth/recover/start', { username: 'alice', phrase: S.a.phrase, newPassword: 'a new and very long password 2026' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await c('POST', '/api/auth/recover/confirm', { code: code(r.body.secret) });
  assert.equal(r.status, 200);
  assert.notEqual(r.body.recoveryPhrase, S.a.phrase);
  assert.equal((await S.a.c('GET', '/api/state')).status, 401, 'old session revoked');
  assert.equal((await S.A('GET', '/api/state')).status, 401, 'old token revoked');
});

test('security headers and generic errors', async () => {
  const r = await client()('GET', '/api/nope');
  assert.equal(r.status, 404);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await client()('GET', '/api/cron/cleanup')).status, 404, 'cron hidden without its secret');
});

test('rate limiting: wrong TOTP codes count across fresh logins', async () => {
  const c = client({ ip: '10.3.7.1' });
  // alice's password and TOTP were reset by the recovery test above; any code from another secret is wrong
  const login = (cl) => cl('POST', '/api/auth/login', { username: 'alice', password: 'a new and very long password 2026' });
  const wrong = () => code(new Secret({ size: 20 }).base32);
  for (let round = 0; round < 2; round++) {
    assert.equal((await login(c)).status, 200);
    for (let i = 0; i < 5; i++) assert.equal((await c('POST', '/api/auth/login/totp', { code: wrong() })).status, 401);
  }
  // ten wrong codes in an hour: a fresh login is refused even with the right password, from any network
  assert.equal((await login(c)).status, 429);
  assert.equal((await login(client({ ip: '10.3.7.2' }))).status, 429);
});
