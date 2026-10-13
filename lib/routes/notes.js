// Human-only ideas, scoped to a room (null = the organization's board).
import { fail, str } from '../http.js';
import { randomId } from '../crypto.js';
import { ORG_ID, need } from '../permissions.js';
import { requireRoom, scopeRoom } from '../room-access.js';
import { audit } from '../auth.js';

const noteId = (v) => (/^\d{1,18}$/.test(String(v)) ? v : fail(404, 'Idea not found'));
export async function ensureGeneral(q, roomId = null) {
  const id = roomId ? `general-room-${roomId}` : 'general-org';
  const roles = (await q.query("select id from roles where org_id = $1 and id <> 'guest'", [ORG_ID])).map((r) => r.id);
  await q.query('insert into idea_categories (id, org_id, room_id, name, view_roles, write_roles) values ($1, $2, $3, $4, $5, $5) on conflict (id) do nothing', [id, ORG_ID, roomId, 'General', JSON.stringify(roles)]);
  return id;
}

async function board(q, ctx) {
  const roomId = ctx.body.room || ctx.query.get('room') || null;
  if (roomId) await requireRoom(q, ctx, roomId); else await scopeRoom(q, ctx, null);
  need(ctx, 'ideas.use');
  await ensureGeneral(q, roomId);
  return roomId;
}
const allowed = (c, ctx, write = false) => c[write ? 'write_roles' : 'view_roles'].includes(ctx.principal.role);
const camel = (c, ctx) => ({ id: c.id, name: c.name, room: c.room_id, viewRoles: c.view_roles, writeRoles: c.write_roles, canWrite: allowed(c, ctx, true) });

async function category(q, ctx, id, write = false) {
  const [c] = await q.query('select * from idea_categories where id = $1 and org_id = $2', [id, ORG_ID]);
  if (!c) fail(404, 'Category not found');
  if (c.room_id) await requireRoom(q, ctx, c.room_id); else await scopeRoom(q, ctx, null);
  need(ctx, 'ideas.use');
  if (!allowed(c, ctx) || (write && !allowed(c, ctx, true))) fail(404, 'Category not found');
  return c;
}

async function roles(q, raw, field) {
  if (!Array.isArray(raw) || raw.length > 100 || raw.some((r) => typeof r !== 'string')) fail(400, `Invalid ${field}`);
  const ids = (await q.query('select id from roles where org_id = $1', [ORG_ID])).map((r) => r.id);
  if (raw.some((r) => !ids.includes(r))) fail(400, `Unknown role in ${field}`);
  return [...new Set(raw)];
}

export const noteRoutes = [
  ['GET', '/api/idea-categories', { auth: 'human', perm: 'station.view' }, async (q, ctx) => {
    const room = await board(q, ctx);
    const categories = await q.query('select * from idea_categories where org_id = $1 and room_id is not distinct from $2 order by name', [ORG_ID, room]);
    return { categories: categories.filter((c) => allowed(c, ctx)).map((c) => camel(c, ctx)), canManage: ctx.principal.permissions.has('ideas.manage') };
  }],
  ['POST', '/api/idea-categories', { auth: 'human', perm: 'station.view' }, async (q, ctx) => {
    const room = await board(q, ctx); need(ctx, 'ideas.manage');
    const view = await roles(q, ctx.body.viewRoles, 'viewRoles'), write = await roles(q, ctx.body.writeRoles, 'writeRoles');
    if (write.some((r) => !view.includes(r))) fail(400, 'Writers must also be viewers');
    const id = randomId(), name = str(ctx.body.name, 'name', { min: 1, max: 60 });
    await q.query('insert into idea_categories (id, org_id, room_id, name, view_roles, write_roles) values ($1, $2, $3, $4, $5, $6)', [id, ORG_ID, room, name, JSON.stringify(view), JSON.stringify(write)]);
    audit(q, ctx, 'idea_category_created', ctx.principal.userId, { id, room, view, write });
    return { id };
  }],
  ['PUT', '/api/idea-categories/:id', { auth: 'human', perm: 'station.view' }, async (q, ctx) => {
    const [c] = await q.query('select * from idea_categories where id = $1 and org_id = $2 for update', [ctx.params.id, ORG_ID]);
    if (!c) fail(404, 'Category not found');
    if (c.room_id) await requireRoom(q, ctx, c.room_id); else await scopeRoom(q, ctx, null);
    need(ctx, 'ideas.manage');
    const view = await roles(q, ctx.body.viewRoles ?? c.view_roles, 'viewRoles'), write = await roles(q, ctx.body.writeRoles ?? c.write_roles, 'writeRoles');
    if (write.some((r) => !view.includes(r))) fail(400, 'Writers must also be viewers');
    const name = str(ctx.body.name ?? c.name, 'name', { min: 1, max: 60 });
    await q.query('update idea_categories set name = $2, view_roles = $3, write_roles = $4 where id = $1', [c.id, name, JSON.stringify(view), JSON.stringify(write)]);
    audit(q, ctx, 'idea_category_changed', ctx.principal.userId, { id: c.id, view, write });
    return { ok: true };
  }],
  ['GET', '/api/notes', { auth: 'human', perm: 'station.view' }, async (q, ctx) => {
    const room = await board(q, ctx);
    const categories = (await q.query('select * from idea_categories where org_id = $1 and room_id is not distinct from $2', [ORG_ID, room])).filter((c) => allowed(c, ctx));
    const selected = ctx.query.get('category');
    if (selected && !categories.some((c) => c.id === selected)) fail(404, 'Category not found');
    const ids = categories.filter((c) => !selected || c.id === selected).map((c) => c.id);
    const rows = await q.query(`select n.*, u.username, u.avatar from notes n join users u on u.id = n.user_id where n.category_id = any($1::text[]) order by n.pinned desc, coalesce(n.pinned_at, n.created_at) desc, n.created_at desc ${ctx.query.get('all') === '1' ? '' : 'limit 300'}`, [ids]);
    const [count] = await q.query('select count(*)::int as n from notes where category_id = any($1::text[])', [ids]);
    return { total: count.n, categories: categories.map((c) => camel(c, ctx)), canManage: ctx.principal.permissions.has('ideas.manage'), notes: rows.map((n) => ({ id: n.id, text: n.text, category: n.category_id, room: n.room_id, pinned: n.pinned, createdAt: n.created_at, author: n.username, avatar: n.avatar, mine: n.user_id === ctx.principal.userId, canWrite: allowed(categories.find((c) => c.id === n.category_id), ctx, true) })) };
  }],
  ['POST', '/api/notes', { auth: 'human', perm: 'station.view' }, async (q, ctx) => {
    const room = await board(q, ctx), id = ctx.body.category || await ensureGeneral(q, room);
    const c = await category(q, ctx, id, true);
    if (c.room_id !== room) fail(400, 'Category belongs to another board');
    const text = str(ctx.body.text, 'text', { min: 1, max: 2000, trim: true });
    const [n] = await q.query('insert into notes (user_id, text, created_at, room_id, category_id) values ($1, $2, $3, $4, $5) returning id', [ctx.principal.userId, text, ctx.now, room, id]);
    return { id: n.id };
  }],
  ['POST', '/api/notes/:id/pin', { auth: 'human', perm: 'station.view' }, async (q, ctx) => {
    const [n] = await q.query('select * from notes where id = $1', [noteId(ctx.params.id)]);
    if (!n) fail(404, 'Idea not found');
    await category(q, ctx, n.category_id, true);
    const pinned = ctx.body.pinned === true;
    await q.query('update notes set pinned = $2, pinned_at = $3 where id = $1', [n.id, pinned, pinned ? ctx.now : null]);
    return { ok: true, pinned };
  }],
  ['POST', '/api/notes/:id/delete', { auth: 'human', perm: 'station.view' }, async (q, ctx) => {
    const [n] = await q.query('select * from notes where id = $1 and user_id = $2', [noteId(ctx.params.id), ctx.principal.userId]);
    if (!n) fail(404, 'You can delete only your own ideas');
    await category(q, ctx, n.category_id, true);
    await q.query('delete from notes where id = $1', [n.id]);
    return { ok: true };
  }],
];
