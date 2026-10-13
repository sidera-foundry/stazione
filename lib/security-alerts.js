import { ORG_ID } from './permissions.js';
import { sendText } from './telegram.js';

const EVENTS = new Set(['role_created', 'role_changed', 'role_deleted', 'role_assigned', 'room_role_assigned', 'invite_created', 'invite_revoked', 'user_limit_changed', 'ip_rules_changed', 'session_closed', 'token_revoked', 'agent_stopped', 'admin_recovery', 'passkey_registered', 'passkey_revoked', 'device_approval_required', 'device_approved', 'device_revoked', 'security_policy_changed', 'admin_change_requested', 'admin_change_approved', 'admin_change_rejected']);
export async function securityAlert(q, ctx, event, detail, actor = ctx.principal?.userId || 'server-console') {
  await q.query('insert into security_alerts (org_id,event,actor,detail,at) values ($1,$2,$3,$4,$5)', [ORG_ID, event, actor, JSON.stringify(detail), ctx.now]);
  const [person] = await q.query('select username from users where id=$1', [actor]);
  const recipients = await q.query("select u.telegram_chat_id from users u join memberships m on m.user_id=u.id where m.org_id=$1 and m.role_id in ('owner','admin') and u.status='active' and u.telegram_chat_id is not null", [ORG_ID]);
  for (const u of recipients) ctx.after.push(() => sendText(u.telegram_chat_id, `Security alert: ${event}. By ${person?.username || 'Server console'}. Review the admin audit log.`));
}
EVENTS.add('model_check_configured');
export async function alertFromAudit(q, ctx, deferred) {
  for (const [sql, params] of deferred) {
    if (sql.startsWith('insert into audit_log') && EVENTS.has(params[1])) await securityAlert(q, ctx, params[1], params[2] ? JSON.parse(params[2]) : null);
    if (sql.startsWith('insert into audit_log') && params[1] === 'register_completed') {
      const detail = params[2] ? JSON.parse(params[2]) : {};
      if (['owner', 'admin'].includes(detail.role)) await securityAlert(q, ctx, 'privileged_account_created', detail, params[0]);
    }
  }
}
