import { BlockList, isIP } from 'node:net';
import { fail, str } from './http.js';
import { audit } from './auth.js';
import { ORG_ID } from './permissions.js';

export function parseCidr(value) {
  const cidr = str(value, 'CIDR', { min: 1, max: 80 });
  const parts = cidr.split('/'), family = isIP(parts[0]);
  const prefix = parts.length === 1 ? (family === 4 ? 32 : 128) : Number(parts[1]);
  if (!family || cidr.includes('%') || parts.length > 2 || (parts.length === 2 && !/^\d{1,3}$/.test(parts[1])) || prefix > (family === 4 ? 32 : 128)) fail(400, 'Invalid IP range');
  return { address: parts[0], prefix, family: family === 4 ? 'ipv4' : 'ipv6', cidr: `${parts[0]}/${prefix}` };
}
export function allowsIp(rules, ip) {
  if (!rules.length) return true;
  const family = isIP(ip);
  if (!family) return false;
  const list = new BlockList();
  for (const rule of rules) { const r = parseCidr(typeof rule === 'string' ? rule : rule.cidr); list.addSubnet(r.address, r.prefix, r.family); }
  return list.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}
export async function enforceIpRules(q, ctx) {
  const target = ctx.principal?.type === 'claude' ? 'agents' : ctx.principal?.type === 'human' || ctx.path.startsWith('/api/auth/') ? 'humans' : null;
  if (!target) return;
  const rules = await q.query('select cidr from ip_rules where org_id=$1 and target=$2', [ORG_ID, target]);
  if (!allowsIp(rules, ctx.ip)) { audit(q, ctx, 'ip_access_denied', ctx.principal?.userId, { target }); fail(403, 'Access from this network is not allowed'); }
}
