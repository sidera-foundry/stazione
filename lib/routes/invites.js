import { fail, str, int } from '../http.js';
import { randomId, randomToken, sha256 } from '../crypto.js';
import { audit } from '../auth.js';
import { ORG_ID } from '../permissions.js';
import { organization, userLimit, occupiedSeats, canInviteTo, prepareRoomInvites } from '../invites.js';

export const inviteRoutes = [
  ['GET', '/api/invites', { auth: 'human', perm: 'station.view' }, async (q, ctx) => {
    const manage = ctx.principal.permissions.has('people.manage');
    const rows = await q.query(`select id, role_id, label, created_by, created_at, expires_at, used_at, revoked_at,
      reserved_until from invites where org_id = $1 ${manage ? '' : 'and created_by = $2'} order by created_at desc limit 100`,
    manage ? [ORG_ID] : [ORG_ID, ctx.principal.userId]);
    return { invites: rows.map((i) => ({ id: i.id, role: i.role_id, label: i.label, createdBy: i.created_by,
      createdAt: i.created_at, expiresAt: i.expires_at, usedAt: i.used_at, revokedAt: i.revoked_at,
      reservedUntil: i.reserved_until > ctx.now ? i.reserved_until : null })) };
  }],
  ['POST', '/api/invites', { auth: 'human', perm: 'station.view' }, async (q, ctx) => {
    await organization(q, { lock: true });
    const role = await canInviteTo(q, ctx.principal, str(ctx.body.role ?? 'member', 'role', { min: 1, max: 40 }));
    const roomRoles = await prepareRoomInvites(q, ctx.principal, ctx.body.roomRoles ?? []);
    if (!ctx.principal.permissions.has('people.invite') && !roomRoles.length) fail(403, 'Your role does not allow this (people.invite)');
    const label = str(ctx.body.label, 'label', { max: 80 });
    const hours = int(ctx.body.hours, 'hours', { min: 1, max: 720, def: 48 });
    const code = randomToken('sti_', 32), id = randomId(), expiresAt = ctx.now + hours * 3600e3;
    await q.query(`insert into invites (id, org_id, code_hash, role_id, label, created_by, created_at, expires_at, grant_scope)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [id, ORG_ID, sha256(code), role.id, label, ctx.principal.userId, ctx.now, expiresAt, JSON.stringify([...ctx.principal.permissions])]);
    await q.query('update invites set room_roles = $2 where id = $1', [id, JSON.stringify(roomRoles)]);
    audit(q, ctx, 'invite_created', ctx.principal.userId, { id, role: role.id, expiresAt });
    ctx.status = 201;
    return { id, code, link: `/register?invite=${encodeURIComponent(code)}`, role: role.id, expiresAt };
  }],
  ['POST', '/api/invites/:id/revoke', { auth: 'human', perm: 'station.view' }, async (q, ctx) => {
    await organization(q, { lock: true });
    const [invite] = await q.query('select * from invites where id = $1 and org_id = $2 for update', [ctx.params.id, ORG_ID]);
    if (!invite || (invite.created_by !== ctx.principal.userId && !ctx.principal.permissions.has('people.manage'))) fail(404, 'Invite not found');
    await q.query('update invites set revoked_at = coalesce(revoked_at, $2) where id = $1', [invite.id, ctx.now]);
    audit(q, ctx, 'invite_revoked', ctx.principal.userId, { id: invite.id });
    return { ok: true };
  }],
  ['GET', '/api/organization', { auth: 'human', perm: 'admin.console' }, async (q, ctx) => {
    const org = await organization(q);
    return { id: org.id, name: org.name, userLimit: userLimit(org), occupiedSeats: await occupiedSeats(q, ctx.now) };
  }],
  ['PUT', '/api/organization/user-limit', { auth: 'human', perm: 'admin.security' }, async (q, ctx) => {
    const org = await organization(q, { lock: true });
    const limit = int(ctx.body.limit, 'limit', { min: 1, max: 99999 });
    if (limit < await occupiedSeats(q, ctx.now)) fail(409, 'The limit cannot exclude existing people or pending registrations');
    await q.query("update orgs set settings = settings || $2::jsonb where id = $1", [ORG_ID, JSON.stringify({ userLimit: limit })]);
    audit(q, ctx, 'user_limit_changed', ctx.principal.userId, { from: userLimit(org), to: limit });
    return { ok: true, userLimit: limit };
  }],
];
