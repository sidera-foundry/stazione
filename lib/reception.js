import { randomId, sha256, encrypt, decrypt } from './crypto.js';
import { fail } from './http.js';
import { loadAccess, ORG_ID } from './permissions.js';
import { roomAccess } from './room-access.js';
import { roomOfProject } from './routes/rooms.js';
import { sendText } from './telegram.js';
import { audit } from './auth.js';
import { checkModel, loadModelConfig } from './model-check.js';

export const MODES = ['unrestricted', 'automatic', 'manual'];
export async function receptionPolicy(q, agent) {
  const [org] = await q.query('select reception_default from orgs where id=$1', [ORG_ID]);
  const [room] = agent.room ? await q.query('select * from rooms where id=$1', [agent.room]) : [];
  const access = await roomAccess(q, agent.owner_id, room);
  const [role] = await q.query('select reception_default from roles where id=$1', [access.role]);
  const baseline = room?.reception_default || role?.reception_default || org.reception_default;
  return { mode: agent.reception_mode || baseline, baseline, trusted: agent.trusted_senders || [] };
}
export async function mayReview(q, userId, item) {
  const base = await loadAccess(q, userId);
  const [room] = item.room ? await q.query('select * from rooms where id=$1', [item.room]) : [];
  const access = await roomAccess(q, userId, room, base);
  return access.visible && ((item.owner_user === userId && access.permissions.has('approvals.own')) || access.permissions.has('approvals.room'));
}
export async function sweepHeld(q, now) {
  const expired = await q.query("update held_items set status='expired',payload_enc=null,decided_at=$1 where status in ('pending','quarantined') and expires_at <= $1 returning id,source,project,room", [now]);
  for (const item of expired) {
    if (item.source?.type === 'claude' && item.source.id) {
      const [message] = await q.query("insert into messages (from_claude,to_target,text,project,room,created_at,quiet) select 'stazione',$1,$2,$3,$4,$5,true from claudes where id=$1 and owner_id=$6 returning id", [item.source.id, `Held item ${item.id} expired without delivery.`, item.project, item.room, now, item.source.owner]);
      if (message) await q.query("insert into content_annotations (resource_key,field,source,findings,updated_at) values ($1,'text',$2,'[]',$3)", [`message:${message.id}`, JSON.stringify({ type: 'station', id: 'stazione' }), now]);
    }
  }
}
export async function decideHeld(q, ctx, id, decision, userId = ctx.principal?.userId, note = '') {
  if (!['approved','discarded','quarantined'].includes(decision)) fail(400, 'Invalid review decision');
  const [item] = await q.query('select * from held_items where id=$1 and org_id=$2 for update', [id, ORG_ID]);
  if (!item || !(await mayReview(q, userId, item))) fail(404, 'Held content not found');
  if (!['pending','quarantined'].includes(item.status) || item.expires_at <= ctx.now) fail(409, 'This content has already been reviewed or expired');
  await q.query('update held_items set status=$2,note=$3,decided_by=$4,decided_at=$5,payload_enc=case when $2=\'discarded\' then null else payload_enc end where id=$1', [id, decision, note, userId, ctx.now]);
  if (decision === 'approved' && item.resource_key.startsWith('message:')) {
    // Reviewed messages must reappear even if an earlier masked inbox was marked read.
    await q.query('update messages set created_at=$2 where id=$1', [Number(item.resource_key.slice(8)), ctx.now]);
  }
  audit(q, ctx, 'held_content_reviewed', userId, { id, decision });
  return { ok: true };
}

export async function filterReception(q, ctx, targets) {
  if (ctx.principal?.type !== 'claude') return;
  // Protected data has already passed its separate human approval and access policy.
  // Re-holding it would consume a one-time disclosure before the recipient could read it.
  if (/^\/api\/secure\/[^/]+$/.test(ctx.path)) return;
  await loadModelConfig(q,ctx);
  const actorId = ctx.body?.as || ctx.query.get('as');
  let agents = actorId ? await q.query('select * from claudes where id=$1 and owner_id=$2', [actorId, ctx.principal.userId]) : await q.query('select * from claudes where owner_id=$1', [ctx.principal.userId]);
  if (actorId && !agents.length) fail(404, 'Agent not found');
  if (!agents.length) agents = [{ id: `token:${ctx.principal.tokenId}`, owner_id: ctx.principal.userId }];
  const policies = [];
  for (const agent of agents) policies.push({ agent, ...await receptionPolicy(q, agent) });
  for (const { v, key, fields, routing } of targets) {
    const contentProject = routing.project || '', contentRoom = routing.room;
    for (const field of fields) {
      const meta = v.content.fields[field], value = v[field];
      // A creator may always see its own successful write result.
      if (ctx.method !== 'GET' && meta.source.type === 'claude' && meta.source.id === ctx.body?.as) continue;
      if (meta.source.type === 'human' && meta.source.owner === ctx.principal.userId) continue;
      if (meta.source.type === 'station' || (meta.source.type === 'claude' && meta.source.id === actorId && meta.source.owner === ctx.principal.userId)) continue;
      const revision = sha256(JSON.stringify({ value, source: meta.source }));
      const blocked = [];
      for (const policy of policies) {
        const [previous] = await q.query('select id,status,note from held_items where resource_key=$1 and field=$2 and revision=$3 and for_claude=$4 and owner_user=$5', [key, field, revision, policy.agent.id, policy.agent.owner_id]);
        if (previous && ['discarded','expired','quarantined'].includes(previous.status)) { blocked.push({ id: previous.id, status: previous.status }); continue; }
        if (previous?.status === 'approved') { if (previous.note) meta.reviewNote = previous.note; continue; }
        const sender = `${meta.source.type}:${meta.source.owner}:${meta.source.id}`;
        if (policy.mode === 'unrestricted' || policy.trusted.includes(sender)) continue;
        if (policy.mode === 'automatic' && !meta.findings.length) {
          if (!v.secure) meta.findings.push(...await checkModel(q,ctx,value,meta.source));
          if (!meta.findings.length) continue;
        }
        const [room] = contentRoom ? await q.query('select * from rooms where id=$1', [contentRoom]) : contentProject ? [await roomOfProject(q, contentProject, ctx.now)] : [];
        const id = randomId();
        const inserted = await q.query(`insert into held_items (id,org_id,resource_key,field,revision,for_claude,owner_user,room,project,source,findings,payload_enc,created_at,expires_at)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) on conflict (resource_key,field,revision,for_claude,owner_user) do nothing returning id`, [id, ORG_ID, key, field, revision, policy.agent.id, policy.agent.owner_id, room?.id || policy.agent.room || null, contentProject || room?.project || '', JSON.stringify(meta.source), JSON.stringify(meta.findings), encrypt(JSON.stringify(value), `held:${id}`), ctx.now, ctx.now + 86400e3]);
        const [held] = await q.query('select id,status,note from held_items where resource_key=$1 and field=$2 and revision=$3 and for_claude=$4 and owner_user=$5', [key, field, revision, policy.agent.id, policy.agent.owner_id]);
        if (inserted.length) {
          audit(q, ctx, 'content_held', policy.agent.owner_id, { id, kind: key.split(':')[0], field });
          const [human] = await q.query('select telegram_chat_id from users where id=$1', [policy.agent.owner_id]);
          if (human?.telegram_chat_id) ctx.after.push(() => sendText(human.telegram_chat_id, `Held content for ${policy.agent.id}: ${key.split(':')[0]}, ${field}. Review on the panel.`, { reply_markup: { inline_keyboard: [[{ text: 'Deliver', callback_data: `hr:${id}:a` }, { text: 'Discard', callback_data: `hr:${id}:d` }]] } }));
        }
        if (held.status !== 'approved') blocked.push({ id: held.id, status: held.status });
        else if (held.note) meta.reviewNote = held.note;
      }
      if (blocked.length) {
        v[field] = Array.isArray(value) ? [] : '[Content held for human review]';
        meta.held = blocked;
        meta.length = typeof value === 'string' ? value.length : JSON.stringify(value).length;
        // Don't leak matched excerpts or review notes from a held payload.
        meta.findings = meta.findings.map(f => ({ type: f.type })); delete meta.reviewNote;
      }
    }
    if (key.startsWith('poll:') && v.content.fields.options?.held && v.winner != null) v.winner = '[Content held for human review]';
  }
}
export const heldPayload = item => item.payload_enc ? JSON.parse(decrypt(item.payload_enc, `held:${item.id}`)) : null;
