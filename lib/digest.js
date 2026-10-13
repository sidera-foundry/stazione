// Daily digest: once a day, in the evening, every human with Telegram linked gets what the station did that
// day — missions closed, recaps, decisions and votes room by room, what is still open, what waits for them.
// Vercel crons run once a day at a fixed hour, so (like silent.js) this rides on the station's own traffic: the first
// request after 20:00 local time (TIMEZONE, default UTC) sends it; if nobody was around in the evening, the day is sent the morning after.
// Only what the panel already shows: never the ideas board, never protected data.
import { sendText } from './telegram.js';
import { visibleRooms, projectVisible, filterRoomContent } from './room-access.js';
import { allRooms } from './routes/rooms.js';

const SEND_HOUR = 20;
const MAX = 3900; // Telegram allows 4096 characters per message
let lastRun = 0;

const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export const TIMEZONE = () => process.env.TIMEZONE || 'UTC';

/** The local calendar day a moment falls in: { day: 'YYYY-MM-DD', hour, start, end } (start/end in ms). */
export function localDay(ts) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE(), hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ts)).map((x) => [x.type, Number(x.value)]));
  const offset = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ts / 1000) * 1000;
  const start = Date.UTC(p.year, p.month - 1, p.day) - offset;
  return { day: new Date(Date.UTC(p.year, p.month - 1, p.day)).toISOString().slice(0, 10), hour: p.hour, start, end: start + 86400e3 };
}

/** The text for one human and one window of time, or null when nothing happened and nothing waits for them. */
export async function buildDigest(q, userId, from, to, now, title) {
  const ctx = { principal: { userId }, now };
  const all = await allRooms(q, now), rooms = await visibleRooms(q, ctx);
  let [done, recaps, decisions, open] = [
    await q.query("select title, project from tasks where status = 'done' and updated_at >= $1 and updated_at < $2 order by updated_at", [from, to]),
    await q.query('select title, project from recaps where created_at >= $1 and created_at < $2 order by created_at', [from, to]),
    await q.query('select text, project from decisions where created_at >= $1 and created_at < $2 order by created_at', [from, to]),
    await q.query("select status, title, project from tasks where status <> 'done'"),
  ];
  [done, recaps, decisions, open] = [done, recaps, decisions, open].map((rows) => rows.filter((r) => projectVisible(r.project, rooms, all)));
  const a = { n: (await filterRoomContent(q, ctx, await q.query("select project from asks where owner_user = $1 and status = 'pending' and expires_at > $2", [userId, now]))).length };
  const s = { n: (await filterRoomContent(q, ctx, await q.query("select s.project, m.room from secure_items s left join messages m on m.id = s.message_id where s.owner_user = $1 and s.status = 'pending'", [userId]))).length };
  const ties = await q.query("select room from polls where status = 'tie'");
  const t = { n: ties.filter((p) => !p.room || rooms.some((r) => r.id === p.room)).length };
  const blocked = open.filter((x) => x.status === 'blocked');
  if (!done.length && !recaps.length && !decisions.length && !blocked.length && !a.n && !s.n && !t.n) return null;

  const lines = [`🌙 ${title}`];
  const projects = [...new Set([...done, ...recaps, ...decisions].map((x) => x.project || ''))];
  const nameOf = (p) => rooms.find((r) => r.project === p)?.name || p || 'No room';
  for (const p of projects) {
    const d = done.filter((x) => (x.project || '') === p), r = recaps.filter((x) => (x.project || '') === p), c = decisions.filter((x) => (x.project || '') === p);
    const head = [d.length && plural(d.length, 'mission closed', 'missions closed'), c.length && plural(c.length, 'decision', 'decisions')].filter(Boolean).join(', ');
    lines.push('', `▪️ ${nameOf(p)}: ${head || plural(r.length, 'recap', 'recaps')}`);
    for (const x of d.slice(0, 6)) lines.push(`  ✅ ${clip(x.title, 90)}`);
    if (d.length > 6) lines.push(`  …and ${d.length - 6} more`);
    for (const x of c.slice(0, 3)) lines.push(`  ⚖️ ${clip(x.text, 140)}`);
    for (const x of r.slice(0, 3)) lines.push(`  📄 ${clip(x.title, 90)}`);
  }
  if (!projects.length) lines.push('', 'No missions closed.');
  lines.push('', `Still open: ${open.filter((x) => x.status === 'open').length} to assign, ${open.filter((x) => x.status === 'claimed').length} in progress${blocked.length ? `, ${blocked.length} blocked` : ''}.`);
  for (const x of blocked.slice(0, 3)) lines.push(`  ⛔ ${clip(x.title, 90)}`);
  const waiting = [
    a.n && plural(a.n, 'request (permission or opinion)', 'requests (permissions or opinions)'),
    s.n && plural(s.n, 'piece of sensitive data', 'pieces of sensitive data'),
    t.n && plural(t.n, 'tied poll', 'tied polls'),
  ].filter(Boolean);
  if (waiting.length) lines.push('', `⚠️ Waiting for you: ${waiting.join(', ')} — answer from the panel.`);
  return lines.join('\n').slice(0, MAX);
}

/**
 * Sends the day's summary to whoever has not had it yet. Returns the users served (for tests); `force` skips the
 * once-a-minute throttle. Each user is marked first, in one statement, so two instances cannot send it twice.
 */
export async function sweepDigest(database, now, force = false) {
  if (!force && now - lastRun < 60e3) return [];
  lastRun = now;
  let d = localDay(now);
  if (d.hour < SEND_HOUR) d = localDay(d.start - 3600e3); // not evening yet: the day to close is yesterday, if still unsent
  const users = await database.query(
    `update users set digest_day = $1 where status = 'active' and telegram_chat_id is not null and not digest_off
        and (digest_day is null or digest_day < $1) returning id, telegram_chat_id`,
    [d.day],
  );
  const label = d.day;
  for (const u of users) {
    const text = await buildDigest(database, u.id, d.start, d.end, now, `Digest for ${label}`);
    if (text) await sendText(u.telegram_chat_id, `${text}\n\n/digest off to stop receiving it.`);
  }
  return users.map((u) => u.id);
}
