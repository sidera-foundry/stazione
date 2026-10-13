import { fail, str, int, oneOf } from '../http.js';
import { randomToken, randomId, sha256, safeEqual, decrypt } from '../crypto.js';
import { audit, isLimited, recordAttempt } from '../auth.js';
import { telegramConfigured, sendText, tg } from '../telegram.js';
import { decideAsk, askOutcome } from './asks.js';
import { commandReply, HELP } from '../tgcommands.js';
import { POLICIES, POLICY_BY_CODE, STATUS_LABEL, decide, sweepSecure, closeTelegramPrompt, humanCanReveal, readAndMaybeConsume } from '../secure.js';
import { filterRoomContent } from '../room-access.js';
import { decideHeld } from '../reception.js';
import { validateRestrictions } from '../token-restrictions.js';
import { canApprove, reviewable } from '../approval-rules.js';

const AVATARS = ['cat', 'astronaut', 'robot', 'fox']; // keys drawn by public/js/avatar.js

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const linkCode = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');

async function targetOwner(q, item) {
  if (item.to_target === '*') return null;
  const [c] = await q.query('select owner_id from claudes where id = $1', [item.to_target]);
  return c?.owner_id ?? null;
}

async function outcomeText(q, item, policy) {
  const [c] = await q.query('select name from claudes where id = $1', [item.from_claude]);
  return `Request from ${c?.name || item.from_claude}: ${POLICIES[policy].label}.`;
}

export const accountRoutes = [
  // ---------- API tokens for agent instances (humans only: an agent can never mint or revoke tokens) ----------
  ['GET', '/api/tokens', { auth: 'human', perm: 'claudes.tokens' }, async (q, ctx) => {
    const rows = await q.query(
      `select id, name, created_at, last_used_at, expires_at, revoked_at, suspended_at, restrictions from api_tokens
        where user_id = $1 order by created_at desc limit 50`,
      [ctx.principal.userId],
    );
    return { tokens: rows };
  }],

  ['POST', '/api/tokens', { auth: 'human', perm: 'claudes.tokens' }, async (q, ctx) => {
    const name = str(ctx.body.name, 'name', { min: 1, max: 60 });
    const days = int(ctx.body.days, 'days', { min: 1, max: 365, def: 90 });
    const restrictions = await validateRestrictions(q, ctx, ctx.body.restrictions ?? {});
    const [c] = await q.query('select count(*)::int as n from api_tokens where user_id = $1 and revoked_at is null and expires_at > $2', [ctx.principal.userId, ctx.now]);
    if (c.n >= 10) fail(400, 'You already have 10 active tokens: revoke some');
    const token = randomToken('stz_', 32);
    const id = randomId();
    await q.query(
      'insert into api_tokens (id, user_id, name, token_hash, created_at, expires_at, restrictions) values ($1, $2, $3, $4, $5, $6, $7)',
      [id, ctx.principal.userId, name, sha256(token), ctx.now, ctx.now + days * 86400e3, JSON.stringify(restrictions)],
    );
    audit(q, ctx, 'token_created', ctx.principal.userId, { id, name, days });
    return { id, name, token, expiresAt: ctx.now + days * 86400e3, restrictions };
  }],

  ['PUT', '/api/tokens/:id', { auth: 'human', perm: 'claudes.tokens' }, async (q, ctx) => {
    const restrictions = await validateRestrictions(q, ctx, ctx.body.restrictions);
    const rows = await q.query('update api_tokens set restrictions=$3 where id=$1 and user_id=$2 and revoked_at is null returning id', [ctx.params.id, ctx.principal.userId, JSON.stringify(restrictions)]);
    if (!rows.length) fail(404, 'Token not found');
    audit(q, ctx, 'token_restrictions_changed', ctx.principal.userId, { id: ctx.params.id, restrictions });
    return { ok: true, restrictions };
  }],

  ['DELETE', '/api/tokens/:id', { auth: 'human', perm: 'claudes.tokens' }, async (q, ctx) => {
    const rows = await q.query(
      'update api_tokens set revoked_at = $3 where id = $1 and user_id = $2 and revoked_at is null returning id',
      [ctx.params.id, ctx.principal.userId, ctx.now],
    );
    if (!rows.length) fail(404, 'Token not found');
    audit(q, ctx, 'token_revoked', ctx.principal.userId, { id: ctx.params.id });
    return { ok: true };
  }],

  /** Who is logged in, and nothing else: pages that only need the name and avatar skip the whole /api/state. */
  ['GET', '/api/me', { auth: 'human' }, async (q, ctx) => {
    const [u] = await q.query('select username, avatar from users where id = $1', [ctx.principal.userId]);
    return { username: u.username, avatar: u.avatar, role: ctx.principal.role, roleName: ctx.principal.roleName, permissions: [...ctx.principal.permissions] };
  }],

  // ---------- avatar (a key from the fixed list in public/js/avatar.js) ----------
  ['POST', '/api/avatar', { auth: 'human' }, async (q, ctx) => {
    const avatar = oneOf(ctx.body.avatar, 'avatar', AVATARS);
    await q.query('update users set avatar = $2, updated_at = $3 where id = $1', [ctx.principal.userId, avatar, ctx.now]);
    return { ok: true, avatar };
  }],

  // ---------- Telegram linking ----------
  ['GET', '/api/telegram', { auth: 'human' }, async (q, ctx) => {
    const [u] = await q.query('select telegram_chat_id from users where id = $1', [ctx.principal.userId]);
    return { configured: telegramConfigured(), linked: Boolean(u?.telegram_chat_id), botUsername: process.env.TELEGRAM_BOT_USERNAME || null };
  }],

  ['POST', '/api/telegram/code', { auth: 'human' }, async (q, ctx) => {
    if (!telegramConfigured()) fail(503, 'Telegram bot not configured on the server');
    const code = linkCode();
    await q.query('delete from telegram_codes where user_id = $1 or expires_at < $2', [ctx.principal.userId, ctx.now]);
    await q.query('insert into telegram_codes (code_hash, user_id, expires_at) values ($1, $2, $3)', [sha256(code), ctx.principal.userId, ctx.now + 10 * 60e3]);
    return { code, expiresInMinutes: 10, botUsername: process.env.TELEGRAM_BOT_USERNAME || null };
  }],

  ['POST', '/api/telegram/unlink', { auth: 'human' }, async (q, ctx) => {
    await q.query('update users set telegram_chat_id = null where id = $1', [ctx.principal.userId]);
    audit(q, ctx, 'telegram_unlinked', ctx.principal.userId);
    return { ok: true };
  }],

  // ---------- approvals of sensitive data (only the owner of the sending agent, only as a human) ----------
  ['GET', '/api/approvals', { auth: 'human', perm: 'station.view' }, async (q, ctx) => {
    await sweepSecure(q, ctx.now);
    const rows = await q.query(
      `select s.id, s.owner_user, s.from_claude, c.name as from_name, m.room, s.to_target, s.project, s.reason, s.detected, s.preview,
              s.status, s.policy, s.created_at, s.approval_expires_at
         from secure_items s left join claudes c on c.id = s.from_claude left join messages m on m.id=s.message_id
        where s.status = 'pending' order by s.created_at`,
    );
    return { approvals: await reviewable(q, await filterRoomContent(q, ctx, rows), ctx.principal.userId, 'secure'), policies: Object.entries(POLICIES).map(([id, p]) => ({ id, label: p.label })) };
  }],

  ['POST', '/api/approvals/:id', { auth: 'human', perm: 'station.view' }, async (q, ctx) => {
    const policy = oneOf(ctx.body.policy, 'option', Object.keys(POLICIES));
    const item = await decide(q, ctx, ctx.params.id, policy, 'panel', ctx.principal.userId);
    const [u] = await q.query('select telegram_chat_id from users where id = $1', [ctx.principal.userId]);
    if (item.status !== 'pending' && !item.promptsClosed) await closeTelegramPrompt(u?.telegram_chat_id, item.telegram_message_id, `${await outcomeText(q, item, policy)} (decided from the panel)`);
    return { ok: true, status: item.status, policy: item.policy, review: item.review };
  }],

  // Reveal to a human: the owner while deciding, or recipients according to the chosen policy.
  ['POST', '/api/secure/:id/reveal', { auth: 'human', perm: 'station.view' }, async (q, ctx) => {
    await sweepSecure(q, ctx.now);
    const [item] = await q.query('select * from secure_items where id = $1 for update', [ctx.params.id]);
    const [message] = item ? await q.query('select room from messages where id=$1', [item.message_id]) : [];
    if (!item || !item.ciphertext || !(item.status === 'pending' ? await canApprove(q, { ...item, room: message?.room }, ctx.principal.userId) : humanCanReveal(item, ctx.principal.userId, await targetOwner(q, item)))) fail(404, 'Data not available');
    const consume = item.status === 'approved' && item.policy === 'once_human';
    const text = item.status === 'pending' ? decrypt(item.ciphertext, `secure:${item.id}`) : await readAndMaybeConsume(q, ctx, item, 'human');
    if (item.status === 'pending') audit(q, ctx, 'secure_inspected', ctx.principal.userId, { id: item.id });
    return { text, consumed: consume };
  }],
];

// ---------- Telegram webhook (authenticated by the secret token header Telegram sends) ----------
export const telegramRoutes = [
  ['POST', '/api/telegram/webhook', { auth: 'none' }, async (q, ctx) => {
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (!telegramConfigured() || !safeEqual(ctx.headers.get('x-telegram-bot-api-secret-token') || '', secret)) fail(404, 'Not found');
    const upd = ctx.body || {};

    if (upd.message?.chat?.type === 'private' && typeof upd.message.text === 'string') {
      const chatId = upd.message.chat.id;
      const text = upd.message.text.trim();
      const m = text.match(/^\/link\s+([A-Za-z0-9]{8})$/);
      if (m) {
        if (await isLimited(q, `tg:link:${sha256(String(chatId))}`, 5, 3600e3, ctx.now)) {
          await sendText(chatId, 'Too many attempts. Try again in an hour.');
          return { ok: true };
        }
        const [row] = await q.query('delete from telegram_codes where code_hash = $1 and expires_at > $2 returning user_id', [sha256(m[1].toUpperCase()), ctx.now]);
        if (!row) {
          recordAttempt(ctx, `tg:link:${sha256(String(chatId))}`);
          await sendText(chatId, 'Invalid or expired code. Generate a new one from the Stazione panel.');
          return { ok: true };
        }
        await q.query('update users set telegram_chat_id = null where telegram_chat_id = $1', [chatId]);
        await q.query('update users set telegram_chat_id = $2 where id = $1', [row.user_id, chatId]);
        audit(q, ctx, 'telegram_linked', row.user_id);
        await sendText(chatId, 'Account linked. From now on I will ask you here for approval when your agent wants to send sensitive data or take drastic actions (deletions, big changes).');
      } else {
        // A linked account can ask for /status, /missions, /recaps; anyone else only learns how to link.
        const [u] = await q.query("select id from users where telegram_chat_id = $1 and status = 'active'", [chatId]);
        const reply = u && await commandReply(q, u.id, text, ctx.now, ctx);
        await sendText(chatId, reply ?? (u ? HELP : 'I am the Stazione bot. To link your account, generate a code from the panel (Account → Telegram) and send me: /link CODE'));
      }
      return { ok: true };
    }

    const cb = upd.callback_query;
    const heldMatch = cb && typeof cb.data === 'string' && cb.data.match(/^hr:([0-9a-f-]{36}):([ad])$/);
    if (heldMatch) {
      const [human] = await q.query("select id from users where telegram_chat_id=$1 and status='active'", [cb.from?.id]);
      let answer = 'Held content not found';
      if (human) {
        try { await decideHeld(q, ctx, heldMatch[1], heldMatch[2] === 'a' ? 'approved' : 'discarded', human.id); answer = 'Review recorded'; }
        catch (err) { if (!err.status) throw err; answer = err.message; }
      }
      await tg('answerCallbackQuery', { callback_query_id: cb.id, text: answer }); return { ok: true };
    }
    const okMatch = cb && typeof cb.data === 'string' && cb.data.match(/^ok:([0-9a-f-]{36}):([yn])$/);
    if (okMatch) {
      const [u] = await q.query("select id from users where telegram_chat_id = $1 and status = 'active'", [cb.from?.id]);
      let answer = 'Invalid request';
      if (u) {
        try {
          const a = await decideAsk(q, ctx, okMatch[1], okMatch[2] === 'y', u.id);
          answer = askOutcome(a);
          if (a.status !== 'pending' && !a.promptsClosed) await closeTelegramPrompt(cb.message?.chat?.id, cb.message?.message_id, answer);
        } catch (err) {
          answer = err?.status ? err.message : 'Errore, riprova dal pannello';
          if ([404,410].includes(err?.status)) await tg('editMessageReplyMarkup', { chat_id: cb.message?.chat?.id, message_id: cb.message?.message_id, reply_markup: { inline_keyboard: [] } });
        }
      }
      await tg('answerCallbackQuery', { callback_query_id: cb.id, text: answer.slice(0, 190) });
      return { ok: true };
    }
    if (cb && typeof cb.data === 'string') {
      const m = cb.data.match(/^ap:([0-9a-f-]{36}):([a-z])$/);
      const policy = m && POLICY_BY_CODE[m[2]];
      const [u] = await q.query("select id from users where telegram_chat_id = $1 and status = 'active'", [cb.from?.id]);
      let answer = 'Invalid request';
      if (m && policy && u) {
        try {
          const item = await decide(q, ctx, m[1], policy, 'telegram', u.id);
          answer = item.status === 'pending' ? 'Approval recorded. Waiting for a second approver.' : await outcomeText(q, item, policy);
          if (item.status !== 'pending' && !item.promptsClosed) await closeTelegramPrompt(cb.message?.chat?.id, cb.message?.message_id, answer);
        } catch (err) {
          answer = err?.status ? err.message : 'Errore, riprova dal pannello';
          if ([404,410].includes(err?.status)) await tg('editMessageReplyMarkup', { chat_id: cb.message?.chat?.id, message_id: cb.message?.message_id, reply_markup: { inline_keyboard: [] } });
        }
      }
      await tg('answerCallbackQuery', { callback_query_id: cb.id, text: answer.slice(0, 190) });
      return { ok: true };
    }
    return { ok: true };
  }],
];

export { STATUS_LABEL };
