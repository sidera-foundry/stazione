import { fail } from './http.js';
import { decrypt } from './crypto.js';
import { audit } from './auth.js';
import { tg, sendText } from './telegram.js';
import { loadAccess, need } from './permissions.js';
import { requireRoom, scopeProject } from './room-access.js';
import { recordApproval, closeApprovalPrompts, canApprove } from './approval-rules.js';

export const APPROVAL_WINDOW_MS = 30 * 60e3;

// What happens to an approved piece of sensitive data. Codes are used in Telegram callback data (64-byte limit).
export const POLICIES = {
  deny: { code: 'd', label: 'Deny' },
  plain: { code: 'p', label: 'Not sensitive: deliver normally' },
  once_human: { code: 'h', label: 'View once, only by the partner (human)' },
  once_claude: { code: 'c', label: 'Read once, only by the receiving agent' },
  claude_24h: { code: 't', label: 'Readable by the receiving agent for 24 hours' },
  permanent: { code: 'k', label: 'Permanent on the board, encrypted, for all members' },
};
export const POLICY_BY_CODE = Object.fromEntries(Object.entries(POLICIES).map(([k, v]) => [v.code, k]));

export const STATUS_LABEL = {
  pending: 'waiting for approval',
  approved: 'approved',
  released: 'delivered as a normal message',
  denied: 'denied',
  expired: 'expired without an answer',
  consumed: 'already read and destroyed',
};

const aad = (id) => `secure:${id}`;

/** Lazy expiry: pending requests past the window and time-limited items past their deadline are wiped. */
export async function sweepSecure(q, now) {
  const expired = await q.query(
    `update secure_items set status = 'expired', ciphertext = null, decided_at = $1
      where status = 'pending' and approval_expires_at < $1 returning id, telegram_message_id, owner_user`,
    [now],
  );
  await q.query(
    `update secure_items set status = 'consumed', ciphertext = null
      where status = 'approved' and available_until is not null and available_until < $1`,
    [now],
  );
  for (const e of expired) {
    await q.query("update messages set text = '[Protected data: request expired without an answer]' where secure_id = $1", [e.id]);
  }
  return expired;
}

/** Who may read: recipients are the owners of the target instance, or everyone but the sender's owner for '*'. */
export function isHumanRecipient(item, userId, targetOwner) {
  return item.to_target === '*' ? userId !== item.owner_user : userId === targetOwner;
}

const pastAvailability = (item) => item.available_until != null && Number(item.available_until) < Date.now();

export function humanCanReveal(item, userId, targetOwner) {
  if (!item.ciphertext || pastAvailability(item)) return false;
  if (item.status === 'pending') return userId === item.owner_user; // the owner inspects before deciding
  if (item.status !== 'approved') return false;
  const recipient = isHumanRecipient(item, userId, targetOwner);
  switch (item.policy) {
    case 'once_human': return recipient;
    case 'claude_24h': return recipient || userId === item.owner_user;
    case 'permanent': return true;
    default: return false;
  }
}

export function claudeCanRead(item, instanceId) {
  if (!item.ciphertext || item.status !== 'approved' || pastAvailability(item)) return false;
  if (!['once_claude', 'claude_24h', 'permanent'].includes(item.policy)) return false;
  if (item.policy === 'permanent') return true;
  return item.to_target === '*' ? instanceId !== item.from_claude : instanceId === item.to_target;
}

/** Decrypt, and destroy the ciphertext when the policy allows a single read. */
export async function readAndMaybeConsume(q, ctx, item, reader) {
  const plaintext = decrypt(item.ciphertext, aad(item.id));
  if (item.status === 'approved' && (item.policy === 'once_human' || item.policy === 'once_claude')) {
    await q.query("update secure_items set status = 'consumed', ciphertext = null where id = $1", [item.id]);
    await q.query("update messages set text = '[Protected data: read once and destroyed]' where secure_id = $1", [item.id]);
  }
  audit(q, ctx, 'secure_read', ctx.principal?.userId ?? null, { id: item.id, reader, policy: item.policy });
  return plaintext;
}

export async function decide(q, ctx, id, policy, via, deciderUserId) {
  const [item] = await q.query('select * from secure_items where id = $1 for update', [id]);
  if (!item) fail(404, 'Request not found');
  ctx.principal = { ...(ctx.principal || {}), userId: deciderUserId, ...(await loadAccess(q, deciderUserId)) };
  const [message] = await q.query('select room from messages where id = $1', [item.message_id]);
  if (message?.room) await requireRoom(q, ctx, message.room); else await scopeProject(q, ctx, item.project);
  if (!await canApprove(q, { ...item, room: message?.room }, deciderUserId)) fail(404, 'Request not found');
  if (item.status !== 'pending') fail(409, `Request already ${STATUS_LABEL[item.status] || 'closed'}`);
  if (item.approval_expires_at < ctx.now) fail(410, 'Request expired');
  if (!POLICIES[policy]) fail(400, 'Invalid option');
  const review = await recordApproval(q, ctx, { ...item, room: message?.room }, 'secure', policy === 'deny' ? 'deny' : policy, deciderUserId);
  if (!review.ready) return { ...item, review };

  if (policy === 'deny') {
    await q.query("update secure_items set status = 'denied', policy = 'deny', ciphertext = null, decided_at = $2 where id = $1", [id, ctx.now]);
    await q.query("update messages set text = '[Protected data: denied by an approver]' where secure_id = $1", [id]);
  } else if (policy === 'plain') {
    const plaintext = decrypt(item.ciphertext, aad(id));
    await q.query("update messages set text = $2, secure_id = null where secure_id = $1", [id, plaintext]);
    await q.query("update secure_items set status = 'released', policy = 'plain', ciphertext = null, decided_at = $2 where id = $1", [id, ctx.now]);
  } else {
    const until = policy === 'claude_24h' ? ctx.now + 24 * 3600e3 : null;
    await q.query(
      "update secure_items set status = 'approved', policy = $2, decided_at = $3, available_until = $4 where id = $1",
      [id, policy, ctx.now, until],
    );
    await q.query('update messages set text = $2 where secure_id = $1', [id, `[Protected data: ${POLICIES[policy].label.toLowerCase()}]`]);
  }
  audit(q, ctx, 'secure_decided', deciderUserId, { id, policy, via });
  const promptsClosed = await closeApprovalPrompts(q, ctx, 'secure', id, `Sensitive data request: ${POLICIES[policy].label}.`);
  return { ...item, policy, review, promptsClosed, status: policy === 'deny' ? 'denied' : policy === 'plain' ? 'released' : 'approved' };
}

export function approvalText(item, fromName, toName) {
  const mins = Math.max(0, Math.round((item.approval_expires_at - Date.now()) / 60e3));
  return [
    'Authorization request',
    '',
    `Agent "${fromName}" wants to send sensitive data.`,
    `Recipient: ${toName}`,
    item.project ? `Project: ${item.project}` : null,
    item.reason ? `Reason: ${item.reason}` : null,
    `Detected: ${(item.detected || []).join(', ') || 'flagged by the agent'}`,
    '',
    `Preview (masked): ${item.preview}`,
    '',
    `Expires in ${mins} minutes. Without an answer it is denied.`,
  ].filter((l) => l !== null).join('\n');
}

export async function notifyOwner(chatId, item, fromName, toName) {
  if (!chatId) return null;
  const keyboard = Object.values(POLICIES).map((p) => [{ text: p.label, callback_data: `ap:${item.id}:${p.code}` }]);
  const msg = await sendText(chatId, approvalText(item, fromName, toName), { reply_markup: { inline_keyboard: keyboard } });
  return msg?.message_id ?? null;
}

export async function closeTelegramPrompt(chatId, messageId, outcome) {
  if (!chatId || !messageId) return;
  await tg('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } });
  await sendText(chatId, outcome, { reply_to_message_id: messageId });
}
