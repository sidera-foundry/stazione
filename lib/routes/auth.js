import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { fail, str, USERNAME_RE, setCookie, clearCookie, parseCookies } from '../http.js';
import { ORG_ID } from '../permissions.js';
import { organization, userLimit, occupiedSeats, validateInviteRole } from '../invites.js';
import { hashSecret, verifySecret, verifyDummy, randomId, safeEqual, sha256, encrypt } from '../crypto.js';
import {
  COOKIE_SESSION, COOKIE_PENDING, audit, enforceLimits, recordAttempt, clearAttempts,
  checkPasswordPolicy, newTotpSecret, totpEnrollment, verifyTotp, decryptTotp, createSession, loadPending,
} from '../auth.js';
import { finishLogin } from '../devices.js';

const MIN15 = 15 * 60e3;
const HOUR = 3600e3;
const INVALID_LOGIN = 'Invalid credentials';

// Wrong TOTP codes count per user across fresh logins: the pending login's own 5 tries alone would let someone
// who knows the password start over without end and, in the long run, guess the code.
const totpKeys = (ctx, userId) => [`totp:u:${userId}`, `totp:ip:${ctx.ipHash}`];
const TOTP_LIMITS = (keys) => [[keys[0], 10, HOUR], [keys[1], 30, HOUR]];

const normUsername = (v) => str(v, 'username', { min: 3, max: 32 }).toLowerCase();
const normPhrase = (v) => str(v, 'recovery phrase', { min: 20, max: 300 }).toLowerCase().split(/\s+/).join(' ');

async function startFullSession(q, ctx, userId) {
  return finishLogin(q, ctx, userId);
}

function bumpPendingAttempts(ctx, row) {
  ctx.persist('update sessions set attempts = attempts + 1 where id_hash = $1', [row.id_hash]);
}

export const authRoutes = [
  ['GET', '/api/auth/status', { auth: 'none' }, async (q, ctx) => {
    const org = await organization(q);
    const [owner] = await q.query("select 1 from memberships where role_id = 'owner' and org_id = $1 limit 1", [ORG_ID]);
    const [pending] = await q.query("select 1 from users where status = 'pending' and registration_role = 'owner' and registration_invite_id is null and pending_expires_at >= $1 limit 1", [ctx.now]);
    const [available] = await q.query('select 1 from invites where org_id = $1 and role_id is not null and used_at is null and revoked_at is null and expires_at > $2 and (reserved_by is null or reserved_until < $2) limit 1', [ORG_ID, ctx.now]);
    const bootstrap = !owner && !pending && Boolean(process.env.INVITE_CODE && process.env.INVITE_CODE.length >= 16);
    return { registrationOpen: (await occupiedSeats(q, ctx.now)) < userLimit(org) && Boolean(bootstrap || available), signedIn: Boolean(ctx.principal) };
  }],

  ['POST', '/api/auth/register/start', { auth: 'none', sameOrigin: true }, async (q, ctx) => {
    await enforceLimits(q, ctx, [[`reg:ip:${ctx.ipHash}`, 10, HOUR]]);
    const org = await organization(q, { lock: true }); // shared with invite revocation, confirmation and limit changes
    await q.query("delete from users where status = 'pending' and pending_expires_at < $1", [ctx.now]);
    if (await occupiedSeats(q, ctx.now) >= userLimit(org)) {
      audit(q, ctx, 'register_closed');
      fail(403, 'Registration closed: the maximum number of users has been reached');
    }
    const rawInvite = typeof ctx.body.invite === 'string' && ctx.body.invite.length <= 100 ? ctx.body.invite : '';
    const [owner] = await q.query("select 1 from memberships where org_id = $1 and role_id = 'owner' limit 1", [ORG_ID]);
    const [pendingOwner] = await q.query("select 1 from users where status = 'pending' and registration_role = 'owner' and registration_invite_id is null and pending_expires_at >= $1 limit 1", [ctx.now]);
    const bootstrap = !owner && !pendingOwner && process.env.INVITE_CODE?.length >= 16 && safeEqual(rawInvite, process.env.INVITE_CODE);
    const [invite] = bootstrap ? [] : await q.query('select * from invites where code_hash = $1 and org_id = $2 for update', [sha256(rawInvite), ORG_ID]);
    if (!bootstrap && (!invite || invite.used_at != null || invite.revoked_at != null || invite.expires_at <= ctx.now || (invite.reserved_by && invite.reserved_until >= ctx.now))) {
      recordAttempt(ctx, `reg:ip:${ctx.ipHash}`);
      audit(q, ctx, 'register_bad_invite');
      fail(403, 'Invalid invite code');
    }
    const registrationRole = bootstrap ? 'owner' : await validateInviteRole(q, invite);
    const username = normUsername(ctx.body.username);
    if (!USERNAME_RE.test(username)) fail(400, 'Username: 3-32 characters among letters, digits, dot, hyphen and underscore');
    const password = await checkPasswordPolicy(ctx.body.password, username);
    const passwordHash = await hashSecret(password);
    const secret = newTotpSecret();
    const userId = randomId();

    const [taken] = await q.query('select 1 from users where username = $1', [username]);
    if (taken) fail(409, 'Username not available');
    await q.query(
      `insert into users (id, username, password_hash, totp_pending_enc, status, pending_expires_at, created_at, updated_at, registration_invite_id, registration_role)
       values ($1, $2, $3, $4, 'pending', $5, $6, $6, $7, $8)`,
      [userId, username, passwordHash, encrypt(secret, `totp:${userId}`), ctx.now + MIN15, ctx.now, invite?.id ?? null, registrationRole],
    );
    if (invite) await q.query('update invites set reserved_by = $2, reserved_until = $3 where id = $1', [invite.id, userId, ctx.now + MIN15]);
    const s = await createSession(q, userId, 'reg', ctx.now);
    ctx.cookies.push(setCookie(COOKIE_PENDING, s.token, s.maxAgeSec));
    audit(q, ctx, 'register_started', userId);
    return totpEnrollment(secret, username);
  }],

  ['POST', '/api/auth/register/confirm', { auth: 'none', sameOrigin: true }, async (q, ctx) => {
    const pending = await loadPending(q, ctx, ['reg']);
    // The bootstrap owner check must be atomic, including when two people confirm at the same time.
    await q.query('select id from orgs where id = $1 for update', [ORG_ID]);
    const [u] = await q.query("select * from users where id = $1 and status = 'pending' for update", [pending.user_id]);
    if (!u || u.pending_expires_at < ctx.now) fail(401, 'Registration expired: start again');
    const step = verifyTotp(decryptTotp(u.totp_pending_enc, u.id), String(ctx.body.code || ''));
    if (!step) {
      bumpPendingAttempts(ctx, pending);
      fail(400, 'Invalid code. Check that the phone\'s clock is correct.');
    }
    const phrase = generateMnemonic(wordlist, 128);
    await q.query(
      `update users set status = 'active', totp_secret_enc = totp_pending_enc, totp_pending_enc = null,
              totp_last_step = $2, recovery_hash = $3, pending_expires_at = null, updated_at = $4 where id = $1`,
      [u.id, step, await hashSecret(phrase), ctx.now],
    );
    let role = u.registration_role;
    if (u.registration_invite_id) {
      const [invite] = await q.query('select * from invites where id = $1 for update', [u.registration_invite_id]);
      if (!invite || invite.used_at != null || invite.revoked_at != null || invite.expires_at <= ctx.now || invite.reserved_by !== u.id || invite.reserved_until < ctx.now) fail(403, 'Invite no longer valid: ask for a new one');
      role = await validateInviteRole(q, invite);
      for (const assignment of invite.room_roles || []) await q.query('insert into room_roles (user_id, room_id, role_id) values ($1, $2, $3)', [u.id, assignment.room, assignment.role]);
      await q.query('update invites set used_by = $2, used_at = $3, reserved_by = null, reserved_until = null where id = $1', [invite.id, u.id, ctx.now]);
    } else {
      const [owner] = await q.query("select 1 from memberships where org_id = $1 and role_id = 'owner' limit 1", [ORG_ID]);
      if (owner || role !== 'owner') fail(403, 'Registration changed: ask for a single-use invite');
    }
    await q.query('insert into memberships (user_id, org_id, role_id, updated_at) values ($1, $2, $3, $4) on conflict (user_id) do nothing', [u.id, ORG_ID, role, ctx.now]);
    await q.query('delete from sessions where id_hash = $1', [pending.id_hash]);
    const login = await startFullSession(q, ctx, u.id);
    audit(q, ctx, 'register_completed', u.id, { role });
    return { username: u.username, recoveryPhrase: phrase, ...login };
  }],

  ['POST', '/api/auth/login', { auth: 'none', sameOrigin: true }, async (q, ctx) => {
    const username = normUsername(ctx.body.username);
    const password = typeof ctx.body.password === 'string' ? ctx.body.password : '';
    const keys = [`login:u:${sha256(username)}`, `login:ip:${ctx.ipHash}`];
    await enforceLimits(q, ctx, [[keys[0], 5, MIN15], [keys[1], 30, MIN15]]);
    const [u] = await q.query("select * from users where username = $1 and status = 'active'", [username]);
    const ok = u && password.length <= 256 ? await verifySecret(u.password_hash, password) : await verifyDummy(password || 'x');
    if (!ok) {
      for (const k of keys) recordAttempt(ctx, k);
      audit(q, ctx, 'login_failed', u?.id ?? null);
      fail(401, INVALID_LOGIN);
    }
    await enforceLimits(q, ctx, TOTP_LIMITS(totpKeys(ctx, u.id)));
    const s = await createSession(q, u.id, 'mfa', ctx.now);
    ctx.cookies.push(setCookie(COOKIE_PENDING, s.token, s.maxAgeSec));
    return { next: 'totp' };
  }],

  ['POST', '/api/auth/login/totp', { auth: 'none', sameOrigin: true }, async (q, ctx) => {
    const pending = await loadPending(q, ctx, ['mfa']);
    const [u] = await q.query("select * from users where id = $1 and status = 'active' for update", [pending.user_id]);
    if (!u) fail(401, INVALID_LOGIN);
    const keys = totpKeys(ctx, u.id);
    await enforceLimits(q, ctx, TOTP_LIMITS(keys));
    const step = verifyTotp(decryptTotp(u.totp_secret_enc, u.id), String(ctx.body.code || ''), u.totp_last_step);
    if (!step) {
      bumpPendingAttempts(ctx, pending);
      for (const k of keys) recordAttempt(ctx, k);
      audit(q, ctx, 'totp_failed', u.id);
      fail(401, 'Invalid code');
    }
    await q.query('update users set totp_last_step = $2 where id = $1', [u.id, step]);
    await q.query('delete from sessions where id_hash = $1', [pending.id_hash]);
    await clearAttempts(q, `login:u:${sha256(u.username)}`);
    await clearAttempts(q, keys[0]);
    const login = await startFullSession(q, ctx, u.id);
    audit(q, ctx, 'login_ok', u.id);
    return { username: u.username, ...login };
  }],

  ['POST', '/api/auth/logout', { auth: 'none', sameOrigin: true }, async (q, ctx) => {
    const token = parseCookies(ctx.headers.get('cookie'))[COOKIE_SESSION];
    if (token) await q.query('delete from sessions where id_hash = $1', [sha256(token)]);
    if (ctx.principal) audit(q, ctx, 'logout', ctx.principal.userId);
    ctx.cookies.push(clearCookie(COOKIE_SESSION), clearCookie(COOKIE_PENDING));
    return { ok: true };
  }],

  ['POST', '/api/auth/recover/start', { auth: 'none', sameOrigin: true }, async (q, ctx) => {
    const username = normUsername(ctx.body.username);
    const phrase = normPhrase(ctx.body.phrase);
    const keys = [`rec:u:${sha256(username)}`, `rec:ip:${ctx.ipHash}`];
    await enforceLimits(q, ctx, [[keys[0], 5, HOUR], [keys[1], 10, HOUR]]);
    const [u] = await q.query("select * from users where username = $1 and status = 'active'", [username]);
    const ok = u ? await verifySecret(u.recovery_hash, phrase) : await verifyDummy(phrase);
    if (!ok) {
      for (const k of keys) recordAttempt(ctx, k);
      audit(q, ctx, 'recover_failed', u?.id ?? null);
      fail(401, 'Invalid username or recovery phrase');
    }
    const password = await checkPasswordPolicy(ctx.body.newPassword, username);
    const secret = newTotpSecret();
    await q.query('update users set password_pending_hash = $2, totp_pending_enc = $3, updated_at = $4 where id = $1', [
      u.id, await hashSecret(password), encrypt(secret, `totp:${u.id}`), ctx.now,
    ]);
    const s = await createSession(q, u.id, 'recover', ctx.now);
    ctx.cookies.push(setCookie(COOKIE_PENDING, s.token, s.maxAgeSec));
    audit(q, ctx, 'recover_started', u.id);
    return totpEnrollment(secret, username);
  }],

  ['POST', '/api/auth/recover/confirm', { auth: 'none', sameOrigin: true }, async (q, ctx) => {
    const pending = await loadPending(q, ctx, ['recover']);
    const [u] = await q.query("select * from users where id = $1 and status = 'active' for update", [pending.user_id]);
    if (!u?.totp_pending_enc || !u.password_pending_hash) fail(401, 'Recovery expired: start again');
    const step = verifyTotp(decryptTotp(u.totp_pending_enc, u.id), String(ctx.body.code || ''));
    if (!step) {
      bumpPendingAttempts(ctx, pending);
      fail(400, 'Invalid code');
    }
    const phrase = generateMnemonic(wordlist, 128);
    await q.query(
      `update users set password_hash = password_pending_hash, password_pending_hash = null,
              totp_secret_enc = totp_pending_enc, totp_pending_enc = null, totp_last_step = $2,
              recovery_hash = $3, updated_at = $4 where id = $1`,
      [u.id, step, await hashSecret(phrase), ctx.now],
    );
    // A recovery means the old credentials may be compromised: end every session and revoke every token.
    await q.query('delete from sessions where user_id = $1', [u.id]);
    await q.query('update api_tokens set revoked_at = $2 where user_id = $1 and revoked_at is null', [u.id, ctx.now]);
    await q.query('update passkeys set revoked_at=$2 where user_id=$1 and revoked_at is null', [u.id, ctx.now]);
    await q.query("update devices set status='revoked',decided_at=$2 where user_id=$1", [u.id, ctx.now]);
    await q.query('delete from webauthn_challenges where user_id=$1', [u.id]);
    await clearAttempts(q, `rec:u:${sha256(u.username)}`);
    const login = await startFullSession(q, ctx, u.id);
    audit(q, ctx, 'recover_completed', u.id);
    return { username: u.username, recoveryPhrase: phrase, ...login };
  }],
];
