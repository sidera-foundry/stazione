import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';
import { fail, str } from './http.js';
import { randomId, sha256 } from './crypto.js';
import { audit, enforceLimits, recordAttempt } from './auth.js';
import { ORG_ID } from './permissions.js';
import { refreshStepUp } from './admin.js';
import { finishLogin } from './devices.js';

const WINDOW_MS = 5 * 60e3;
function rejectEmbedded(credential) {
  const client = JSON.parse(Buffer.from(credential.response.clientDataJSON, 'base64url').toString());
  if (client.crossOrigin === true || client.topOrigin !== undefined) throw new Error('Embedded passkey requests are not supported');
}
function relyingParty(ctx) {
  const origin = new URL(ctx.origin);
  if (origin.protocol !== 'https:' && !['localhost','127.0.0.1','[::1]'].includes(origin.hostname)) fail(400, 'Passkeys require HTTPS or localhost');
  return { rpID: origin.hostname, origin: origin.origin };
}
async function newChallenge(q, ctx, purpose, options, name = null) {
  if (ctx.principal?.type === 'claude') fail(403, 'Only humans can use passkeys');
  const key = `passkey:${purpose}:${ctx.principal?.userId || ctx.ipHash}`;
  await enforceLimits(q, ctx, [[key, 10, WINDOW_MS], [`passkey:ip:${ctx.ipHash}`, 30, WINDOW_MS]]);
  recordAttempt(ctx, key); recordAttempt(ctx, `passkey:ip:${ctx.ipHash}`);
  const id = randomId();
  await q.query('delete from webauthn_challenges where expires_at<$1', [ctx.now]);
  await q.query('insert into webauthn_challenges (id,user_id,session_hash,purpose,challenge,origin,ip_hash,name,expires_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [id, purpose === 'login' ? null : ctx.principal.userId, purpose === 'login' ? null : ctx.principal.sessionHash, purpose, options.challenge, relyingParty(ctx).origin, ctx.ipHash, name, ctx.now + WINDOW_MS]);
  return { challengeId: id, options };
}
async function consumeChallenge(q, ctx, purpose) {
  if (ctx.principal?.type === 'claude') fail(403, 'Only humans can use passkeys');
  const id = str(ctx.body.challengeId, 'challenge', { min: 1, max: 60 });
  const [row] = await q.query('select * from webauthn_challenges where id=$1 for update', [id]);
  if (!row || row.purpose !== purpose || row.expires_at <= ctx.now || row.origin !== relyingParty(ctx).origin || row.ip_hash !== ctx.ipHash || (purpose !== 'login' && (row.user_id !== ctx.principal.userId || row.session_hash !== ctx.principal.sessionHash))) fail(400, 'Passkey request expired. Try again.');
  await q.query('delete from webauthn_challenges where id=$1', [id]);
  // Failed assertions consume their challenge too; never persist credential responses or private material.
  ctx.persist('delete from webauthn_challenges where id=$1', [id]);
  return row;
}
const safeKeys = (q, userId) => q.query('select id,name,device_type,backed_up,created_at,last_used_at from passkeys where user_id=$1 and revoked_at is null order by created_at', [userId]);
export async function passkeyHints(q, userId) { return { count: (await safeKeys(q, userId)).length }; }
async function assertion(q, ctx, purpose) {
  const challenge = await consumeChallenge(q, ctx, purpose), response = ctx.body.credential;
  const id = str(response?.id, 'credential', { min: 1, max: 1500, pattern: /^[A-Za-z0-9_-]+$/ });
  const [key] = await q.query("select p.*,u.username from passkeys p join users u on u.id=p.user_id where p.credential_id=$1 and p.revoked_at is null and u.status='active' for update of p", [id]);
  if (!key || key.rp_id !== relyingParty(ctx).rpID || (purpose !== 'login' && key.user_id !== challenge.user_id)) fail(401, 'Passkey verification failed');
  let verification;
  try {
    rejectEmbedded(response);
    verification = await verifyAuthenticationResponse({ response, expectedChallenge: challenge.challenge, expectedOrigin: challenge.origin, expectedRPID: relyingParty(ctx).rpID, requireUserVerification: true, credential: { id: key.credential_id, publicKey: new Uint8Array(Buffer.from(key.public_key, 'base64url')), counter: Number(key.counter), transports: key.transports } });
  } catch { audit(q, ctx, 'passkey_failed', key.user_id); fail(401, 'Passkey verification failed'); }
  if (!verification.verified) fail(401, 'Passkey verification failed');
  await q.query('update passkeys set counter=$2,last_used_at=$3,backed_up=$4 where id=$1', [key.id, verification.authenticationInfo.newCounter, ctx.now, verification.authenticationInfo.credentialBackedUp]);
  return key;
}
export const passkeyRoutes = [
  ['GET', '/api/passkeys', { auth: 'human', perm: 'station.view' }, async (q, ctx) => ({ passkeys: await safeKeys(q, ctx.principal.userId) })],
  ['POST', '/api/passkeys/register/options', { auth: 'human', perm: 'station.view' }, async (q, ctx) => {
    const name = str(ctx.body.name, 'passkey name', { min: 1, max: 60 }), { rpID } = relyingParty(ctx);
    const keys = await q.query('select credential_id,transports from passkeys where user_id=$1 and revoked_at is null', [ctx.principal.userId]);
    if (keys.length >= 10) fail(400, 'You already have 10 passkeys');
    const options = await generateRegistrationOptions({ rpName: 'Stazione', rpID, userID: new Uint8Array(Buffer.from(sha256(`webauthn:${ORG_ID}:${ctx.principal.userId}`), 'hex')), userName: ctx.principal.username, attestationType: 'none', supportedAlgorithmIDs: [-7,-257], authenticatorSelection: { residentKey: 'required', userVerification: 'required' }, excludeCredentials: keys.map(k => ({ id: k.credential_id, transports: k.transports })) });
    return newChallenge(q, ctx, 'register', options, name);
  }],
  ['POST', '/api/passkeys/register/verify', { auth: 'human', perm: 'station.view' }, async (q, ctx) => {
    const challenge = await consumeChallenge(q, ctx, 'register');
    await q.query('select id from users where id=$1 for update', [ctx.principal.userId]);
    if ((await safeKeys(q, ctx.principal.userId)).length >= 10) fail(400, 'You already have 10 passkeys');
    let verification;
    try { rejectEmbedded(ctx.body.credential); verification = await verifyRegistrationResponse({ response: ctx.body.credential, expectedChallenge: challenge.challenge, expectedOrigin: challenge.origin, expectedRPID: relyingParty(ctx).rpID, requireUserVerification: true, supportedAlgorithmIDs: [-7,-257] }); }
    catch { audit(q, ctx, 'passkey_failed', ctx.principal.userId); fail(400, 'Passkey registration failed'); }
    if (!verification.verified) fail(400, 'Passkey registration failed');
    const info = verification.registrationInfo, id = randomId();
    const existing = await q.query('select id from passkeys where credential_id=$1', [info.credential.id]);
    if (existing.length) fail(409, 'Passkey already registered');
    await q.query('insert into passkeys (id,org_id,user_id,credential_id,public_key,counter,transports,device_type,backed_up,name,rp_id,created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)', [id, ORG_ID, ctx.principal.userId, info.credential.id, Buffer.from(info.credential.publicKey).toString('base64url'), info.credential.counter, JSON.stringify(info.credential.transports || []), info.credentialDeviceType, info.credentialBackedUp, challenge.name, relyingParty(ctx).rpID, ctx.now]);
    audit(q, ctx, 'passkey_registered', ctx.principal.userId, { id, deviceType: info.credentialDeviceType }); return { ok: true, id };
  }],
  ['DELETE', '/api/passkeys/:id', { auth: 'human', perm: 'station.view' }, async (q, ctx) => {
    const rows = await q.query('update passkeys set revoked_at=$3 where id=$1 and user_id=$2 and revoked_at is null returning id', [ctx.params.id, ctx.principal.userId, ctx.now]);
    if (!rows.length) fail(404, 'Passkey not found');
    audit(q, ctx, 'passkey_revoked', ctx.principal.userId, { id: ctx.params.id }); return { ok: true };
  }],
  ['POST', '/api/auth/passkey/options', { auth: 'none', sameOrigin: true }, async (q, ctx) => newChallenge(q, ctx, 'login', await generateAuthenticationOptions({ rpID: relyingParty(ctx).rpID, userVerification: 'required' }))],
  ['POST', '/api/auth/passkey/verify', { auth: 'none', sameOrigin: true }, async (q, ctx) => {
    const key = await assertion(q, ctx, 'login');
    const result = await finishLogin(q, ctx, key.user_id); audit(q, ctx, 'passkey_login', key.user_id, { id: key.id }); return { username: key.username, ...result };
  }],
  ['POST', '/api/auth/passkey/step-up/options', { auth: 'human', perm: 'station.view', sameOrigin: true }, async (q, ctx) => {
    const keys = await q.query('select credential_id,transports from passkeys where user_id=$1 and revoked_at is null and rp_id=$2', [ctx.principal.userId, relyingParty(ctx).rpID]);
    if (!keys.length) fail(404, 'No passkey registered');
    return newChallenge(q, ctx, 'step-up', await generateAuthenticationOptions({ rpID: relyingParty(ctx).rpID, userVerification: 'required', allowCredentials: keys.map(k => ({ id: k.credential_id, transports: k.transports })) }));
  }],
  ['POST', '/api/auth/passkey/step-up/verify', { auth: 'human', perm: 'station.view', sameOrigin: true }, async (q, ctx) => {
    const key = await assertion(q, ctx, 'step-up'); audit(q, ctx, 'step_up_confirmed', ctx.principal.userId, { passkey: key.id }); return refreshStepUp(q, ctx);
  }],
];
