import { fail, str, oneOf } from './http.js';
import { randomId, sha256, encrypt, decrypt } from './crypto.js';
import { ORG_ID, loadAccess, need } from './permissions.js';
import { scopeRequest } from './room-access.js';
import { audit } from './auth.js';
import { parseCidr, allowsIp } from './ip-rules.js';

const WINDOW_MS = 30 * 60e3;
const normalized = pattern => pattern.replace('/api/admin/', '/api/');
const list = value => Array.isArray(value) ? value : [];
const administrative = permissions => list(permissions).some(p => typeof p === 'string' && (p.startsWith('admin.') || p === 'people.manage'));
const broaderNetworks = (before, after) => before.length > 0 && (!after.length || after.some(cidr => {
  const next = parseCidr(cidr);
  return !before.some(old => { const prev = parseCidr(old); return prev.family === next.family && next.prefix >= prev.prefix && allowsIp([old], next.address); });
}));
async function heavyChange(q, ctx, pattern) {
  const p = normalized(pattern), b = ctx.body;
  if (/^\/api\/people\/:id\/(role|rooms\/:room\/role)$/.test(p) || p === '/api/invites') {
    const ids = [b.role, ...list(b.roomRoles).map(r => r?.role)].filter(v => typeof v === 'string');
    for (const id of ids) {
      const [role] = await q.query('select permissions from roles where id=$1', [id]);
      if (['admin','owner'].includes(id) || administrative(role?.permissions || [])) return 'Grant administrative privileges';
    }
  }
  if (p === '/api/people/:id/delete') return 'Delete an account';
  if (p === '/api/roles/:id' || p === '/api/roles') {
    const [old] = await q.query('select permissions from roles where id=$1', [ctx.params.id || '']);
    if (administrative(list(b.permissions).filter(v => !(old?.permissions || []).includes(v)))) return 'Grant administrative privileges';
  }
  if (p === '/api/ip-rules') {
    const old = await q.query('select target,cidr from ip_rules where org_id=$1', [ORG_ID]);
    if (['humans','agents'].some(target => broaderNetworks(old.filter(r => r.target === target).map(r => r.cidr), list(b[target])))) return 'Relax allowed networks';
  }
  if (p === '/api/rooms/:id/visibility' && b.visibility === 'open') {
    const [old] = await q.query('select visibility from rooms where id=$1', [ctx.params.id]);
    if (old?.visibility === 'restricted') return 'Open a restricted room';
  }
  if ((p === '/api/organization/approval-rule' || p === '/api/rooms/:id/approval-rule') && b.rule !== 'two') return 'Change approval safeguards';
  if (p.startsWith('/api/reception/') && ctx.method === 'PUT' && (b.mode !== 'manual' || b.trustedSenders?.length)) return 'Change reception safeguards';
  if (p === '/api/tokens/:id' && ctx.method === 'PUT') {
    const [token] = await q.query('select restrictions from api_tokens where id=$1', [ctx.params.id]);
    const before = token?.restrictions || {}, after = b.restrictions || {};
    if (['readOnly','noPolls','noContext'].some(k => before[k] && !after[k]) || (before.rooms != null && (after.rooms == null || list(after.rooms).some(r => !before.rooms.includes(r)))) || broaderNetworks(before.ips || [], list(after.ips))) return 'Relax token restrictions';
  }
  if (p === '/api/security-policy') {
    const [org] = await q.query('select settings from orgs where id=$1', [ORG_ID]);
    if ((org.settings.fourEyes && b.fourEyes === false) || (org.settings.requireKnownDevice && b.requireKnownDevice === false)) return 'Relax sign-in safeguards';
  }
  if (p === '/api/model-check') {
    const [org] = await q.query('select settings from orgs where id=$1',[ORG_ID]);
    const old = org.settings.modelCheck || {};
    if ((b.enabled === true && !old.enabled) || (old.enabled && (b.enabled === false || b.removeKey === true || b.apiKey || b.dailyLimit > old.dailyLimit))) return 'Change model check safeguards';
  }
  return null;
}
async function stateHash(q) {
  const rows = [];
  for (const sql of [
    'select settings,approval_default,reception_default from orgs order by id',
    'select id,permissions,reception_default from roles order by id',
    'select user_id,role_id from memberships order by user_id',
    'select id,status from users order by id',
    'select user_id,room_id,role_id from room_roles order by user_id,room_id',
    'select id,visibility,approval_rule,reception_default from rooms order by id',
    'select target,cidr from ip_rules order by target,cidr',
    'select id,restrictions,revoked_at,suspended_at,expires_at from api_tokens order by id',
    'select id,owner_id,reception_mode,trusted_senders from claudes order by id',
  ]) rows.push(await q.query(sql));
  return sha256(JSON.stringify(rows));
}
async function validateOnly(q, ctx, route) {
  await q.query('savepoint validate_admin_change');
  const shadow = { ...ctx, principal: { ...ctx.principal, permissions: new Set(ctx.principal.permissions) }, after: [], cookies: [], persist: () => {}, body: structuredClone(ctx.body) };
  try { await route.handler(q, shadow); }
  finally { await q.query('rollback to savepoint validate_admin_change'); await q.query('release savepoint validate_admin_change'); }
}
export async function queueAdminChange(q, ctx, route) {
  if (ctx.principal?.type !== 'human' || ['GET','HEAD'].includes(ctx.method) || normalized(route.pattern) === '/api/changes/:id/decide') return null;
  const [org] = await q.query('select settings from orgs where id=$1 for update', [ORG_ID]);
  if (!org.settings.fourEyes) return null;
  const title = await heavyChange(q, ctx, route.pattern);
  if (!title) return null;
  Object.assign(ctx.principal, await loadAccess(q, ctx.principal.userId));
  await scopeRequest(q, ctx, route.pattern); if (route.opts.perm) need(ctx, route.opts.perm);
  await validateOnly(q, ctx, route);
  const id = randomId(), payload = { method: ctx.method, path: ctx.path, body: ctx.body, query: [...ctx.query], sessionHash: ctx.principal.sessionHash };
  await q.query('insert into admin_changes (id,org_id,created_by,title,payload_enc,state_hash,created_at,expires_at) values ($1,$2,$3,$4,$5,$6,$7,$8)', [id, ORG_ID, ctx.principal.userId, title, encrypt(JSON.stringify(payload), `admin-change:${id}`), await stateHash(q), ctx.now, ctx.now + WINDOW_MS]);
  audit(q, ctx, 'admin_change_requested', ctx.principal.userId, { id, title });
  ctx.status = 202;
  return { status: 'pending_approval', changeId: id, expiresAt: ctx.now + WINDOW_MS, message: 'Waiting for a second administrator. No change has been applied.' };
}
export async function decideAdminChange(q, ctx) {
  const decision = oneOf(ctx.body.decision, 'decision', ['approve','reject']);
  // Use the same lock order as submissions so the fingerprint and execution
  // cannot race another administrative write.
  const [org] = await q.query('select settings from orgs where id=$1 for update', [ORG_ID]);
  const [change] = await q.query('select * from admin_changes where id=$1 for update', [str(ctx.params.id, 'change', { min: 1, max: 60 })]);
  if (!change || change.status !== 'pending') fail(404, 'Pending change not found');
  if (change.expires_at <= ctx.now) fail(410, 'Change expired. Submit a new request.');
  if (!['owner','admin'].includes(ctx.principal.role)) fail(403, 'An owner or administrator must review this change');
  if (decision === 'reject') {
    await q.query("update admin_changes set status='rejected',payload_enc=null,decided_by=$2,decided_at=$3 where id=$1", [change.id, ctx.principal.userId, ctx.now]);
    audit(q, ctx, 'admin_change_rejected', ctx.principal.userId, { id: change.id }); return { ok: true, status: 'rejected' };
  }
  if (change.created_by === ctx.principal.userId) fail(409, 'A different administrator must approve this change');
  if (await stateHash(q) !== change.state_hash) fail(409, 'Security settings changed. Reject this request and submit it again.');
  const payload = JSON.parse(decrypt(change.payload_enc, `admin-change:${change.id}`));
  const [proposer] = await q.query("select u.username from users u join sessions s on s.user_id=u.id left join devices d on d.id=s.device_id and d.user_id=u.id where u.id=$1 and u.status='active' and s.id_hash=$2 and s.kind='session' and s.expires_at>$3 and s.last_seen>$4 and (not $5::boolean or (d.status='approved' and d.expires_at>$3))", [change.created_by, payload.sessionHash, ctx.now, ctx.now - 12 * 3600e3, Boolean(org.settings.requireKnownDevice)]);
  if (!proposer) fail(409, 'The requesting administrator must sign in and submit a new request');
  const { route, params } = ctx.resolveRoute(payload.method, payload.path);
  const review = { ...ctx, method: payload.method, path: payload.path, params, body: payload.body, query: new URLSearchParams(payload.query), principal: { ...ctx.principal, ...(await loadAccess(q, ctx.principal.userId)) } };
  await scopeRequest(q, review, route.pattern); if (route.opts.perm) need(review, route.opts.perm);
  const execution = { ...review, principal: { type: 'human', userId: change.created_by, username: proposer.username, sessionHash: payload.sessionHash, ...(await loadAccess(q, change.created_by)) } };
  // An administrator may countersign an owner's grant, but cannot initiate one.
  // Scope and permissions were checked for both people; the owner's handler still
  // checks the target, grant ceiling and last-owner protection at execution time.
  const ownerInitiated = execution.principal.role === 'owner' && (['Grant administrative privileges', 'Delete an account'].includes(change.title) || normalized(route.pattern) === '/api/model-check');
  if (ownerInitiated) {
    // Waive only the owner's initiation restriction for this dry run. Preserve
    // the reviewer's real permission set, so grant ceilings and invitation/room
    // permissions still apply. This context is never used to execute a change.
    await validateOnly(q, { ...review, principal: { ...review.principal, role: 'owner' } }, route);
  } else await validateOnly(q, review, route);
  await scopeRequest(q, execution, route.pattern); if (route.opts.perm) need(execution, route.opts.perm);
  const result = await route.handler(q, execution);
  await q.query("update admin_changes set status='approved',payload_enc=null,decided_by=$2,decided_at=$3 where id=$1", [change.id, ctx.principal.userId, ctx.now]);
  audit(q, ctx, 'admin_change_approved', ctx.principal.userId, { id: change.id, requestedBy: change.created_by });
  return { ok: true, status: 'approved', result };
}
export function describeChange(row) {
  if (row.status !== 'pending' || !row.payload_enc) return null;
  const payload = JSON.parse(decrypt(row.payload_enc, `admin-change:${row.id}`));
  // Only the fields used by the covered security operations can be shown.
  const settings = Object.fromEntries(Object.entries(payload.body).filter(([key]) => ['role','roomRoles','name','permissions','humans','agents','visibility','rule','mode','trustedSenders','restrictions','fourEyes','requireKnownDevice','hours','label','enabled','dailyLimit','removeKey'].includes(key)));
  if (payload.body.apiKey) settings.keyChanged = true;
  return { method: payload.method, path: payload.path, settings };
}
