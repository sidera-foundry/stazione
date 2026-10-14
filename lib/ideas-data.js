// Data of the ideas board (module modules/ideas). Its tables belong to the core schema and this upkeep runs at start
// even when the module is switched off, so turning the board off and on again never loses or breaks an idea.
import { ORG_ID } from './permissions.js';

/** The "General" category of the organization's board (roomId null) or of a room's board, created on first use. */
export async function ensureGeneral(q, roomId = null) {
  const id = roomId ? `general-room-${roomId}` : 'general-org';
  const roles = (await q.query("select id from roles where org_id = $1 and id <> 'guest'", [ORG_ID])).map((r) => r.id);
  await q.query('insert into idea_categories (id, org_id, room_id, name, view_roles, write_roles) values ($1, $2, $3, $4, $5, $5) on conflict (id) do nothing', [id, ORG_ID, roomId, 'General', JSON.stringify(roles)]);
  return id;
}
