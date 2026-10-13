import { fail, oneOf } from './http.js';
import { ORG_ID, loadAccess, need } from './permissions.js';
import { roomOfProject } from './routes/rooms.js';
import { roomAccess, requireRoom, visibleRooms } from './room-access.js';
import { audit } from './auth.js';
import { tg, sendText } from './telegram.js';

export const APPROVAL_RULES = ['owner','room','two'];
export async function approvalContext(q, item, userId) {
  const room = item.room ? (await q.query('select * from rooms where id=$1', [item.room]))[0] : await roomOfProject(q, item.project, Date.now());
  const [org] = await q.query('select approval_default from orgs where id=$1', [ORG_ID]);
  const rule = item.kind === 'opinion' ? 'owner' : room?.approval_rule || org.approval_default;
  const [user] = await q.query('select status from users where id=$1', [userId]);
  const access = await roomAccess(q, userId, room, await loadAccess(q, userId));
  const own = item.owner_user === userId && access.permissions.has('approvals.own'), responsible = access.permissions.has('approvals.room');
  return { rule, room, allowed: user?.status === 'active' && access.visible && (rule === 'owner' ? own : rule === 'room' ? responsible : own || responsible) };
}
export async function canApprove(q, item, userId) { return (await approvalContext(q, item, userId)).allowed; }
export async function approvalProgress(q, item, kind, userId) {
  const c = await approvalContext(q, item, userId), votes = [];
  for (const vote of await q.query('select * from approval_votes where kind=$1 and request_id=$2 and rule=$3', [kind, item.id, c.rule])) {
    if (await canApprove(q, item, vote.user_id)) votes.push(vote);
  }
  return { rule: c.rule, required: c.rule === 'two' ? 2 : 1, approvals: votes.length, voted: votes.some(v => v.user_id === userId), proposal: votes[0]?.choice ?? null };
}
// Caller locks the request first; both clients and Telegram use this same decision path.
export async function recordApproval(q, ctx, item, kind, choice, userId) {
  const c = await approvalContext(q, item, userId);
  if (!c.allowed) fail(404, 'Request not found');
  if (choice === 'deny' || c.rule !== 'two') return { ready: true, ...await approvalProgress(q, item, kind, userId) };
  const progress = await approvalProgress(q, item, kind, userId);
  if (progress.voted) fail(409, 'You already approved this request');
  const valid = [];
  for (const vote of await q.query('select * from approval_votes where kind=$1 and request_id=$2', [kind, item.id])) {
    if (vote.rule === c.rule && await canApprove(q, item, vote.user_id)) valid.push(vote);
    else await q.query('delete from approval_votes where kind=$1 and request_id=$2 and user_id=$3', [kind, item.id, vote.user_id]);
  }
  if (valid.some(v => v.choice !== choice)) fail(409, 'Choose the same disclosure policy as the first approver');
  await q.query('insert into approval_votes (kind,request_id,user_id,choice,rule,at) values ($1,$2,$3,$4,$5,$6)', [kind, item.id, userId, choice, c.rule, ctx.now]);
  audit(q, ctx, 'approval_vote', userId, { kind, id: item.id, choice });
  return { ready: valid.length + 1 >= 2, rule: c.rule, required: 2, approvals: valid.length + 1, voted: true, proposal: choice };
}
// Notifications contain only the existing masked preview; eligibility is checked again on every decision.
export async function approvers(q, item) {
  const out = [];
  for (const user of await q.query("select id,telegram_chat_id from users where status='active'")) {
    if (await canApprove(q, item, user.id)) out.push(user);
  }
  return out;
}
export async function notifyApprovers(database, item, kind, send) {
  for (const user of await approvers(database, item)) {
    if (!user.telegram_chat_id) continue;
    const messageId = await send(user.telegram_chat_id);
    if (messageId) await database.query('insert into approval_prompts (kind,request_id,chat_id,message_id) values ($1,$2,$3,$4) on conflict do nothing', [kind, item.id, String(user.telegram_chat_id), messageId]);
  }
}
export async function closeApprovalPrompts(q, ctx, kind, id, outcome) {
  const rows = await q.query('delete from approval_prompts where kind=$1 and request_id=$2 returning chat_id,message_id', [kind, id]);
  ctx.after.push(async () => {
    for (const row of rows) {
      await tg('editMessageReplyMarkup', { chat_id: row.chat_id, message_id: row.message_id, reply_markup: { inline_keyboard: [] } });
      await sendText(row.chat_id, outcome, { reply_to_message_id: row.message_id });
    }
  });
  return rows.length > 0;
}
export async function reviewable(q, rows, userId, kind) {
  const out = [];
  for (const item of rows) {
    if (await canApprove(q, item, userId)) out.push({ ...item, review: await approvalProgress(q, item, kind, userId) });
  }
  return out;
}
export const approvalRoutes = [
  ['GET', '/api/approval-rules', { auth: 'human', perm: 'station.view' }, async (q, ctx) => ({ organization: (await q.query('select approval_default as rule from orgs where id=$1', [ORG_ID]))[0], rooms: (await visibleRooms(q, ctx)).map(r => ({ id: r.id, name: r.name, rule: r.approval_rule })) })],
  ['PUT', '/api/organization/approval-rule', { auth: 'human', perm: 'admin.security' }, async (q, ctx) => {
    const rule = oneOf(ctx.body.rule, 'approval rule', APPROVAL_RULES);
    await q.query('update orgs set approval_default=$2 where id=$1', [ORG_ID, rule]); audit(q, ctx, 'approval_rule_changed', ctx.principal.userId, { organization: ORG_ID, rule }); return { ok: true };
  }],
  ['PUT', '/api/rooms/:id/approval-rule', { auth: 'human' }, async (q, ctx) => {
    await requireRoom(q, ctx, ctx.params.id); need(ctx, 'admin.security');
    const rule = ctx.body.rule == null ? null : oneOf(ctx.body.rule, 'approval rule', APPROVAL_RULES);
    await q.query('update rooms set approval_rule=$2 where id=$1', [ctx.params.id, rule]); audit(q, ctx, 'approval_rule_changed', ctx.principal.userId, { room: ctx.params.id, rule }); return { ok: true };
  }],
];
