import { fail } from './http.js';
import { parseCidr, allowsIp } from './ip-rules.js';
import { visibleRooms } from './room-access.js';

export async function validateRestrictions(q, ctx, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'Provide token restrictions');
  if (Object.keys(value).some(k => !['rooms','readOnly','noPolls','noContext','ips'].includes(k))) fail(400, 'Unknown token restriction');
  const out = {};
  for (const key of ['readOnly','noPolls','noContext']) {
    if (value[key] != null && typeof value[key] !== 'boolean') fail(400, 'Token switches must be boolean');
    if (value[key]) out[key] = true;
  }
  if (value.rooms != null) {
    if (!Array.isArray(value.rooms) || value.rooms.length > 100 || value.rooms.some(id => typeof id !== 'string')) fail(400, 'Provide at most 100 room IDs');
    const rooms = await visibleRooms(q, ctx);
    if (value.rooms.some(id => !rooms.some(r => r.id === id))) fail(404, 'Room not found');
    out.rooms = [...new Set(value.rooms)]; // [] deliberately permits no rooms; null inherits human access.
  }
  if (value.ips != null) {
    if (!Array.isArray(value.ips) || value.ips.length > 100) fail(400, 'Provide at most 100 IP ranges');
    out.ips = [...new Set(value.ips.map(v => parseCidr(v).cidr))];
  }
  return out;
}
export function tokenRoomAllowed(principal, room) {
  return principal?.type !== 'claude' || principal.restrictions?.rooms == null || (room && principal.restrictions.rooms.includes(room.id));
}
export function capTokenPermissions(principal) {
  if (principal?.type !== 'claude') return;
  const r = principal.restrictions || {};
  if (r.readOnly) principal.permissions = new Set([...principal.permissions].filter(p => p === 'station.view'));
  if (r.noPolls) for (const p of ['polls.open','polls.vote','polls.decide']) principal.permissions.delete(p);
  if (r.noContext) principal.permissions.delete('rooms.context');
}
export async function enforceTokenRequest(q, ctx, pattern) {
  if (ctx.principal?.type !== 'claude') return;
  const r = ctx.principal.restrictions || {};
  if (!allowsIp(r.ips || [], ctx.ip)) fail(403, 'Token access from this network is not allowed');
  if (r.readOnly && ctx.method !== 'GET' && !['/api/claudes/heartbeat','/api/inbox/read'].includes(pattern)) fail(403, 'This token is read only');
  if (r.noPolls && ctx.method !== 'GET' && pattern.startsWith('/api/polls')) fail(403, 'This token cannot change polls');
  if (r.noContext && ctx.method !== 'GET' && pattern.startsWith('/api/context')) fail(403, 'This token cannot write context');
}
