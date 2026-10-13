import { fail } from './http.js';
import { enforceLimits, recordAttempt, audit } from './auth.js';

export const ADMIN_IDLE_MS = 15 * 60e3;
export const ADMIN_ABSOLUTE_MS = 8 * 3600e3;
export const STEP_UP_MS = 5 * 60e3;
export async function refreshStepUp(q, ctx) {
  await q.query(`update sessions set admin_until=$2,ip_hash=$3,admin_closed_at=null,
    admin_started_at=case when admin_closed_at is not null or admin_started_at is null or admin_started_at <= $4 or admin_last_seen <= $5 then $6 else admin_started_at end,
    admin_last_seen=$6 where id_hash=$1`, [ctx.principal.sessionHash, ctx.now + STEP_UP_MS, ctx.ipHash, ctx.now - ADMIN_ABSOLUTE_MS, ctx.now - ADMIN_IDLE_MS, ctx.now]);
  return { ok: true, confirmedUntil: ctx.now + STEP_UP_MS };
}

// The same protection covers aliases and the original panel endpoints.
export function criticalAction(method, pattern) {
  if (['GET', 'HEAD'].includes(method)) return false;
  const p = pattern.replace('/api/admin/', '/api/');
  return /^\/api\/(roles|people|invites|organization|ip-rules|sessions|reception)(\/|$)/.test(p) || p === '/api/context/:project/rollback' ||
    p === '/api/rooms/:id/visibility' || p === '/api/rooms/:id/approval-rule' || p === '/api/locks/release-human' ||
    p === '/api/claudes/:id/forget-human' || p === '/api/tokens' || p === '/api/tokens/:id' || /^\/api\/tokens\/[^/]+\/(revoke|stop)$/.test(p) ||
    p === '/api/security-policy' || p === '/api/model-check' || p === '/api/devices/:id/decide' || p === '/api/changes/:id/decide' ||
    p.startsWith('/api/passkeys/register/') || p === '/api/passkeys/:id' || p === '/api/devices/register';
}
export async function requireStepUp(q, ctx) {
  if (ctx.principal?.type !== 'human') return;
  const [s] = await q.query('select admin_until, ip_hash, admin_closed_at, admin_started_at, admin_last_seen from sessions where id_hash=$1', [ctx.principal.sessionHash]);
  if (!s || !s.admin_until || s.admin_until <= ctx.now || s.ip_hash !== ctx.ipHash || s.admin_closed_at ||
    (s.admin_started_at && (ctx.now - s.admin_started_at >= ADMIN_ABSOLUTE_MS || ctx.now - s.admin_last_seen >= ADMIN_IDLE_MS))) {
    audit(q, ctx, 'step_up_required', ctx.principal.userId);
    fail(403, 'Confirm your identity to continue', { code: 'step_up_required' });
  }
}
export async function requireAdmin(q, ctx) {
  if (ctx.principal?.type !== 'human' || !ctx.principal.permissions.has('admin.console')) fail(404, 'Not found');
  const [session] = await q.query('select * from sessions where id_hash = $1 for update', [ctx.principal.sessionHash]);
  if (!session || session.admin_closed_at || (session.admin_started_at &&
    (ctx.now - session.admin_started_at >= ADMIN_ABSOLUTE_MS || ctx.now - session.admin_last_seen >= ADMIN_IDLE_MS))) {
    fail(403, 'Admin session expired. Sign in again to continue.');
  }
  const key = `admin:${ctx.principal.userId}`;
  await enforceLimits(q, ctx, [[key, 60, 60e3]]); recordAttempt(ctx, key);
  await q.query('update sessions set admin_started_at = coalesce(admin_started_at, $2), admin_last_seen = $2 where id_hash = $1', [ctx.principal.sessionHash, ctx.now]);
}
