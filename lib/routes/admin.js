import { readFile } from 'node:fs/promises';
import { regionCheck } from '../region.js';
import { fail, str, int } from '../http.js';
import { audit, enforceLimits, recordAttempt, clearAttempts, verifyTotp, decryptTotp } from '../auth.js';
import { refreshStepUp, ADMIN_IDLE_MS, ADMIN_ABSOLUTE_MS } from '../admin.js';
import { randomId, randomToken } from '../crypto.js';
import { ORG_ID } from '../permissions.js';
import { parseCidr, allowsIp } from '../ip-rules.js';
import { validateRestrictions } from '../token-restrictions.js';
import { currentDevice } from '../devices.js';
import { decideAdminChange, describeChange } from '../admin-changes.js';
import { modelCheckSettings, saveModelCheck } from '../model-check.js';

const confirmIdentity = async (q, ctx) => {
  const userId = ctx.principal.userId, key = `stepup:user:${userId}`;
  await enforceLimits(q, ctx, [[key, 6, 15 * 60e3], [`stepup:ip:${ctx.ipHash}`, 30, 3600e3]]);
  const [u] = await q.query('select id,totp_secret_enc,totp_last_step from users where id=$1 for update', [userId]);
  const code = str(ctx.body.code, 'code', { min: 1, max: 6 });
  const step = u?.totp_secret_enc && verifyTotp(decryptTotp(u.totp_secret_enc, u.id), code, u.totp_last_step);
  if (!step) { recordAttempt(ctx, key); recordAttempt(ctx, `stepup:ip:${ctx.ipHash}`); audit(q, ctx, 'step_up_failed', userId); fail(400, 'Invalid confirmation code'); }
  await clearAttempts(q, key);
  await q.query('update users set totp_last_step=$2 where id=$1', [userId, step]);
  audit(q, ctx, 'step_up_confirmed', userId);
  return refreshStepUp(q, ctx);
};
import { visibleRooms, filterRoomContent } from '../room-access.js';
import { camelRoom } from './rooms.js';
import { peopleRoutes } from './people.js';
import { inviteRoutes } from './invites.js';
import { roomRoutes } from './rooms.js';
import { scopeRequest } from '../room-access.js';
import { need } from '../permissions.js';

// Reuse the same handlers and permission/target checks as the established human APIs.
const aliases = [...peopleRoutes, ...inviteRoutes, ...roomRoutes.filter(([m, p]) => m === 'PUT' && p.endsWith('/visibility'))]
  .map(([method, path, opts, handler]) => [method, path.replace('/api/', '/api/admin/'), { ...opts, auth: 'human', admin: true }, async (q, ctx) => {
    await scopeRequest(q, ctx, path); if (opts.perm) need(ctx, opts.perm);
    return handler(q, ctx);
  }]);

export const adminRoutes = [
  ['GET','/api/admin/model-check',{ auth:'human',admin:true,perm:'admin.security' },modelCheckSettings],
  ['PUT','/api/admin/model-check',{ auth:'human',admin:true,perm:'admin.security' },saveModelCheck],
  ['GET', '/api/admin/security-policy', { auth: 'human', admin: true, perm: 'admin.security' }, async q => {
    const [org] = await q.query('select settings from orgs where id=$1', [ORG_ID]);
    return { fourEyes: Boolean(org.settings.fourEyes), requireKnownDevice: Boolean(org.settings.requireKnownDevice) };
  }],
  ['PUT', '/api/admin/security-policy', { auth: 'human', admin: true, perm: 'admin.security' }, async (q, ctx) => {
    const { fourEyes, requireKnownDevice } = ctx.body;
    if (typeof fourEyes !== 'boolean' || typeof requireKnownDevice !== 'boolean') fail(400, 'Security switches must be boolean');
    if (fourEyes) {
      const [admins] = await q.query("select count(*)::int as n from users u join memberships m on m.user_id=u.id join roles r on r.id=m.role_id where u.status='active' and m.role_id in ('owner','admin') and (m.role_id='owner' or r.permissions @> '[\"admin.console\",\"admin.security\",\"people.manage\"]'::jsonb)");
      if (admins.n < 2) fail(409, 'Four-eyes approval requires two active administrators with security permissions');
    }
    if (requireKnownDevice) {
      const current = await currentDevice(q, ctx);
      if (!current || current.status !== 'approved' || current.expires_at <= ctx.now) fail(409, 'Approve your current browser before requiring registered devices');
      const [owner] = await q.query("select 1 from devices d join users u on u.id=d.user_id join memberships m on m.user_id=u.id where u.status='active' and m.role_id='owner' and d.status='approved' and d.expires_at>$1 limit 1", [ctx.now]);
      if (!owner) fail(409, 'At least one owner must have an approved device');
    }
    const [old] = await q.query('select settings from orgs where id=$1', [ORG_ID]);
    await q.query('update orgs set settings=settings || $2::jsonb where id=$1', [ORG_ID, JSON.stringify({ fourEyes, requireKnownDevice })]);
    audit(q, ctx, 'security_policy_changed', ctx.principal.userId, { from: { fourEyes: Boolean(old.settings.fourEyes), requireKnownDevice: Boolean(old.settings.requireKnownDevice) }, to: { fourEyes, requireKnownDevice } });
    return { ok: true, fourEyes, requireKnownDevice };
  }],
  ['GET', '/api/admin/devices', { auth: 'human', admin: true, perm: 'people.manage' }, async q => ({ devices: await q.query('select d.id,d.user_id,u.username,m.role_id as role,d.name,d.status,d.created_at,d.expires_at,d.last_used_at from devices d join users u on u.id=d.user_id join memberships m on m.user_id=u.id order by d.created_at desc limit 300') })],
  ['POST', '/api/admin/devices/:id/decide', { auth: 'human', admin: true, perm: 'people.manage' }, async (q, ctx) => {
    if (typeof ctx.body.approve !== 'boolean') fail(400, 'Device decision must be boolean');
    const [device] = await q.query('select d.*,m.role_id from devices d join memberships m on m.user_id=d.user_id where d.id=$1 for update of d', [ctx.params.id]);
    if (!device || device.expires_at <= ctx.now || device.status === 'revoked') fail(404, 'Device not found');
    if (device.role_id === 'owner' && ctx.principal.role !== 'owner') fail(403, 'Only an owner can change an owner device');
    const status = ctx.body.approve === true ? 'approved' : 'revoked';
    if (status === 'revoked' && device.role_id === 'owner' && device.status === 'approved') {
      const [org] = await q.query('select settings from orgs where id=$1', [ORG_ID]);
      if (org.settings.requireKnownDevice) {
        const [other] = await q.query("select 1 from devices d join users u on u.id=d.user_id join memberships m on m.user_id=u.id where d.id<>$1 and d.status='approved' and d.expires_at>$2 and u.status='active' and m.role_id='owner' limit 1", [device.id, ctx.now]);
        if (!other) fail(409, 'Keep at least one approved owner device or disable the device requirement first');
      }
    }
    await q.query('update devices set status=$2,approved_by=$3,decided_at=$4 where id=$1', [device.id, status, ctx.principal.userId, ctx.now]);
    if (status === 'revoked') await q.query('delete from sessions where device_id=$1', [device.id]);
    audit(q, ctx, status === 'approved' ? 'device_approved' : 'device_revoked', ctx.principal.userId, { id: device.id, user: device.user_id }); return { ok: true, status };
  }],
  ['GET', '/api/admin/passkeys', { auth: 'human', admin: true, perm: 'people.manage' }, async q => ({ passkeys: await q.query('select p.id,p.user_id,u.username,m.role_id as role,p.name,p.device_type,p.backed_up,p.created_at,p.last_used_at from passkeys p join users u on u.id=p.user_id join memberships m on m.user_id=u.id where p.revoked_at is null order by p.created_at desc limit 300') })],
  ['DELETE', '/api/admin/passkeys/:id', { auth: 'human', admin: true, perm: 'people.manage' }, async (q, ctx) => {
    const [key] = await q.query('select p.id,p.user_id,m.role_id from passkeys p join memberships m on m.user_id=p.user_id where p.id=$1 and p.revoked_at is null for update of p', [ctx.params.id]);
    if (!key) fail(404, 'Passkey not found');
    if (key.role_id === 'owner' && ctx.principal.role !== 'owner') fail(403, 'Only an owner can revoke an owner passkey');
    await q.query('update passkeys set revoked_at=$2 where id=$1', [key.id, ctx.now]);
    audit(q, ctx, 'passkey_revoked', ctx.principal.userId, { id: key.id, user: key.user_id }); return { ok: true };
  }],
  ['GET', '/api/admin/changes', { auth: 'human', admin: true }, async (q, ctx) => {
    if (!['owner','admin'].includes(ctx.principal.role)) fail(403, 'An owner or administrator must review this change');
    await q.query("update admin_changes set status='expired',payload_enc=null where status='pending' and expires_at<=$1", [ctx.now]);
    const rows = await q.query('select c.id,c.created_by,u.username,c.title,c.status,c.created_at,c.expires_at,c.decided_by,c.payload_enc from admin_changes c join users u on u.id=c.created_by order by c.created_at desc limit 100');
    return { changes: rows.map(row => { const proposal = describeChange(row); delete row.payload_enc; return { ...row, proposal }; }) };
  }],
  ['POST', '/api/admin/changes/:id/decide', { auth: 'human', admin: true }, decideAdminChange],
  ['POST', '/api/auth/step-up', { auth: 'human', sameOrigin: true }, confirmIdentity],
  ['POST', '/api/admin/step-up', { auth: 'human', admin: true }, confirmIdentity],
  ['GET', '/api/admin/page', { auth: 'human', admin: true, html: true }, async () => readFile(new URL('../admin-page.html', import.meta.url), 'utf8')],
  ['GET', '/api/admin/session', { auth: 'human', admin: true }, async (q, ctx) => {
    const [s] = await q.query('select admin_started_at from sessions where id_hash=$1', [ctx.principal.sessionHash]);
    return { userId: ctx.principal.userId, username: ctx.principal.username, role: ctx.principal.role, permissions: [...ctx.principal.permissions],
      idleMinutes: ADMIN_IDLE_MS / 60e3, absoluteHours: ADMIN_ABSOLUTE_MS / 3600e3, startedAt: Number(s?.admin_started_at) || ctx.now, now: ctx.now };
  }],
  ['POST', '/api/admin/logout', { auth: 'human', admin: true }, async (q, ctx) => {
    await q.query('update sessions set admin_closed_at = $2, admin_until=null where id_hash = $1', [ctx.principal.sessionHash, ctx.now]);
    return { ok: true };
  }],
  ['GET', '/api/admin/overview', { auth: 'human', admin: true, perm: 'station.view' }, async (q, ctx) => {
    const rooms = await visibleRooms(q, ctx);
    const claudes = await filterRoomContent(q, ctx, await q.query('select id, name, owner_id, room, project, status, last_seen, reception_mode, trusted_senders from claudes order by joined_at'));
    const tasks = await filterRoomContent(q, ctx, await q.query("select id, title, project, status, owner_claude from tasks where status <> 'done' order by created_at"));
    const locks = await filterRoomContent(q, ctx, await q.query('select project, resource, owner_claude, expires_at from locks where expires_at > $1', [ctx.now]));
    return { rooms: rooms.map(r => ({ ...camelRoom(r), receptionDefault: r.reception_default })), claudes, tasks, locks, region: regionCheck() };
  }],
  ['GET', '/api/admin/tokens', { auth: 'human', admin: true, perm: 'claudes.manage' }, async (q, ctx) => {
    const tokens = await q.query('select t.id, t.name, t.user_id, u.username, t.created_at, t.last_used_at, t.expires_at, t.revoked_at, t.suspended_at, t.restrictions from api_tokens t join users u on u.id = t.user_id order by t.created_at desc limit 300');
    return { tokens };
  }],
  ['PUT', '/api/admin/tokens/:id', { auth: 'human', admin: true, perm: 'claudes.manage' }, async (q, ctx) => {
    const [t] = await q.query('select t.id,t.user_id,m.role_id from api_tokens t join memberships m on m.user_id=t.user_id where t.id=$1 and t.revoked_at is null for update of t', [ctx.params.id]);
    if (!t) fail(404, 'Token not found');
    if (t.role_id === 'owner' && ctx.principal.role !== 'owner') fail(403, 'Only an owner can change an owner token');
    const restrictions = await validateRestrictions(q, ctx, ctx.body.restrictions);
    await q.query('update api_tokens set restrictions=$2 where id=$1', [t.id, JSON.stringify(restrictions)]);
    audit(q, ctx, 'token_restrictions_changed', ctx.principal.userId, { id: t.id, owner: t.user_id, restrictions });
    return { ok: true, restrictions };
  }],
  ['POST', '/api/admin/tokens/:id/revoke', { auth: 'human', admin: true, perm: 'claudes.manage' }, async (q, ctx) => {
    const [t] = await q.query('select t.id, t.user_id, m.role_id from api_tokens t join memberships m on m.user_id = t.user_id where t.id = $1 for update of t', [ctx.params.id]);
    if (!t) fail(404, 'Token not found');
    if (t.role_id === 'owner' && ctx.principal.role !== 'owner') fail(403, 'Only an owner can revoke an owner token');
    await q.query('update api_tokens set revoked_at = coalesce(revoked_at, $2) where id = $1', [t.id, ctx.now]);
    audit(q, ctx, 'token_revoked', ctx.principal.userId, { id: t.id, owner: t.user_id });
    return { ok: true };
  }],
  ['GET', '/api/admin/audit', { auth: 'human', admin: true, perm: 'admin.audit' }, async (q, ctx) => {
    const event = str(ctx.query.get('event'), 'event', { max: 80 }), user = str(ctx.query.get('user'), 'user', { max: 60 });
    const from = int(ctx.query.get('from'), 'from', { min: 0, max: Number.MAX_SAFE_INTEGER, def: 0 });
    const to = int(ctx.query.get('to'), 'to', { min: from, max: Number.MAX_SAFE_INTEGER, def: ctx.now });
    const before = int(ctx.query.get('before'), 'before', { min: 1, max: Number.MAX_SAFE_INTEGER, def: Number.MAX_SAFE_INTEGER });
    const rows = await q.query(`select a.id, a.user_id, u.username, a.event, a.detail, a.ip_hash, a.at from audit_log a left join users u on u.id = a.user_id
      where a.at >= $1 and a.at <= $2 and a.id < $3 and ($4 = '' or a.event = $4) and ($5 = '' or a.user_id = $5) order by a.id desc limit 101`, [from, to, before, event, user]);
    return { entries: rows.slice(0, 100), nextBefore: rows.length > 100 ? rows[99].id : null };
  }],
  ['GET', '/api/admin/ip-rules', { auth: 'human', admin: true, perm: 'admin.security' }, async (q) => ({ rules: await q.query('select id,target,cidr,created_at from ip_rules where org_id=$1 order by target,created_at', [ORG_ID]) })],
  ['PUT', '/api/admin/ip-rules', { auth: 'human', admin: true, perm: 'admin.security' }, async (q, ctx) => {
    await q.query('select id from orgs where id=$1 for update', [ORG_ID]);
    const rules = [];
    for (const target of ['humans', 'agents']) {
      const values = ctx.body[target];
      if (!Array.isArray(values) || values.length > 100) fail(400, 'Provide at most 100 IP ranges for each group');
      for (const cidr of new Set(values.map(v => parseCidr(v).cidr))) rules.push({ target, cidr });
    }
    if (!allowsIp(rules.filter(r => r.target === 'humans'), ctx.ip)) fail(409, 'The allowed networks must include your current address');
    const previous = await q.query('select target,cidr from ip_rules where org_id=$1 order by target,cidr', [ORG_ID]);
    await q.query('delete from ip_rules where org_id=$1', [ORG_ID]);
    for (const r of rules) await q.query('insert into ip_rules (id,org_id,target,cidr,created_by,created_at) values ($1,$2,$3,$4,$5,$6)', [randomId(), ORG_ID, r.target, r.cidr, ctx.principal.userId, ctx.now]);
    audit(q, ctx, 'ip_rules_changed', ctx.principal.userId, { from: previous, to: rules });
    return { ok: true, rules };
  }],
  ['GET', '/api/admin/sessions', { auth: 'human', admin: true, perm: 'people.manage' }, async (q, ctx) => {
    for (const s of await q.query("select id_hash from sessions where public_id is null and kind='session' and expires_at>$1", [ctx.now])) {
      await q.query('update sessions set public_id=$2 where id_hash=$1 and public_id is null', [s.id_hash, randomToken('ss_', 16)]);
    }
    const sessions = await q.query(`select s.public_id as id,s.user_id,u.username,m.role_id as role,s.created_at,s.last_seen,s.expires_at,s.ip_hash,
      (s.id_hash=$1) as current from sessions s join users u on u.id=s.user_id join memberships m on m.user_id=s.user_id
      where s.kind='session' and s.expires_at>$2 and s.last_seen>$3 and u.status='active' order by s.last_seen desc limit 300`, [ctx.principal.sessionHash, ctx.now, ctx.now - 12 * 3600e3]);
    return { sessions };
  }],
  ['POST', '/api/admin/sessions/:id/close', { auth: 'human', admin: true, perm: 'people.manage' }, async (q, ctx) => {
    const [s] = await q.query('select s.id_hash,s.user_id,m.role_id from sessions s join memberships m on m.user_id=s.user_id where s.public_id=$1 and s.kind=\'session\' for update of s', [ctx.params.id]);
    if (!s) fail(404, 'Session not found');
    if (s.role_id === 'owner' && ctx.principal.role !== 'owner') fail(403, 'Only an owner can close an owner session');
    await q.query('delete from sessions where id_hash=$1', [s.id_hash]);
    audit(q, ctx, 'session_closed', ctx.principal.userId, { id: ctx.params.id, user: s.user_id });
    return { ok: true };
  }],
  ['GET', '/api/admin/alerts', { auth: 'human', admin: true, perm: 'admin.audit' }, async (q) => ({ alerts: await q.query('select id,event,actor,detail,at from security_alerts where org_id=$1 order by id desc limit 50', [ORG_ID]) })],
  ...aliases,
];
