// Deleting an account: by the person themselves (password and authenticator code again) or by an owner.
// The row stays, so the audit log and old messages keep pointing somewhere, but everything that identifies or
// authenticates the person goes: name, password, authenticator, recovery phrase, Telegram, sessions, tokens, passkeys,
// browsers, roles and astronauts. Their pending requests close and their missions go back to the room.
import { fail, str, clearCookie } from './http.js';
import { randomToken, sha256, verifySecret } from './crypto.js';
import { ORG_ID } from './permissions.js';
import { audit, enforceLimits, recordAttempt, verifyTotp, decryptTotp, COOKIE_SESSION, COOKIE_PENDING } from './auth.js';

const HOUR = 3600e3;

export async function deleteAccount(q, ctx, userId) {
  // Same lock as role changes: two owners deleting each other at once must not leave the station without one.
  await q.query('select id from orgs where id = $1 for update', [ORG_ID]);
  const [u] = await q.query("select u.id, u.username, m.role_id from users u left join memberships m on m.user_id = u.id where u.id = $1 and u.status = 'active' for update of u", [userId]);
  if (!u) fail(404, 'Person not found');
  if (u.role_id === 'owner') {
    const [r] = await q.query("select count(*)::int as n from memberships m join users x on x.id = m.user_id where m.org_id = $1 and m.role_id = 'owner' and x.status = 'active' and m.user_id <> $2", [ORG_ID, u.id]);
    if (!r.n) fail(409, 'The station needs at least one owner: make someone else owner first');
  }
  const now = ctx.now;
  // Astronauts: their locks are released and their missions go back to the room, as with forget.
  const agents = (await q.query('select id from claudes where owner_id = $1', [u.id])).map((c) => c.id);
  if (agents.length) {
    await q.query('delete from locks where owner_claude = any($1)', [agents]);
    await q.query("update tasks set status = 'open', owner_claude = null, updated_at = $2 where owner_claude = any($1) and status in ('claimed', 'blocked')", [agents, now]);
    await q.query('delete from claudes where id = any($1)', [agents]);
  }
  // Requests waiting for this person, and protected data they were about to send, end here.
  await q.query("update asks set status = 'expired', decided_at = $2 where owner_user = $1 and status = 'pending'", [u.id, now]);
  const held = await q.query("update secure_items set status = 'denied', ciphertext = null, decided_at = $2 where owner_user = $1 and status = 'pending' returning id", [u.id, now]);
  for (const s of held) await q.query("update messages set text = '[Protected data: the account of the sender was deleted]' where secure_id = $1", [s.id]);
  await q.query('delete from approval_votes where user_id = $1', [u.id]);
  // Ways in.
  await q.query('delete from sessions where user_id = $1', [u.id]);
  await q.query('update api_tokens set revoked_at = $2 where user_id = $1 and revoked_at is null', [u.id, now]);
  await q.query('update passkeys set revoked_at = $2 where user_id = $1 and revoked_at is null', [u.id, now]);
  await q.query("update devices set status = 'revoked', decided_at = $2 where user_id = $1", [u.id, now]);
  await q.query('delete from webauthn_challenges where user_id = $1', [u.id]);
  await q.query('delete from telegram_codes where user_id = $1', [u.id]);
  await q.query('update invites set revoked_at = coalesce(revoked_at, $2) where created_by = $1 and used_at is null', [u.id, now]);
  // Roles.
  await q.query('delete from room_roles where user_id = $1', [u.id]);
  await q.query('delete from memberships where user_id = $1', [u.id]);
  // The person: no name, no secrets. The username becomes free again.
  await q.query(
    `update users set status = 'deleted', username = $2, password_hash = '!', password_pending_hash = null, totp_secret_enc = null,
            totp_pending_enc = null, recovery_hash = null, telegram_chat_id = null, avatar = 'astronaut', pending_expires_at = null,
            updated_at = $3 where id = $1`,
    [u.id, `deleted-${sha256(randomToken('', 16)).slice(0, 10)}`, now],
  );
  return { id: u.id, username: u.username, role: u.role_id, agents };
}

export const accountDeleteRoutes = [
  // The person deletes their own account: the password and a fresh authenticator code prove it is really them.
  ['POST', '/api/account/delete', { auth: 'human', sameOrigin: true }, async (q, ctx) => {
    const key = `delete:u:${ctx.principal.userId}`;
    await enforceLimits(q, ctx, [[key, 5, HOUR]]);
    const [u] = await q.query('select id, username, password_hash, totp_secret_enc, totp_last_step from users where id = $1 for update', [ctx.principal.userId]);
    if (str(ctx.body.confirm, 'confirmation', { max: 40 }).toLowerCase() !== u.username) fail(400, 'Type your username to confirm');
    const password = typeof ctx.body.password === 'string' && ctx.body.password.length <= 256 ? ctx.body.password : '';
    const passwordOk = await verifySecret(u.password_hash, password);
    const step = passwordOk && u.totp_secret_enc && verifyTotp(decryptTotp(u.totp_secret_enc, u.id), String(ctx.body.code || ''), u.totp_last_step);
    if (!step) {
      recordAttempt(ctx, key);
      audit(q, ctx, 'account_delete_failed', u.id);
      fail(401, 'Wrong password or authenticator code');
    }
    const gone = await deleteAccount(q, ctx, u.id);
    audit(q, ctx, 'account_deleted', u.id, { by: 'self', role: gone.role, agents: gone.agents.length });
    ctx.cookies.push(clearCookie(COOKIE_SESSION), clearCookie(COOKIE_PENDING));
    return { ok: true };
  }],
];
