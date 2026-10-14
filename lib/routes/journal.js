// Logbook: what happened in a room, day by day — recaps, missions closed, decisions and, for the Bridge,
// the station's own commits. Read-only, built from what the panel already shows (no messages, no ideas board).
// The statistics (GET /api/stats) are in the stats module (modules/stats/server.js).
import { fail, int } from '../http.js';
import { visibleRooms } from '../room-access.js';
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
];
