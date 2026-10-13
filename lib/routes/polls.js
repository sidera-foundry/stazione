// Polls: a choice that concerns everybody is put to a vote instead of being decided by one Claude alone.
// A Claude or a human opens it (question, 2-5 options, deadline) in a room or for the whole station; every session
// votes once, with one line of reasons; the humans can vote too, or close it choosing themselves. It closes when
// every active session has voted or at the deadline: the majority wins and is written in the decisions; a tie goes
// to the humans. A vote never authorises a drastic action: that still needs "ask".
import { fail, str, int, PROJECT_MAX } from '../http.js';
import { randomToken } from '../crypto.js';
import { sendText } from '../telegram.js';
import { guardText, ownInstance } from './board.js';
import { need } from '../permissions.js';
import { recordContent } from '../content.js';
import { detectInjection } from '../injection.js';
import { visibleRooms, requireRoom, roomAccess, scopeRoom } from '../room-access.js';

const AWAY_MS = 10 * 60e3;
const TIE_WINDOW_MS = 24 * 3600e3; // how long a tie waits for a human before it is dropped
const POLL_ID_RE = /^V-[A-Z0-9-]{3,40}$/;
const LABEL = { open: 'open', tie: 'tie: the humans decide', closed: 'closed' };

const ballotsOf = (q, id) => q.query('select * from poll_votes where poll_id = $1 order by at', [id]);

function camelPoll(p, ballots) {
  const counts = p.options.map((_, i) => ballots.filter((b) => b.choice === i).length);
  return {
    id: p.id, by: p.by_claude, project: p.project, room: p.room, question: p.question, options: p.options,
    status: p.status, statusLabel: LABEL[p.status], result: p.result, winner: p.result == null ? null : p.options[p.result],
    closedBy: p.closed_by, createdAt: p.created_at, expiresAt: p.expires_at, closedAt: p.closed_at, counts,
    ballots: ballots.map((b) => ({ voter: b.voter, choice: b.choice, reason: b.reason, at: b.at })),
  };
}

const tell = (q, p, text, now, from = 'stazione') => q.query(
  'insert into messages (from_claude, to_target, text, project, room, created_at, quiet) values ($1, $2, $3, $4, $5, $6, $7)',
  [from, p.room ? '*' : '**', text.slice(0, 4000), p.project, p.room, now, detectInjection(text).length > 0],
);

/** Ends a vote: the given option, or the majority; a tie (or nobody voted) is left to the humans. */
async function closePoll(q, ctx, p, { choice = null, by = 'stazione' } = {}) {
  const ballots = await ballotsOf(q, p.id);
  const counts = p.options.map((_, i) => ballots.filter((b) => b.choice === i).length);
  let result = choice;
  if (result == null) {
    const top = Math.max(...counts);
    const leaders = counts.flatMap((n, i) => (n === top && top > 0 ? [i] : []));
    if (leaders.length === 1) [result] = leaders;
  }
  const tally = p.options.map((o, i) => `${o}: ${counts[i]}`).join(', ');
  if (result == null) {
    if (p.status === 'tie') return p; // already waiting for a human
    await q.query("update polls set status = 'tie', closed_at = $2 where id = $1", [p.id, ctx.now]);
    await tell(q, p, `Poll ${p.id} is a TIE (${tally}): "${p.question}". The humans decide from the panel; meanwhile do not proceed on this point.`, ctx.now);
    const owners = [];
    const [room] = p.room ? await q.query('select * from rooms where id = $1', [p.room]) : [];
    for (const user of await q.query("select id, telegram_chat_id from users where status = 'active' and telegram_chat_id is not null")) {
      const access = await roomAccess(q, user.id, room);
      if (access.visible && access.permissions.has('polls.decide')) owners.push(user);
    }
    ctx.after.push(async () => {
      for (const o of owners) await sendText(o.telegram_chat_id, `⚖️ Tied poll${p.project ? ` [${p.project}]` : ''}:\n\n${p.question}\n${tally}\n\nChoose from the panel (Station → Polls) or here: /vote ${p.id} N`);
    });
    return { ...p, status: 'tie' };
  }
  await q.query("update polls set status = 'closed', result = $2, closed_by = $3, closed_at = $4 where id = $1", [p.id, result, by, ctx.now]);
  const how = choice == null ? `by majority (${tally})` : `decided by ${by.startsWith('human:') ? `${by.slice(6)} (human)` : by} (votes: ${tally})`;
  await q.query('insert into decisions (by_claude, project, text, created_at) values ($1, $2, $3, $4)',
    [p.by_claude, p.project, `Poll ${p.id}: "${p.question}" → ${p.options[result]}, ${how}.`.slice(0, 1000), ctx.now]);
  await tell(q, p, `Poll ${p.id} CLOSED: "${p.question}" → "${p.options[result]}" wins, ${how}. Decision recorded: follow it.`, ctx.now);
  return { ...p, status: 'closed', result };
}

/** Closes the votes past their deadline, and drops the ties no human answered. */
export async function sweepPolls(q, ctx) {
  for (const p of await q.query("select * from polls where status = 'open' and expires_at < $1 for update", [ctx.now])) await closePoll(q, ctx, p);
  const dropped = await q.query(
    "update polls set status = 'closed', closed_by = 'stazione' where status = 'tie' and closed_at < $1 returning *", [ctx.now - TIE_WINDOW_MS]);
  for (const p of dropped) await tell(q, p, `Poll ${p.id} without an outcome: a tie and no choice from the humans in 24 hours ("${p.question}"). Whoever opened it decides carefully or opens it again.`, ctx.now);
}

/** The votes of a room (and those of the whole station): the open ones and the recent ones, with their ballots. */
export async function pollsFor(q, ctx, roomId) {
  const rooms = await visibleRooms(q, ctx);
  if (roomId && !rooms.some((r) => r.id === roomId)) fail(404, 'Room not found');
  await sweepPolls(q, ctx);
  const rows = await q.query(
    `select * from polls where (status <> 'closed' or closed_at > $1) ${roomId ? 'and (room is null or room = $2)' : ''} order by created_at desc limit 30`,
    roomId ? [ctx.now - 7 * 86400e3, roomId] : [ctx.now - 7 * 86400e3],
  );
  const out = [];
  for (const p of rows) if ((!p.room && !rooms.restrictedToToken) || rooms.some((r) => r.id === p.room)) out.push(camelPoll(p, await ballotsOf(q, p.id)));
  return out;
}

const pollId = (v) => str(v, 'id', { min: 1, max: 50, pattern: POLL_ID_RE });
const choiceOf = (v, p) => int(v, 'choice', { min: 1, max: p.options.length }) - 1;

/** Opens a vote. by: a Claude id or "human:name"; room: a room id, or null for the whole station. */
export async function openPoll(q, ctx, { by, room, project, text, options, minutes }) {
  if (room) await requireRoom(q, ctx, room); else await scopeRoom(q, ctx, null);
  need(ctx, 'polls.open');
  const question = guardText(str(text, 'question', { min: 5, max: 500 }), 'question');
  if (!Array.isArray(options)) fail(400, 'Give the options: from 2 to 5');
  const opts = [...new Set(options.map((o) => guardText(str(o, 'option', { min: 1, max: 120 }), 'option')))];
  if (opts.length < 2 || opts.length > 5) fail(400, 'From 2 to 5 different options are needed');
  const mins = int(minutes, 'minutes', { min: 5, max: 1440, def: 30 });
  const id = `V-${ctx.now.toString(36).toUpperCase()}-${randomToken('', 2).replace(/[^A-Za-z0-9]/g, 'X').toUpperCase()}`;
  await q.query(
    'insert into polls (id, by_claude, project, room, question, options, created_at, expires_at) values ($1, $2, $3, $4, $5, $6, $7, $8)',
    [id, by, project || '', room, question, JSON.stringify(opts), ctx.now, ctx.now + mins * 60e3],
  );
  const [author] = by.startsWith('human:') ? await q.query('select id from users where username = $1', [by.slice(6)]) : [];
  if (author) await recordContent(q, ctx, 'poll', id, { question, options: opts }, { type: 'human', id: author.id, owner: author.id });
  await tell(q, { room, project: project || '' },
    `Poll ${id}: "${question}" — ${opts.map((o, i) => `${i + 1}) ${o}`).join('  ')}. Closes in ${mins} minutes. Vote with: vote ${id} --choice N --reason "why"`, ctx.now, by);
  return { id, expiresAt: ctx.now + mins * 60e3 };
}

/** One ballot (replacing the voter's previous one); closes the vote when everybody around has voted. */
export async function castVote(q, ctx, id, voter, choiceRaw, reasonRaw, { needReason = false, room = null } = {}) {
  await sweepPolls(q, ctx);
  const [p] = await q.query('select * from polls where id = $1 for update', [pollId(id)]);
  if (!p) fail(404, 'Poll not found');
  if (p.room) await requireRoom(q, ctx, p.room);
  need(ctx, 'polls.vote');
  if (p.status !== 'open') fail(409, `Poll ${LABEL[p.status]}`, { status: p.status });
  if (p.room && room && room !== p.room) fail(403, 'This poll concerns another room');
  const choice = choiceOf(choiceRaw, p);
  // A Claude must say why: the reasons are what the others (and the humans) read.
  const reason = guardText(str(reasonRaw, 'reason', { min: needReason ? 3 : 0, max: 300 }), 'reason');
  await q.query(
    `insert into poll_votes (poll_id, voter, choice, reason, at) values ($1, $2, $3, $4, $5)
     on conflict (poll_id, voter) do update set choice = excluded.choice, reason = excluded.reason, at = excluded.at`,
    [p.id, voter, choice, reason, ctx.now],
  );
  const [author] = voter.startsWith('human:') ? await q.query('select id from users where username = $1', [voter.slice(6)]) : [];
  if (author) await recordContent(q, ctx, 'vote', `${p.id}/${voter}`, { reason }, { type: 'human', id: author.id, owner: author.id });
  // Everybody who is around has voted (at least two sessions): no need to wait for the deadline.
  const ballots = await ballotsOf(q, p.id);
  const voted = new Set(ballots.map((x) => x.voter));
  const active = await q.query(
    `select id from claudes where last_seen > $1 and status <> 'offline' ${p.room ? 'and room = $2' : ''}`,
    p.room ? [ctx.now - AWAY_MS, p.room] : [ctx.now - AWAY_MS],
  );
  let status = 'open';
  if (ballots.filter((x) => !x.voter.startsWith('human:')).length >= 2 && active.every((c) => voted.has(c.id))) ({ status } = await closePoll(q, ctx, p));
  return { ok: true, voted: p.options[choice], status, statusLabel: LABEL[status] };
}

/** A human closes a vote: with a choice that settles it, or without (majority so far; not allowed on a tie). */
export async function humanClose(q, ctx, id, choiceRaw, username) {
  await sweepPolls(q, ctx);
  const [p] = await q.query('select * from polls where id = $1 for update', [pollId(id)]);
  if (!p) fail(404, 'Poll not found');
  if (p.room) await requireRoom(q, ctx, p.room);
  need(ctx, 'polls.decide');
  if (p.status === 'closed') fail(409, 'Poll already closed', { status: p.status });
  if (choiceRaw == null && p.status === 'tie') fail(400, 'Tie: choose an option yourself');
  const r = await closePoll(q, ctx, p, { choice: choiceRaw == null ? null : choiceOf(choiceRaw, p), by: `human:${username}` });
  return { ok: true, status: r.status, statusLabel: LABEL[r.status], winner: r.result == null ? undefined : p.options[r.result] };
}

export const pollRoutes = [
  ['POST', '/api/polls', { auth: 'any', perm: 'polls.open' }, async (q, ctx) => {
    const b = ctx.body;
    let by, room, project;
    if (ctx.principal.type === 'claude') {
      const me = await ownInstance(q, ctx, b.as);
      by = me.id;
      room = b.all === true ? null : me.room;
      project = room ? me.project : str(b.project, 'project', { max: PROJECT_MAX });
    } else { // a human: the room chosen on the panel, or the whole station
      by = `human:${ctx.principal.username}`;
      const [r] = b.room ? await q.query('select id, project from rooms where id = $1', [str(b.room, 'room', { max: 40 })]) : [];
      if (b.room && !r) fail(404, 'Unknown room');
      room = r?.id ?? null; project = r?.project ?? '';
    }
    const res = await openPoll(q, ctx, { by, room, project, text: b.text, options: b.options, minutes: b.minutes });
    return { ...res, next: `vote too: vote ${res.id} --choice N --reason "..."; the outcome arrives as a message` };
  }],

  ['GET', '/api/polls', { auth: 'any', perm: 'station.view' }, async (q, ctx) => ({ polls: await pollsFor(q, ctx, ctx.query.get('room') || null) })],

  ['GET', '/api/polls/:id', { auth: 'any', perm: 'station.view' }, async (q, ctx) => {
    await sweepPolls(q, ctx);
    const [p] = await q.query('select * from polls where id = $1', [pollId(ctx.params.id)]);
    if (!p) fail(404, 'Poll not found');
    return camelPoll(p, await ballotsOf(q, p.id));
  }],

  ['POST', '/api/polls/:id/vote', { auth: 'any', perm: 'polls.vote' }, async (q, ctx) => {
    const b = ctx.body;
    if (ctx.principal.type !== 'claude') return castVote(q, ctx, ctx.params.id, `human:${ctx.principal.username}`, b.choice, b.reason);
    const me = await ownInstance(q, ctx, b.as);
    return castVote(q, ctx, ctx.params.id, me.id, b.choice, b.reason, { needReason: true, room: me.room });
  }],

  /** Close now: who opened it (majority so far), or a human — who may also choose the option, and that settles it. */
  ['POST', '/api/polls/:id/close', { auth: 'any', perm: 'station.view' }, async (q, ctx) => {
    const b = ctx.body;
    if (ctx.principal.type !== 'claude') { need(ctx, 'polls.decide'); return humanClose(q, ctx, ctx.params.id, b.choice, ctx.principal.username); }
    need(ctx, 'polls.open'); // an opener whose role was revoked cannot keep changing its old polls
    await sweepPolls(q, ctx);
    const [p] = await q.query('select * from polls where id = $1 for update', [pollId(ctx.params.id)]);
    if (!p) fail(404, 'Poll not found');
    if (p.status === 'closed') fail(409, 'Poll already closed', { status: p.status });
    const me = await ownInstance(q, ctx, b.as);
    if (me.id !== p.by_claude) fail(403, `The poll belongs to ${p.by_claude}: it can be closed by them or by a human`);
    if (p.status === 'tie') fail(409, 'Tie: a human decides from the panel', { status: p.status });
    const r = await closePoll(q, ctx, p, { by: me.id });
    return { ok: true, status: r.status, statusLabel: LABEL[r.status], winner: r.result == null ? undefined : p.options[r.result] };
  }],
];
