import { db } from './db.js';
import { HttpError, fail, json } from './http.js';
import { hashIp, randomId, safeEqual, assertSecretsConfigured } from './crypto.js';
import { authenticate } from './auth.js';
import { loadAccess, need as needPermission } from './permissions.js';
import { sweepSecure } from './secure.js';
import { sweepSilent } from './silent.js';
import { sweepDigest } from './digest.js';
import { authRoutes } from './routes/auth.js';
import { accountRoutes, telegramRoutes } from './routes/account.js';
import { boardRoutes } from './routes/board.js';
import { logRoutes } from './routes/log.js';
import { askRoutes } from './routes/asks.js';
import { roomRoutes } from './routes/rooms.js';
import { journalRoutes } from './routes/journal.js';
import { pollRoutes } from './routes/polls.js';
import { peopleRoutes } from './routes/people.js';
import { inviteRoutes } from './routes/invites.js';
import { sanitizeContent } from './sanitize.js';
import { recordRequestContent, decorateContent } from './content.js';
import { scopeRequest } from './room-access.js';
import { adminRoutes } from './routes/admin.js';
import { requireAdmin, criticalAction, requireStepUp } from './admin.js';
import { enforceIpRules } from './ip-rules.js';
import { alertFromAudit } from './security-alerts.js';
import { receptionRoutes, snapshotContext } from './routes/reception.js';
import { sweepHeld } from './reception.js';
import { approvalRoutes } from './approval-rules.js';
import { capTokenPermissions, enforceTokenRequest } from './token-restrictions.js';
import { passkeyRoutes } from './passkeys.js';
import { deviceRoutes } from './devices.js';
import { queueAdminChange } from './admin-changes.js';
import { accountDeleteRoutes } from './account-delete.js';
import { moduleRoutes } from './routes/modules.js';
import { loadModules, enabledModules } from './modules.js';

const MAX_BODY = 64 * 1024;

const cronRoutes = [
  ['GET', '/api/cron/cleanup', { auth: 'none' }, async (q, ctx) => {
    const secret = process.env.CRON_SECRET;
    if (!secret || !safeEqual(ctx.headers.get('authorization') || '', `Bearer ${secret}`)) fail(404, 'Not found');
    const now = ctx.now;
    await q.query('delete from sessions where expires_at < $1', [now]);
    await q.query('delete from webauthn_challenges where expires_at <= $1', [now]);
    await q.query('delete from model_check_cache where expires_at <= $1',[now]);
    await q.query('delete from model_check_usage where at < $1',[now-30*86400e3]);
    await q.query("update admin_changes set status='expired',payload_enc=null where status='pending' and expires_at <= $1", [now]);
    await q.query('delete from auth_attempts where at < $1', [now - 86400e3]);
    const [org] = await q.query("select settings from orgs where id = 'default'");
    const retention = org?.settings?.auditRetentionDays;
    if (retention !== null) {
      const days = Number.isInteger(retention) && retention >= 90 ? retention : 365;
      await q.query('delete from audit_log where at < $1', [now - days * 86400e3]);
      await q.query('delete from security_alerts where at < $1', [now - days * 86400e3]);
    }
    await q.query('delete from telegram_codes where expires_at < $1', [now]);
    await q.query("delete from users where status = 'pending' and pending_expires_at < $1", [now]);
    await q.query('delete from api_tokens where (revoked_at is not null or expires_at < $1) and coalesce(revoked_at, expires_at) < $2', [now, now - 30 * 86400e3]);
    await q.query('delete from locks where expires_at < $1', [now - 86400e3]);
    await sweepSecure(q, now);
    return { ok: true };
  }],
];

// Compile ":param" patterns once. Core routes first; the routes of the modules are added after they load (cold
// start), and a module route that repeats a core route is dropped: modules never replace the core.
const compile = ([method, pattern, opts, handler]) => {
  const names = [];
  const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, n) => { names.push(n); return '([^/]+)'; })}$`);
  return { method, pattern, re, names, opts, handler };
};
const CORE = [...authRoutes, ...accountRoutes, ...telegramRoutes, ...boardRoutes, ...askRoutes, ...roomRoutes, ...journalRoutes, ...pollRoutes, ...peopleRoutes, ...inviteRoutes, ...adminRoutes, ...receptionRoutes, ...approvalRoutes, ...passkeyRoutes, ...deviceRoutes, ...accountDeleteRoutes, ...moduleRoutes, ...logRoutes, ...cronRoutes].map(compile);
let ROUTES = CORE, modulesReady = null;
function addModuleRoutes() {
  modulesReady ??= loadModules().then((reg) => {
    const taken = new Set(CORE.map((r) => `${r.method} ${r.pattern}`));
    const extra = reg.routes.filter(([method, pattern, opts]) => {
      if (!taken.has(`${method} ${pattern}`)) { taken.add(`${method} ${pattern}`); return true; }
      console.error(`module ${opts.module}: route ${method} ${pattern} is already taken, ignored`); return false;
    });
    ROUTES = [...CORE, ...extra.map(compile)];
  });
  return modulesReady;
}

function findRoute(method, path) {
  let pathMatched = false;
  for (const r of ROUTES) {
    const m = path.match(r.re);
    if (!m) continue;
    pathMatched = true;
    if (r.method !== method) continue;
    const params = {};
    r.names.forEach((n, i) => {
      try { params[n] = decodeURIComponent(m[i + 1]); } catch { fail(400, 'Invalid path'); }
    });
    return { route: r, params };
  }
  if (path.startsWith('/api/admin/')) fail(404, 'Not found');
  fail(pathMatched ? 405 : 404, pathMatched ? 'Method not allowed' : 'Not found');
}

async function readBody(request, path) {
  if (request.method === 'GET' || request.method === 'HEAD') return {};
  const len = Number(request.headers.get('content-length') || 0);
  if (len > MAX_BODY) fail(413, 'Request too large');
  const type = request.headers.get('content-type') || '';
  const text = await request.text();
  if (text.length > MAX_BODY) fail(413, 'Request too large');
  if (!text) return {};
  if (!type.toLowerCase().startsWith('application/json') && path !== '/api/telegram/webhook') fail(415, 'Content-Type: application/json is required');
  try {
    const body = JSON.parse(text);
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'The body must be a JSON object');
      return sanitizeContent(body);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    fail(400, 'Invalid JSON');
  }
}

function clientIp(headers) {
  return headers.get('x-real-ip') || (headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'local';
}

export async function handleRequest(request) {
  const requestId = randomId().slice(0, 8);
  let ctx = null;
  try {
    assertSecretsConfigured(); // fail closed if the deployment is missing its keys
    const url = new URL(request.url);
    await addModuleRoutes();
    const routed = url.searchParams.get('__route');
    const path = routed != null ? `/api/${routed.replace(/^\/+/, '')}`.replace(/\/+$/, '') : url.pathname.replace(/\/+$/, '');
    const { route, params } = findRoute(request.method, path);
    const deferred = [];
    ctx = {
      method: request.method,
      path,
      params,
      query: url.searchParams,
      headers: request.headers,
      body: route.opts.admin ? {} : await readBody(request, path),
      ip: clientIp(request.headers),
      now: Date.now(),
      origin: process.env.APP_ORIGIN || `${url.protocol}//${url.host}`,
      cookies: [],
      after: [],
      principal: null,
      status: 200,
      resolveRoute: findRoute,
      persist: (sql, p) => deferred.push([sql, p]),
    };
    ctx.ipHash = hashIp(ctx.ip);

    const database = await db();
    let result;
    let error = null;
    try {
      result = await database.tx(async (q) => {
        // A switched-off module's routes do not exist.
        if (route.opts.module && !(await enabledModules(q)).has(route.opts.module)) fail(404, 'Not found');
        ctx.principal = await authenticate(q, ctx);
        // Conceal console routes even when the caller's network would also be refused.
        if (route.opts.admin) {
          if (ctx.principal) Object.assign(ctx.principal, await loadAccess(q, ctx.principal.userId));
          if (ctx.principal?.type !== 'human' || !ctx.principal.permissions.has('admin.console')) fail(404, 'Not found');
        }
        await enforceIpRules(q, ctx);
        if (route.opts.admin) {
          await requireAdmin(q, ctx, route.pattern);
          ctx.body = await readBody(request, path);
        }
        const need = route.opts.auth;
        if (need !== 'none' && !ctx.principal) fail(401, 'Sign-in required');
        if (need === 'human' && ctx.principal.type !== 'human') fail(403, 'Only humans can do this, from the panel');
        if (need === 'claude' && ctx.principal.type !== 'claude') fail(403, 'Only agent instances can do this');
        // Role and permissions of the human (an agent acts with those of its human, never more).
        if (ctx.principal) Object.assign(ctx.principal, await loadAccess(q, ctx.principal.userId));
        if (ctx.principal) capTokenPermissions(ctx.principal);
        if (ctx.principal) await scopeRequest(q, ctx, route.pattern);
        if (ctx.principal) await enforceTokenRequest(q, ctx, route.pattern); // scopeRoom re-caps when it changes permissions
        if (route.opts.perm) needPermission(ctx, route.opts.perm);
        // CSRF: cookie-authenticated writes must come from our own origin.
        const cookieWrite = ctx.method !== 'GET' && ctx.principal?.type !== 'claude';
        if ((route.opts.sameOrigin || (cookieWrite && need !== 'none')) && request.headers.get('origin') !== ctx.origin) {
          fail(403, 'Request origin not allowed');
        }
        if (criticalAction(ctx.method, route.pattern)) await requireStepUp(q, ctx);
        await sweepHeld(q, ctx.now);
        if (ctx.method !== 'GET' && route.pattern === '/api/context/:project') await snapshotContext(q, ctx.params.project);
        const output = await queueAdminChange(q, ctx, route) || await route.handler(q, ctx);
        await alertFromAudit(q, ctx, deferred);
        if (route.opts.html) { ctx.html = true; return output; }
        if (route.opts.asset) { ctx.asset = output; return output; }
        await recordRequestContent(q, ctx, output);
        if (ctx.method !== 'GET' && route.pattern === '/api/context/:project') await snapshotContext(q, ctx.params.project);
        return decorateContent(q, ctx, output);
      });
    } catch (err) {
      error = err;
    }
    // Audit entries and rate-limit counters survive a rolled-back request.
    for (const [sql, p] of deferred) {
      try { await database.query(sql, p); } catch (e) { console.error(`[${requestId}] persist failed: ${e?.code || e?.name}`); }
    }
    if (error) throw error;
    for (const fn of ctx.after) {
      try { await fn(database); } catch (e) { console.error(`[${requestId}] after-commit task failed: ${e?.code || e?.name}`); }
    }
    try { await sweepSilent(database, ctx.now); } catch (e) { console.error(`[${requestId}] silent sweep failed: ${e?.code || e?.name}`); }
    try { await sweepDigest(database, ctx.now); } catch (e) { console.error(`[${requestId}] digest sweep failed: ${e?.code || e?.name}`); }
    if (ctx.asset) {
      const headers = json(200, {}).headers;
      headers.set('content-type', ctx.asset.type);
      headers.set('cache-control', 'no-cache'); // a module switched off or updated must not linger in the browser
      return new Response(ctx.asset.body, { status: 200, headers });
    }
    if (ctx.html) {
      const headers = json(200, {}).headers;
      headers.set('content-type', 'text/html; charset=utf-8');
      headers.set('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
      headers.set('x-frame-options', 'DENY');
      for (const cookie of ctx.cookies) headers.append('set-cookie', cookie);
      return new Response(result, { status: ctx.status, headers });
    }
    return json(ctx.status, result, ctx.cookies);
  } catch (err) {
    if (err instanceof HttpError) return json(err.status, { error: err.message, ...(err.extra || {}) }, ctx?.cookies || []);
    // Log enough to debug without leaking request data, secrets or stack contents to the client.
    console.error(`[${requestId}] ${err?.name || 'Error'} ${err?.code || ''}: ${String(err?.message || '').slice(0, 200)}`);
    return json(500, { error: 'Internal error. Try again shortly.', requestId });
  }
}
