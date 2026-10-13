import { fail, str, parseCookies, setCookie, clearCookie } from './http.js';
import { randomId, randomToken, sha256 } from './crypto.js';
import { ORG_ID } from './permissions.js';
import { createSession, loadPending, COOKIE_SESSION, COOKIE_PENDING, audit } from './auth.js';

export const COOKIE_DEVICE = '__Host-stz_d';
const DEVICE_MS = 90 * 86400e3;
export async function finishLogin(q, ctx, userId) {
  const [user] = await q.query("select id from users where id=$1 and status='active'", [userId]);
  if (!user) fail(401, 'Sign-in required');
  const cookie = parseCookies(ctx.headers.get('cookie'))[COOKIE_DEVICE];
  let [device] = cookie ? await q.query("select * from devices where cookie_hash=$1 and user_id=$2 and status<>'revoked' and expires_at>$3", [sha256(cookie), userId, ctx.now]) : [];
  if (!device) {
    const token = randomToken('', 32), id = randomId();
    [device] = await q.query('insert into devices (id,org_id,user_id,cookie_hash,name,created_at,expires_at,last_used_at) values ($1,$2,$3,$4,$5,$6,$7,$6) returning *', [id, ORG_ID, userId, sha256(token), 'New browser', ctx.now, ctx.now + DEVICE_MS]);
    ctx.cookies.push(setCookie(COOKIE_DEVICE, token, DEVICE_MS / 1000));
    audit(q, ctx, 'device_registered', userId, { id });
  }
  const [org] = await q.query('select settings from orgs where id=$1', [ORG_ID]);
  const blocked = org.settings.requireKnownDevice && device.status !== 'approved';
  const s = await createSession(q, userId, blocked ? 'device' : 'session', ctx.now);
  await q.query('update sessions set device_id=$2,ip_hash=$3,admin_until=$4 where id_hash=$1', [sha256(s.token), device.id, ctx.ipHash, blocked ? null : ctx.now + 5 * 60e3]);
  await q.query('update devices set last_used_at=$2 where id=$1', [device.id, ctx.now]);
  if (blocked) {
    ctx.cookies.push(setCookie(COOKIE_PENDING, s.token, s.maxAgeSec), clearCookie(COOKIE_SESSION));
    audit(q, ctx, 'device_approval_required', userId, { id: device.id });
    return { next: 'device', deviceId: device.id };
  }
  ctx.cookies.push(setCookie(COOKIE_SESSION, s.token, s.maxAgeSec), clearCookie(COOKIE_PENDING));
  return { next: 'session' };
}
export async function currentDevice(q, ctx) {
  const cookie = parseCookies(ctx.headers.get('cookie'))[COOKIE_DEVICE];
  return cookie ? (await q.query('select id,status,expires_at from devices where cookie_hash=$1 and user_id=$2', [sha256(cookie), ctx.principal.userId]))[0] : null;
}
export const deviceRoutes = [
  ['POST', '/api/devices/register', { auth: 'human', perm: 'station.view' }, async (q, ctx) => {
    const result = await finishLogin(q, ctx, ctx.principal.userId);
    await q.query('delete from sessions where id_hash=$1', [ctx.principal.sessionHash]);
    return { ok: true, ...result };
  }],
  ['GET', '/api/devices', { auth: 'human', perm: 'station.view' }, async (q, ctx) => ({ devices: await q.query('select id,name,status,created_at,expires_at,last_used_at from devices where user_id=$1 order by created_at desc', [ctx.principal.userId]), current: (await currentDevice(q, ctx))?.id ?? null })],
  ['PUT', '/api/devices/:id', { auth: 'human', perm: 'station.view' }, async (q, ctx) => {
    const name = str(ctx.body.name, 'device name', { min: 1, max: 60 });
    const rows = await q.query('update devices set name=$3 where id=$1 and user_id=$2 returning id', [ctx.params.id, ctx.principal.userId, name]);
    if (!rows.length) fail(404, 'Device not found');
    return { ok: true };
  }],
  ['POST', '/api/auth/device/status', { auth: 'none', sameOrigin: true }, async (q, ctx) => {
    const pending = await loadPending(q, ctx, ['device']), cookie = parseCookies(ctx.headers.get('cookie'))[COOKIE_DEVICE];
    const [device] = await q.query('select status,expires_at from devices where id=$1 and user_id=$2 and cookie_hash=$3', [pending.device_id, pending.user_id, cookie ? sha256(cookie) : '']);
    if (pending.ip_hash !== ctx.ipHash || !device || device.status === 'revoked' || device.expires_at <= ctx.now) fail(401, 'Device request expired. Sign in again.');
    const [org] = await q.query('select settings from orgs where id=$1', [ORG_ID]);
    if (device.status !== 'approved' && org.settings.requireKnownDevice) return { next: 'device', status: 'pending' };
    const removed = await q.query('delete from sessions where id_hash=$1 returning id_hash', [pending.id_hash]);
    if (!removed.length) fail(401, 'Device request expired. Sign in again.');
    return finishLogin(q, ctx, pending.user_id);
  }],
];
