// Permission requests for drastic actions (deleting files or data, big rewrites): a Claude asks its own human,
// who answers from Telegram or the panel. The answer reaches the Claude as a message, so a running "wait" wakes it.
import { fail, str, PROJECT_MAX } from '../http.js';
import { randomId } from '../crypto.js';
import { sendText } from '../telegram.js';
import { closeTelegramPrompt } from '../secure.js';
import { guardText, ownInstance } from './board.js';
import { detectInjection } from '../injection.js';
import { filterRoomContent, scopeProject } from '../room-access.js';
import { loadAccess } from '../permissions.js';
import { checkRoom } from './rooms.js';
import { recordApproval, reviewable, notifyApprovers, closeApprovalPrompts, canApprove } from '../approval-rules.js';
import { audit } from '../auth.js';

export const ASK_WINDOW_MS = 30 * 60e3;
const OPINION_WINDOW_MS = 24 * 3600e3; // an opinion is not urgent: the humans answer when they read it
const LABEL = { pending: 'pending', approved: 'approved', rejected: 'rejected', expired: 'expired without an answer', answered: 'answered' };

const camelAsk = (a) => ({
  id: a.id, kind: a.kind, claude: a.claude_id, project: a.project, text: a.text, status: a.status, statusLabel: LABEL[a.status], answer: a.answer,
  createdAt: a.created_at, expiresAt: a.expires_at, decidedAt: a.decided_at,
  ...(a.review && { review: a.review }),
});

const tellClaude = (q, from, a, outcome, now) => q.query(
  'insert into messages (from_claude, to_target, text, project, created_at, quiet) values ($1, $2, $3, $4, $5, $6)',
  [from, a.claude_id, `Request ${a.id} ${outcome}: ${a.text}`.slice(0, 4000), a.project, now, detectInjection(`${outcome}\n${a.text}`).length > 0],
);

/** Expire unanswered requests; the Claude is told, so it never waits forever. */
export async function sweepAsks(q, now) {
  const expired = await q.query(
    "update asks set status = 'expired', decided_at = $1 where status = 'pending' and expires_at < $1 returning *",
    [now],
  );
  for (const a of expired) await tellClaude(q, 'stazione', a, a.kind === 'opinion' ? 'EXPIRED without an opinion: decide yourself, carefully' : 'EXPIRED without an answer: consider it rejected', now);
}

/** Records the human's answer and tells the Claude. Only the owner of the asking Claude may answer. */
export async function decideAsk(q, ctx, id, approve, userId) {
  await sweepAsks(q, ctx.now);
  const [a] = await q.query('select * from asks where id = $1 for update', [id]);
  if (!a) fail(404, 'Request not found');
  ctx.principal = { ...(ctx.principal || {}), userId, ...(await loadAccess(q, userId)) };
  await scopeProject(q, ctx, a.project);
  if (!await canApprove(q, a, userId)) fail(404, 'Request not found');
  if (a.status !== 'pending') fail(409, `Request already ${LABEL[a.status]}`);
  if (a.kind === 'opinion') fail(400, 'This is a request for an opinion: answer with a text');
  const review = await recordApproval(q, ctx, a, 'ask', approve ? 'approve' : 'deny', userId);
  if (!review.ready) return { ...a, review };
  const status = approve ? 'approved' : 'rejected';
  await q.query('update asks set status = $2, decided_at = $3 where id = $1', [id, status, ctx.now]);
  const [u] = await q.query('select username from users where id = $1', [userId]);
  await tellClaude(q, `human:${u.username}`, a, approve ? 'APPROVED: go ahead' : 'REJECTED: do not do it', ctx.now);
  audit(q, ctx, 'ask_decided', userId, { id, status });
  const promptsClosed = await closeApprovalPrompts(q, ctx, 'ask', id, askOutcome({ status }));
  return { ...a, status, review, promptsClosed };
}

export const askOutcome = (a) => (a.status === 'pending' ? 'Waiting for a second approver' : a.status === 'approved' ? '✅ Approved' : '❌ Rejected');

export const askRoutes = [
  ['POST', '/api/asks', { auth: 'claude' }, async (q, ctx) => {
    const me = await ownInstance(q, ctx, ctx.body.as);
    const text = guardText(str(ctx.body.text, 'text', { min: 1, max: 500 }), 'text');
    const project = str(ctx.body.project, 'project', { max: PROJECT_MAX }) || me.project;
    await checkRoom(q, me, project, ctx.now, 'ask about projects');
    const kind = ctx.body.kind === 'opinion' ? 'opinion' : 'permission';
    const id = randomId();
    const expiresAt = ctx.now + (kind === 'opinion' ? OPINION_WINDOW_MS : ASK_WINDOW_MS);
    await q.query(
      'insert into asks (id, claude_id, owner_user, project, text, created_at, expires_at, kind) values ($1, $2, $3, $4, $5, $6, $7, $8)',
      [id, me.id, ctx.principal.userId, project, text, ctx.now, expiresAt, kind],
    );
    const [owner] = await q.query('select telegram_chat_id from users where id = $1', [ctx.principal.userId]);
    // Notify only after commit, so a tap on Telegram always finds the request.
    ctx.after.push(async (database) => {
      if (kind === 'opinion') {
        if (!owner?.telegram_chat_id) return;
        await sendText(owner.telegram_chat_id, `💬 ${me.name} asks for an opinion${project ? ` [${project}]` : ''}:\n\n${text}\n\nAnswer from the panel (bell at the top right).`);
        return;
      }
      await notifyApprovers(database, { id, owner_user: ctx.principal.userId, project, kind }, 'ask', async chatId => {
      const msg = await sendText(chatId,
        `🛑 ${me.name} asks for permission${project ? ` [${project}]` : ''}:\n\n${text}\n\nWithout an answer within 30 minutes it is rejected.`,
        { reply_markup: { inline_keyboard: [[{ text: '✅ Approve', callback_data: `ok:${id}:y` }, { text: '❌ Reject', callback_data: `ok:${id}:n` }]] } });
      return msg?.message_id;
      });
    });
    ctx.status = 202;
    if (kind === 'opinion') return { status: 'pending', id, expiresAt, next: 'keep working: the opinion arrives as a message and wakes wait' };
    return {
      status: 'pending', id, expiresAt,
      approvalVia: owner?.telegram_chat_id ? 'telegram and panel' : 'panel (Telegram not linked)',
      next: 'go on with the rest of the work: the outcome arrives as a message and wakes wait',
    };
  }],

  ['GET', '/api/asks/:id', { auth: 'claude' }, async (q, ctx) => {
    await sweepAsks(q, ctx.now);
    const [a] = await q.query('select * from asks where id = $1', [ctx.params.id]);
    if (!a || a.owner_user !== ctx.principal.userId) fail(404, 'Request not found');
    return camelAsk(a);
  }],

  ['GET', '/api/asks', { auth: 'human', perm: 'station.view' }, async (q, ctx) => {
    await sweepAsks(q, ctx.now);
    const rows = await q.query("select * from asks where status = 'pending' order by created_at");
    return { asks: (await reviewable(q, await filterRoomContent(q, ctx, rows), ctx.principal.userId, 'ask')).map(camelAsk) };
  }],

  ['POST', '/api/asks/:id', { auth: 'human', perm: 'station.view' }, async (q, ctx) => {
    if (ctx.body.answer != null) { // an opinion: free text, delivered to the Claude as a message
      const answer = guardText(str(ctx.body.answer, 'opinion', { min: 1, max: 2000 }), 'opinion');
      await sweepAsks(q, ctx.now);
      const [a] = await q.query('select * from asks where id = $1 for update', [ctx.params.id]);
      if (!a || a.owner_user !== ctx.principal.userId) fail(404, 'Request not found');
      if (a.kind !== 'opinion') fail(400, 'This request requires an approval decision');
      if (!await canApprove(q, a, ctx.principal.userId)) fail(404, 'Request not found');
      if (a.status !== 'pending') fail(409, `Request already ${LABEL[a.status]}`);
      await q.query("update asks set status = 'answered', answer = $2, decided_at = $3 where id = $1", [a.id, answer, ctx.now]);
      await tellClaude(q, `human:${ctx.principal.username}`, a, `OPINION: ${answer} — question`, ctx.now);
      return { ok: true, status: 'answered' };
    }
    const a = await decideAsk(q, ctx, ctx.params.id, ctx.body.approve === true, ctx.principal.userId);
    const [u] = await q.query('select telegram_chat_id from users where id = $1', [ctx.principal.userId]);
    if (a.status !== 'pending' && !a.promptsClosed) await closeTelegramPrompt(u?.telegram_chat_id, a.telegram_message_id, `${askOutcome(a)} (decided from the panel)`);
    return { ok: true, status: a.status, review: a.review };
  }],
];
