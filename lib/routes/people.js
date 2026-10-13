// People and roles: who has which role, and the roles themselves (sets of permissions, lib/permissions.js).
// Rules that keep it safe: nobody grants permissions they do not have; only an owner touches owners; the last owner
// can never be removed or demoted; every change is audited. Humans only (a Claude token gets 403).
import { fail, str } from '../http.js';
import { randomToken } from '../crypto.js';
import { audit } from '../auth.js';
import { ORG_ID, PERMISSIONS, ALL, cleanPermissions } from '../permissions.js';
import { requireRoom } from '../room-access.js';
import { need } from '../permissions.js';
import { deleteAccount } from '../account-delete.js';

const roleId = (v) => str(v, 'role', { min: 1, max: 40, pattern: /^[a-z0-9-]+$/ });
const effective = (r) => (r.id === 'owner' ? ALL : cleanPermissions(r.permissions));
const camelRole = (r, members) => ({ id: r.id, name: r.name, builtin: r.builtin, permissions: effective(r), members: members ?? undefined });

/** The caller may only hand out permissions they hold themselves. */
function withinOwn(ctx, perms) {
  const extra = perms.filter((p) => !ctx.principal.permissions.has(p));
  if (extra.length) fail(403, `You cannot grant permissions you do not have: ${extra.join(', ')}`);
}

async function ownersLeft(q, exceptUser) {
  const [r] = await q.query("select count(*)::int as n from memberships m join users u on u.id = m.user_id where m.org_id = $1 and m.role_id = 'owner' and u.status = 'active' and m.user_id <> $2", [ORG_ID, exceptUser]);
  return r.n;
}

export const peopleRoutes = [
  ['GET', '/api/people', { auth: 'human', perm: 'people.manage' }, async (q) => {
    const rows = await q.query(
      `select u.id, u.username, u.status, u.created_at, m.role_id, r.name as role_name from users u
         left join memberships m on m.user_id = u.id left join roles r on r.id = m.role_id
        where u.status = 'active' order by u.created_at`,
    );
    const assignments = await q.query('select user_id, room_id, role_id from room_roles');
    return { people: rows.map((u) => ({ id: u.id, username: u.username, role: u.role_id, roleName: u.role_name, createdAt: u.created_at, roomRoles: assignments.filter((r) => r.user_id === u.id).map((r) => ({ room: r.room_id, role: r.role_id })) })) };
  }],

  ['PUT', '/api/people/:id/role', { auth: 'human', perm: 'people.manage' }, async (q, ctx) => {
    // Serialize membership changes across targets: two owners must not both see the other and step down.
    await q.query('select id from orgs where id = $1 for update', [ORG_ID]);
    const target = str(ctx.params.id, 'person', { min: 1, max: 60 });
    const [u] = await q.query("select u.id, u.username, m.role_id from users u left join memberships m on m.user_id = u.id where u.id = $1 and u.status = 'active' for update of u", [target]);
    if (!u) fail(404, 'Person not found');
    const [role] = await q.query('select * from roles where id = $1 and org_id = $2', [roleId(ctx.body.role), ORG_ID]);
    if (!role) fail(404, 'Role not found');
    const isOwner = ctx.principal.role === 'owner';
    if ((u.role_id === 'owner' || role.id === 'owner') && !isOwner) fail(403, 'Only an owner can make or change an owner');
    withinOwn(ctx, effective(role));
    if (u.role_id === 'owner' && role.id !== 'owner' && !(await ownersLeft(q, u.id))) fail(409, 'The station needs at least one owner');
    await q.query(
      `insert into memberships (user_id, org_id, role_id, updated_at) values ($1, $2, $3, $4)
       on conflict (user_id) do update set role_id = excluded.role_id, updated_at = excluded.updated_at`,
      [u.id, ORG_ID, role.id, ctx.now],
    );
    audit(q, ctx, 'role_assigned', ctx.principal.userId, { user: u.id, from: u.role_id, to: role.id });
    return { ok: true, id: u.id, role: role.id };
  }],

  ['PUT', '/api/people/:id/rooms/:room/role', { auth: 'human', perm: 'people.manage' }, async (q, ctx) => {
    await q.query('select id from orgs where id = $1 for update', [ORG_ID]);
    const organizationRole = ctx.principal.role;
    const [u] = await q.query("select u.id, m.role_id from users u join memberships m on m.user_id = u.id where u.id = $1 and u.status = 'active'", [ctx.params.id]);
    const [room] = await q.query('select id from rooms where id = $1', [ctx.params.room]);
    if (!u || !room) fail(404, 'Person or room not found');
    await requireRoom(q, ctx, room.id); need(ctx, 'people.manage');
    if (u.role_id === 'owner' && organizationRole !== 'owner') fail(403, 'Only an owner can change an owner');
    if (ctx.body.role == null) await q.query('delete from room_roles where user_id = $1 and room_id = $2', [u.id, room.id]);
    else {
      const [role] = await q.query('select * from roles where id = $1 and org_id = $2', [roleId(ctx.body.role), ORG_ID]);
      if (!role) fail(404, 'Role not found');
      if (role.id === 'owner' && organizationRole !== 'owner') fail(403, 'Only an owner can assign the owner role');
      withinOwn(ctx, effective(role));
      await q.query('insert into room_roles (user_id, room_id, role_id) values ($1, $2, $3) on conflict (user_id, room_id) do update set role_id = excluded.role_id', [u.id, room.id, role.id]);
    }
    audit(q, ctx, 'room_role_assigned', ctx.principal.userId, { user: u.id, room: room.id, role: ctx.body.role ?? null });
    return { ok: true };
  }],

  /** An owner deletes someone else's account (people delete their own from the Account page). */
  ['POST', '/api/people/:id/delete', { auth: 'human', perm: 'people.manage' }, async (q, ctx) => {
    if (ctx.principal.role !== 'owner') fail(403, 'Only an owner can delete an account');
    const target = str(ctx.params.id, 'person', { min: 1, max: 60 });
    if (target === ctx.principal.userId) fail(400, 'Delete your own account from the Account page');
    const gone = await deleteAccount(q, ctx, target);
    audit(q, ctx, 'account_deleted', ctx.principal.userId, { user: gone.id, by: 'owner', role: gone.role, agents: gone.agents.length });
    return { ok: true, id: gone.id };
  }],

  /** Roles and the permission catalog: every human may read them (the panel shows what a role allows). */
  ['GET', '/api/roles', { auth: 'human', perm: 'station.view' }, async (q) => {
    const roles = await q.query('select * from roles where org_id = $1 order by builtin desc, created_at', [ORG_ID]);
    const counts = Object.fromEntries((await q.query('select role_id, count(*)::int as n from memberships where org_id = $1 group by role_id', [ORG_ID])).map((r) => [r.role_id, r.n]));
    return { roles: roles.map((r) => camelRole(r, counts[r.id] || 0)), permissions: Object.entries(PERMISSIONS).map(([id, label]) => ({ id, label })) };
  }],

  ['POST', '/api/roles', { auth: 'human', perm: 'admin.roles' }, async (q, ctx) => {
    const name = str(ctx.body.name, 'name', { min: 1, max: 40 });
    const permissions = cleanPermissions(ctx.body.permissions);
    withinOwn(ctx, permissions);
    const [dup] = await q.query('select 1 from roles where org_id = $1 and lower(name) = lower($2)', [ORG_ID, name]);
    if (dup) fail(409, 'A role with this name already exists');
    const id = `r-${randomToken('', 6).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;
    await q.query('insert into roles (id, org_id, name, builtin, permissions, created_at, updated_at) values ($1, $2, $3, false, $4, $5, $5)', [id, ORG_ID, name, JSON.stringify(permissions), ctx.now]);
    audit(q, ctx, 'role_created', ctx.principal.userId, { role: id, permissions });
    ctx.status = 201;
    return { id, name, permissions };
  }],

  ['PUT', '/api/roles/:id', { auth: 'human', perm: 'admin.roles' }, async (q, ctx) => {
    const [role] = await q.query('select * from roles where id = $1 and org_id = $2 for update', [roleId(ctx.params.id), ORG_ID]);
    if (!role) fail(404, 'Role not found');
    if (role.id === 'owner') fail(400, 'The owner role always has every permission');
    if (role.id === 'admin' && ctx.principal.role !== 'owner') fail(403, 'Only an owner can change the admin role');
    const name = ctx.body.name == null ? role.name : str(ctx.body.name, 'name', { min: 1, max: 40 });
    const permissions = ctx.body.permissions == null ? cleanPermissions(role.permissions) : cleanPermissions(ctx.body.permissions);
    // Adding is limited to what you hold; removing is always possible.
    withinOwn(ctx, permissions.filter((p) => !cleanPermissions(role.permissions).includes(p)));
    await q.query('update roles set name = $2, permissions = $3, updated_at = $4 where id = $1', [role.id, name, JSON.stringify(permissions), ctx.now]);
    audit(q, ctx, 'role_changed', ctx.principal.userId, { role: role.id, from: cleanPermissions(role.permissions), to: permissions });
    return { id: role.id, name, permissions };
  }],

  ['DELETE', '/api/roles/:id', { auth: 'human', perm: 'admin.roles' }, async (q, ctx) => {
    const [role] = await q.query('select * from roles where id = $1 and org_id = $2 for update', [roleId(ctx.params.id), ORG_ID]);
    if (!role) fail(404, 'Role not found');
    if (role.builtin) fail(400, 'Built-in roles cannot be deleted');
    const [m] = await q.query('select count(*)::int as n from memberships where role_id = $1', [role.id]);
    if (m.n) fail(409, `${m.n} people still have this role: give them another one first`);
    if ((await q.query('select 1 from room_roles where role_id = $1 limit 1', [role.id])).length) fail(409, 'People still have this role in rooms');
    await q.query('delete from roles where id = $1', [role.id]);
    audit(q, ctx, 'role_deleted', ctx.principal.userId, { role: role.id });
    return { ok: true };
  }],
];
