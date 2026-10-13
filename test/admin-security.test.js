process.env.RECEPTION_DEFAULT = 'unrestricted'; // Legacy behaviour fixtures; reception.test.js covers manual defaults.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { TOTP, Secret } from 'otpauth';
import { db, setDb, pgliteDb } from '../lib/db.js';
import { createSession } from '../lib/auth.js';
import { encrypt, sha256 } from '../lib/crypto.js';
import { allowsIp, parseCidr } from '../lib/ip-rules.js';
import { recoverAdmin } from '../scripts/admin-recover.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.PASSWORD_PEPPER = crypto.randomBytes(32).toString('base64');
process.env.DATA_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
process.env.HIBP_DISABLED = '1'; process.env.MAX_USERS = '3';
delete process.env.TELEGRAM_BOT_TOKEN;

test('IP ranges: IPv4, IPv6, mapped IPv4 and invalid input fail closed', () => {
  assert.equal(allowsIp(['10.0.0.0/24'], '10.0.0.5'), true);
  assert.equal(allowsIp(['10.0.0.0/24'], '::ffff:10.0.0.5'), true);
  assert.equal(allowsIp(['10.0.0.0/24'], '::ffff:a00:5'), true);
  assert.equal(allowsIp(['2001:db8::/32'], '2001:db8:abcd::1'), true);
  assert.equal(allowsIp(['2001:db8::/32'], '2001:db9::1'), false);
  assert.equal(allowsIp(['10.0.0.0/24'], 'unknown'), false);
  assert.equal(allowsIp([], 'unknown'), true);
  for (const value of ['10.0.0.1/', '10.0.0.0/33', '::/129', '10.0.0.0/-1', '10.0.0.0/1e1', 'example.com', '::1%eth0']) assert.throws(() => parseCidr(value));
});

test('step-up, IP enforcement, session closure, critical alerts and emergency recovery', async () => {
  const pg = await PGlite.create({ parsers: { 20: Number } }); setDb(pgliteDb(pg));
  try {
    const q = await db(), { handleRequest } = await import('../lib/app.js');
    const clients = new Map(), secrets = new Map(), tokens = new Map();
    const client = (cookie, token, ip = '10.0.0.10', origin = 'http://localhost') => async (method, path, body) => {
      const headers = new Headers({ origin, 'x-real-ip': ip, 'content-type': 'application/json' });
      if (cookie) headers.set('cookie', `__Host-stz_s=${cookie}`); if (token) headers.set('authorization', `Bearer ${token}`);
      const r = await handleRequest(new Request(`http://localhost${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
      return { status: r.status, body: await r.json() };
    };
    for (const [id, role] of [['owner','owner'],['admin','admin'],['member','member']]) {
      const secret = new Secret({ size: 20 }).base32; secrets.set(id, secret);
      await q.query("insert into users (id,username,password_hash,status,totp_secret_enc,created_at,updated_at) values ($1,$1,'fixture','active',$2,$3,$3)", [id, encrypt(secret, `totp:${id}`), Date.now()]);
      await q.query("insert into memberships (user_id,org_id,role_id,updated_at) values ($1,'default',$2,$3)", [id, role, Date.now()]);
      const { token } = await createSession(q, id, 'session', Date.now()); tokens.set(id, token); clients.set(id, client(token));
    }
    const owner = clients.get('owner'), admin = clients.get('admin'), member = clients.get('member');
    for (const path of ['/api/invites','/api/admin/invites','/api/roles','/api/admin/roles','/api/tokens']) {
      const r = await owner('POST', path, { role: 'member', name: 'Sample', permissions: [] }); assert.equal(r.body.code, 'step_up_required', path);
    }
    assert.equal((await owner('PUT', '/api/organization/user-limit', { limit: 5 })).body.code, 'step_up_required');
    const otp = id => new TOTP({ secret: Secret.fromBase32(secrets.get(id)) }).generate();
    assert.equal((await client(tokens.get('owner'), null, '10.0.0.10', 'https://other.invalid')('POST', '/api/auth/step-up', { code: otp('owner') })).status, 403);
    assert.equal((await owner('POST', '/api/auth/step-up', { code: 'bad' })).status, 400);
    const acceptedCode = otp('owner');
    assert.equal((await owner('POST', '/api/auth/step-up', { code: acceptedCode })).status, 200);
    assert.equal((await owner('POST', '/api/auth/step-up', { code: acceptedCode })).status, 400, 'TOTP cannot be reused');
    const second = await createSession(q, 'owner', 'session', Date.now());
    assert.equal((await client(second.token)('POST', '/api/invites', { role: 'member' })).body.code, 'step_up_required', 'confirmation is session-bound');
    assert.equal((await client(tokens.get('owner'), null, '10.0.0.11')('POST', '/api/invites', { role: 'member' })).body.code, 'step_up_required', 'confirmation is IP-bound');
    const apiToken = (await owner('POST', '/api/tokens', { name: 'Demo agent' })).body.token;
    assert.equal((await client(null, apiToken)('POST', '/api/auth/step-up', { code: otp('owner') })).status, 403);
    await q.query('update sessions set admin_until=$2 where id_hash=$1', [sha256(tokens.get('owner')), Date.now() - 1]);
    assert.equal((await owner('POST', '/api/admin/invites', { role: 'member' })).body.code, 'step_up_required', 'expired confirmation is refused');
    // Restore only this fixture's confirmation to exercise the remaining controls independently.
    await q.query('update sessions set admin_until=$2 where id_hash=$1', [sha256(tokens.get('owner')), Date.now() + 300000]);
    assert.equal((await owner('PUT', '/api/admin/ip-rules', { humans: ['192.0.2.0/24'], agents: [] })).status, 409, 'cannot exclude self');
    assert.equal((await owner('PUT', '/api/admin/ip-rules', { humans: ['10.0.0.0/24'], agents: ['::/129'] })).status, 400);
    assert.equal((await owner('PUT', '/api/admin/ip-rules', { humans: ['10.0.0.0/24'], agents: ['2001:db8::/32'] })).status, 200);
    assert.equal((await client(tokens.get('owner'), null, '192.0.2.1')('GET', '/api/me')).status, 403);
    assert.equal((await client(null, null, '192.0.2.1')('POST', '/api/auth/login', { username: 'owner', password: 'irrelevant' })).status, 403);
    assert.equal((await client(null, apiToken)('GET', '/api/state')).status, 403);
    assert.equal((await client(null, apiToken, '2001:db8::1')('GET', '/api/state')).status, 200);
    const { createServer } = await import('../lib/server.js');
    const server = createServer({ root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), hsts: false });
    await new Promise(done => server.listen(0, '127.0.0.1', done));
    try {
      const r = await fetch(`http://127.0.0.1:${server.address().port}/api/me`, { headers: { cookie: `__Host-stz_s=${tokens.get('owner')}`, 'x-real-ip': '10.0.0.10', 'x-forwarded-for': '10.0.0.10' } });
      assert.equal(r.status, 403, 'self-hosted server ignores spoofed proxy headers by default');
    } finally { await new Promise(done => server.close(done)); }
    assert.equal((await member('GET', '/api/admin/ip-rules')).status, 404);
    assert.equal((await client(tokens.get('member'), null, '192.0.2.1')('GET', '/api/admin/ip-rules')).status, 404, 'console stays hidden on an excluded network');
    assert.equal((await client(null, apiToken)('GET', '/api/admin/ip-rules')).status, 404, 'agent token never reveals the console even from an excluded network');
    assert.equal((await admin('POST', '/api/auth/step-up', { code: otp('admin') })).status, 200);
    const sessions = (await owner('GET', '/api/admin/sessions')).body.sessions;
    const sessionText = JSON.stringify(sessions);
    for (const token of tokens.values()) { assert.ok(!sessionText.includes(token)); assert.ok(!sessionText.includes(sha256(token))); }
    const memberSession = sessions.find(s => s.user_id === 'member'), ownerSession = sessions.find(s => s.user_id === 'owner');
    assert.equal((await admin('POST', `/api/admin/sessions/${ownerSession.id}/close`, {})).status, 403);
    assert.equal((await owner('POST', `/api/admin/sessions/${memberSession.id}/close`, {})).status, 200);
    assert.equal((await member('GET', '/api/me')).status, 401, 'closed cookie is immediately invalid');
    assert.ok((await owner('GET', '/api/admin/alerts')).body.alerts.some(a => a.event === 'ip_rules_changed'));
    const events = await q.query("select event,detail from audit_log where event='ip_rules_changed'");
    assert.equal(events[0].detail.from.length, 0); assert.equal(events[0].detail.to.length, 2);
    // Exhaustion is persisted even when requests fail or transactions roll back.
    for (let i = 0; i < 6; i++) await admin('POST', '/api/auth/step-up', { code: '000000' });
    assert.equal((await admin('POST', '/api/auth/step-up', { code: '000000' })).status, 429);
    const recovery = await recoverAdmin(q);
    assert.equal((await q.query('select * from ip_rules')).length, 0);
    const [invite] = await q.query('select * from invites where code_hash=$1', [sha256(recovery.code)]);
    assert.equal(invite.role_id, 'owner'); assert.ok(invite.expires_at <= Date.now() + 3600000);
    assert.equal((await q.query("select settings from orgs where id='default'"))[0].settings.userLimit, 4, 'recovery reserves a seat');
    const headers = new Headers({ origin: 'http://localhost', 'content-type': 'application/json', 'x-real-ip': '192.0.2.1' });
    const start = await handleRequest(new Request('http://localhost/api/auth/register/start', { method: 'POST', headers, body: JSON.stringify({ invite: recovery.code, username: 'recovered-owner', password: 'a long fixture password 42' }) }));
    assert.equal(start.status, 200, 'recovery invite reaches real enrollment');
    const enrollment = await start.json(); headers.set('cookie', start.headers.getSetCookie()[0].split(';')[0]);
    const done = await handleRequest(new Request('http://localhost/api/auth/register/confirm', { method: 'POST', headers, body: JSON.stringify({ code: new TOTP({ secret: Secret.fromBase32(enrollment.secret) }).generate() }) }));
    assert.equal(done.status, 200); assert.equal((await q.query("select role_id from memberships m join users u on u.id=m.user_id where u.username='recovered-owner'"))[0].role_id, 'owner');
    assert.ok((await q.query("select used_at from invites where id=$1", [invite.id]))[0].used_at);
    assert.equal((await q.query("select count(*)::int as n from audit_log where event='admin_recovery'"))[0].n, 1);
  } finally { await pg.close(); }
});
