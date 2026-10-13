// Telegram commands for a linked human: a short look at the station from the phone. Only what the panel already
// shows (board content passed the sensitive-data filter); never the ideas board, never protected data.
import { buildDigest, localDay } from './digest.js';
import { HttpError } from './http.js';
import { randomToken } from './crypto.js';
import { detectSensitive } from './sensitive.js';
import { openPoll, castVote, humanClose, pollsFor } from './routes/polls.js';
import { loadAccess } from './permissions.js';
import { sanitizeText } from './sanitize.js';
import { recordContent } from './content.js';
import { detectInjection } from './injection.js';
import { visibleRooms, projectVisible, requireRoom, filterRoomContent } from './room-access.js';
import { allRooms } from './routes/rooms.js';
import { reviewable } from './approval-rules.js';

const AWAY_MS = 10 * 60e3;
const RANK = { high: 0, normal: 1, low: 2 };
const MAX = 3900; // Telegram allows 4096 characters per message

const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
function ago(now, ts) {
  const d = Math.max(0, now - ts);
  if (d < 3600e3) return `${Math.max(1, Math.floor(d / 60e3))} min ago`;
  if (d < 86400e3) return `${Math.floor(d / 3600e3)} h ago`;
  return `${Math.floor(d / 86400e3)} d ago`;
}

export const HELP = 'Commands:\n/status — who is working, room by room\n/missions — the open missions, most urgent first\n/recaps — the latest recaps from the agents\n/today — the digest of the day so far\n/digest on|off — get it every evening after 20:00, or not\n/mission [Room:] text — launch a mission\n/polls — the open polls\n/vote V-ID N — vote (or choose, if it is a tie)\n/poll question | A | B — open a poll for the whole station';

/** The reply to a command from user `userId`, or null if the text is not a command we know. */
export async function commandReply(q, userId, text, now, ctx = { now, after: [] }) {
  try { return await reply(q, userId, sanitizeText(text), now, ctx); } catch (err) {
    if (err instanceof HttpError) return `⚠️ ${err.message}`; // a refused command is an answer, not a failed webhook
    throw err;
  }
}

async function reply(q, userId, text, now, ctx) {
  const cmd = text.trim().split(/[\s@]/)[0].toLowerCase();
  const rest = text.trim().replace(/^\S+\s*/, '');
  // The same permissions as on the panel: the role of this human decides what the bot may do for them.
  const access = await loadAccess(q, userId);
  ctx.principal = { type: 'human', userId, ...access };
  ctx.body ??= {}; ctx.query ??= new URLSearchParams();
  const permissions = access.permissions;
  const denied = (p) => (permissions.has(p) ? null : `⛔ Your role does not allow this (${p}).`);
  if (cmd !== '/help' && cmd !== '/start' && denied('station.view')) return denied('station.view');
  const all = await allRooms(q, now), rooms = await visibleRooms(q, ctx);
  const sees = (r) => (!r.room || rooms.some((room) => room.id === r.room)) && projectVisible(r.project, rooms, all);
  const roomName = (p) => rooms.find((r) => r.project === p)?.name || p || 'no room';

  if (cmd === '/status') {
    const claudes = await q.query("select room, status, last_seen from claudes where last_seen > $1 or task_id is not null", [now - 86400e3]);
    const tasks = (await q.query("select status, project from tasks where status <> 'done'")).filter(sees);
    const a = { n: (await reviewable(q, await filterRoomContent(q, ctx, await q.query("select id,owner_user,project,kind from asks where status = 'pending' and expires_at > $1", [now])), userId, 'ask')).length };
    const s = { n: (await reviewable(q, await filterRoomContent(q, ctx, await q.query("select s.id,s.owner_user,s.project,m.room from secure_items s left join messages m on m.id = s.message_id where s.status = 'pending' and s.approval_expires_at > $1", [now])), userId, 'secure')).length };
    const lines = ['🛰 Station status'];
    for (const r of rooms) {
      const live = claudes.filter((c) => c.room === r.id && now - c.last_seen < AWAY_MS && c.status !== 'offline');
      if (!live.length) continue;
      const working = live.filter((c) => c.status === 'working').length;
      lines.push(`• ${r.name}: ${live.length} on board, ${working} working`);
    }
    if (lines.length === 1) lines.push('No agent active right now.');
    lines.push(`Missions: ${tasks.filter((t) => t.status === 'open').length} to assign, ${tasks.filter((t) => t.status !== 'open').length} in progress`);
    if (a.n || s.n) lines.push(`⚠️ Waiting for you: ${a.n ? `${a.n} requests (permissions or opinions)` : ''}${a.n && s.n ? ', ' : ''}${s.n ? `${s.n} pieces of sensitive data` : ''} — answer from the panel.`);
    return lines.join('\n').slice(0, MAX);
  }

  if (cmd === '/missions') {
    const tasks = (await q.query("select t.*, c.name as owner_name from tasks t left join claudes c on c.id = t.owner_claude where t.status <> 'done'")).filter(sees);
    tasks.sort((x, y) => (RANK[x.priority] ?? 1) - (RANK[y.priority] ?? 1) || (x.due_date || '9').localeCompare(y.due_date || '9') || x.created_at - y.created_at);
    if (!tasks.length) return 'No open missions. 🎉';
    const lines = [`📋 Open missions (${tasks.length})`];
    for (const t of tasks.slice(0, 15)) {
      const who = t.status === 'open' ? 'to assign' : `${t.owner_name || t.owner_claude}${t.status === 'blocked' ? ', BLOCKED' : ''}`;
      const tags = [t.priority === 'high' && 'HIGH', t.due_date && `due ${t.due_date}`].filter(Boolean).join(' · ');
      lines.push(`• [${roomName(t.project)}] ${clip(t.title, 90)} — ${who}${tags ? ` · ${tags}` : ''}`);
    }
    if (tasks.length > 15) lines.push(`…and ${tasks.length - 15} more on the panel.`);
    return lines.join('\n').slice(0, MAX);
  }

  if (cmd === '/recaps') {
    const recaps = (await q.query('select r.*, c.name from recaps r left join claudes c on c.id = r.by_claude order by r.created_at desc')).filter(sees).slice(0, 5);
    if (!recaps.length) return 'No recaps yet.';
    const parts = recaps.map((r) => `📄 ${r.title}\n${roomName(r.project)} · ${r.name || r.by_claude} · ${ago(now, r.created_at)}\n${clip(r.body, 500)}`);
    return parts.join('\n\n').slice(0, MAX);
  }

  if (cmd === '/mission') {
    // "/mission Web Shop: redo the menu" goes to that room; without a room it belongs to the Bridge.
    const m = rest.match(/^([^:]{2,40}):\s*(.+)$/s);
    const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const room = m && rooms.find((r) => norm(r.name) === norm(m[1]) || norm(r.project) === norm(m[1]));
    if (m && !room) return 'Room not found.';
    if (room) await requireRoom(q, ctx, room.id);
    if (!ctx.principal.permissions.has('missions.create')) return '⛔ Your role does not allow this (missions.create).';
    const title = clip(room ? m[2] : rest, 140);
    if (!title) return `Write: /mission [Room:] what to do\nRooms: ${rooms.map((r) => r.name).join(', ')}`;
    if (detectSensitive(title).length) return '⚠️ The text seems to contain sensitive data: the mission was not created.';
    const [u] = await q.query('select username from users where id = $1', [userId]);
    const id = `T-${now.toString(36).toUpperCase()}-${randomToken('', 2).replace(/[^A-Za-z0-9]/g, 'X').toUpperCase()}`;
    const proj = room?.project ?? '';
    await q.query("insert into tasks (id, title, project, resources, status, created_by, created_at, updated_at) values ($1, $2, $3, '[]', 'open', $4, $5, $5)", [id, title, proj, `human:${u.username}`, now]);
    await recordContent(q, ctx, 'task', id, { title, project: proj }, { type: 'human', id: userId, owner: userId });
    await q.query('insert into messages (from_claude, to_target, text, project, room, created_at, quiet) values ($1, $2, $3, $4, $5, $6, $7)',
      [`human:${u.username}`, '*', `New mission ${id}: ${title}${proj ? ` [${proj}]` : ''}. Take it with: claim ${id}`, proj, room?.id ?? null, now, detectInjection(`${title}\n${proj}`).length > 0]);
    return `🚀 Mission ${id} launched ${room ? `in the ${room.name} room` : 'on the Bridge (no room given)'}: ${title}`;
  }

  if (cmd === '/polls') {
    const polls = (await pollsFor(q, ctx, null)).filter((p) => p.status !== 'closed');
    if (!polls.length) return 'No open polls.';
    return polls.map((p) => `🗳 ${p.id}${p.status === 'tie' ? ' — TIE, you choose' : ''}\n${p.question}\n${p.options.map((o, i) => `${i + 1}) ${o}: ${p.counts[i]}`).join('\n')}\n→ /vote ${p.id} N`).join('\n\n').slice(0, MAX);
  }

  if (cmd === '/vote') {
    const [id, n] = rest.split(/\s+/);
    if (!id || !n) return 'Write: /vote V-ID N (the option number). /polls lists the open ones.';
    const [u] = await q.query('select username from users where id = $1', [userId]);
    const [p] = await q.query('select status, room from polls where id = $1', [id.toUpperCase()]);
    if (p?.room) await requireRoom(q, ctx, p.room);
    const permission = p?.status === 'tie' ? 'polls.decide' : 'polls.vote';
    if (!ctx.principal.permissions.has(permission)) return `⛔ Your role does not allow this (${permission}).`;
    if (p?.status === 'tie') { const r = await humanClose(q, ctx, id.toUpperCase(), Number(n), u.username); return `⚖️ Decided: ${r.winner}. The agents have been told.`; }
    const r = await castVote(q, ctx, id.toUpperCase(), `human:${u.username}`, Number(n), '');
    return `🗳 Vote recorded: ${r.voted}. Poll ${r.statusLabel}.`;
  }

  if (cmd === '/poll') {
    if (denied('polls.open')) return denied('polls.open');
    const parts = rest.split('|').map((s) => s.trim()).filter(Boolean);
    if (parts.length < 3) return 'Write: /poll question | option A | option B (up to 5 options). It is for the whole station and closes in 30 minutes.';
    const [u] = await q.query('select username from users where id = $1', [userId]);
    const r = await openPoll(q, ctx, { by: `human:${u.username}`, room: null, project: '', text: parts[0], options: parts.slice(1) });
    return `🗳 Poll ${r.id} opened for the whole station. Vote too: /vote ${r.id} N`;
  }

  if (cmd === '/today') {
    const d = localDay(now);
    return (await buildDigest(q, userId, d.start, d.end, now, 'Today so far')) ?? 'Nothing to report today yet: no missions closed, nothing waiting for you.';
  }

  if (cmd === '/digest') {
    const arg = text.trim().split(/\s+/)[1]?.toLowerCase();
    if (arg !== 'on' && arg !== 'off') return 'Write /digest on to get the digest of the day every evening, /digest off to stop it.';
    await q.query('update users set digest_off = $2 where id = $1', [userId, arg === 'off']);
    return arg === 'off' ? 'All right: no more evening digest. /today shows it whenever you want, /digest on turns it back on.' : 'Done: every evening after 20:00 I will send you the digest of the day.';
  }

  if (cmd === '/help' || cmd === '/start') return HELP;
  return null;
}
