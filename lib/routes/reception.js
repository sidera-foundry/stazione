import { fail, str, strList } from '../http.js';
import { MODES, receptionPolicy, mayReview, heldPayload, decideHeld } from '../reception.js';
import { ORG_ID, need } from '../permissions.js';
import { requireRoom } from '../room-access.js';
import { audit } from '../auth.js';
import { recordContent } from '../content.js';
import { guardText } from './board.js';

const mode = value => { if (value != null && !MODES.includes(value)) fail(400, 'Invalid reception mode'); return value; };
export async function snapshotContext(q, project) {
  await q.query(`insert into context_versions (project,version,summary,updated_by,updated_at,source)
    select c.project,c.version,c.summary,c.updated_by,c.updated_at,a.source from contexts c left join content_annotations a on a.resource_key='context:' || c.project and a.field='summary'
    where c.project=$1 on conflict (project,version) do nothing`, [project]);
}
export const receptionRoutes = [
  ['GET', '/api/reception', { auth: 'human', perm: 'station.view' }, async q => ({
    organization: (await q.query('select reception_default as mode from orgs where id=$1', [ORG_ID]))[0],
    roles: await q.query('select id,name,reception_default as mode from roles'),
  })],
  ['PUT', '/api/reception/organization', { auth: 'human', perm: 'admin.security' }, async (q, ctx) => {
    const value = mode(ctx.body.mode); if (!value) fail(400, 'Choose a reception mode');
    await q.query('update orgs set reception_default=$2 where id=$1', [ORG_ID, value]); audit(q, ctx, 'reception_changed', ctx.principal.userId, { organization: ORG_ID, mode: value }); return { ok: true };
  }],
  ['PUT', '/api/reception/roles/:id', { auth: 'human', perm: 'admin.roles' }, async (q, ctx) => {
    if (['owner','admin'].includes(ctx.params.id) && ctx.principal.role !== 'owner') fail(403, 'Only an owner can change this role');
    if (!(await q.query('update roles set reception_default=$2 where id=$1 and org_id=$3 returning id', [ctx.params.id, mode(ctx.body.mode), ORG_ID])).length) fail(404, 'Role not found');
    audit(q, ctx, 'reception_changed', ctx.principal.userId, { role: ctx.params.id, mode: ctx.body.mode }); return { ok: true };
  }],
  ['PUT', '/api/reception/rooms/:id', { auth: 'human' }, async (q, ctx) => {
    await requireRoom(q, ctx, ctx.params.id); need(ctx, 'claudes.reception');
    await q.query('update rooms set reception_default=$2 where id=$1', [ctx.params.id, mode(ctx.body.mode)]);
    audit(q, ctx, 'reception_changed', ctx.principal.userId, { room: ctx.params.id, mode: ctx.body.mode }); return { ok: true };
  }],
  ['PUT', '/api/reception/agents/:id', { auth: 'human' }, async (q, ctx) => {
    const [agent] = await q.query('select * from claudes where id=$1 for update', [ctx.params.id]); if (!agent) fail(404, 'Agent not found');
    if (agent.room) await requireRoom(q, ctx, agent.room);
    const policy = await receptionPolicy(q, agent), next = mode(ctx.body.mode), manager = ctx.principal.permissions.has('claudes.reception');
    if (!manager) {
      if (agent.owner_id !== ctx.principal.userId || !ctx.principal.permissions.has('claudes.tokens')) fail(403, 'Your role does not allow this');
      if (!next || MODES.indexOf(next) < MODES.indexOf(policy.mode) || MODES.indexOf(next) < MODES.indexOf(policy.baseline) || ctx.body.trustedSenders != null) fail(403, 'You can only make reception stricter');
    }
    let trusted = agent.trusted_senders;
    if (ctx.body.trustedSenders != null) {
      trusted = [];
      for (const sender of strList(ctx.body.trustedSenders, 'trusted senders', { maxItems: 50, maxLen: 150 })) {
        const [type, ...parts] = sender.replace(/^agent:/, 'claude:').split(':');
        const id = parts.at(-1);
        const [person] = type === 'human' ? await q.query('select id as owner_id from users where id=$1', [id]) : type === 'claude' ? await q.query('select owner_id from claudes where id=$1', [id]) : [];
        if (!person || (parts.length > 1 && parts[0] !== person.owner_id)) fail(400, 'Trusted sender not found');
        // Bind trust to the human as well as the agent id, which can be forgotten and reused.
        trusted.push(`${type}:${person.owner_id}:${id}`);
      }
    }
    await q.query('update claudes set reception_mode=$2,trusted_senders=$3 where id=$1', [agent.id, next, JSON.stringify(trusted)]);
    audit(q, ctx, 'reception_changed', ctx.principal.userId, { agent: agent.id, mode: next }); return { ok: true };
  }],
  ['POST', '/api/reception/agents/:id/stop', { auth: 'human' }, async (q, ctx) => {
    const organizationRole = ctx.principal.role;
    const [agent] = await q.query('select * from claudes where id=$1 for update', [ctx.params.id]); if (!agent) fail(404, 'Agent not found');
    if (agent.room) await requireRoom(q, ctx, agent.room); need(ctx, 'claudes.manage');
    const [membership] = await q.query('select role_id from memberships where user_id=$1', [agent.owner_id]);
    if (membership?.role_id === 'owner' && organizationRole !== 'owner') fail(403, 'Only an owner can stop an owner agent');
    // Sessions created before token association was introduced: fail safe by suspending all of that human's tokens.
    await q.query('update api_tokens set suspended_at=$2 where user_id=$1 and ($3::text is null or id=$3)', [agent.owner_id, ctx.now, agent.token_id]);
    await q.query("update claudes set status='offline' where id=$1 or token_id=$2 or ($2::text is null and owner_id=$3)", [agent.id, agent.token_id, agent.owner_id]);
    await q.query('delete from locks where owner_claude in (select id from claudes where id=$1 or token_id=$2 or ($2::text is null and owner_id=$3))', [agent.id, agent.token_id, agent.owner_id]);
    audit(q, ctx, 'agent_stopped', ctx.principal.userId, { agent: agent.id, token: agent.token_id, allOwnerTokens: !agent.token_id }); return { ok: true };
  }],
  ['GET', '/api/held', { auth: 'human', perm: 'station.view' }, async (q, ctx) => {
    const items = []; for (const item of await q.query("select * from held_items where org_id=$1 order by (status in ('pending','quarantined')) desc,created_at desc limit 300", [ORG_ID])) {
      if (await mayReview(q, ctx.principal.userId, item)) { const { payload_enc, revision, ...safe } = item; items.push({ ...safe, payload: heldPayload(item) }); }
    } return { items };
  }],
  ['POST', '/api/held/decide', { auth: 'human', perm: 'station.view' }, async (q, ctx) => {
    const ids = strList(ctx.body.ids, 'ids', { maxItems: 50, maxLen: 40 }); if (!ids.length) fail(400, 'Select content to review');
    const note = guardText(str(ctx.body.note, 'note', { max: 500 }), 'note');
    for (const id of new Set(ids)) await decideHeld(q, ctx, id, ctx.body.decision, ctx.principal.userId, note);
    return { ok: true };
  }],
  ['GET', '/api/context/:project/versions', { auth: 'human', perm: 'station.view' }, async (q, ctx) => {
    await snapshotContext(q, ctx.params.project);
    return { versions: await q.query('select project,version,summary,updated_by,updated_at from context_versions where project=$1 order by version desc limit 100', [ctx.params.project]) };
  }],
  ['POST', '/api/context/:project/rollback', { auth: 'human', perm: 'rooms.context' }, async (q, ctx) => {
    const [current] = await q.query('select * from contexts where project=$1 for update', [ctx.params.project]);
    const [old] = await q.query('select * from context_versions where project=$1 and version=$2', [ctx.params.project, ctx.body.version]);
    if (!current || !old) fail(404, 'Context version not found');
    await snapshotContext(q, ctx.params.project);
    await q.query('update contexts set summary=$2,version=version+1,updated_by=$3,updated_at=$4 where project=$1', [current.project, old.summary, `human:${ctx.principal.username}`, ctx.now]);
    await recordContent(q, ctx, 'context', current.project, { summary: old.summary }); await snapshotContext(q, current.project);
    audit(q, ctx, 'context_restored', ctx.principal.userId, { project: current.project, from: current.version, restored: old.version }); return { ok: true };
  }],
];
