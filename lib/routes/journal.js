// Logbook: what happened in a room, day by day — recaps, missions closed, decisions and, for the Bridge,
// the station's own commits. Read-only, built from what the panel already shows (no messages, no ideas board).
// Also the statistics (GET /api/stats): who closed what, how long missions take, what is stuck, who votes.
import { fail, int } from '../http.js';
import { allRooms } from './rooms.js';
import { visibleRooms, projectVisible } from '../room-access.js';
import info from '../build-info.json' with { type: 'json' };

const MAX_ITEMS = 600;

export const journalRoutes = [
  ['GET', '/api/journal', { auth: 'any', perm: 'station.view' }, async (q, ctx) => {
    const rooms = await visibleRooms(q, ctx);
    const key = ctx.query.get('room') || 'bridge';
    const room = rooms.find((r) => r.id === key || r.project === key) ?? fail(404, 'Unknown room');
    const days = int(ctx.query.get('days'), 'days', { min: 1, max: 365, def: 30 });
    const since = ctx.now - days * 86400e3;
    const [recaps, done, decisions] = [
      await q.query('select id, title, body, by_claude, created_at from recaps where (room = $1 or project = $2) and created_at > $3', [room.id, room.project, since]),
      await q.query("select id, title, note, owner_claude, updated_at from tasks where status = 'done' and project = $1 and updated_at > $2", [room.project, since]),
      await q.query('select id, text, by_claude, created_at from decisions where project = $1 and created_at > $2', [room.project, since]),
    ];
    const items = [
      ...recaps.map((r) => ({ type: 'recap', id: r.id, at: r.created_at, title: r.title, text: r.body, by: r.by_claude })),
      ...done.map((t) => ({ type: 'mission', at: t.updated_at, title: t.title, text: t.note, by: t.owner_claude, id: t.id })),
      ...decisions.map((d) => ({ type: 'decision', id: d.id, at: d.created_at, title: d.text, by: d.by_claude })),
      ...(room.kind === 'bridge' ? (info.commits || []).filter((c) => c.at > since).map((c) => ({ type: 'release', at: c.at, title: c.subject, by: c.author, id: c.sha })) : []),
    ].sort((a, b) => b.at - a.at).slice(0, MAX_ITEMS);
    return { room: { id: room.id, name: room.name, project: room.project }, rooms: rooms.map((r) => ({ id: r.id, name: r.name })), days, items };
  }],

  /** Statistics per session and per room over the last N days (default 30); ?room= narrows them to one room. */
  ['GET', '/api/stats', { auth: 'any', perm: 'station.view' }, async (q, ctx) => {
    const all = await allRooms(q, ctx.now), rooms = await visibleRooms(q, ctx);
    const key = ctx.query.get('room');
    const room = key ? rooms.find((r) => r.id === key || r.project === key) ?? fail(404, 'Unknown room') : null;
    const days = int(ctx.query.get('days'), 'days', { min: 1, max: 365, def: 30 });
    const since = ctx.now - days * 86400e3, week = ctx.now - 7 * 86400e3;
    const inRoom = room ? 'and project = $2' : '';
    const p = (x) => (room ? [x, room.project] : [x]);
    let [done, blocked, votes, claudes] = [
      await q.query(`select owner_claude, project, claimed_at, updated_at from tasks where status = 'done' and updated_at > $1 ${inRoom}`, p(since)),
      await q.query(`select owner_claude, project from tasks where status = 'blocked' and updated_at > $1 ${inRoom}`, p(0)),
      await q.query('select v.voter, p.room, p.project from poll_votes v join polls p on p.id = v.poll_id where v.at > $1', [since]),
      await q.query('select id, name, room, project from claudes'),
    ];
    const sees = (x) => (!x.room || rooms.some((r) => r.id === x.room)) && projectVisible(x.project, rooms, all, x.room) && (!room || x.project === room.project);
    done = done.filter(sees); blocked = blocked.filter(sees); claudes = claudes.filter(sees);
    const counts = new Map();
    for (const v of votes.filter(sees)) counts.set(v.voter, (counts.get(v.voter) || 0) + 1);
    votes = [...counts].map(([voter, n]) => ({ voter, n }));
    const byId = Object.fromEntries(claudes.map((c) => [c.id, c]));
    const blank = () => ({ closed7: 0, closed: 0, durations: [], blocked: 0, votes: 0 });
    const sessions = {}, perRoom = {};
    const ses = (id) => (sessions[id] ??= { id, name: byId[id]?.name || id, ...blank() });
    const roo = (proj) => (perRoom[proj] ??= { project: proj, name: rooms.find((r) => r.project === proj)?.name || proj || 'no room', ...blank() });
    for (const t of done) {
      for (const s of [t.owner_claude && ses(t.owner_claude), roo(t.project)].filter(Boolean)) {
        s.closed++; if (t.updated_at > week) s.closed7++;
        if (t.claimed_at && t.updated_at >= t.claimed_at) s.durations.push(t.updated_at - t.claimed_at);
      }
    }
    for (const t of blocked) for (const s of [t.owner_claude && ses(t.owner_claude), roo(t.project)].filter(Boolean)) s.blocked++;
    for (const v of votes) if (byId[v.voter] && (!room || byId[v.voter].room === room.id)) ses(v.voter).votes = v.n;
    const finish = (s) => { const { durations, ...rest } = s; return { ...rest, avgMinutes: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length / 60e3) : null }; };
    return {
      days, room: room && { id: room.id, name: room.name },
      closedAt: done.map((t) => t.updated_at).sort((a, b) => a - b), // the client buckets them by its own local day
      sessions: Object.values(sessions).map(finish).sort((a, b) => b.closed - a.closed || b.votes - a.votes),
      rooms: Object.values(perRoom).map(finish).sort((a, b) => b.closed - a.closed),
    };
  }],
];
