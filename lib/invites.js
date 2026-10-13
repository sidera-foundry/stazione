import { fail } from './http.js';
import { ORG_ID, ALL, cleanPermissions, loadAccess } from './permissions.js';
import { maxUsers } from './auth.js';
import { roomAccess } from './room-access.js';

export async function organization(q, { lock = false } = {}) {
  const [org] = await q.query(`select * from orgs where id = $1${lock ? ' for update' : ''}`, [ORG_ID]);
  return org;
}
export const userLimit = (org) => Number.isInteger(org?.settings?.userLimit) && org.settings.userLimit > 0 ? org.settings.userLimit : maxUsers();
export async function occupiedSeats(q, now) {
  return (await q.query("select count(*)::int as n from users where status = 'active' or (status = 'pending' and pending_expires_at >= $1)", [now]))[0].n;
}
export async function canInviteTo(q, principal, roleId) {
  const [role] = await q.query('select * from roles where id = $1 and org_id = $2', [roleId, ORG_ID]);
  if (!role) fail(404, 'Role not found');
  if (role.id === 'owner' && principal.role !== 'owner') fail(403, 'Only an owner can invite an owner');
  const permissions = role.id === 'owner' ? ALL : cleanPermissions(role.permissions);
  if (permissions.some((p) => !principal.permissions.has(p))) fail(403, 'You cannot invite someone to permissions you do not have');
  return role;
}

export async function validateInviteRole(q, invite) {
  const issuer = await loadAccess(q, invite.created_by);
  if (!issuer.permissions.has('people.invite') && !invite.room_roles?.length) fail(403, 'Invalid invite code');
  const role = await canInviteTo(q, issuer, invite.role_id);
  const permissions = role.id === 'owner' ? ALL : cleanPermissions(role.permissions);
  if (permissions.some((p) => !invite.grant_scope.includes(p))) fail(403, 'The invited role changed: ask for a new invite');
  for (const assignment of invite.room_roles || []) {
    const [room] = await q.query('select * from rooms where id = $1', [assignment.room]);
    if (!room) fail(403, 'The invited room no longer exists');
    const access = await roomAccess(q, invite.created_by, room, issuer);
    if (!access.visible || !access.permissions.has('people.invite')) fail(403, 'Invalid room invite');
    const role = await canInviteTo(q, { ...access, role: issuer.role }, assignment.role);
    if ((role.id === 'owner' ? ALL : cleanPermissions(role.permissions)).some((p) => !assignment.grantScope.includes(p))) fail(403, 'The invited room role changed: ask for a new invite');
  }
  return role.id;
}

export async function prepareRoomInvites(q, principal, assignments = []) {
  if (!Array.isArray(assignments) || assignments.length > 30) fail(400, 'Invalid room roles');
  const out = [], seen = new Set();
  for (const item of assignments) {
    if (!item || typeof item.room !== 'string' || typeof item.role !== 'string' || seen.has(item.room)) fail(400, 'Invalid or duplicate room role');
    const [room] = await q.query('select * from rooms where id = $1', [item.room]);
    if (!room) fail(404, 'Room not found');
    const access = await roomAccess(q, principal.userId, room, principal);
    if (!access.visible || !access.permissions.has('people.invite')) fail(403, 'You cannot invite to this room');
    await canInviteTo(q, { ...access, role: principal.role }, item.role);
    seen.add(item.room); out.push({ room: item.room, role: item.role, grantScope: [...access.permissions] });
  }
  return out;
}
