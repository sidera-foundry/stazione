// Local server access is required. Never expose this operation as an HTTP endpoint.
import { pathToFileURL } from 'node:url';
import { db } from '../lib/db.js';
import { randomId, randomToken, sha256 } from '../lib/crypto.js';
import { ORG_ID, ALL } from '../lib/permissions.js';
import { securityAlert } from '../lib/security-alerts.js';

export async function recoverAdmin(q, now = Date.now()) {
  const ctx = { now, after: [] };
  const result = await q.tx(async tx => {
    const [org] = await tx.query('select * from orgs where id=$1 for update', [ORG_ID]);
    const [owner] = await tx.query("select m.user_id from memberships m join users u on u.id=m.user_id where m.org_id=$1 and m.role_id='owner' and u.status='active' order by m.updated_at limit 1", [ORG_ID]);
    if (!org || !owner) throw new Error('An active owner is required; use the first-owner bootstrap for a new installation');
    const previous = await tx.query('select target,cidr from ip_rules where org_id=$1', [ORG_ID]);
    await tx.query('delete from ip_rules where org_id=$1', [ORG_ID]);
    const [occupied] = await tx.query("select count(*)::int as n from users where status='active' or (status='pending' and pending_expires_at>$1)", [now]);
    const oldLimit = Number(org.settings.userLimit || 2), limit = Math.max(oldLimit, occupied.n + 1);
    await tx.query("update orgs set settings=settings || $2::jsonb where id=$1", [ORG_ID, JSON.stringify({ userLimit: limit, requireKnownDevice: false, fourEyes: false })]);
    await tx.query("update admin_changes set status='expired',payload_enc=null where status='pending'");
    const id = randomId(), code = randomToken('sti_', 32), expiresAt = now + 3600e3;
    await tx.query(`insert into invites (id,org_id,code_hash,role_id,label,created_by,created_at,expires_at,grant_scope) values ($1,$2,$3,'owner','Emergency recovery',$4,$5,$6,$7)`, [id, ORG_ID, sha256(code), owner.user_id, now, expiresAt, JSON.stringify(ALL)]);
    const detail = JSON.stringify({ invite: id, allowedNetworksBefore: previous, userLimitBefore: oldLimit, userLimitAfter: limit, requireKnownDeviceBefore: Boolean(org.settings.requireKnownDevice), fourEyesBefore: Boolean(org.settings.fourEyes) });
    await tx.query("insert into audit_log (event,detail,at) values ('admin_recovery',$1,$2)", [detail, now]);
    await securityAlert(tx, ctx, 'admin_recovery', JSON.parse(detail));
    return { code, expiresAt };
  });
  for (const notify of ctx.after) await notify();
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv.includes('--confirm')) { console.error('Use --confirm to reset IP, registered-device and four-eyes requirements and create a one-time owner invite.'); process.exit(1); }
  try {
    const result = await recoverAdmin(await db());
    console.log('IP, registered-device and four-eyes requirements reset. One-time owner invite (expires in 1 hour):');
    console.log(result.code);
    console.log('Keep this code private. It grants owner access.');
    process.exit(0);
  } catch { console.error('Recovery failed. Check the server configuration and active owner.'); process.exit(1); }
}
