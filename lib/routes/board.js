import { fail, str, int, strList, oneOf, INSTANCE_RE, TASK_ID_RE, PROJECT_MAX } from '../http.js';
import { encrypt, randomId, randomToken } from '../crypto.js';
import { detectSensitive, maskedPreview, findingTypes } from '../sensitive.js';
import {
  APPROVAL_WINDOW_MS, STATUS_LABEL, sweepSecure, humanCanReveal, claudeCanRead, readAndMaybeConsume, notifyOwner,
} from '../secure.js';
import { resolveRoom, roomOfProject, checkRoom, allRooms, camelRoom, normName } from './rooms.js';
import { need } from '../permissions.js';
import { sanitizeText, textLimit } from '../sanitize.js';
import { detectInjection } from '../injection.js';
import { visibleRooms, requireRoom, projectVisible, roomAccess, filterRoomContent } from '../room-access.js';
import { reviewable, notifyApprovers } from '../approval-rules.js';
import { capTokenPermissions, tokenRoomAllowed } from '../token-restrictions.js';

const STATUSES = ['idle', 'working', 'comms', 'offline'];
const ROLES = ['server', 'design', 'bridge', 'test', 'research', 'general'];
const ARCHIVE_MS = 30 * 86400e3; // read messages older than this leave /api/state: one summary line instead
const AWAY_MS = 10 * 60e3; // F3: silent for 10 min = shown offline (the row is not changed)
const TASK_STATUSES = ['open', 'claimed', 'blocked', 'done'];
const PRIORITIES = ['high', 'normal', 'low'];
/** Deadline: a real calendar day "YYYY-MM-DD", or ""/null to clear it. */
function dueDate(v) {
  if (v == null || v === '') return null;
  const s = str(v, 'due', { max: 10 });
  const d = new Date(`${s}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) fail(400, 'Invalid due date: use YYYY-MM-DD (e.g. 2026-10-05)');
  return s;
}
const MAX_INSTANCES_PER_USER = 60; // ids are never reused, so there is room for many; old ones go with forget
// A session that stops answering (e.g. its tokens ran out) must not block the others: its locks stop counting after
// LOCK_IDLE_MS of silence and are released, its missions can be taken over after TASK_IDLE_MS.
const LOCK_IDLE_MS = 15 * 60e3;
const TASK_IDLE_MS = 30 * 60e3;
const MODEL_IDLE_MS = 60 * 60e3; // the agent itself did nothing for an hour: its wait may still poll, but it is stuck
const SILENT = (p) => `(last_seen < ${p} or (last_active > 0 and last_active < ${p} - ${MODEL_IDLE_MS - LOCK_IDLE_MS}))`;
async function sweepIdle(q, now) {
  await q.query(`delete from locks where owner_claude in (select id from claudes where ${SILENT('$1')})`, [now - LOCK_IDLE_MS]);
}

/** Messages an instance sees: addressed to it, to the whole station ("**"), or to everyone ("*") in its own room. */
const VISIBLE = `(m.to_target = $1 or m.to_target = '**' or (m.to_target = '*' and (m.room is null or c.room is null or m.room = c.room)))`;

/**
 * "hello --new": the first instance id nobody has, starting from the base one (base, base-2, base-3...). An id is
 * never handed to another session, however long it has been silent: a session may be quiet for days and come back.
 * The only way to free an id is to remove that astronaut with forget (from an agent, or from the panel).
 */
async function freeInstance(q, ctx, base) {
  for (let i = 1; i <= MAX_INSTANCES_PER_USER + 40; i++) {
    const id = i === 1 ? base : `${base.slice(0, 36)}-${i}`;
    const [c] = await q.query('select 1 from claudes where id = $1', [id]);
    if (!c) return id;
  }
  fail(400, `No free id starting from ${base}: remove the astronauts you no longer need from the panel, or use another base name`);
}

/** Removes a silent astronaut of its own user: its locks go, its missions go back to the room. */
async function forgetInstance(q, ctx, c) {
  if (ctx.now - c.last_seen < AWAY_MS) fail(409, 'Instance still active: it can be removed only after 10 minutes of silence');
  const locks = await q.query('delete from locks where owner_claude = $1 returning resource', [c.id]);
  const reopened = await q.query(
    "update tasks set status = 'open', owner_claude = null, updated_at = $2 where owner_claude = $1 and status in ('claimed', 'blocked') returning id",
    [c.id, ctx.now],
  );
  await q.query('delete from claudes where id = $1', [c.id]);
  return { forgotten: c.id, reopened: reopened.map((t) => t.id), released: locks.map((l) => l.resource) };
}

/** Free text on the board must not carry sensitive data: that goes only through an approved secure message. */
export function guardText(value, field) {
  value = sanitizeText(value);
  const found = detectSensitive(value);
  if (found.length) {
    fail(422, `Possible sensitive data (${findingTypes(found).join(', ')}) in the field "${field}". ` +
      'Sensitive data can only be sent with a sensitive message, which needs the owner\'s approval.');
  }
  return value;
}

const project = (v, required = false) => str(v, 'project', { min: required ? 1 : 0, max: PROJECT_MAX });

function normResource(r) {
  const s = r.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (!s || s === '.' || s.includes('..')) fail(400, `Invalid resource: "${r}"`);
  return s;
}

/** Two resources overlap when equal or one contains the other (path "/" or instance "." hierarchy). */
export const overlaps = (a, b) => a === b || b.startsWith(`${a}/`) || a.startsWith(`${b}/`) || b.startsWith(`${a}.`) || a.startsWith(`${b}.`);

/** A agent may only act as an instance registered under its own user. */
export async function ownInstance(q, ctx, as) {
  if (ctx.principal.type !== 'claude') fail(403, 'Only agent instances can do this');
  const id = str(as, 'as', { min: 2, max: 40 });
  if (!INSTANCE_RE.test(id)) fail(400, 'Invalid instance id');
  const [c] = await q.query('select * from claudes where id = $1', [id]);
  if (!c) fail(404, 'Instance not registered: run "hello" first');
  if (c.owner_id !== ctx.principal.userId) fail(403, 'This instance belongs to another user');
  if (c.room) {
    const [room] = await q.query('select * from rooms where id = $1', [c.room]);
    if (!room || !tokenRoomAllowed(ctx.principal, room) || !(await roomAccess(q, ctx.principal.userId, room)).visible) fail(404, 'Room not found');
  }
  // Every call made by the agent itself proves the model is alive; the wait loop's polls do not (they say ?wait=1).
  if (ctx.query.get('wait') !== '1' && ctx.body?.auto !== true) await q.query('update claudes set last_active = $2 where id = $1', [c.id, ctx.now]);
  return c;
}

const camelTask = (t) => ({
  id: t.id, title: t.title, detail: t.detail, project: t.project, resources: t.resources, status: t.status,
  owner: t.owner_claude, assignee: t.assignee, priority: t.priority, due: t.due_date, checkpoint: t.checkpoint, checkpointAt: t.checkpoint_at, createdBy: t.created_by, note: t.note, createdAt: t.created_at, updatedAt: t.updated_at,
});

export const boardRoutes = [
  ['GET', '/api/state', { auth: 'any', perm: 'station.view' }, async (q, ctx) => {
    await sweepSecure(q, ctx.now);
    await sweepIdle(q, ctx.now);
    const all = await allRooms(q, ctx.now), rooms = await visibleRooms(q, ctx);
    // ?room=<id> or ?as=<instance>: only that room (fewer bytes and tokens); other rooms become a crew count.
    let roomId = ctx.query.get('room');
    if (!roomId && ctx.query.get('as')) roomId = (await q.query('select room from claudes where id = $1', [ctx.query.get('as')]))[0]?.room;
    const room = roomId ? rooms.find((r) => r.id === roomId) ?? fail(404, 'Unknown room') : null;
    const archiveBefore = ctx.now - ARCHIVE_MS;
    // Read = addressed to one instance that has read its inbox past it; old broadcasts count as read.
    const READ = `(m.to_target in ('*', '**') or exists (select 1 from claudes r where r.id = m.to_target and r.inbox_read_at >= m.created_at))`;
    const OLD = `(m.created_at < $1 and m.secure_id is null and ${READ})`;
    let [users, claudes, tasks, locks, messages, decisions, contexts, recaps, [archived]] = [
      await q.query("select id, username, avatar from users where status = 'active' order by created_at"),
      await q.query('select * from claudes order by joined_at'), // silent ones stay (shown offline) until someone uses forget
      await q.query("select * from tasks where status <> 'done' or updated_at > $1 order by created_at limit 300", [ctx.now - 14 * 86400e3]),
      await q.query('select * from locks where expires_at > $1 order by expires_at', [ctx.now - 3600e3]),
      await q.query(
        `select m.*, s.status as s_status, s.policy as s_policy, s.reason as s_reason, s.detected as s_detected,
                s.owner_user as s_owner, s.ciphertext is not null as s_has_data
           from messages m left join secure_items s on s.id = m.secure_id
          where not ${OLD} ${room ? `and (m.room = $2 or m.to_target = '**' or m.to_target in (select id from claudes where room = $2))` : ''}
          order by m.created_at desc limit 100`,
        room ? [archiveBefore, room.id] : [archiveBefore],
      ),
      await q.query('select * from decisions order by created_at desc limit 60'),
      await q.query('select * from contexts order by project'),
      await q.query(`select * from recaps ${room ? 'where room = $1 or project = $2' : ''} order by created_at desc limit 40`, room ? [room.id, room.project] : []),
      await q.query(`select count(*)::int as count, min(created_at) as first, max(created_at) as last from messages m where ${OLD}`, [archiveBefore]),
    ];
    const seesProject = (x) => projectVisible(x.project, rooms, all, x.room);
    const seesRoom = (x) => (!x.room || rooms.some((r) => r.id === x.room)) && seesProject(x);
    claudes = claudes.filter(seesRoom);
    [tasks, locks, decisions, contexts] = [tasks, locks, decisions, contexts].map((rows) => rows.filter(seesProject));
    messages = messages.filter(seesRoom); recaps = recaps.filter(seesRoom);
    // Archive totals also respect visibility; hidden messages do not enter counts or date ranges.
    const oldMessages = (await q.query(`select m.project, m.room, m.created_at from messages m where ${OLD}`, [archiveBefore])).filter(seesRoom);
    archived.count = oldMessages.length;
    archived.first = oldMessages.length ? Math.min(...oldMessages.map((m) => m.created_at)) : null;
    archived.last = oldMessages.length ? Math.max(...oldMessages.map((m) => m.created_at)) : null;
    const day = (t) => new Date(Number(t)).toISOString().slice(0, 10);
    archived.summary = archived.count
      ? `${archived.count} read message${archived.count === 1 ? '' : 's'} archived (from ${day(archived.first)} to ${day(archived.last)})` : '';
    let otherRooms;
    if (room) {
      const inRoom = (x) => normName(x.project) === normName(room.project);
      otherRooms = {};
      for (const c of claudes) if (c.room !== room.id) otherRooms[c.room ?? ''] = (otherRooms[c.room ?? ''] || 0) + 1;
      claudes = claudes.filter((c) => c.room === room.id);
      [tasks, locks, decisions, contexts] = [tasks, locks, decisions, contexts].map((l) => l.filter(inRoom));
    }
    const ownerOf = Object.fromEntries(claudes.map((c) => [c.id, c.owner_id]));
    const me = ctx.principal;
    const roomViews = [];
    for (const r of rooms) {
      const access = { ...me, ...await roomAccess(q, me.userId, r) };
      capTokenPermissions(access);
      roomViews.push({ ...camelRoom(r), role: access.role, roleName: access.roleName, permissions: [...access.permissions] });
    }
    const { pollsFor } = await import('./polls.js'); // polls.js imports this module: loaded here to avoid the cycle at start
    const polls = await pollsFor(q, ctx, room?.id ?? null);
    let pendingApprovals = 0, pendingAsks = 0;
    if (me.type === 'human') {
      const rows = await q.query("select s.id,s.owner_user,s.project,m.room from secure_items s left join messages m on m.id = s.message_id where s.status = 'pending'");
      pendingApprovals = (await reviewable(q, await filterRoomContent(q, ctx, rows), me.userId, 'secure')).length;
      const asks = await q.query("select id,owner_user,project,kind from asks where status = 'pending' and expires_at > $1", [ctx.now]);
      pendingAsks = (await reviewable(q, await filterRoomContent(q, ctx, asks), me.userId, 'ask')).length;
    }
    return {
      me: { type: me.type, username: me.username, userId: me.userId, avatar: users.find((u) => u.id === me.userId)?.avatar, role: me.role, roleName: me.roleName, permissions: [...me.permissions] },
      pendingApprovals,
      pendingAsks,
      users,
      rooms: roomViews,
      polls,
      archived,
      ...(room && { room: room.id, otherRooms }),
      claudes: claudes.map((c) => ({
        id: c.id, name: c.name, owner: c.owner_id, status: ctx.now - c.last_seen > AWAY_MS ? 'offline' : c.status, activity: c.activity, taskId: c.task_id,
        project: c.project, room: c.room, host: c.host, lastActive: c.last_active, role: c.role, color: c.color, joinedAt: c.joined_at, lastSeen: c.last_seen, inboxReadAt: c.inbox_read_at,
      })),
      tasks: tasks.map(camelTask),
      locks: locks.map((l) => ({
        project: l.project, resource: l.resource, owner: l.owner_claude, reason: l.reason, taskId: l.task_id,
        createdAt: l.created_at, expiresAt: l.expires_at,
      })),
      messages: messages.map((m) => {
        const out = { id: m.id, from: m.from_claude, to: m.to_target, text: m.text, project: m.project, room: m.room, createdAt: m.created_at };
        if (m.secure_id) {
          const item = { id: m.secure_id, status: m.s_status, policy: m.s_policy, owner_user: m.s_owner, to_target: m.to_target, from_claude: m.from_claude, ciphertext: m.s_has_data };
          out.secure = {
            id: m.secure_id, status: m.s_status, statusLabel: STATUS_LABEL[m.s_status], policy: m.s_policy,
            reason: m.s_reason, detected: m.s_detected, mine: me.userId === m.s_owner,
            canReveal: me.type === 'human' && humanCanReveal(item, me.userId, ownerOf[m.to_target]),
          };
        }
        return out;
      }),
      decisions: decisions.map((d) => ({ id: d.id, by: d.by_claude, project: d.project, text: d.text, createdAt: d.created_at })),
      contexts: contexts.map((c) => ({ project: c.project, summary: c.summary, updatedBy: c.updated_by, updatedAt: c.updated_at, version: c.version })),
      recaps: recaps.map((r) => ({ id: r.id, by: r.by_claude, project: r.project, room: r.room, title: r.title, body: r.body, createdAt: r.created_at })),
    };
  }],

  // ---------- agent instances ----------
  ['POST', '/api/claudes/heartbeat', { auth: 'claude', perm: 'station.view' }, async (q, ctx) => {
    const b = ctx.body;
    let id = str(b.as, 'as', { min: 2, max: 40 });
    if (!INSTANCE_RE.test(id)) fail(400, 'Invalid instance id: 2-40 characters among lowercase letters, digits and hyphens');
    if (b.new === true) id = await freeInstance(q, ctx, id);
    const [existing] = await q.query('select * from claudes where id = $1 for update', [id]);
    if (existing && existing.owner_id !== ctx.principal.userId) fail(403, 'This instance belongs to another user: choose another name');
    const status = b.status == null ? existing?.status ?? 'idle' : oneOf(b.status, 'status', STATUSES);
    const activity = b.activity == null ? existing?.activity ?? '' : guardText(str(b.activity, 'activity', { max: 200 }), 'activity');
    const taskId = b.taskId === undefined ? existing?.task_id ?? null : b.taskId ? str(b.taskId, 'taskId', { max: 50, pattern: TASK_ID_RE }) : null;
    const host = b.host == null ? existing?.host ?? '' : str(b.host, 'host', { max: 60 });
    const role = b.role == null ? existing?.role ?? 'general' : oneOf(b.role, 'role', ROLES);
    let roomId = existing?.room ?? null;
    let room = null;
    if (b.join && typeof b.join === 'object') {
      // The Bridge manages the station: only the agents of people who may open and merge rooms enter it.
      room = await resolveRoom(q, b.join, id, ctx.now, { readOnly: ctx.principal.restrictions?.readOnly });
      await requireRoom(q, ctx, room.id); need(ctx, 'station.view');
      if (b.join.bridge) {
        const { loadAccess } = await import('../permissions.js');
        const base = await loadAccess(q, ctx.principal.userId);
        if (!base.permissions.has('rooms.create') || !base.permissions.has('rooms.merge')) fail(403, 'Only management agents enter the Bridge');
      }
      if (roomId && roomId !== room.id) {
        fail(409, `This session is bound to the room "${roomId}" and cannot change project: for another project the user opens a new session (hello --new).`, { room: roomId });
      }
      roomId = room.id;
    } else if (roomId) {
      [room] = await q.query('select * from rooms where id = $1', [roomId]);
    }
    // A session bound to a room always reports that room's project; others keep the old free-form project.
    const proj = room ? room.project : (b.project == null ? existing?.project ?? '' : project(b.project));
    if (!tokenRoomAllowed(ctx.principal, room)) fail(404, 'Room not found');
    if (!existing) {
      const [n] = await q.query('select count(*)::int as n from claudes where owner_id = $1', [ctx.principal.userId]);
      if (n.n >= MAX_INSTANCES_PER_USER) fail(400, `At most ${MAX_INSTANCES_PER_USER} instances per user`);
      const name = guardText(str(b.name, 'name', { min: 1, max: 40 }), 'name');
      await q.query(
        `insert into claudes (id, owner_id, name, status, activity, task_id, project, room, host, role, joined_at, last_seen, inbox_read_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $11, $10, $10, $10)`,
        [id, ctx.principal.userId, name, status, activity, taskId, proj, roomId, host, ctx.now, role],
      );
    } else {
      const name = b.name == null ? existing.name : guardText(str(b.name, 'name', { min: 1, max: 40 }), 'name');
      await q.query(
        'update claudes set name = $2, status = $3, activity = $4, task_id = $5, project = $6, room = $7, host = $8, last_seen = $9, role = $10 where id = $1',
        [id, name, status, activity, taskId, proj, roomId, host, ctx.now, role],
      );
    }
    // The astronaut's colour: "#rrggbb" sets it, "" goes back to the one derived from the id.
    if (b.color != null) {
      const color = b.color ? str(b.color, 'color', { max: 7, pattern: /^#[0-9a-fA-F]{6}$/ }).toLowerCase() : null;
      await q.query('update claudes set color = $2 where id = $1', [id, color]);
    }
    await q.query('update claudes set last_active = $2, token_id = $3 where id = $1', [id, ctx.now, ctx.principal.tokenId]); // hello/beat: the agent itself
    const [unread] = await q.query(
      `select count(*)::int as n from messages m, claudes c
        where c.id = $1 and ${VISIBLE} and m.from_claude <> $1 and m.created_at > c.inbox_read_at`,
      [id],
    );
    return { id, registered: !existing, unread: unread.n, room: room && camelRoom(room) };
  }],

  /** Removes one of your own instances that has gone silent (e.g. an old session): its missions go back to the room. */
  ['POST', '/api/claudes/:id/forget', { auth: 'claude', perm: 'claudes.tokens' }, async (q, ctx) => {
    const me = await ownInstance(q, ctx, ctx.body.as);
    const [c] = await q.query('select * from claudes where id = $1 for update', [ctx.params.id]);
    if (!c || c.owner_id !== ctx.principal.userId) fail(404, 'No instance with this id among your user\'s');
    if (c.id === me.id) fail(400, 'You cannot remove yourself: at the end of the session use beat --status offline');
    const [l] = await q.query('select count(*)::int as n from locks where owner_claude = $1 and expires_at > $2', [c.id, ctx.now]);
    if (l.n) fail(409, `The instance still has ${l.n} active locks: wait for them to expire`);
    return forgetInstance(q, ctx, c);
  }],

  /** The same from the panel: a human removes one of their own astronauts that is no longer used (its id is freed). */
  ['POST', '/api/claudes/:id/forget-human', { auth: 'human', perm: 'claudes.tokens' }, async (q, ctx) => {
    const [c] = await q.query('select * from claudes where id = $1 for update', [ctx.params.id]);
    if (!c || c.owner_id !== ctx.principal.userId) fail(404, 'No astronaut with this id among yours');
    return forgetInstance(q, ctx, c);
  }],

  // ---------- missions ----------
  ['POST', '/api/tasks', { auth: 'any', perm: 'missions.create' }, async (q, ctx) => {
    const b = ctx.body;
    const me = ctx.principal.type === 'claude' ? await ownInstance(q, ctx, b.as) : null;
    const createdBy = me ? me.id : `human:${ctx.principal.username}`;
    const title = guardText(str(b.title, 'title', { min: 1, max: 140 }), 'title');
    const detail = guardText(str(b.detail, 'detail', { max: 2000 }), 'detail');
    const resources = strList(b.resources, 'resources').map(normResource);
    guardText(resources.join('\n'), 'resources');
    let proj = project(b.project);
    if (me?.room && !proj) proj = me.project;
    if (me?.room && me.room !== 'bridge') await checkRoom(q, me, proj, ctx.now, 'create missions');
    const room = await roomOfProject(q, proj, ctx.now);
    if (room) proj = room.project;
    let assignee = null;
    if (b.to != null && b.to !== '') {
      const [c] = await q.query('select id, room from claudes where id = $1', [String(b.to)]);
      if (!c) fail(404, `No agent with id ${b.to}`);
      if (c.room && room && c.room !== room.id) fail(409, `${c.id} works in another room: assign the mission to a session of "${room.name}"`, { room: c.room });
      assignee = c.id;
    }
    if ((b.to != null && b.to !== '') || (b.priority != null && b.priority !== '' && b.priority !== 'normal') || (b.due != null && b.due !== '')) need(ctx, 'missions.assign');
    const priority = b.priority == null || b.priority === '' ? 'normal' : oneOf(b.priority, 'priority', PRIORITIES);
    const deadline = dueDate(b.due);
    const id = `T-${ctx.now.toString(36).toUpperCase()}-${randomToken('', 2).replace(/[^A-Za-z0-9]/g, 'X').toUpperCase()}`;
    await q.query(
      `insert into tasks (id, title, detail, project, resources, status, created_by, assignee, created_at, updated_at, priority, due_date)
       values ($1, $2, $3, $4, $5, 'open', $6, $7, $8, $8, $9, $10)`,
      [id, title, detail, proj, JSON.stringify(resources), createdBy, assignee, ctx.now, priority, deadline],
    );
    // Tell only the room (or only the assignee), so the sessions of that project wake up and nobody else is disturbed.
    await q.query(
      'insert into messages (from_claude, to_target, text, project, room, created_at, quiet) values ($1, $2, $3, $4, $5, $6, $7)',
      [createdBy, assignee || '*', `${assignee ? 'Mission assigned to you' : 'New mission'} ${id}: ${title}${proj ? ` [${proj}]` : ''}${priority === 'high' ? ' — HIGH PRIORITY' : ''}${deadline ? ` — due ${deadline}` : ''}. Take it with: claim ${id}`, proj, room?.id ?? null, ctx.now, detectInjection(`${title}\n${proj}`).length > 0],
    );
    return { id };
  }],

  ['POST', '/api/tasks/:id/claim', { auth: 'claude', perm: 'missions.work' }, async (q, ctx) => {
    const me = await ownInstance(q, ctx, ctx.body.as);
    const [t0] = await q.query('select project, owner_claude from tasks where id = $1', [ctx.params.id]);
    if (t0) await checkRoom(q, me, t0.project, ctx.now, 'take missions');
    // Open missions, your own, or one whose owner has gone silent (e.g. out of tokens): it can be taken over.
    const [t] = await q.query(
      `update tasks set status = 'claimed', owner_claude = $2, updated_at = $3,
          claimed_at = case when owner_claude = $2 and claimed_at is not null then claimed_at else $3 end -- the owner's re-claim keeps its start
        where id = $1 and ((status = 'open' and (assignee is null or assignee = $2)) or owner_claude = $2
          or (status in ('claimed', 'blocked') and owner_claude in (select id from claudes where ${SILENT('$4')}))) returning *`,
      [ctx.params.id, me.id, ctx.now, ctx.now - TASK_IDLE_MS],
    );
    if (t && t0?.owner_claude && t0.owner_claude !== me.id) await q.query('update claudes set task_id = null where id = $1 and task_id = $2', [t0.owner_claude, t.id]);
    if (!t) {
      const [cur] = await q.query('select status, owner_claude, assignee from tasks where id = $1', [ctx.params.id]);
      if (!cur) fail(404, 'Mission not found');
      if (cur.status === 'open') fail(409, `Mission reserved for ${cur.assignee}`, { assignee: cur.assignee, status: cur.status });
      fail(409, `Mission already taken by ${cur.owner_claude || 'nobody'} (status: ${cur.status})`, { owner: cur.owner_claude, status: cur.status });
    }
    await q.query("update claudes set task_id = $2, project = $3, status = 'working', last_seen = $4 where id = $1", [me.id, t.id, t.project, ctx.now]);
    return { task: camelTask(t) };
  }],

  ['PATCH', '/api/tasks/:id', { auth: 'any', perm: 'station.view' }, async (q, ctx) => {
    const b = ctx.body;
    const [t] = await q.query('select * from tasks where id = $1 for update', [ctx.params.id]);
    if (!t) fail(404, 'Mission not found');
    let actor = null;
    if (ctx.principal.type === 'claude') {
      actor = (await ownInstance(q, ctx, b.as)).id;
      if (t.owner_claude && t.owner_claude !== actor) fail(403, `The mission belongs to ${t.owner_claude}`);
      need(ctx, 'missions.work');
    } else need(ctx, 'missions.manage'); // a human changes missions from the panel
    if ((b.priority != null && b.priority !== t.priority) || (b.due !== undefined && (b.due || null) !== t.due_date)) need(ctx, 'missions.assign');
    const status = b.status == null ? t.status : oneOf(b.status, 'status', TASK_STATUSES);
    const note = b.note == null ? t.note : guardText(str(b.note, 'note', { max: 1000 }), 'note');
    const checkpoint = b.checkpoint == null ? t.checkpoint : guardText(str(b.checkpoint, 'checkpoint', { max: 2000 }), 'checkpoint');
    const owner = status === 'open' ? null : t.owner_claude ?? actor;
    const priority = b.priority == null ? t.priority : oneOf(b.priority, 'priority', PRIORITIES);
    const deadline = b.due === undefined ? t.due_date : dueDate(b.due);
    await q.query(
      'update tasks set status = $2, note = $3, owner_claude = $4, updated_at = $5, checkpoint = $6, checkpoint_at = $7, priority = $8, due_date = $9 where id = $1',
      [t.id, status, note, owner, ctx.now, checkpoint, b.checkpoint == null ? t.checkpoint_at : ctx.now, priority, deadline],
    );
    if (status === 'done' || status === 'open') {
      // Whoever closed or reopened it (the agent itself or a human from the panel), no agent is working on it any more.
      await q.query('update claudes set task_id = null where task_id = $1', [t.id]);
    }
    return { ok: true, status };
  }],

  // ---------- locks ----------
  ['POST', '/api/locks', { auth: 'claude', perm: 'missions.work' }, async (q, ctx) => {
    const b = ctx.body;
    const me = await ownInstance(q, ctx, b.as);
    let proj = project(b.project, true);
    await checkRoom(q, me, proj, ctx.now, 'lock resources');
    const room = await roomOfProject(q, proj, ctx.now);
    if (room) proj = room.project;
    const resources = strList(b.resources, 'resources').map(normResource);
    if (!resources.length) fail(400, 'Give at least one resource');
    const reason = guardText(str(b.reason, 'reason', { max: 200 }), 'reason');
    const ttl = int(b.ttlMinutes, 'ttlMinutes', { min: 5, max: 240, def: 45 });
    const taskId = b.taskId ? str(b.taskId, 'taskId', { max: 50, pattern: TASK_ID_RE }) : null;
    await sweepIdle(q, ctx.now);

    await q.query('insert into lock_guards (project) values ($1) on conflict do nothing', [proj]);
    await q.query('select project from lock_guards where project = $1 for update', [proj]); // serializes lock changes per project
    const active = await q.query(
      `select l.*, c.name as owner_name from locks l left join claudes c on c.id = l.owner_claude
        where l.project = $1 and l.expires_at > $2 and l.owner_claude <> $3`,
      [proj, ctx.now, me.id],
    );
    const conflicts = [];
    for (const r of resources) {
      for (const l of active) {
        if (overlaps(r, l.resource)) conflicts.push({ requested: r, resource: l.resource, owner: l.owner_claude, ownerName: l.owner_name, reason: l.reason, expiresAt: l.expires_at });
      }
    }
    if (conflicts.length) fail(409, 'Some resources are locked by another agent: no lock was taken', { conflicts });
    for (const r of resources) {
      await q.query(
        `insert into locks (project, resource, owner_claude, reason, task_id, created_at, expires_at)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (project, resource) do update set
           created_at = case when locks.owner_claude = excluded.owner_claude and locks.expires_at > $6 then locks.created_at else excluded.created_at end,
           owner_claude = excluded.owner_claude, reason = excluded.reason, task_id = excluded.task_id, expires_at = excluded.expires_at`,
        [proj, r, me.id, reason, taskId, ctx.now, ctx.now + ttl * 60e3],
      );
    }
    return { project: proj, resources, expiresAt: ctx.now + ttl * 60e3 };
  }],

  ['POST', '/api/locks/release', { auth: 'claude', perm: 'missions.work' }, async (q, ctx) => {
    const b = ctx.body;
    const me = await ownInstance(q, ctx, b.as);
    const params = [me.id];
    let sql = 'delete from locks where owner_claude = $1';
    if (b.project != null) { params.push(project(b.project)); sql += ` and project = $${params.length}`; }
    const resources = strList(b.resources, 'resources').map(normResource);
    if (resources.length) { params.push(resources); sql += ` and resource = any($${params.length})`; }
    const rows = await q.query(`${sql} returning project, resource`, params);
    return { released: rows };
  }],

  /**
   * A human releases locks held by their own agents (e.g. a session that ran out of tokens and cannot unlock).
   * Only their own: another user's agents are never touched. The agent is told, so it does not trust a lock it lost.
   */
  ['POST', '/api/locks/release-human', { auth: 'human', perm: 'claudes.tokens' }, async (q, ctx) => {
    const b = ctx.body;
    const params = [ctx.principal.userId];
    let sql = 'delete from locks where owner_claude in (select id from claudes where owner_id = $1)';
    if (b.owner != null) { params.push(str(b.owner, 'owner', { max: 40 })); sql += ` and owner_claude = $${params.length}`; }
    if (b.project != null) { params.push(project(b.project)); sql += ` and project = $${params.length}`; }
    if (b.resource != null) { params.push(normResource(str(b.resource, 'resource', { min: 1, max: 300 }))); sql += ` and resource = $${params.length}`; }
    const rows = await q.query(`${sql} returning owner_claude, project, resource`, params);
    for (const l of rows) {
      await q.query('insert into messages (from_claude, to_target, text, project, created_at) values ($1, $2, $3, $4, $5)',
        [`human:${ctx.principal.username}`, l.owner_claude, `Your human released your lock on ${l.resource} from the panel: do not touch that resource again without taking it back.`, l.project, ctx.now]);
    }
    return { released: rows.map((l) => ({ owner: l.owner_claude, project: l.project, resource: l.resource })) };
  }],

  ['POST', '/api/locks/renew', { auth: 'claude', perm: 'missions.work' }, async (q, ctx) => {
    const me = await ownInstance(q, ctx, ctx.body.as);
    const ttl = int(ctx.body.ttlMinutes, 'ttlMinutes', { min: 5, max: 240, def: 45 });
    // auto = sent by the wait loop: it keeps the locks only while the agent itself has been active within the hour.
    if (ctx.body.auto === true && ctx.now - me.last_active > MODEL_IDLE_MS) return { renewed: [], skipped: 'agent inactive for more than an hour' };
    const rows = await q.query(
      'update locks set expires_at = $2 where owner_claude = $1 and expires_at > $3 returning project, resource',
      [me.id, ctx.now + ttl * 60e3, ctx.now],
    );
    await q.query('update claudes set last_seen = $2 where id = $1', [me.id, ctx.now]);
    return { renewed: rows, expiresAt: ctx.now + ttl * 60e3 };
  }],

  // ---------- messages ----------
  ['POST', '/api/messages', { auth: 'claude', perm: 'messages.send' }, async (q, ctx) => {
    const b = ctx.body;
    const me = await ownInstance(q, ctx, b.as);
    const to = str(b.to, 'to', { min: 1, max: 40 });
    let toName = to === '**' ? 'the whole station' : 'everyone in the room';
    if (to !== '*' && to !== '**') {
      if (!INSTANCE_RE.test(to)) fail(400, 'Invalid recipient');
      const [c] = await q.query('select name, room from claudes where id = $1', [to]);
      if (!c) fail(404, 'Recipient not registered');
      if (c.room) {
        const visible = await visibleRooms(q, ctx);
        if (!visible.some((r) => r.id === c.room)) fail(404, 'Recipient not registered');
      }
      toName = c.name;
    }
    const text = str(b.text, 'text', { min: 1, max: textLimit('MESSAGE_MAX_CHARS', 2000), trim: false });
    const proj = project(b.project);
    // A row lock serializes simultaneous sends from this instance, including broadcasts and secure messages.
    await q.query('insert into message_rate_guards (claude_id) values ($1) on conflict do nothing', [me.id]);
    await q.query('select claude_id from message_rate_guards where claude_id = $1 for update', [me.id]);
    const [rate] = await q.query('select count(*)::int as n from messages where from_claude = $1 and created_at > $2', [me.id, ctx.now - 10 * 60e3]);
    if (rate.n >= textLimit('MESSAGE_RATE_LIMIT', 20)) fail(429, 'Too many messages: try again after the 10-minute window');
    const findings = detectSensitive(text);
    const injection = detectInjection(text);
    await q.query("update claudes set last_seen = $2, status = case when status = 'offline' then 'idle' else status end where id = $1", [me.id, ctx.now]);

    if (!findings.length && b.sensitive !== true) {
      // Every wake-up makes the receiving agent re-read its whole context: news for the whole station ("**") and
      // anything sent with quiet do not wake anybody, they ride along with the next command. urgent overrides.
      const quiet = injection.length > 0 || (b.urgent === true ? false : b.quiet === true || to === '**');
      const [m] = await q.query(
        'insert into messages (from_claude, to_target, text, project, room, created_at, quiet) values ($1, $2, $3, $4, $5, $6, $7) returning id',
        [me.id, to, text, proj, me.room, ctx.now, quiet],
      );
      return { status: 'delivered', id: m.id, ...(injection.length && { injectionFindings: injection }), ...(quiet && { quiet: true, note: 'wakes nobody: it arrives with the recipient\'s next command' }) };
    }

    const reason = guardText(str(b.reason, 'reason', { max: 200 }), 'reason');
    const id = randomId();
    const detected = findings.length ? findingTypes(findings) : ['flagged by the agent'];
    const item = {
      id, from_claude: me.id, owner_user: ctx.principal.userId, to_target: to, project: proj, reason, detected,
      preview: findings.length ? maskedPreview(text, findings) : `[${text.length} characters hidden]`,
      approval_expires_at: ctx.now + APPROVAL_WINDOW_MS,
    };
    const [m] = await q.query(
      'insert into messages (from_claude, to_target, text, project, secure_id, room, created_at, quiet) values ($1, $2, $3, $4, $5, $6, $7, $8) returning id',
      [me.id, to, '[Protected data: waiting for approval]', proj, id, me.room, ctx.now, injection.length > 0],
    );
    await q.query(
      `insert into secure_items (id, message_id, from_claude, owner_user, to_target, project, reason, detected, preview,
                                 ciphertext, status, created_at, approval_expires_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', $11, $12)`,
      [id, m.id, me.id, ctx.principal.userId, to, proj, reason, JSON.stringify(detected), item.preview,
        encrypt(text, `secure:${id}`), ctx.now, item.approval_expires_at],
    );
    ctx.persist('insert into audit_log (user_id, event, detail, ip_hash, at) values ($1, $2, $3, $4, $5)', [
      ctx.principal.userId, 'secure_created', JSON.stringify({ id, from: me.id, to, detected }), ctx.ipHash, ctx.now,
    ]);
    const [owner] = await q.query('select telegram_chat_id from users where id = $1', [ctx.principal.userId]);
    // Notify only after commit, so a tap on Telegram always finds the request.
    ctx.after.push(async (database) => {
      await notifyApprovers(database, { ...item, room: me.room }, 'secure', chatId => notifyOwner(chatId, item, me.name, toName));
    });
    ctx.status = 202;
    return {
      status: 'pending_approval', secureId: id, detected, expiresAt: item.approval_expires_at,
      approvalVia: owner?.telegram_chat_id ? 'telegram and panel' : 'panel (Telegram not linked)',
    };
  }],

  ['GET', '/api/inbox', { auth: 'claude', perm: 'station.view' }, async (q, ctx) => {
    const me = await ownInstance(q, ctx, ctx.query.get('as'));
    await sweepSecure(q, ctx.now);
    await (await import('./polls.js')).sweepPolls(q, ctx); // a vote past its deadline closes here: the result wakes the waiters
    const recent = ctx.query.get('recent') != null ? int(ctx.query.get('recent'), 'recent', { min: 1, max: 50 }) : null;
    const since = recent ? 0 : ctx.query.get('since') != null ? int(ctx.query.get('since'), 'since', { min: 0, max: 1e15 }) : me.inbox_read_at;
    let rows = await q.query(
      `select m.*, s.status as s_status, s.policy as s_policy, s.ciphertext is not null as s_has_data, s.available_until
         from messages m left join secure_items s on s.id = m.secure_id join claudes c on c.id = $1
        where ${VISIBLE} and m.from_claude <> $1 and m.created_at > $2
        order by m.created_at ${recent ? 'desc' : ''} limit ${recent || 100}`,
      [me.id, since],
    );
    const all = await allRooms(q, ctx.now), rooms = await visibleRooms(q, ctx);
    rows = rows.filter((m) => (!m.room || rooms.some((r) => r.id === m.room)) && projectVisible(m.project, rooms, all, m.room));
    if (recent) rows.reverse(); // the last N, oldest first like the normal inbox
    await q.query('update claudes set last_seen = $2 where id = $1', [me.id, ctx.now]);
    return {
      messages: rows.map((m) => ({
        id: m.id, from: m.from_claude, to: m.to_target, text: m.text, project: m.project, createdAt: m.created_at, ...(m.quiet && { quiet: true }),
        ...(m.secure_id && {
          secure: {
            id: m.secure_id, status: m.s_status, statusLabel: STATUS_LABEL[m.s_status], policy: m.s_policy,
            readable: claudeCanRead({ ...m, status: m.s_status, policy: m.s_policy, ciphertext: m.s_has_data }, me.id),
          },
        }),
      })),
    };
  }],

  ['POST', '/api/inbox/read', { auth: 'claude', perm: 'station.view' }, async (q, ctx) => {
    const me = await ownInstance(q, ctx, ctx.body.as);
    const upTo = int(ctx.body.upTo, 'upTo', { min: 0, max: ctx.now });
    await q.query('update claudes set inbox_read_at = greatest(inbox_read_at, $2), last_seen = $3 where id = $1', [me.id, upTo, ctx.now]);
    return { ok: true };
  }],

  ['GET', '/api/secure/:id', { auth: 'claude', perm: 'station.view' }, async (q, ctx) => {
    const me = await ownInstance(q, ctx, ctx.query.get('as'));
    await sweepSecure(q, ctx.now);
    const [item] = await q.query('select * from secure_items where id = $1 for update', [ctx.params.id]);
    if (!item) fail(404, 'Data not found');
    if (!claudeCanRead(item, me.id)) {
      const visible = item.from_claude === me.id || item.to_target === me.id || item.to_target === '*';
      fail(403, visible ? `Data not readable: ${STATUS_LABEL[item.status]}${item.policy ? ` (${item.policy})` : ''}` : 'Data not found', visible ? { status: item.status, policy: item.policy } : undefined);
    }
    const consumed = item.policy === 'once_claude';
    return { text: await readAndMaybeConsume(q, ctx, item, `claude:${me.id}`), consumed, policy: item.policy };
  }],

  ['GET', '/api/secure/:id/status', { auth: 'claude', perm: 'station.view' }, async (q, ctx) => {
    const me = await ownInstance(q, ctx, ctx.query.get('as'));
    await sweepSecure(q, ctx.now);
    const [item] = await q.query('select id, from_claude, to_target, status, policy, approval_expires_at, available_until from secure_items where id = $1', [ctx.params.id]);
    if (!item || !(item.from_claude === me.id || item.to_target === me.id || item.to_target === '*')) fail(404, 'Data not found');
    return { id: item.id, status: item.status, statusLabel: STATUS_LABEL[item.status], policy: item.policy, approvalExpiresAt: item.approval_expires_at, availableUntil: item.available_until };
  }],

  // ---------- decisions + project context ----------
  /** A recap for the humans of the room: what was done, what is open, what they should know. */
  ['POST', '/api/recaps', { auth: 'claude', perm: 'messages.send' }, async (q, ctx) => {
    const me = await ownInstance(q, ctx, ctx.body.as);
    const title = guardText(str(ctx.body.title, 'title', { min: 1, max: 140 }), 'title');
    const body = guardText(str(ctx.body.text, 'text', { min: 1, max: 6000 }), 'text');
    const proj = me.room ? me.project : project(ctx.body.project);
    const [r] = await q.query(
      'insert into recaps (project, room, by_claude, title, body, created_at) values ($1, $2, $3, $4, $5, $6) returning id',
      [proj, me.room, me.id, title, body, ctx.now],
    );
    return { ok: true, id: r.id };
  }],

  ['POST', '/api/decisions', { auth: 'claude', perm: 'messages.send' }, async (q, ctx) => {
    const me = await ownInstance(q, ctx, ctx.body.as);
    const proj = project(ctx.body.project) || me.project;
    await checkRoom(q, me, proj, ctx.now, 'write decisions');
    const text = guardText(str(ctx.body.text, 'text', { min: 1, max: 1000 }), 'text');
    const [d] = await q.query('insert into decisions (by_claude, project, text, created_at) values ($1, $2, $3, $4) returning id', [me.id, proj, text, ctx.now]);
    return { id: d.id };
  }],

  ['GET', '/api/context/:project', { auth: 'any', perm: 'station.view' }, async (q, ctx) => {
    const [c] = await q.query('select * from contexts where project = $1', [ctx.params.project]);
    if (!c) fail(404, 'No context for this project');
    return { project: c.project, summary: c.summary, version: c.version, updatedBy: c.updated_by, updatedAt: c.updated_at };
  }],

  ['PUT', '/api/context/:project', { auth: 'claude', perm: 'rooms.context' }, async (q, ctx) => {
    const me = await ownInstance(q, ctx, ctx.body.as);
    const proj = project(ctx.params.project, true);
    await checkRoom(q, me, proj, ctx.now, 'write context');
    const summary = guardText(str(ctx.body.summary, 'context', { min: 1, max: textLimit('CONTEXT_MAX_CHARS', 8000), trim: false }), 'context');
    const [cur] = await q.query('select version from contexts where project = $1 for update', [proj]);
    if (cur) {
      if (Number(ctx.body.version) !== cur.version) fail(409, 'The context was changed by another agent: read it again and reapply your changes', { version: cur.version });
      await q.query('update contexts set summary = $2, updated_by = $3, updated_at = $4, version = version + 1 where project = $1', [proj, summary, me.id, ctx.now]);
      return { project: proj, version: cur.version + 1 };
    }
    await q.query('insert into contexts (project, summary, updated_by, updated_at, version) values ($1, $2, $3, $4, 1)', [proj, summary, me.id, ctx.now]);
    return { project: proj, version: 1 };
  }],
];
