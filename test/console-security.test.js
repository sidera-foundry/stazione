import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { PGlite } from '@electric-sql/pglite';
import { db, setDb, pgliteDb } from '../lib/db.js';
import { createSession } from '../lib/auth.js';
import { ALL } from '../lib/permissions.js';
import { sha256, hashIp, encrypt } from '../lib/crypto.js';
import { TOTP } from 'otpauth';
import { recoverAdmin } from '../scripts/admin-recover.js';

process.env.PASSWORD_PEPPER = crypto.randomBytes(32).toString('base64');
process.env.DATA_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
process.env.RECEPTION_DEFAULT = 'unrestricted';
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.APP_ORIGIN;
const hash = value => crypto.createHash('sha256').update(value).digest();
const b64 = value => Buffer.from(value).toString('base64url');
const cbor = value => Buffer.from(isoCBOR.encode(value));

// A software authenticator signs actual ES256 WebAuthn assertions. Verification
// is never stubbed: origin, RP hash, flags, challenge and counter are exercised.
function authenticator() {
  const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = pair.publicKey.export({ format: 'jwk' }), id = crypto.randomBytes(32);
  const cose = cbor(new Map([[1,2],[3,-7],[-1,1],[-2,new Uint8Array(Buffer.from(jwk.x, 'base64url'))],[-3,new Uint8Array(Buffer.from(jwk.y, 'base64url'))]]));
  const credential = response => ({ id: b64(id), rawId: b64(id), type: 'public-key', clientExtensionResults: {}, response });
  const clientData = (request, type, overrides) => Buffer.from(JSON.stringify({ type, challenge: request.options.challenge, origin: 'http://localhost', crossOrigin: false, ...overrides }));
  const authData = (flags, counter, rp) => { const count = Buffer.alloc(4); count.writeUInt32BE(counter); return Buffer.concat([hash(rp), Buffer.from([flags]), count]); };
  return {
    id: b64(id),
    register(request, { flags = 0x45, rp = 'localhost', ...client } = {}) {
      const length = Buffer.alloc(2); length.writeUInt16BE(id.length);
      const data = Buffer.concat([authData(flags, 0, rp), Buffer.alloc(16), length, id, cose]);
      return credential({ clientDataJSON: b64(clientData(request, 'webauthn.create', client)), attestationObject: b64(cbor(new Map([['fmt','none'],['authData',new Uint8Array(data)],['attStmt',new Map()]]))), transports: ['internal'] });
    },
    sign(request, counter, { flags = 5, rp = 'localhost', badSignature = false, ...client } = {}) {
      const json = clientData(request, 'webauthn.get', client), data = authData(flags, counter, rp);
      const signature = crypto.sign('sha256', Buffer.concat([data, hash(json)]), pair.privateKey);
      if (badSignature) signature[signature.length - 1] ^= 1;
      return credential({ clientDataJSON: b64(json), authenticatorData: b64(data), signature: b64(signature), userHandle: null });
    },
  };
}

test('console security: real passkeys, browser gating and independent administrative approval', async t => {
  const pg = await PGlite.create({ parsers: { 20: Number } }); setDb(pgliteDb(pg));
  try {
    const q = await db(), { handleRequest } = await import('../lib/app.js');
    const client = (cookies = {}, ip = '10.0.0.1', bearer = null) => {
      const jar = { ...cookies };
      const request = async (method, path, body, origin = 'http://localhost') => {
        const headers = new Headers({ origin, 'content-type': 'application/json', 'x-real-ip': ip });
        headers.set('cookie', Object.entries(jar).map(([k,v]) => `${k}=${v}`).join('; '));
        if (bearer) headers.set('authorization', `Bearer ${bearer}`);
        const res = await handleRequest(new Request(`http://localhost${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
        for (const value of res.headers.getSetCookie()) { const [name, token] = value.split(';')[0].split('='); if (token) jar[name] = token; else delete jar[name]; }
        return { status: res.status, body: await res.json(), headers: res.headers };
      };
      return Object.assign(request, { jar, ip });
    };
    const humans = {};
    for (const [id,role] of [['boss','owner'],['admin','admin'],['member','member'],['other','member']]) {
      await q.query("insert into users (id,username,password_hash,status,created_at,updated_at) values ($1,$1,'fixture','active',$2,$2)", [id, Date.now()]);
      await q.query("insert into memberships (user_id,org_id,role_id,updated_at) values ($1,'default',$2,$3)", [id,role,Date.now()]);
      const session = await createSession(q,id,'session',Date.now());
      await q.query('update sessions set admin_until=$2,ip_hash=$3 where id_hash=$1', [sha256(session.token),Date.now()+300000,hashIp('10.0.0.1')]);
      humans[id] = client({ '__Host-stz_s': session.token });
    }
    const boss = humans.boss, admin = humans.admin, member = humans.member, anon = client();
    const deviceAuth = authenticator(); let keyId, counter = 0;
    const options = async (who, path) => { const r = await who('POST', `${path}/options`, { name: 'Fixture passkey' }); assert.equal(r.status,200,JSON.stringify(r.body)); return r.body; };
    const verify = (who,path,request,credential) => who('POST', `${path}/verify`, { challengeId: request.challengeId, credential });
    const clearLimits = () => q.query('delete from auth_attempts');
    await t.test('registration verifies origin, RP, user verification, embedding and single-use challenges', async () => {
      assert.equal((await anon('POST','/api/passkeys/register/options',{ name:'Anonymous' })).status,401);
      for (const invalid of [{ origin:'https://other.invalid' },{ rp:'other.invalid' },{ flags:0x41 },{ flags:0x44 },{ crossOrigin:true },{ challenge:'wrong' }]) {
        const request = await options(member,'/api/passkeys/register');
        assert.equal((await verify(member,'/api/passkeys/register',request,deviceAuth.register(request,invalid))).status,400);
        assert.equal((await verify(member,'/api/passkeys/register',request,deviceAuth.register(request))).status,400, 'Failed verification consumes the nonce');
      }
      await clearLimits();
      const request = await options(member,'/api/passkeys/register');
      assert.equal((await verify(humans.other,'/api/passkeys/register',request,deviceAuth.register(request))).status,400,'Challenge bound to human and session');
      const r = await verify(member,'/api/passkeys/register',request,deviceAuth.register(request)); assert.equal(r.status,200,JSON.stringify(r.body)); keyId = r.body.id;
      assert.equal((await verify(member,'/api/passkeys/register',request,deviceAuth.register(request))).status,400);
      const list = await member('GET','/api/passkeys'); assert.equal(list.body.passkeys.length,1);
      assert.ok(!JSON.stringify(list.body).includes(deviceAuth.id)); assert.ok(!JSON.stringify(list.body).includes('public_key'));
      const expired = await options(member,'/api/passkeys/register');
      await q.query('update webauthn_challenges set expires_at=0 where id=$1',[expired.challengeId]);
      assert.equal((await verify(member,'/api/passkeys/register',expired,authenticator().register(expired))).status,400);
    });
    await t.test('assertion checks signatures, counters, RP, UV, origin and step-up bindings', async () => {
      await clearLimits();
      for (const invalid of [{ badSignature:true },{ flags:1 },{ flags:4 },{ rp:'other.invalid' },{ origin:'https://other.invalid' },{ crossOrigin:true }]) {
        const r = await options(anon,'/api/auth/passkey');
        assert.equal((await verify(anon,'/api/auth/passkey',r,deviceAuth.sign(r,1,invalid))).status,401);
      }
      const request = await options(anon,'/api/auth/passkey');
      const login = await verify(anon,'/api/auth/passkey',request,deviceAuth.sign(request,++counter));
      assert.equal(login.status,200,JSON.stringify(login.body)); assert.equal(login.body.next,'session');
      assert.equal((await anon('GET','/api/me')).status,200);
      assert.ok(anon.jar['__Host-stz_d']); assert.ok(anon.jar['__Host-stz_s']);
      const deviceCookie = login.headers.getSetCookie().find(c => c.startsWith('__Host-stz_d=')); assert.match(deviceCookie,/Secure/); assert.match(deviceCookie,/HttpOnly/); assert.match(deviceCookie,/SameSite=Strict/);
      assert.equal((await verify(client(),'/api/auth/passkey',request,deviceAuth.sign(request,2))).status,400,'Nonce cannot be replayed');
      const replay = await options(client(),'/api/auth/passkey');
      assert.equal((await verify(client(),'/api/auth/passkey',replay,deviceAuth.sign(replay,counter))).status,401,'Counter rollback detected');
      await q.query('update sessions set admin_until=0 where id_hash=$1',[sha256(member.jar['__Host-stz_s'])]);
      assert.equal((await member('POST','/api/tokens',{name:'Protected'})).body.code,'step_up_required');
      const step = await options(member,'/api/auth/passkey/step-up');
      assert.equal((await verify(anon,'/api/auth/passkey/step-up',step,deviceAuth.sign(step,2))).status,400,'A second session of the same human cannot use this challenge');
      assert.equal((await verify(member,'/api/auth/passkey',step,deviceAuth.sign(step,2))).status,400,'Wrong purpose');
      const anotherIP = client(member.jar,'10.0.0.2');
      assert.equal((await verify(anotherIP,'/api/auth/passkey/step-up',step,deviceAuth.sign(step,2))).status,400,'IP binding');
      assert.equal((await verify(member,'/api/auth/passkey/step-up',step,deviceAuth.sign(step,++counter))).status,200);
      assert.equal((await member('POST','/api/tokens',{ name:'Protected' })).status,200);
      const token = (await boss('POST','/api/tokens',{name:'Agent'})).body.token;
      assert.equal((await client({},'10.0.0.1',token)('POST','/api/auth/passkey/options',{})).status,403);
    });
    await t.test('registered browser policy gates sign-in and existing sessions; approval and revocation bind cookies', async () => {
      await clearLimits();
      assert.equal((await boss('PUT','/api/admin/security-policy',{fourEyes:false,requireKnownDevice:true})).status,409);
      assert.equal((await boss('POST','/api/devices/register',{})).status,200);
      const current = (await boss('GET','/api/devices')).body.current;
      assert.equal((await admin('POST',`/api/admin/devices/${current}/decide`,{approve:true})).status,403,'Owner device protection');
      assert.equal((await boss('POST',`/api/admin/devices/${current}/decide`,{approve:'yes'})).status,400);
      assert.equal((await boss('POST',`/api/admin/devices/${current}/decide`,{approve:true})).status,200);
      assert.equal((await boss('PUT','/api/admin/security-policy',{fourEyes:false,requireKnownDevice:true})).status,200);
      assert.equal((await member('GET','/api/me')).status,401,'Unregistered legacy session denied');
      assert.equal((await client({ '__Host-stz_s':boss.jar['__Host-stz_s'] })('GET','/api/me')).status,401,'Approved session also requires its browser cookie');
      const newcomer = client(), request = await options(newcomer,'/api/auth/passkey');
      const pending = await verify(newcomer,'/api/auth/passkey',request,deviceAuth.sign(request,++counter));
      assert.equal(pending.body.next,'device'); assert.ok(newcomer.jar['__Host-stz_p']); assert.ok(!newcomer.jar['__Host-stz_s']);
      assert.equal((await newcomer('GET','/api/me')).status,401);
      assert.equal((await newcomer('POST','/api/auth/device/status',{})).body.next,'device');
      assert.equal((await boss('POST',`/api/admin/devices/${pending.body.deviceId}/decide`,{approve:true})).status,200);
      assert.equal((await client({ '__Host-stz_p':newcomer.jar['__Host-stz_p'] })('POST','/api/auth/device/status',{})).status,401,'Cannot redeem without browser proof');
      assert.equal((await newcomer('POST','/api/auth/device/status',{})).body.next,'session');
      assert.equal((await newcomer('GET','/api/me')).status,200);
      assert.equal((await boss('POST',`/api/admin/devices/${pending.body.deviceId}/decide`,{approve:false})).status,200);
      assert.equal((await newcomer('GET','/api/me')).status,401,'Revocation closes bound sessions');
      assert.equal((await boss('POST',`/api/admin/devices/${current}/decide`,{approve:false})).status,409,'Last owner browser protected');
      const lists = await boss('GET','/api/admin/devices'); assert.ok(!JSON.stringify(lists.body).includes('cookie_hash'));
      assert.ok(!JSON.stringify(lists.body).includes(boss.jar['__Host-stz_d']));
      assert.equal((await boss('PUT','/api/admin/security-policy',{fourEyes:false,requireKnownDevice:false})).status,200);
    });
    await t.test('four-eyes queues aliases and original APIs without mutation, requires a second current administrator', async () => {
      await clearLimits();
      assert.equal((await boss('PUT','/api/admin/security-policy',{fourEyes:true,requireKnownDevice:false})).status,200);
      const r = await boss('PUT','/api/admin/people/other/role',{role:'admin'});
      assert.equal(r.status,202,JSON.stringify(r.body)); const id = r.body.changeId;
      assert.equal((await q.query("select role_id from memberships where user_id='other'"))[0].role_id,'member');
      assert.equal((await q.query("select count(*)::int as n from audit_log where event='role_assigned'"))[0].n,0,'Validation has no audit side effects');
      assert.equal((await boss('POST',`/api/admin/changes/${id}/decide`,{decision:'approve'})).status,409,'Same person cannot countersign');
      const pending = (await boss('GET','/api/admin/changes')).body.changes.find(c => c.id === id);
      assert.equal(pending.proposal.settings.role,'admin'); assert.ok(!JSON.stringify(pending).includes('sessionHash')); assert.ok(!JSON.stringify(pending).includes('payload_enc'));
      const result = await admin('POST',`/api/admin/changes/${id}/decide`,{decision:'approve'}); assert.equal(result.status,200,JSON.stringify(result.body));
      assert.equal((await q.query("select role_id from memberships where user_id='other'"))[0].role_id,'admin');
      assert.equal((await q.query('select payload_enc from admin_changes where id=$1',[id]))[0].payload_enc,null);
      assert.equal((await admin('POST',`/api/admin/changes/${id}/decide`,{decision:'approve'})).status,404);
      assert.equal((await boss('PUT','/api/people/missing/role',{role:'admin'})).status,404,'Invalid target never queued');
      assert.equal((await boss('POST','/api/roles',{name:'Malformed',permissions:'admin.console'})).status,201,'Legacy role validation normalizes non-array permissions without crashing');
      const owner = await boss('PUT','/api/people/other/role',{role:'owner'}); assert.equal(owner.status,202);
      assert.equal((await admin('PUT','/api/people/member/role',{role:'owner'})).status,403,'Admin cannot initiate owner grants');
      assert.equal((await admin('POST',`/api/admin/changes/${owner.body.changeId}/decide`,{decision:'approve'})).status,200,'Admin can countersign an owner-initiated grant');
      const invite = await boss('POST','/api/invites',{role:'admin',label:'Two-person invitation'}); assert.equal(invite.status,202);
      assert.equal((await q.query('select count(*)::int as n from invites'))[0].n,0,'No invitation minted before approval');
      const approved = await admin('POST',`/api/admin/changes/${invite.body.changeId}/decide`,{decision:'approve'});
      assert.equal(approved.status,200,JSON.stringify(approved.body)); assert.ok(approved.body.result.code.startsWith('sti_'));
      assert.ok(!JSON.stringify((await admin('GET','/api/admin/changes')).body).includes(approved.body.result.code));
      const relax = await boss('PUT','/api/admin/security-policy',{fourEyes:false,requireKnownDevice:false}); assert.equal(relax.status,202,'Disabling itself requires independent approval');
      await q.query('update sessions set admin_until=0 where id_hash=$1',[sha256(admin.jar['__Host-stz_s'])]);
      assert.equal((await admin('POST',`/api/admin/changes/${relax.body.changeId}/decide`,{decision:'approve'})).body.code,'step_up_required');
      await q.query('update sessions set admin_until=$2 where id_hash=$1',[sha256(admin.jar['__Host-stz_s']),Date.now()+300000]);
      assert.equal((await admin('POST',`/api/admin/changes/${relax.body.changeId}/decide`,{decision:'reject'})).status,200);
      const stale = await boss('PUT','/api/people/member/role',{role:'admin'}); assert.equal(stale.status,202);
      assert.equal((await boss('PUT','/api/people/other/role',{role:'member'})).status,200);
      assert.equal((await admin('POST',`/api/admin/changes/${stale.body.changeId}/decide`,{decision:'approve'})).status,409,'Security state changed');
      await admin('POST',`/api/admin/changes/${stale.body.changeId}/decide`,{decision:'reject'});
      const expired = await boss('PUT','/api/people/member/role',{role:'admin'});
      await q.query('update admin_changes set expires_at=0 where id=$1',[expired.body.changeId]);
      assert.equal((await admin('POST',`/api/admin/changes/${expired.body.changeId}/decide`,{decision:'approve'})).status,410);
      await admin('GET','/api/admin/changes'); assert.equal((await q.query('select payload_enc from admin_changes where id=$1',[expired.body.changeId]))[0].payload_enc,null);
      const lost = await boss('PUT','/api/people/member/role',{role:'admin'});
      await q.query("update memberships set role_id='member' where user_id='admin'");
      assert.equal((await admin('POST',`/api/admin/changes/${lost.body.changeId}/decide`,{decision:'approve'})).status,404,'Reviewer permission loss');
      await q.query("update memberships set role_id='admin' where user_id='admin'");
      await boss('POST',`/api/admin/changes/${lost.body.changeId}/decide`,{decision:'reject'});
      await q.query("update roles set permissions=$1 where id='admin'",[JSON.stringify(ALL.filter(p => p !== 'people.invite'))]);
      const deniedInvite = await boss('POST','/api/invites',{role:'admin',label:'Reviewer permission check'});
      assert.equal(deniedInvite.status,202);
      assert.equal((await admin('POST',`/api/admin/changes/${deniedInvite.body.changeId}/decide`,{decision:'approve'})).status,403,'Countersigning preserves invitation permission and grant ceiling');
      await boss('POST',`/api/admin/changes/${deniedInvite.body.changeId}/decide`,{decision:'reject'});
      await q.query("update roles set permissions=$1 where id='admin'",[JSON.stringify(ALL)]);
    });
    await t.test('revoked passkeys cannot sign in; recovery and local break-glass reset restrictions', async () => {
      await clearLimits();
      assert.equal((await admin('DELETE',`/api/admin/passkeys/${keyId}`)).status,200);
      const r = await options(client(),'/api/auth/passkey'); assert.equal((await verify(client(),'/api/auth/passkey',r,deviceAuth.sign(r,++counter))).status,401);
      const pending = await boss('PUT','/api/people/member/role',{role:'admin'}); assert.equal(pending.status,202);
      await q.query("update orgs set settings=settings || '{\"requireKnownDevice\":true}'::jsonb");
      const recovery = await recoverAdmin(q); assert.ok(recovery.code.startsWith('sti_'));
      const [org] = await q.query('select settings from orgs'); assert.equal(org.settings.requireKnownDevice,false); assert.equal(org.settings.fourEyes,false);
      assert.equal((await q.query('select payload_enc,status from admin_changes where id=$1',[pending.body.changeId]))[0].status,'expired');
      assert.ok(!JSON.stringify(await q.query("select detail from audit_log where event='admin_recovery'")).includes(recovery.code));
      // Exercise the real recovery confirmation handler without an expensive
      // password setup: its existing pending-session checks and TOTP stay real.
      const auth = authenticator(), keyRequest = await options(member,'/api/passkeys/register');
      assert.equal((await verify(member,'/api/passkeys/register',keyRequest,auth.register(keyRequest))).status,200);
      const totp = new TOTP({ algorithm:'SHA1', digits:6, period:30, secret:'JBSWY3DPEHPK3PXP' });
      await q.query("update users set totp_pending_enc=$1,password_pending_hash='fixture' where id='member'",[encrypt('JBSWY3DPEHPK3PXP','totp:member')]);
      const session = await createSession(q,'member','recover',Date.now()), recovering = client({ '__Host-stz_p':session.token });
      const restored = await recovering('POST','/api/auth/recover/confirm',{code:totp.generate()}); assert.equal(restored.status,200,JSON.stringify(restored.body));
      assert.equal((await q.query("select count(*)::int as n from passkeys where user_id='member' and revoked_at is null"))[0].n,0);
      assert.equal((await q.query("select count(*)::int as n from devices where user_id='member' and status='revoked'"))[0].n > 0,true);
      assert.equal((await member('GET','/api/me')).status,401);
      const fresh = client(); await clearLimits();
      for (let i=0;i<10;i++) assert.equal((await fresh('POST','/api/auth/passkey/options',{})).status,200);
      assert.equal((await fresh('POST','/api/auth/passkey/options',{})).status,429,'Bounded challenge issuance');
    });
  } finally { await pg.close(); }
});
