// Durable per-field author snapshots survive forgetting an astronaut or reusing its id.
import { detectInjection } from './injection.js';
import { sanitizeContent, TEXT_FIELDS } from './sanitize.js';
import { filterReception } from './reception.js';
import { sha256 } from './crypto.js';

export async function recordContent(q, ctx, kind, id, fields, actor = null) {
  const p = ctx.principal;
  const source = actor ?? (p ? { type: p.type, id: p.type === 'human' ? p.userId : ctx.body?.as, owner: p.userId } : null);
  for (const [field, value] of Object.entries(fields)) {
    if (value == null || !TEXT_FIELDS.has(field)) continue;
    const findings = detectInjection(typeof value === 'string' ? value : JSON.stringify(value));
    await q.query(`insert into content_annotations (resource_key, field, source, findings, updated_at)
      values ($1, $2, $3, $4, $5) on conflict (resource_key, field)
      do update set source = excluded.source, findings = excluded.findings, updated_at = excluded.updated_at`,
    [`${kind}:${id}`, field, JSON.stringify(source ?? { type: 'unknown' }), JSON.stringify(findings), ctx.now]);
  }
}

/** Only successfully authorised writes are recorded, inside the same transaction as the content. */
export async function recordRequestContent(q, ctx, result) {
  const b = ctx.body, path = ctx.path, p = ctx.principal;
  if (!p || ctx.method === 'GET') return;
  let kind, id, fields;
  if (path === '/api/messages') {
    kind = 'message'; id = result.id;
    if (id == null && result.secureId) id = (await q.query('select message_id from secure_items where id = $1', [result.secureId]))[0]?.message_id;
    fields = { text: b.text };
  }
  else if (path === '/api/tasks' || /^\/api\/tasks\/[^/]+$/.test(path)) { kind = 'task'; id = result.id ?? ctx.params.id; fields = b; }
  else if (path === '/api/recaps') { kind = 'recap'; id = result.id; fields = { title: b.title, body: b.text }; }
  else if (path === '/api/decisions') { kind = 'decision'; id = result.id; fields = b; }
  else if (path.startsWith('/api/context/')) { kind = 'context'; id = ctx.params.project; fields = b; }
  else if (path === '/api/polls') { kind = 'poll'; id = result.id; fields = { question: b.text, options: b.options }; }
  else if (/^\/api\/polls\/[^/]+\/vote$/.test(path)) { kind = 'vote'; id = `${ctx.params.id}/${p.type === 'human' ? `human:${p.username}` : b.as}`; fields = { reason: b.reason }; }
  else if (path === '/api/claudes/heartbeat') { kind = 'claude'; id = result.id; fields = b; }
  else if (/^\/api\/rooms\/[^/]+\/project$/.test(path)) { kind = 'room'; id = ctx.params.id; fields = b; }
  else if (path === '/api/asks') { kind = 'ask'; id = result.id; fields = b; }
  else if (/^\/api\/asks\/[^/]+$/.test(path)) { kind = 'ask'; id = ctx.params.id; fields = { answer: b.answer }; }
  if (id != null) await recordContent(q, ctx, kind, id, fields,
    kind === 'claude' ? { type: 'claude', id: result.id, owner: p.userId } : null);
}

const keyOf = (v) => {
  if (v.type === 'mission' && v.id) return `task:${v.id}`;
  if (['recap','decision'].includes(v.type) && v.id != null) return `${v.type}:${v.id}`;
  if (v.from && v.text != null && v.id != null) return `message:${v.id}`;
  if (v.title != null && v.resources && v.id) return `task:${v.id}`;
  if (v.question != null && v.id) return `poll:${v.id}`;
  if (v.title != null && v.body != null && v.id != null) return `recap:${v.id}`;
  if (v.text != null && v.by && v.id != null) return `decision:${v.id}`;
  if (v.summary != null && v.project) return `context:${v.project}`;
  if (v.activity != null && v.id) return `claude:${v.id}`;
  if (v.goal != null && v.milestones && v.id) return `room:${v.id}`;
  if (v.text != null && v.claude && v.id) return `ask:${v.id}`;
  return null;
};

export function trustLevel(source, userId) {
  if (source?.type === 'human') return source.owner === userId ? 'own-human' : 'human';
  if (source?.type === 'claude') return source.owner === userId ? 'own-claude' : 'claude';
  return 'unknown'; // legacy/generated content without an author snapshot is never elevated to an instruction
}

/** Add metadata without changing the API's readable fields (the CLI separates those fields on output). */
export async function decorateContent(q, ctx, raw) {
  const result = sanitizeContent(raw), targets = [];
  let secureKey = null;
  if (result?.text != null && /^\/api\/secure\/[^/]+$/.test(ctx.path)) {
    const [item] = await q.query('select message_id from secure_items where id = $1', [ctx.params.id]);
    if (item) secureKey = `message:${item.message_id}`;
  }
  const visit = (v, inheritedKey = null, scope = {}) => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) { v.forEach((x) => visit(x, inheritedKey, scope)); return; }
    const routing = { room: (typeof v.room === 'object' ? v.room?.id : v.room) || scope.room,
      project: v.project || v.room?.project || scope.project };
    const key = keyOf(v) ?? (v === result ? secureKey : null) ?? (v.voter && inheritedKey?.startsWith('poll:') ? `vote:${inheritedKey.slice(5)}/${v.voter}` : null) ??
      (ctx.principal?.type === 'claude' && ctx.method === 'GET' ? `view:${ctx.path}:${v.id ?? v.at ?? v.sha ?? sha256(JSON.stringify(v))}` : null);
    const fields = Object.keys(v).filter((f) => TEXT_FIELDS.has(f) && v[f] != null);
    if (key && fields.length) targets.push({ v, key, fields, routing });
    for (const [field, x] of Object.entries(v)) visit(x, field === 'ballots' ? key : null, routing);
  };
  visit(result);
  if (!targets.length) return result;
  const rows = await q.query('select resource_key, field, source, findings from content_annotations where resource_key = any($1::text[])', [[...new Set(targets.map((t) => t.key))]]);
  const byField = new Map(rows.map((r) => [`${r.resource_key}/${r.field}`, r]));
  for (const { v, key, fields } of targets) {
    v.content = { untrusted: true, fields: {} };
    for (const field of fields) {
      const journalField = ctx.path === '/api/journal' ? (v.type === 'recap' && field === 'text' ? 'body' : v.type === 'mission' && field === 'text' ? 'note' : v.type === 'decision' && field === 'title' ? 'text' : field) : field;
      const annotation = byField.get(`${key}/${journalField}`), source = annotation?.source ?? { type: 'unknown' };
      v.content.fields[field] = { source, trustLevel: trustLevel(source, ctx.principal?.userId),
        findings: annotation?.findings ?? detectInjection(typeof v[field] === 'string' ? v[field] : JSON.stringify(v[field])) };
    }
  }
  await filterReception(q, ctx, targets);
  return result;
}
