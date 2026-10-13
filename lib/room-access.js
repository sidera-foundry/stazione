import { fail } from './http.js';
import { loadAccess, ALL, cleanPermissions } from './permissions.js';
import { allRooms, roomOfProject, normName } from './routes/rooms.js';
import { tokenRoomAllowed, capTokenPermissions } from './token-restrictions.js';

export async function roomAccess(q, userId, room, base = null) {
  base ??= await loadAccess(q, userId);
  const [assignment] = room ? await q.query('select r.id, r.name, r.permissions from room_roles m join roles r on r.id = m.role_id where m.user_id = $1 and m.room_id = $2', [userId, room.id]) : [];
  const visible = !room || room.visibility !== 'restricted' || assignment || ['owner', 'admin'].includes(base.role);
  const effective = assignment && base.role !== 'owner'
    ? { role: assignment.id, roleName: assignment.name, permissions: new Set(assignment.id === 'owner' ? ALL : cleanPermissions(assignment.permissions)) } : base;
  return { ...effective, visible: Boolean(visible && effective.permissions.has('station.view')) };
}

export async function visibleRooms(q, ctx) {
  const base = await loadAccess(q, ctx.principal.userId), rooms = await allRooms(q, ctx.now), out = [];
  for (const room of rooms) if (tokenRoomAllowed(ctx.principal, room) && (await roomAccess(q, ctx.principal.userId, room, base)).visible) out.push(room);
  out.restrictedToToken = ctx.principal.type === 'claude' && ctx.principal.restrictions?.rooms != null;
  return out;
}

export async function scopeRoom(q, ctx, room) {
  const base = await loadAccess(q, ctx.principal.userId);
  const access = await roomAccess(q, ctx.principal.userId, room, base);
  if (room && !access.visible) fail(404, 'Room not found');
  if (!tokenRoomAllowed(ctx.principal, room)) fail(404, 'Room not found');
  Object.assign(ctx.principal, access, { organizationRole: base.role, roomId: room?.id ?? null });
  capTokenPermissions(ctx.principal);
  return room;
}

export async function requireRoom(q, ctx, id) {
  const [room] = await q.query('select * from rooms where id = $1', [id]);
  if (!room) fail(404, 'Room not found');
  return scopeRoom(q, ctx, room);
}

export async function scopeProject(q, ctx, project) {
  return scopeRoom(q, ctx, await roomOfProject(q, project, ctx.now));
}

export function projectVisible(project, rooms, all, roomId = null) {
  if (!project && roomId) return rooms.some(r => r.id === roomId);
  const room = all.find((r) => r.keys.includes(`n:${normName(project)}`) || normName(r.project) === normName(project));
  return room ? rooms.some((r) => r.id === room.id) : !rooms.restrictedToToken;
}

export async function filterRoomContent(q, ctx, rows) {
  const all = await allRooms(q, ctx.now), rooms = await visibleRooms(q, ctx);
  return rows.filter((r) => (!r.room || rooms.some((room) => room.id === r.room)) && projectVisible(r.project, rooms, all, r.room));
}

// Resolve scope before checking route permissions. Target objects win over a caller-supplied room.
// Organization administration always keeps organization permissions.
export async function scopeRequest(q, ctx, pattern) {
  if (/^\/api\/(people|roles|invites|organization|admin|auth|me)(\/|$)/.test(pattern)) return;
  if (pattern === '/api/rooms' && ctx.method === 'POST') return;
  if (pattern === '/api/tokens' || pattern.startsWith('/api/tokens/')) return;
  const actor = ctx.body.as || ctx.query.get('as');
  let actorRoom = null;
  if (actor && ctx.principal.type === 'claude') {
    const [instance] = await q.query('select owner_id, room from claudes where id = $1', [actor]);
    if (instance && instance.owner_id !== ctx.principal.userId) fail(403, 'This instance belongs to another user');
    if (instance?.room) { await requireRoom(q, ctx, instance.room); actorRoom = instance.room; }
  }
  if (pattern.startsWith('/api/tasks/:id')) {
    const [t] = await q.query('select project from tasks where id = $1', [ctx.params.id]);
    if (t) await scopeProject(q, ctx, t.project);
  } else if (pattern.startsWith('/api/polls/:id')) {
    const [p] = await q.query('select room from polls where id = $1', [ctx.params.id]);
    if (p?.room) await requireRoom(q, ctx, p.room); else await scopeRoom(q, ctx, null);
  } else if (pattern.startsWith('/api/rooms/:id')) await requireRoom(q, ctx, ctx.params.id);
  else if (/^\/api\/(secure|approvals)\/:id/.test(pattern)) {
    const [item] = await q.query('select m.room, s.project from secure_items s left join messages m on m.id = s.message_id where s.id = $1', [ctx.params.id]);
    if (item?.room) await requireRoom(q, ctx, item.room); else if (item) await scopeProject(q, ctx, item.project);
  } else if (pattern.startsWith('/api/asks/:id')) {
    const [item] = await q.query('select project from asks where id = $1', [ctx.params.id]);
    if (item) await scopeProject(q, ctx, item.project);
  }
  else if (pattern.startsWith('/api/notes/:id')) {
    if (/^\d{1,18}$/.test(ctx.params.id)) {
      const [note] = await q.query('select room_id from notes where id = $1', [ctx.params.id]);
      if (note?.room_id) await requireRoom(q, ctx, note.room_id);
    }
  }
  else if (pattern.startsWith('/api/context/:project')) await scopeProject(q, ctx, ctx.params.project);
  else if (ctx.body.project && pattern !== '/api/claudes/heartbeat' && (!actorRoom || ['/api/tasks', '/api/locks', '/api/decisions'].includes(pattern))) await scopeProject(q, ctx, ctx.body.project);
  else if (ctx.query.get('room') || (ctx.body.room && ['/api/polls', '/api/notes', '/api/idea-categories'].includes(pattern))) await requireRoom(q, ctx, ctx.query.get('room') || ctx.body.room);
  else if (pattern === '/api/claudes/heartbeat' && ctx.body.join?.project) {
    const joining = await roomOfProject(q, ctx.body.join.project, ctx.now);
    if (joining) await scopeRoom(q, ctx, joining);
  }
  if (pattern === '/api/polls' && ctx.body.all === true) await scopeRoom(q, ctx, null);
  if (pattern === '/api/polls' && ctx.principal.type === 'human' && !ctx.body.room) await scopeRoom(q, ctx, null);
  if (ctx.principal.type === 'claude' && actorRoom && pattern.startsWith('/api/tasks/:id') && ctx.principal.roomId && ctx.principal.roomId !== actorRoom) fail(403, 'This mission concerns another room');
}
