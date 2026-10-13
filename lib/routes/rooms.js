// Rooms: every Claude session is bound to one room (one project) for its whole life; the Bridge is the management
// room, which also develops the station. A room is recognised on several PCs by its keys: normalised name, git
// remote of the project folder, or an explicit key (e.g. an ID from an external tool), so two sessions of the same project
// meet in the same room even when their folders have different names.
import { fail, str, PROJECT_MAX } from '../http.js';
import { detectInjection } from '../injection.js';
import { visibleRooms, requireRoom, roomAccess } from '../room-access.js';
import { loadAccess, need } from '../permissions.js';
import { audit } from '../auth.js';
import { capTokenPermissions } from '../token-restrictions.js';

export const BRIDGE = { id: 'bridge', name: 'Bridge', project: 'stazione', keys: ['n:bridge', 'n:stazione'] };

/** "Web Shop", "web-shop" and "WebShop" are the same room. */
export const normName = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** https://user@github.com/a/b.git, git@github.com:a/b and github.com/a/b all become "github.com/a/b". */
export function normGit(url) {
  let s = String(url || '').trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/^[a-z+]+:\/\//, '').replace(/^[^@/]+@/, '').replace(/^([^/:]+):(?!\d)/, '$1/');
  return s.replace(/\.git$/, '').replace(/\/+$/, '');
}

const slug = (s) => normName(s).slice(0, 30) || 'room';
/** What kind of project a room holds, for its furnishing: a git repository, or other. */
const typeOf = (r) => (r.kind === 'bridge' ? 'bridge' : r.keys.some((k) => k.startsWith('g:')) ? 'code' : 'general');
const camelRoom = (r) => ({ id: r.id, name: r.name, kind: r.kind, project: r.project, visibility: r.visibility, type: typeOf(r), goal: r.goal || '', milestones: r.milestones || [] });

async function ensureBridge(q, now) {
  await q.query(
    `insert into rooms (id, name, kind, project, keys, created_by, created_at) values ($1, $2, 'bridge', $3, $4, 'stazione', $5)
     on conflict (id) do nothing`,
    [BRIDGE.id, BRIDGE.name, BRIDGE.project, JSON.stringify(BRIDGE.keys), now],
  );
}

/** All rooms (few: one per project). The Bridge always exists. */
export async function allRooms(q, now) {
  await ensureBridge(q, now);
  return q.query('select * from rooms order by created_at');
}

/** The room a project string belongs to (by name/alias), or null for a project with no room yet. */
export async function roomOfProject(q, proj, now) {
  const k = `n:${normName(proj)}`;
  if (k === 'n:') return null;
  return (await allRooms(q, now)).find((r) => r.keys.includes(k) || normName(r.project) === normName(proj)) ?? null;
}

/**
 * Finds (or creates) the room for a session joining with { project, key, git, bridge }. Every key given is learnt,
 * so the next session of the same project is recognised by any of them.
 */
export async function resolveRoom(q, join, createdBy, now, { readOnly = false } = {}) {
  const rooms = await allRooms(q, now);
  if (join.bridge) return rooms.find((r) => r.kind === 'bridge'); // the Bridge never learns project keys
  const keys = [];
  if (join.key) keys.push(`k:${normName(join.key)}`);
  const name = join.project ? str(join.project, 'project', { max: PROJECT_MAX }) : '';
  if (name) keys.push(`n:${normName(name)}`);
  if (join.git) { const g = normGit(join.git); if (g) keys.push(`g:${g}`); }
  // What the user said wins: explicit key, then the project name; the folder's git remote only when neither is known.
  let room = null;
  for (const k of keys) { if (!room) room = rooms.find((r) => r.kind !== 'bridge' && r.keys.includes(k)); }
  if (!room) {
    if (readOnly) fail(403, 'A read-only token cannot create rooms');
    if (!name) fail(400, 'Give the session\'s project (--project "Name"), or --bridge for management');
    let id = slug(name);
    for (let i = 2; rooms.some((r) => r.id === id); i++) id = `${slug(name)}-${i}`;
    const [r] = await q.query(
      `insert into rooms (id, name, kind, project, keys, created_by, created_at) values ($1, $2, 'project', $2, $3, $4, $5) returning *`,
      [id, name, JSON.stringify(keys), createdBy, now],
    );
    return r;
  }
  const learnt = keys.filter((k) => !room.keys.includes(k) && !rooms.some((r) => r.id !== room.id && r.keys.includes(k)));
  if (learnt.length && !readOnly) {
    room.keys = [...room.keys, ...learnt];
    await q.query('update rooms set keys = $2 where id = $1', [room.id, JSON.stringify(room.keys)]);
  }
  return room;
}

/** A session bound to a room may only work on that room's project (the Bridge may also create missions anywhere). */
export async function checkRoom(q, me, proj, now, what) {
  if (!me.room) return; // instance from before rooms: no binding
  if (me.room === 'bridge' && !proj) return; // missions without a project are the Bridge's business
  const r = await roomOfProject(q, proj, now);
  if (r?.id === me.room) return;
  const [mine] = await q.query('select name from rooms where id = $1', [me.room]);
  fail(403, `This session works only in the room "${mine?.name ?? me.room}": it may not ${what} of another project. ` +
    'For another project the user opens a new session.', { room: me.room });
}

export const roomRoutes = [
  /**
   * Merges a room opened by mistake (e.g. "Shop Web" next to "Web Shop") into the right one: its astronauts, missions,
   * decisions, recaps, votes and messages move there, its names are learnt by the right room (so the next session
   * that says "Shop Web" lands in "Web Shop"), and the duplicate disappears. A human from the panel, or the Bridge.
   */
  ['POST', '/api/rooms/:id/merge', { auth: 'any', perm: 'rooms.merge' }, async (q, ctx) => {
    const b = ctx.body;
    if (ctx.principal.type === 'claude') {
      const { ownInstance } = await import('./board.js'); // board.js imports this module: loaded here to avoid the cycle
      const me = await ownInstance(q, ctx, b.as);
      if (me.room !== 'bridge') fail(403, 'Rooms are merged by the Bridge (or by a human from the panel)');
    }
    const [src] = await q.query('select * from rooms where id = $1 for update', [str(ctx.params.id, 'room', { max: 40 })]);
    const [dst] = await q.query('select * from rooms where id = $1 for update', [str(b.into, 'target room', { min: 1, max: 40 })]);
    if (!src || !dst) fail(404, 'Unknown room');
    const base = await loadAccess(q, ctx.principal.userId);
    if (!base.permissions.has('rooms.merge')) fail(403, 'Your organization role does not allow merging rooms');
    if (src.id === dst.id) fail(400, 'A room cannot be merged into itself');
    if (src.kind === 'bridge' || dst.kind === 'bridge') fail(400, 'The Bridge cannot be merged with other rooms');
    await requireRoom(q, ctx, dst.id); need(ctx, 'rooms.merge');
    // A merge must not broaden visibility or silently change any person's room powers.
    if (src.visibility !== dst.visibility) fail(409, 'Rooms with different visibility cannot be merged');
    const memberships = await q.query('select * from room_roles where room_id = $1 or room_id = $2', [src.id, dst.id]);
    const sourceRoles = memberships.filter((m) => m.room_id === src.id), targetRoles = memberships.filter((m) => m.room_id === dst.id);
    if (JSON.stringify(sourceRoles.map((m) => [m.user_id, m.role_id]).sort()) !== JSON.stringify(targetRoles.map((m) => [m.user_id, m.role_id]).sort())) fail(409, 'Align the room roles before merging');
    await q.query('update notes set room_id = $2 where room_id = $1', [src.id, dst.id]);
    await q.query('update idea_categories set room_id = $2 where room_id = $1', [src.id, dst.id]);
    const [from, to] = [src.project, dst.project];
    const moved = await q.query('update claudes set room = $2, project = $3 where room = $1 returning id', [src.id, dst.id, to]);
    await q.query('update claudes set project = $2 where room is null and project = $1', [from, to]);
    const tasks = await q.query('update tasks set project = $2 where project = $1 returning id', [from, to]);
    await q.query('delete from locks where project = $1', [from]); // a lock is re-taken in the right room
    for (const t of ['decisions', 'recaps', 'polls']) await q.query(`update ${t} set project = $2 where project = $1`, [from, to]);
    for (const t of ['recaps', 'polls', 'messages']) await q.query(`update ${t} set room = $2 where room = $1`, [src.id, dst.id]);
    await q.query('update messages set project = $2 where project = $1', [from, to]);
    const [ctxDst] = await q.query('select 1 from contexts where project = $1', [to]);
    if (!ctxDst) await q.query('update contexts set project = $2 where project = $1', [from, to]);
    const keys = [...new Set([...(dst.keys || []), ...(src.keys || []), `n:${normName(src.name)}`])];
    await q.query('update rooms set keys = $2 where id = $1', [dst.id, JSON.stringify(keys)]);
    await q.query('delete from rooms where id = $1', [src.id]);
    const by = ctx.principal.type === 'claude' ? b.as : `human:${ctx.principal.username}`;
    await q.query('insert into messages (from_claude, to_target, text, project, room, created_at, quiet) values ($1, $2, $3, $4, $5, $6, true)',
      [by, '*', `The room "${src.name}" was merged into "${dst.name}": whoever was there is now here, with their missions.`, to, dst.id, ctx.now]);
    return { merged: src.id, into: dst.id, astronauts: moved.map((c) => c.id), missions: tasks.map((t) => t.id) };
  }],
  /**
   * The project page of a room: its goal and milestones. The humans set them from the panel; the sessions of that
   * room (and the Bridge) may update them too, e.g. to tick a milestone. The room is told, so everybody follows.
   */
  ['PUT', '/api/rooms/:id/project', { auth: 'any', perm: 'rooms.project' }, async (q, ctx) => {
    const b = ctx.body;
    const { guardText, ownInstance } = await import('./board.js'); // board.js imports this module: loaded here to avoid the cycle
    const [room] = await q.query('select * from rooms where id = $1 for update', [str(ctx.params.id, 'room', { max: 40 })]);
    if (!room) fail(404, 'Unknown room');
    let actor = `human:${ctx.principal.username}`;
    if (ctx.principal.type === 'claude') {
      const me = await ownInstance(q, ctx, b.as);
      if (me.room !== room.id && me.room !== 'bridge') fail(403, `This session works in another room: the project of "${room.name}" is updated by its own sessions, the Bridge or the humans`);
      actor = me.id;
    }
    const goal = b.goal == null ? room.goal : guardText(str(b.goal, 'goal', { max: 300 }), 'goal');
    let milestones = room.milestones || [];
    if (b.milestones != null) {
      if (!Array.isArray(b.milestones) || b.milestones.length > 12) fail(400, 'Milestones are a list of at most 12 items');
      milestones = b.milestones.map((m) => ({ text: guardText(str(m?.text, 'milestone', { min: 1, max: 120 }), 'milestone'), done: m?.done === true }));
    }
    await q.query('update rooms set goal = $2, milestones = $3 where id = $1', [room.id, goal, JSON.stringify(milestones)]);
    const done = milestones.filter((m) => m.done).length;
    const changes = [goal !== room.goal && `goal: ${goal || '(removed)'}`, JSON.stringify(milestones) !== JSON.stringify(room.milestones || []) && `milestones ${done}/${milestones.length} done${milestones.find((m) => !m.done) ? `, next: ${milestones.find((m) => !m.done).text}` : ''}`].filter(Boolean);
    if (changes.length) {
      await q.query('insert into messages (from_claude, to_target, text, project, room, created_at, quiet) values ($1, $2, $3, $4, $5, $6, $7)',
        [actor, '*', `Project of the ${room.name} room updated — ${changes.join('; ')}.`.slice(0, 4000), room.project, room.id, ctx.now, detectInjection(`${room.name}\n${changes.join('; ')}`).length > 0]);
    }
    return { ok: true, goal, milestones };
  }],
  /**
   * Opens a room before any session enters it (the Bridge or a human): e.g. a new project to hand out missions for.
   * Same recognition as a session joining, so an existing room with that name (or git remote) is returned, not doubled.
   */
  ['POST', '/api/rooms', { auth: 'any', perm: 'rooms.create' }, async (q, ctx) => {
    const b = ctx.body;
    const { guardText, ownInstance } = await import('./board.js'); // board.js imports this module: loaded here to avoid the cycle
    let by = `human:${ctx.principal.username}`;
    if (ctx.principal.type === 'claude') {
      const me = await ownInstance(q, ctx, b.as);
      if (me.room !== 'bridge') fail(403, 'New rooms are opened by the Bridge (or by a human from the panel)');
      by = me.id;
    }
    const name = guardText(str(b.name, 'name', { min: 1, max: PROJECT_MAX }), 'name');
    if (normName(name) === 'bridge' || !normName(name)) fail(400, 'Invalid room name');
    const before = new Set((await allRooms(q, ctx.now)).map((r) => r.id));
    const room = await resolveRoom(q, { project: name, git: b.git, key: b.key }, by, ctx.now);
    await requireRoom(q, ctx, room.id);
    if (b.goal != null) {
      need(ctx, 'rooms.project');
      room.goal = guardText(str(b.goal, 'goal', { max: 300 }), 'goal');
      await q.query('update rooms set goal = $2 where id = $1', [room.id, room.goal]);
    }
    const created = !before.has(room.id);
    if (created) {
      await q.query('insert into messages (from_claude, to_target, text, project, room, created_at, quiet) values ($1, $2, $3, $4, $5, $6, true)',
        [by, '**', `Opened the room "${room.name}"${room.goal ? `: ${room.goal}` : ''}. Sessions of this project enter it with hello --project "${room.name}".`, room.project, room.id, ctx.now]);
    }
    ctx.status = created ? 201 : 200;
    return { created, room: camelRoom(room) };
  }],
  ['PUT', '/api/rooms/:id/visibility', { auth: 'human', perm: 'station.view' }, async (q, ctx) => {
    const base = await loadAccess(q, ctx.principal.userId);
    if (!base.permissions.has('admin.security')) fail(403, 'Your role does not allow this (admin.security)');
    if (!['open', 'restricted'].includes(ctx.body.visibility)) fail(400, 'Invalid visibility');
    if (ctx.params.id === 'bridge' && ctx.body.visibility !== 'open') fail(400, 'The Bridge remains open');
    const [room] = await q.query('update rooms set visibility = $2 where id = $1 returning *', [ctx.params.id, ctx.body.visibility]);
    if (!room) fail(404, 'Room not found');
    audit(q, ctx, 'room_visibility_changed', ctx.principal.userId, { room: room.id, visibility: room.visibility });
    return { room: camelRoom(room) };
  }],
  ['GET', '/api/rooms', { auth: 'any', perm: 'station.view' }, async (q, ctx) => {
    const rooms = await visibleRooms(q, ctx), out = [];
    for (const r of rooms) {
      const access = { ...ctx.principal, ...await roomAccess(q, ctx.principal.userId, r) };
      capTokenPermissions(access);
      out.push({ ...camelRoom(r), role: access.role, roleName: access.roleName, permissions: [...access.permissions] });
    }
    return { rooms: out };
  }],
];

export { camelRoom };
