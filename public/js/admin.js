import { $, el, api, say, __, can, locale } from './common.js';
import { renderHeld } from './reception.js';
import { restrictionEditor } from './token-restrictions.js';

let me, roles = [], rooms = [], people = [], lastInvite = null;
const panels = new Map();
// The console is long: its panels are grouped in sections shown one at a time, like the station's own tabs.
const GROUPS = [['overview', __('Overview')], ['people', __('People')], ['rooms', __('Rooms')], ['agents', __('Agents')], ['modules', __('Modules')], ['security', __('Security')], ['log', __('Log')]];
const groups = new Map();
let nav;
function setupNav() {
  nav = el('nav', 'views admin-tabs'); nav.setAttribute('aria-label', __('Sections'));
  for (const [id, label] of GROUPS) {
    const b = el('button', null, label); b.type = 'button'; b.dataset.group = id; b.addEventListener('click', () => showGroup(id)); nav.append(b);
    const group = el('div', 'admin-group'); group.dataset.group = id; group.hidden = true; groups.set(id, group);
  }
  $('adminContent').before(nav); $('adminContent').append(...groups.values());
}
function showGroup(id) {
  if (!groups.has(id) || !groups.get(id).children.length) id = 'overview';
  for (const [g, node] of groups) node.hidden = g !== id;
  nav.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.group === id));
  history.replaceState(null, '', `#${id}`);
}
function badge(group, n) {
  const b = nav?.querySelector(`button[data-group="${group}"]`); if (!b) return;
  b.querySelector('.badge')?.remove(); if (n > 0) b.append(el('span', 'badge', String(n)));
}
const AGENT_STATUS = { working: 'Working', idle: 'Idle', comms: 'Talking with others', offline: 'Offline', blocked: 'Blocked' };
const TASK_STATUS = { open: 'Free, nobody on it', claimed: 'In progress', blocked: 'Blocked', done: 'Done' };
const word = (map, value) => map[value] ? __(map[value]) : value;
// Audit events in plain words; unknown ones show their technical name.
const EVENTS = {
  login_ok: 'Signed in', login_failed: 'Failed sign-in', logout: 'Signed out', totp_failed: 'Wrong authenticator code',
  passkey_login: 'Signed in with a passkey', passkey_failed: 'Failed passkey', passkey_registered: 'Passkey added', passkey_revoked: 'Passkey removed',
  step_up_required: 'Identity confirmation asked', step_up_confirmed: 'Identity confirmed', step_up_failed: 'Identity confirmation failed',
  session_closed: 'Session closed', rate_limited: 'Too many attempts, slowed down', ip_access_denied: 'Blocked by network rules',
  register_started: 'Registration started', register_completed: 'Registration completed', register_closed: 'Registration refused: station full', register_bad_invite: 'Registration with an invalid invite',
  recover_started: 'Account recovery started', recover_completed: 'Account recovered', recover_failed: 'Account recovery failed',
  invite_created: 'Invite created', invite_revoked: 'Invite revoked', role_assigned: 'Role changed for a person', room_role_assigned: 'Room role changed for a person',
  role_created: 'Role created', role_changed: 'Role edited', role_deleted: 'Role deleted', account_deleted: 'Account deleted', account_delete_failed: 'Account deletion failed',
  token_created: 'Agent token created', token_revoked: 'Agent token revoked', token_restrictions_changed: 'Agent token limits changed', agent_stopped: 'Agent stopped',
  device_registered: 'Browser registered', device_approval_required: 'Browser waiting for approval',
  room_visibility_changed: 'Room visibility changed', reception_changed: 'Reception mode changed', approval_rule_changed: 'Approval rule changed',
  security_policy_changed: 'Security safeguards changed', ip_rules_changed: 'Allowed networks changed', user_limit_changed: 'User limit changed',
  admin_change_requested: 'Change sent for a second approval', admin_change_approved: 'Change approved by a second administrator', admin_change_rejected: 'Change rejected',
  ask_decided: 'Drastic action approved or refused', approval_vote: 'Vote on an approval', secure_decided: 'Protected data decided', secure_read: 'Protected data read', secure_inspected: 'Protected data inspected',
  content_held: 'Content held for review', held_content_reviewed: 'Held content reviewed', context_restored: 'Project context restored',
  module_changed: 'Module switched on or off', module_settings_changed: 'Module settings changed',
  idea_category_created: 'Idea category created', idea_category_changed: 'Idea category changed', telegram_linked: 'Telegram linked', telegram_unlinked: 'Telegram unlinked',
};
const eventLabel = (e) => EVENTS[e] ? __(EVENTS[e]) : e;
const detailText = (d) => !d || !Object.keys(d).length ? '—' : Object.entries(d).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ');
const date = (t) => t ? new Date(Number(t)).toLocaleString(locale) : '—';
const option = (value, text) => { const o = el('option', null, text); o.value = value; return o; };
const select = (items, selected) => { const s = el('select'); s.append(...items.map(([v, t]) => option(v, t))); if (selected != null) s.value = selected; return s; };
const field = (name, input) => { const l = el('label', 'field', name); l.append(input); return l; };
const input = (type = 'text', value = '') => { const i = el('input'); i.type = type; i.value = value; return i; };
const button = (text, action, danger = false) => { const b = el('button', danger ? 'danger' : 'ghost', text); b.type = 'button'; b.addEventListener('click', () => act(action)); return b; };
async function act(fn) {
  say($('adminMsg'), '');
  try { await fn(); if (panels.has('alerts')) await alertsPanel(); } catch (err) {
    say($('adminMsg'), err.message, 'err');
    // A 404 is often routine (a change expired, someone deleted it first): clear the console only if the admin
    // session itself is gone, which the server also answers with 404.
    if (err.status === 404) try { await api('GET', '/api/admin/session'); } catch (e) { if ([401, 403, 404].includes(e.status)) $('adminContent').replaceChildren(); }
  }
  if (panels.has('changes')) try { await changesPanel(); } catch { /* Existing error remains visible. */ }
}
function panel(id, title, group, wide = false, intro = '') {
  const section = el('section', wide ? 'panel wide' : 'panel'); section.append(el('h2', null, title));
  if (intro) section.append(el('p', 'panel-intro', intro));
  const body = el('div', 'panel-body'); section.append(body); groups.get(group).append(section); panels.set(id, body);
  nav.querySelector(`button[data-group="${group}"]`).hidden = false; return body;
}
function table(headings, rows) {
  const t = el('table', 'admin-table'), head = el('thead'), body = el('tbody'), tr = el('tr');
  tr.append(...headings.map((h) => el('th', null, h))); head.append(tr);
  for (const cells of rows) { const row = el('tr'); for (const value of cells) { const cell = el('td'); cell.append(value instanceof Node ? value : document.createTextNode(String(value ?? '—'))); row.append(cell); } body.append(row); }
  t.append(head, body); return t;
}
const roleOptions = () => roles.map((r) => [r.id, r.name]);

async function overview() {
  const data = await api('GET', '/api/admin/overview'); rooms = data.rooms;
  const target = panels.get('overview'); target.replaceChildren();
  const stats = el('div', 'admin-stats'), stat = (n, label) => { const s = el('div', 'admin-stat'); s.append(el('b', null, String(n)), el('span', null, label)); return s; };
  const online = data.claudes.filter((c) => c.status !== 'offline' && Date.now() - c.last_seen < 10 * 60e3).length;
  stats.append(stat(rooms.length, __('Rooms')), stat(`${online}/${data.claudes.length}`, __('Agents online')), stat(data.tasks.length, __('Open missions')), stat(data.locks.length, __('Locked files')));
  target.append(stats);
  if (panels.has('rooms')) roomsPanel();
  const stop = (c) => button(__('Stop agent'), async () => { if (confirm(__('Stop this agent and suspend its token? Sessions sharing the token will also stop.'))) { await api('POST', `/api/reception/agents/${c.id}/stop`, {}); await overview(); } }, true);
  const manage = can(me, 'claudes.manage');
  target.append(el('h3', null, __('Agents')), table([__('Name'), __('Owner'), __('Room'), __('Status'), ...(manage ? [__('Actions')] : [])], data.claudes.map((c) => [c.name, people.find((p) => p.id === c.owner_id)?.username || c.owner_id, rooms.find((r) => r.id === c.room)?.name || '—', word(AGENT_STATUS, c.status), ...(manage ? [stop(c)] : [])])));
  if (manage) target.append(el('p', 'meta', __('Stop agent suspends that agent’s token at once: it can no longer act on the station until its owner creates a new token.')));
  target.append(el('h3', null, __('Open missions')), table([__('Mission'), __('Room'), __('Status')], data.tasks.map((t) => [t.title, t.project, word(TASK_STATUS, t.status)])));
  target.append(el('h3', null, __('Locked files')), el('p', 'meta', __('Files and resources an agent is changing right now: the others leave them alone until the lock is released or expires.')),
    table([__('Room'), __('File or resource'), __('Agent'), __('Lock expires')], data.locks.map((l) => [l.project, l.resource, l.owner_claude, date(l.expires_at)])));
}
function roomsPanel() {
  const target = panels.get('rooms'); target.replaceChildren();
  target.append(table([__('Room'), __('Visibility'), __('Actions')], rooms.map((r) => {
    const visibility = select([['open', __('Open: everyone sees it')], ['restricted', __('Restricted: only the people assigned to it')]], r.visibility);
    const action = button(__('Save visibility'), async () => { await api('PUT', `/api/admin/rooms/${r.id}/visibility`, { visibility: visibility.value }); await overview(); });
    visibility.disabled = !can(me, 'admin.security') || r.kind === 'bridge'; action.disabled = visibility.disabled;
    return [r.kind === 'bridge' ? `${r.name} (${__('always open')})` : r.name, visibility, action];
  })));
}
const modeChoices = [['', __('Inherit')], ['manual', __('Manual')], ['automatic', __('Automatic')], ['unrestricted', __('Unrestricted')]];
// Reception: the organization default, then only the exceptions that are set (a role, a room or an agent with
// its own mode), a form to add one, and the trusted senders picked from lists instead of typed codes.
async function receptionPanel() {
  const [settings, overview] = await Promise.all([api('GET', '/api/reception'), api('GET', '/api/admin/overview')]), target = panels.get('reception'); target.replaceChildren();
  const modeName = (m) => modeChoices.find(([v]) => v === m)?.[1] || m;
  const save = async (path, mode, extra = {}) => { await api('PUT', path, { mode, ...extra }); await receptionPanel(); };
  if (can(me, 'admin.security')) {
    const choice = select(modeChoices.slice(1), settings.organization.mode || 'manual'), row = el('div', 'stack');
    row.append(field(__('Default for the whole station'), choice), button(__('Save mode'), () => save('/api/reception/organization', choice.value)));
    target.append(row);
  }
  // Every place that may carry its own mode, with the permission needed to change it.
  const targets = [
    ...(can(me, 'admin.roles') ? settings.roles.map((r) => ({ kind: __('Role'), name: r.name, mode: r.mode, path: `/api/reception/roles/${r.id}` })) : []),
    ...(can(me, 'claudes.reception') ? overview.rooms.map((r) => ({ kind: __('Room'), name: r.name, mode: r.receptionDefault, path: `/api/reception/rooms/${r.id}` })) : []),
    ...(can(me, 'claudes.reception') ? overview.claudes.map((c) => ({ kind: __('Agent'), name: c.name, mode: c.reception_mode, path: `/api/reception/agents/${c.id}`, agent: c })) : []),
  ];
  const set = targets.filter((t) => t.mode), unset = targets.filter((t) => !t.mode);
  target.append(el('h3', null, __('Exceptions')));
  if (!set.length) target.append(el('p', 'meta', __('No exceptions: every agent follows the default above.')));
  else target.append(table([__('Where'), __('Mode'), __('Actions')], set.map((t) => {
    const choice = select(modeChoices.slice(1), t.mode), controls = el('div');
    // An agent keeps its trusted senders when its mode changes.
    const extra = t.agent ? { trustedSenders: t.agent.trusted_senders || [] } : {};
    controls.append(choice, button(__('Save mode'), () => save(t.path, choice.value, extra)), button(__('Remove exception'), () => save(t.path, null, extra)));
    return [`${t.kind}: ${t.name}`, modeName(t.mode), controls];
  })));
  if (unset.length) {
    const where = select(unset.map((t, i) => [String(i), `${t.kind}: ${t.name}`])), mode = select(modeChoices.slice(1), 'manual'), row = el('div', 'stack');
    row.append(field(__('Where'), where), field(__('Mode'), mode), button(__('Add exception'), () => {
      const t = unset[Number(where.value)]; save(t.path, mode.value, t.agent ? { trustedSenders: t.agent.trusted_senders || [] } : {});
    }));
    target.append(row);
  }
  if (can(me, 'claudes.reception') && overview.claudes.length) trustedSenders(target, overview.claudes);
}
// Trusted senders: messages from them always reach that agent, whatever its mode. Stored as "type:owner:id".
function trustedSenders(target, agents) {
  const label = (s) => { const [type, , id] = s.split(':'); return type === 'human' ? __`person ${people.find((p) => p.id === id)?.username || id}` : __`agent ${id}`; };
  const candidates = [...people.map((p) => [`human:${p.id}:${p.id}`, __`person ${p.username}`]), ...agents.map((c) => [`claude:${c.owner_id}:${c.id}`, __`agent ${c.name} (${c.id})`])];
  const box = el('details', 'trusted-senders');
  box.append(el('summary', null, __('Trusted senders')), el('p', 'meta', __('Messages from a trusted sender always reach that agent, even when its reception would hold them. Use it for people and agents you fully trust.')));
  const send = (c, list) => act(async () => { await api('PUT', `/api/reception/agents/${c.id}`, { mode: c.reception_mode || null, trustedSenders: list }); await receptionPanel(); });
  for (const c of agents) {
    const list = c.trusted_senders || [], row = el('div', 'trusted-row');
    row.append(el('b', null, c.name));
    for (const s of list) { const chip = el('span', 'chip'); chip.append(label(s), ' '); const x = el('button', 'ghost', '×'); x.type = 'button'; x.title = __('Remove'); x.addEventListener('click', () => send(c, list.filter((v) => v !== s))); chip.append(x); row.append(chip); }
    const pick = select([['', __('Add a trusted sender…')], ...candidates.filter(([v]) => !list.includes(v) && v !== `claude:${c.owner_id}:${c.id}`)]);
    pick.addEventListener('change', () => { if (pick.value) send(c, [...list, pick.value]); });
    row.append(pick); box.append(row);
  }
  target.append(box);
}
async function heldPanel() {
  await renderHeld(panels.get('held'));
}
async function historyPanel() {
  const target = panels.get('history'), choices = select(rooms.map(r => [r.project, r.name])), content = el('div');
  const show = async () => { const project = choices.value, data = await api('GET', `/api/context/${encodeURIComponent(project)}/versions`); content.replaceChildren(table([__('Version'), __('Preview'), __('Actions')], data.versions.map(v => [v.version, el('pre', null, v.summary), button(__('Restore this version'), async () => { if (confirm(__('Restore this context version?'))) { await api('POST', `/api/context/${encodeURIComponent(project)}/rollback`, { version: v.version }); await show(); } })]))); };
  choices.addEventListener('change', () => act(show)); target.append(field(__('Room'), choices), content); if (rooms.length) await show();
}

// One block per person: the role that counts everywhere, then (folded) the rooms where a different role applies.
// Deleting an account sits apart, at the bottom of the block.
async function loadPeople() {
  people = (await api('GET', '/api/admin/people')).people;
  const roleName = (id) => roles.find((r) => r.id === id)?.name || id;
  const blocks = people.map((p) => {
    const box = el('div', 'person-block'), locked = p.role === 'owner' && me.role !== 'owner';
    const head = el('div', 'person-head'); head.append(el('b', null, p.username));
    const role = select(roleOptions(), p.role), saveRole = button(__('Save role'), async () => { await api('PUT', `/api/admin/people/${p.id}/role`, { role: role.value }); await loadPeople(); await loadRoles(); });
    head.append(field(__('Role in the whole station'), role), saveRole);
    box.append(head);
    // Room exceptions: the set ones are listed, the others can be added.
    const exceptions = p.roomRoles.filter((a) => rooms.some((r) => r.id === a.room));
    const details = el('details', 'room-exceptions');
    details.append(el('summary', null, exceptions.length === 1 ? __('Different role in 1 room') : exceptions.length ? __`Different role in ${exceptions.length} rooms` : __('Same role in every room')));
    details.append(el('p', 'meta', __('A room role replaces the role above, only inside that room. Example: Member everywhere, Project lead in Checkout.')));
    for (const a of exceptions) {
      const room = rooms.find((r) => r.id === a.room), local = select(roleOptions(), a.role), row = el('div', 'stack');
      row.append(field(room.name, local),
        button(__('Save room role'), async () => { await api('PUT', `/api/admin/people/${p.id}/rooms/${room.id}/role`, { role: local.value }); await loadPeople(); }),
        button(__('Remove exception'), async () => { await api('PUT', `/api/admin/people/${p.id}/rooms/${room.id}/role`, { role: null }); await loadPeople(); }));
      details.append(row);
    }
    const free = rooms.filter((r) => !exceptions.some((a) => a.room === r.id));
    if (free.length) {
      const room = select(free.map((r) => [r.id, r.name])), local = select(roleOptions(), p.role), row = el('div', 'stack');
      row.append(field(__('Room'), room), field(__('Role in that room'), local),
        button(__('Add exception'), async () => { await api('PUT', `/api/admin/people/${p.id}/rooms/${room.value}/role`, { role: local.value }); await loadPeople(); }));
      details.append(el('h3', null, __('Add a room exception')), row);
    }
    box.append(details);
    if (exceptions.length) box.append(el('p', 'meta', exceptions.map((a) => `${rooms.find((r) => r.id === a.room).name}: ${roleName(a.role)}`).join(' · ')));
    if (locked) box.querySelectorAll('button,select').forEach((c) => { c.disabled = true; });
    if (me.role === 'owner' && p.id !== me.userId) {
      const danger = el('div', 'danger-zone');
      danger.append(button(__('Delete account'), async () => {
        if (!confirm(__`Delete the account of ${p.username} for good? Their tokens, passkeys and astronauts go too. This cannot be undone.`)) return;
        const r = await api('POST', `/api/admin/people/${encodeURIComponent(p.id)}/delete`, {});
        if (r.status === 'pending_approval') say($('adminMsg'), __(r.message), 'good');
        await loadPeople(); if (panels.has('changes')) await changesPanel();
      }, true), el('span', 'meta', __('Removes the account, its tokens and its agents for good.')));
      box.append(danger);
    }
    return box;
  });
  panels.get('people').replaceChildren(...blocks);
}

// Permissions grouped by what they are about, so a role reads as a short list of topics.
const PERMISSION_GROUPS = [
  ['Basics', ['station.view', 'messages.send']],
  ['Missions', ['missions.create', 'missions.work', 'missions.assign', 'missions.manage']],
  ['Rooms', ['rooms.create', 'rooms.merge', 'rooms.project', 'rooms.context']],
  ['Agents', ['claudes.tokens', 'claudes.manage', 'claudes.reception']],
  ['Approvals', ['approvals.own', 'approvals.room']],
  ['Polls', ['polls.open', 'polls.vote', 'polls.decide']],
  ['Ideas', ['ideas.use', 'ideas.manage']],
  ['People', ['people.invite', 'people.manage']],
  ['Administration', ['admin.console', 'admin.roles', 'admin.security', 'admin.audit']],
];
function permissionFields(selected = []) {
  const fields = el('div', 'perm-groups'), checks = new Map(), byId = new Map(me.catalog.map((p) => [p.id, p]));
  const grouped = new Set(PERMISSION_GROUPS.flatMap(([, ids]) => ids));
  const groups = [...PERMISSION_GROUPS, ['Other', me.catalog.map((p) => p.id).filter((id) => !grouped.has(id))]];
  for (const [title, ids] of groups) {
    const list = ids.filter((id) => byId.has(id)); if (!list.length) continue;
    const box = el('fieldset', 'perm-group'); box.append(el('legend', null, __(title)));
    for (const id of list) {
      const c = input('checkbox'); c.checked = selected.includes(id); c.disabled = !can(me, id) && !c.checked; checks.set(id, c);
      const l = el('label', 'check'); l.append(c, el('span', null, __(byId.get(id).label))); box.append(l);
    }
    fields.append(box);
  }
  return { fields, values: () => [...checks].filter(([, c]) => c.checked).map(([id]) => id) };
}
async function loadRoles() {
  const data = await api('GET', '/api/admin/roles'); roles = data.roles; me.catalog = data.permissions;
  const target = panels.get('roles'); target.replaceChildren();
  for (const r of roles) {
    const details = el('details'); details.append(el('summary', null, `${r.name}${r.builtin ? ` · ${__('Built-in')}` : ''} · ${r.members === 1 ? __('1 person') : __`${r.members} people`} · ${__`${r.permissions.length} permissions`}`));
    if (r.id === 'owner') details.append(el('p', 'meta', __('The owner always has every permission and cannot be changed.')));
    const name = input('text', r.name), permissions = permissionFields(r.permissions);
    details.append(field(__('Name'), name), permissions.fields);
    const save = button(__('Save this role'), async () => { await api('PUT', `/api/admin/roles/${r.id}`, { name: name.value, permissions: permissions.values() }); await loadRoles(); });
    save.disabled = !can(me, 'admin.roles') || r.id === 'owner' || (r.id === 'admin' && me.role !== 'owner');
    details.append(save);
    if (!r.builtin && can(me, 'admin.roles')) details.append(button(__('Delete this role'), async () => { if (confirm(__('Delete this role?'))) { await api('DELETE', `/api/admin/roles/${r.id}`); await loadRoles(); } }, true));
    target.append(details);
  }
  if (can(me, 'admin.roles')) {
    const box = el('details', 'new-role'), form = el('form', 'stack'), name = input(), permissions = permissionFields(); name.required = true; name.maxLength = 40;
    box.append(el('summary', null, __('New role')), form);
    const submit = el('button', null, __('Create role')); submit.type = 'submit';
    form.append(field(__('Role name'), name), permissions.fields, submit);
    form.addEventListener('submit', (e) => { e.preventDefault(); act(async () => { await api('POST', '/api/admin/roles', { name: name.value, permissions: permissions.values() }); await loadRoles(); }); }); target.append(box);
  }
  if (panels.has('people')) await loadPeople();
}

async function loadInvites() {
  const target = panels.get('invites'); target.replaceChildren();
  const { invites } = await api('GET', '/api/admin/invites');
  target.append(table([__('Who it is for'), __('Role'), __('Expires'), __('Status'), __('Actions')], invites.map((i) => [i.label, roles.find((r) => r.id === i.role)?.name || '—', date(i.expiresAt), i.revokedAt ? __('Revoked') : i.usedAt ? __('Used') : i.expiresAt < Date.now() ? __('Expired') : __('Available'), button(__('Revoke invite'), async () => { await api('POST', `/api/admin/invites/${i.id}/revoke`, {}); await loadInvites(); }, true)])));
  const form = el('form', 'stack'), role = select(roleOptions(), 'member'), label = input(), hours = input('number', '48'); hours.min = 1; hours.max = 720;
  label.placeholder = __('e.g. Mario, new designer'); label.maxLength = 80;
  const roomAssignments = el('details', 'invite-advanced'), assignmentSelects = new Map();
  roomAssignments.append(el('summary', null, __('Advanced: a different role in some rooms')));
  for (const r of rooms.filter((r) => r.kind !== 'bridge')) { const s = select([['', __('Same role as above')], ...roleOptions()]); assignmentSelects.set(r.id, s); roomAssignments.append(field(r.name, s)); }
  const submit = el('button', null, __('Create invite')); submit.type = 'submit';
  const code = el('pre', 'secret-box'); code.hidden = !lastInvite;
  if (lastInvite) code.textContent = `${__('Save this invite now. It is shown only once.')}\n${lastInvite.code}\n${new URL(lastInvite.link, location.origin)}`;
  form.append(field(__('Role the person will have'), role), field(__('Who is it for (only you see this)'), label), field(__('Valid for (hours)'), hours), roomAssignments, submit);
  form.addEventListener('submit', (e) => { e.preventDefault(); act(async () => {
    const roomRoles = [...assignmentSelects].filter(([, s]) => s.value).map(([room, s]) => ({ room, role: s.value }));
    const r = await api('POST', '/api/admin/invites', { role: role.value, label: label.value, hours: Number(hours.value), roomRoles });
    lastInvite = r; await loadInvites();
  }); }); target.append(form, code);
}

async function loadTokens() {
  const { tokens } = await api('GET', '/api/admin/tokens');
  panels.get('tokens').replaceChildren(table([__('Name'), __('Owner'), __('Last used'), __('Expires'), __('Actions')], tokens.map((t) => {
    const action = button(t.revoked_at ? __('Revoked') : __('Revoke token'), async () => { if (confirm(__('Revoke this token?'))) { await api('POST', `/api/admin/tokens/${t.id}/revoke`, {}); await loadTokens(); } }, true); action.disabled = Boolean(t.revoked_at);
    const controls = el('div'), details = el('details'), editor = restrictionEditor(rooms, t.restrictions);
    details.append(el('summary', null, __('Token limits')), editor.element, button(__('Save limits'), async () => { await api('PUT', `/api/admin/tokens/${t.id}`, { restrictions: editor.value() }); await loadTokens(); }));
    if (t.revoked_at) details.querySelectorAll('input,select,textarea,button').forEach(c => { c.disabled = true; });
    controls.append(details, action);
    return [t.name, t.username, date(t.last_used_at), date(t.expires_at), controls];
  })));
}
async function approvalRulesPanel() {
  const data = await api('GET', '/api/approval-rules'), target = panels.get('approvalRules'); target.replaceChildren();
  const rules = [['owner', __('Agent owner')], ['room', __('Room approver')], ['two', __('Two distinct approvers')]];
  const control = (name, value, path, inherited) => {
    const choice = select(inherited ? [['', __('Inherit')], ...rules] : rules, value || ''), row = el('div', 'stack');
    row.append(field(name, choice), button(__('Save rule'), async () => { await api('PUT', path, { rule: choice.value || null }); await approvalRulesPanel(); })); target.append(row);
  };
  const explain = el('ul', 'rule-list');
  for (const [name, text] of [[__('Agent owner'), __('the person who owns the agent decides.')], [__('Room approver'), __('the people with the right to approve in that room decide (for example its project lead).')],
    [__('Two distinct approvers'), __('two different people must both say yes; one no stops the request at once.')]]) { const li = el('li'); li.append(el('b', null, name), ': ', text); explain.append(li); }
  target.append(explain, el('p', 'meta', __('Set the default for the whole station; a room can follow it (Inherit) or use its own rule.')));
  control(__('Default for the whole station'), data.organization.rule, '/api/organization/approval-rule', false);
  for (const room of data.rooms) control(room.name, room.rule, `/api/rooms/${room.id}/approval-rule`, true);
}
async function security() {
  const org = await api('GET', '/api/admin/organization'), limit = input('number', String(org.userLimit)); limit.min = org.occupiedSeats; limit.max = 99999;
  const form = el('form', 'stack'), submit = el('button', null, __('Save user limit')); submit.type = 'submit'; submit.disabled = !can(me, 'admin.security');
  form.append(field(__('Maximum number of accounts'), limit), el('p', 'meta', __`${org.occupiedSeats} occupied seats`), submit);
  form.addEventListener('submit', (e) => { e.preventDefault(); act(async () => { await api('PUT', '/api/admin/organization/user-limit', { limit: Number(limit.value) }); await security(); }); });
  panels.get('security').replaceChildren(el('h3', null, __('Accounts')), el('p', 'meta', __('New registrations stop when the station is full. It cannot go below the accounts that already exist.')), form);
  if (can(me, 'admin.security')) {
    const data = await api('GET', '/api/admin/ip-rules');
    const networks = el('form', 'stack'), humans = el('textarea'), agents = el('textarea');
    for (const [target, area] of [['humans', humans], ['agents', agents]]) { area.rows = 4; area.value = data.rules.filter(r => r.target === target).map(r => r.cidr).join('\n'); }
    networks.append(field(__('Allowed networks for people'), humans), field(__('Allowed networks for agents'), agents), el('p', 'meta', __('One IPv4 or IPv6 range per line (for example 192.168.1.0/24). Leave empty to allow every network. Your current address must remain allowed.')));
    const save = el('button', null, __('Save networks')); save.type = 'submit'; networks.append(save);
    networks.addEventListener('submit', e => { e.preventDefault(); act(async () => { const ranges = area => area.value.split('\n').map(v => v.trim()).filter(Boolean); await api('PUT', '/api/admin/ip-rules', { humans: ranges(humans), agents: ranges(agents) }); await security(); }); });
    panels.get('security').append(el('h3', null, __('Allowed networks')), el('p', 'meta', __('Limit from where people and agents can reach the station, for example only the office network or a VPN. Anyone outside is refused.')), networks);
    const policy = await api('GET', '/api/admin/security-policy'), known = input('checkbox'), fourEyes = input('checkbox');
    known.checked = policy.requireKnownDevice; fourEyes.checked = policy.fourEyes;
    const safeguards = el('div', 'stack');
    safeguards.append(field(__('Require approved browsers'), known), el('p', 'meta', __('Only browsers an administrator has approved can sign in: a stolen password alone is not enough.')),
      field(__('Require a second administrator for sensitive changes'), fourEyes), el('p', 'meta', __('Four eyes: changes that loosen security (giving admin rights, deleting accounts, opening restricted rooms, relaxing networks, tokens or safeguards) wait until a second administrator approves them.')),
      el('p', 'meta', __('Approve your current browser and an owner browser first. Double approval requires two active administrators with security and people management permissions.')), button(__('Save safeguards'), async () => { await api('PUT', '/api/admin/security-policy', { requireKnownDevice: known.checked, fourEyes: fourEyes.checked }); await security(); }));
    panels.get('security').append(el('h3', null, __('Extra safeguards')), safeguards);
  }
}
async function modelCheckPanel() {
  const config = await api('GET','/api/admin/model-check'), target = panels.get('modelCheck'); target.replaceChildren();
  const enabled = input('checkbox'), key = input('password'), limit = input('number',String(config.dailyLimit)), consent = input('checkbox');
  enabled.checked = config.enabled; key.autocomplete = 'off'; key.maxLength = 256; limit.min = 1; limit.max = 1000;
  target.append(el('p','meta',__('Optional extra check for automatic reception. Text is sent to an external model using your organization’s account, with usage costs charged to you. Local rules remain active if the model is unavailable.')),
    el('p','meta',config.keySet ? __('API key saved. It cannot be displayed again.') : __('No API key saved.')),
    el('p','meta',__`${config.callsToday} model calls today`));
  if (me.role !== 'owner') { target.append(el('p','meta',__('Only the owner can configure this check.'))); return; }
  const form = el('form','stack'), save = el('button',null,__('Save model check')); save.type = 'submit';
  form.append(field(__('Enable model check'),enabled),field(__('New API key (leave empty to keep the saved key)'),key),field(__('Daily call limit'),limit),field(__('I authorize external text processing and the related usage costs.'),consent),save);
  form.addEventListener('submit',e => { e.preventDefault(); act(async () => {
    const body = { enabled:enabled.checked,dailyLimit:Number(limit.value),acknowledgeExternalProcessing:consent.checked }; if (key.value) body.apiKey = key.value;
    try { await api('PUT','/api/admin/model-check',body); await modelCheckPanel(); } finally { key.value = ''; }
  }); });
  target.append(form,button(__('Remove model key'),async () => { if (confirm(__('Remove the saved API key and disable the model check?'))) { await api('PUT','/api/admin/model-check',{enabled:false,removeKey:true,dailyLimit:config.dailyLimit}); await modelCheckPanel(); } },true));
}
// Modules: the optional parts of the station. Switching one is a sensitive action (confirmed, logged); a module that
// failed to load stays off. Settings are the ones the module declares in its module.json.
async function modulesPanel() {
  const { modules } = await api('GET', '/api/admin/modules'), target = panels.get('modules'); target.replaceChildren();
  if (!modules.length) { target.append(el('p', 'meta', __('No modules installed.'))); return; }
  for (const m of modules) {
    const box = el('div', `module-block${m.enabled ? ' on' : ''}`), head = el('div', 'module-head');
    head.append(el('b', null, __(m.name)), el('span', `chip ${m.enabled ? 'ok' : 'dim'}`, m.enabled ? __('On') : __('Off')),
      el('span', 'chip dim', m.builtin ? __('Built-in module') : __('Your team')));
    if (m.broken) head.append(el('span', 'chip bad', __('Failed to load: see the server log')));
    box.append(head, el('p', 'meta', __(m.description)));
    const toggle = button(m.enabled ? __('Switch off') : __('Switch on'), async () => {
      if (!m.enabled && !m.builtin && !confirm(__('This module was added by your team: it runs on the server with the same trust as the station. Switch it on?'))) return;
      await api('PUT', `/api/admin/modules/${encodeURIComponent(m.id)}`, { enabled: !m.enabled });
      say($('adminMsg'), __('Saved. Reload the station page to see the change.'), 'good');
      await modulesPanel();
    }, m.enabled);
    toggle.disabled = m.broken && !m.enabled;
    box.append(toggle);
    if (m.settings.length) {
      const details = el('details', 'module-settings'), fields = new Map();
      details.append(el('summary', null, __('Settings')));
      for (const st of m.settings) {
        const value = m.values[st.key];
        let control;
        if (st.type === 'bool') { control = input('checkbox'); control.checked = Boolean(value); }
        else if (st.type === 'list') { control = el('textarea'); control.rows = 4; control.value = (value || []).join('\n'); }
        else { control = input('text', value || ''); control.maxLength = 500; }
        fields.set(st.key, [st, control]); details.append(field(__(st.label), control));
      }
      details.append(button(__('Save settings'), async () => {
        const settings = Object.fromEntries([...fields].map(([key, [st, c]]) => [key, st.type === 'bool' ? c.checked : st.type === 'list' ? c.value.split('\n').map((v) => v.trim()).filter(Boolean) : c.value]));
        await api('PUT', `/api/admin/modules/${encodeURIComponent(m.id)}/settings`, { settings });
        say($('adminMsg'), __('Saved.'), 'good'); await modulesPanel();
      }));
      box.append(details);
    }
    target.append(box);
  }
}
async function credentialsPanel() {
  const [browsers, keys] = await Promise.all([api('GET', '/api/admin/devices'), api('GET', '/api/admin/passkeys')]), target = panels.get('credentials');
  target.replaceChildren(el('p', 'meta', __('Add your own passkey and register this browser in Account.')));
  const account = el('a', 'links', 'Account'); account.href = '/account'; target.append(account);
  target.append(table([__('Person'), __('Registered browsers'), __('Status'), __('Expires'), __('Actions')], browsers.devices.map(d => {
    const controls = el('div'), expired = d.expires_at <= Date.now(), protectedOwner = d.role === 'owner' && me.role !== 'owner';
    if (d.status !== 'revoked' && !expired) {
      if (d.status === 'pending') { const approve = button(__('Approve browser'), async () => { await api('POST', `/api/admin/devices/${d.id}/decide`, { approve: true }); await credentialsPanel(); }); approve.disabled = protectedOwner; controls.append(approve); }
      const revoke = button(__('Revoke browser'), async () => { if (confirm(__('Revoke this browser and close its sessions?'))) { await api('POST', `/api/admin/devices/${d.id}/decide`, { approve: false }); await credentialsPanel(); } }, true); revoke.disabled = protectedOwner; controls.append(revoke);
    }
    return [d.username, d.name, expired ? __('expired') : __(d.status), date(d.expires_at), controls];
  })));
  target.append(el('h3', null, __('Passkeys')), table([__('Person'), __('Name'), __('Last used'), __('Actions')], keys.passkeys.map(k => {
    const revoke = button(__('Revoke passkey'), async () => { if (confirm(__('Revoke this passkey?'))) { await api('DELETE', `/api/admin/passkeys/${k.id}`); await credentialsPanel(); } }, true); revoke.disabled = k.role === 'owner' && me.role !== 'owner'; return [k.username, k.name, date(k.last_used_at), revoke];
  })));
}
async function changesPanel() {
  const { changes } = await api('GET', '/api/admin/changes'), target = panels.get('changes');
  badge('security', changes.filter((c) => c.status === 'pending').length);
  target.replaceChildren(el('p', 'meta', __('Requests expire after 30 minutes. Changing the security settings cancels the earlier requests.')));
  target.append(table([__('Person'), __('Change'), __('Status'), __('Expires'), __('Actions')], changes.map(c => {
    const controls = el('div');
    if (c.status === 'pending') for (const decision of ['approve', 'reject']) {
      const b = button(decision === 'approve' ? __('Approve change') : __('Reject change'), async () => {
        const r = await api('POST', `/api/admin/changes/${c.id}/decide`, { decision });
        if (r.result?.code) { lastInvite = r.result; if (panels.has('invites')) await loadInvites(); }
        await changesPanel();
        if (r.status === 'approved' && !r.result?.code) location.reload();
      }, decision === 'reject'); b.disabled = decision === 'approve' && c.created_by === me.userId; controls.append(b);
    }
    if (c.status === 'pending' && c.created_by === me.userId) controls.append(el('p', 'meta', __('You asked for this change: another administrator has to approve it.')));
    const description = el('div'); description.append(el('span', null, __(c.title)));
    if (c.proposal) {
      const person = people.find(p => c.proposal.path.includes(`/people/${encodeURIComponent(p.id)}/`));
      const role = roles.find(r => r.id === c.proposal.settings.role);
      const room = rooms.find(r => c.proposal.path.includes(`/rooms/${encodeURIComponent(r.id)}/`));
      const names = [person?.username, role?.name, room?.name].filter(Boolean);
      if (names.length) description.append(el('p', 'meta', names.join(' · ')));
      const settings = Object.entries(c.proposal.settings || {}).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
      if (settings.length) description.append(el('p', 'meta', settings.join(' · ')));
      const tech = el('details', 'tech'); tech.append(el('summary', null, __('Technical details')), el('pre', 'meta', `${c.proposal.method} ${c.proposal.path}\n${JSON.stringify(c.proposal.settings, null, 2)}`));
      description.append(tech);
    }
    return [c.username, description, __(c.status), date(c.expires_at), controls];
  })));
}
async function sessionsPanel() {
  const data = await api('GET', '/api/admin/sessions');
  panels.get('sessions').replaceChildren(table([__('Person'), __('Created'), __('Last used'), __('Expires'), __('Actions')], data.sessions.map(s => {
    const close = button(__('Close this session'), async () => { if (confirm(__('Close this sign-in session?'))) { await api('POST', `/api/admin/sessions/${s.id}/close`, {}); if (s.current) location.replace('/login'); else await sessionsPanel(); } }, true);
    close.disabled = s.role === 'owner' && me.role !== 'owner';
    return [s.username + (s.current ? ` (${__('Current session')})` : ''), date(s.created_at), date(s.last_seen), date(s.expires_at), close];
  })));
}
async function alertsPanel() {
  const data = await api('GET', '/api/admin/alerts');
  badge('log', data.alerts.filter((a) => Date.now() - a.at < 86400e3).length);
  panels.get('alerts').replaceChildren(table([__('Event'), __('Person'), __('When')], data.alerts.map(a => [eventLabel(a.event), people.find(p => p.id === a.actor)?.username || a.actor, date(a.at)])));
}
function auditPanel() {
  const target = panels.get('audit'), form = el('form', 'stack'), event = select([['', __('All events')], ...Object.keys(EVENTS).map((e) => [e, eventLabel(e)]).sort((a, b) => a[1].localeCompare(b[1]))]), person = select([['', __('Everyone')], ...people.map((p) => [p.id, p.username])]);
  const from = input('date'), to = input('date'), submit = el('button', null, __('Apply filters')); submit.type = 'submit';
  const list = el('div'), more = el('button', 'ghost', __('Load older events')); more.type = 'button'; more.hidden = true;
  const download = el('button', 'ghost', __('Export loaded events (JSON)')); download.type = 'button';
  let entries = [], before = null;
  async function load(append = false) {
    const p = new URLSearchParams(); if (event.value) p.set('event', event.value); if (person.value) p.set('user', person.value);
    if (from.value) p.set('from', String(Date.parse(`${from.value}T00:00:00`))); if (to.value) p.set('to', String(Date.parse(`${to.value}T23:59:59.999`)));
    if (append && before) p.set('before', before);
    const r = await api('GET', `/api/admin/audit?${p}`); entries = append ? [...entries, ...r.entries] : r.entries; before = r.nextBefore; more.hidden = !before;
    list.replaceChildren(table([__('When'), __('Person'), __('Event'), __('Details')], entries.map((e) => [date(e.at), e.username || '—', eventLabel(e.event), detailText(e.detail)])));
  }
  form.append(field(__('Event'), event), field(__('Person'), person), field(__('From'), from), field(__('To'), to), submit);
  form.addEventListener('submit', (e) => { e.preventDefault(); act(() => load()); }); more.addEventListener('click', () => act(() => load(true)));
  download.addEventListener('click', () => { const url = URL.createObjectURL(new Blob([JSON.stringify(entries, null, 2)], { type: 'application/json' })); const a = el('a'); a.href = url; a.download = 'stazione-audit.json'; a.click(); URL.revokeObjectURL(url); });
  target.append(form, list, more, download, el('p', 'meta', __('Export includes the loaded audit entries. Load more to include older entries.')));
  return load();
}

// Admin access closes after 15 minutes without activity or 8 hours in total (server side). Show how long is left;
// when it runs out, the next action opens the in-page confirmation instead of a dead end.
function adminTimer(session) {
  let skew = Date.now() - session.now, started = session.startedAt, last = Date.now();
  const idle = session.idleMinutes * 60e3, total = session.absoluteHours * 3600e3;
  const show = () => {
    const left = Math.min(idle - (Date.now() - last), total - (Date.now() - skew - started));
    $('sessionInfo').textContent = left > 0
      ? __`Admin access: ${Math.ceil(left / 60e3)} min left. Every action restarts the 15 minutes; after 8 hours in total you confirm it’s you again.`
      : __('Admin access paused for security. Your next action will ask you to confirm it’s you, without signing out.');
  };
  window.addEventListener('stazione:api', () => { last = Date.now(); show(); });
  // A confirmation may restart the 8 hours: read the new start from the server.
  window.addEventListener('stazione:confirmed', async () => {
    try { const s = await api('GET', '/api/admin/session'); skew = Date.now() - s.now; started = s.startedAt; show(); } catch { /* next tick */ }
  });
  show(); setInterval(show, 20e3);
}
$('closeAdmin').addEventListener('click', () => act(async () => { await api('POST', '/api/admin/logout', {}); location.replace('/'); }));
// One panel that fails to load shows its error and the others still load.
async function safely(fn) { try { await fn(); } catch (err) { say($('adminMsg'), err.message, 'err'); } }
(async () => {
  try {
    const wanted = location.hash.slice(1); // showGroup rewrites the address: keep the section asked for
    me = await api('GET', '/api/admin/session'); $('who').textContent = me.username;
    adminTimer(me);
    setupNav(); nav.querySelectorAll('button').forEach((b) => { b.hidden = true; });
    panel('overview', __('Overview'), 'overview', true, __('The station at a glance: how many rooms, agents, missions and locked files there are now. Read only.'));
    if (can(me, 'people.manage')) panel('people', __('People'), 'people', true, __('Everyone with an account. The role decides what a person (and their agents) can do; a room role replaces it inside that room.'));
    if (can(me, 'people.invite')) panel('invites', __('Invites'), 'people', true, __('Create a one-time code to let someone register, with the role they will have.'));
    panel('roles', __('Roles'), 'people', true, __('Each role is a set of permissions. Open a role to see or change what it allows.'));
    panel('rooms', __('Rooms'), 'rooms', true, __('Who can see each room. Open rooms are visible to everyone; restricted rooms only to the people with a role in them.'));
    await safely(async () => { await overview(); await loadRoles(); await overview(); }); // rooms first, then People (in loadRoles), then owner names
    showGroup(wanted);
    if (can(me, 'people.invite')) await safely(loadInvites);
    if (can(me, 'people.manage')) { panel('sessions', __('Sign-in sessions'), 'people', false, __('Where each person is signed in right now. Closing a session signs that person out on that device.')); await safely(sessionsPanel); panel('credentials', __('Passkeys and browsers'), 'people', false, __('Passkeys and approved browsers of every person. Revoke the ones that are lost or no longer used.')); await safely(credentialsPanel); }
    if (can(me, 'claudes.manage')) { panel('tokens', __('Agent tokens'), 'agents', true, __('The keys agents use to connect. Each person creates their own from the Account page; here you can limit or revoke anyone’s.')); await safely(loadTokens); }
    panel('reception', __('Reception'), 'agents', false, __('How messages from other agents and people reach your agents. Manual: everything waits for a human. Automatic: only suspicious content waits. Unrestricted: everything goes through. The most specific setting wins: agent, then room, then role, then organization.')); await safely(receptionPanel);
    if (can(me, 'approvals.own') || can(me, 'approvals.room')) { panel('held', __('Held content'), 'agents', false, __('What the reception stopped before your agents could read it.')); await safely(heldPanel); }
    if (can(me, 'admin.modules')) { panel('modules', __('Modules'), 'modules', true, __('Optional parts of the station. Switch off what your team does not use; your team can add its own modules in modules-custom/. Rules of the core (permissions, approvals, reception) always stay on.')); await safely(modulesPanel); }
    if (can(me, 'rooms.context')) { panel('history', __('Context history'), 'agents', true, __('Earlier versions of each room’s project context, the text agents read when they start. Restore one if a change went wrong.')); await safely(historyPanel); }
    if (['owner','admin'].includes(me.role)) { panel('changes', __('Changes waiting for a second administrator'), 'security', true, __('With the four-eyes safeguard on, sensitive changes wait here until another administrator approves them.')); await safely(changesPanel); }
    panel('security', __('Security'), 'security', false, __('Station-wide limits: how many accounts, from which networks people and agents may connect, and extra safeguards.')); await safely(security);
    if (can(me, 'admin.security')) { panel('approvalRules', __('Approval rules'), 'security', false, __('Who must approve an agent’s drastic actions (deleting, force pushes, deploys) and its requests for protected data.')); await safely(approvalRulesPanel); }
    if (can(me, 'admin.security')) { panel('modelCheck',__('Optional model check'), 'security', false, __('An extra AI check on incoming content for automatic reception. Off unless you turn it on.')); await safely(modelCheckPanel); }
    if (can(me, 'admin.audit')) { panel('alerts', __('Security alerts'), 'log', true, __('Events that deserve a look: failed sign-ins, blocked networks, changes to security.')); await safely(alertsPanel); panel('audit', __('Audit log'), 'log', true, __('Everything that happened on the station, newest first. Filter by event, person or date.')); await safely(auditPanel); }
    showGroup(wanted);
  } catch (err) {
    say($('adminMsg'), __(err.message), 'err');
    // Confirmation cancelled: offer it again instead of leaving a dead page.
    if (err.data?.code === 'step_up_required') {
      const again = el('button', null, __('Confirm it’s you')); again.type = 'button'; again.addEventListener('click', () => location.reload());
      $('adminMsg').append(' ', again);
    }
  }
})();
