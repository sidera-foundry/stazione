// Silent sessions: a Claude that holds a mission and has not been heard from for 20 minutes (out of tokens, closed
// window) is reported once on Telegram to its own human; nothing more until it comes back and goes silent again.
// Vercel crons run once a day, so this piggybacks on the station's own traffic, at most once a minute per instance.
import { sendText } from './telegram.js';
import { roomAccess } from './room-access.js';

export const SILENT_MS = 20 * 60e3;
let lastRun = 0;

/** Returns the sessions just reported (for tests); `force` skips the once-a-minute throttle. */
export async function sweepSilent(database, now, force = false) {
  if (!force && now - lastRun < 60e3) return [];
  lastRun = now;
  // One statement marks and returns: two instances sweeping at once cannot report the same silence twice.
  const rows = await database.query(
    `update claudes c set silent_alerted_at = $1
       from users u, tasks t
      where u.id = c.owner_id and t.id = c.task_id and t.status in ('claimed', 'blocked')
        and u.telegram_chat_id is not null and c.last_seen < $2
        and (c.silent_alerted_at is null or c.silent_alerted_at < c.last_seen)
      returning c.id, c.name, c.project, c.room, c.owner_id, c.task_id, t.title, u.telegram_chat_id`,
    [now, now - SILENT_MS],
  );
  for (const r of rows) {
    try {
      const [room] = r.room ? await database.query('select * from rooms where id = $1', [r.room]) : [];
      if (!(await roomAccess(database, r.owner_id, room)).visible) continue;
      await sendText(r.telegram_chat_id,
        `⏸ Your session ${r.name} (${r.id}${r.project ? `, ${r.project}` : ''}) has been silent for more than 20 minutes with mission ${r.task_id}: ${r.title}.\n\n` +
        'Maybe it ran out of tokens or the window is closed. Reopen it and write to it, or another session of the same room can take the mission over.');
    } catch (err) {
      // Already marked as alerted: unmark it so the next sweep tries again, and go on with the others.
      console.error(`silent alert failed: ${err?.code || err?.name}`);
      await database.query('update claudes set silent_alerted_at = null where id = $1', [r.id]).catch(() => {});
    }
  }
  return rows.map((r) => r.id);
}
