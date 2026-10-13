import { $, el, api, say, __, can, locale } from './common.js';
import { renderHeld } from './reception.js';
import { restrictionEditor } from './token-restrictions.js';

let me, roles = [], rooms = [], people = [], lastInvite = null;
const panels = new Map();
// The console is long: its panels are grouped in sections shown one at a time, like the station's own tabs.
const GROUPS = [['overview', __('Overview')], ['people', __('People')], ['agents', __('Agents')], ['security', __('Security')], ['log', __('Log')]];
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
function panel(id, title, group, wide = false) {
  const section = el('section', wide ? 'panel wide' : 'panel'); section.append(el('h2', null, title));
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
  stats.append(stat(rooms.length, __('Rooms')), stat(`${online}/${data.claudes.length}`, __('Agents online')), stat(data.tasks.length, __('Open missions')), stat(data.locks.length, __('Locks')));
  target.append(stats, el('h3', null, __('Rooms')));
  target.append(table([__('Room'), __('Visibility'), __('Actions')], rooms.map((r) => {
    const visibility = select([['open', __('Open')], ['restricted', __('Restricted')]], r.visibility);
    const action = button(__('SAVE'), async () => { await api('PUT', `/api/admin/rooms/${r.id}/visibility`, { visibility: visibility.value }); await overview(); });
    visibility.disabled = !can(me, 'admin.security') || r.kind === 'bridge'; action.disabled = visibility.disabled;
    return [r.name, visibility, action];
  })));
  const stop = (c) => button(__('STOP AGENT'), async () => { if (confirm(__('Stop this agent and suspend its token? Sessions sharing the token will also stop.'))) { await api('POST', `/api/reception/agents/${c.id}/stop`, {}); await overview(); } }, true);
  const manage = can(me, 'claudes.manage');
  target.append(el('h3', null, __('Agents')), table([__('Name'), __('Owner'), __('Room'), __('Status'), ...(manage ? [__('Actions')] : [])], data.claudes.map((c) => [c.name, people.find((p) => p.id === c.owner_id)?.username || c.owner_id, rooms.find((r) => r.id === c.room)?.name || '—', c.status, ...(manage ? [stop(c)] : [])])));
  target.append(el('h3', null, __('Open missions')), table([__('Mission'), __('Room'), __('Status')], data.tasks.map((t) => [t.title, t.project, t.status])));
  target.append(el('h3', null, __('Locks')), table([__('Room'), __('Resource'), __('Owner'), __('Expires')], data.locks.map((l) => [l.project, l.resource, l.owner_claude, date(l.expires_at)])));
}
const modeChoices = [['', __('Inherit')], ['manual', __('Manual')], ['automatic', __('Automatic')], ['unrestricted', __('Unrestricted')]];
async function receptionPanel() {
  const [settings, overview] = await Promise.all([api('GET', '/api/reception'), api('GET', '/api/admin/overview')]), target = panels.get('reception'); target.replaceChildren();
  const control = (name, value, path, inherited = true) => { const choice = select(inherited ? modeChoices : modeChoices.slice(1), value || ''); const row = el('div', 'stack'); row.append(field(name, choice), button(__('SAVE'), async () => { await api('PUT', path, { mode: choice.value || null }); await receptionPanel(); })); return row; };
  if (can(me, 'admin.security')) target.append(control(__('Organization default'), settings.organization.mode, '/api/reception/organization', false));
  if (can(me, 'admin.roles')) for (const r of settings.roles) target.append(control(r.name, r.mode, `/api/reception/roles/${r.id}`));
  if (can(me, 'claudes.reception')) {
    for (const r of overview.rooms) target.append(control(r.name, r.receptionDefault, `/api/reception/rooms/${r.id}`));
    for (const c of overview.claudes) {
      const row = control(c.name, c.reception_mode, `/api/reception/agents/${c.id}`), trusted = input('text', (c.trusted_senders || []).map(s => s.replace(/^claude:/, 'agent:')).join(', '));
      row.append(field(__('Trusted senders (human:id or agent:id)'), trusted), button(__('SAVE TRUSTED SENDERS'), async () => { await api('PUT', `/api/reception/agents/${c.id}`, { mode: c.reception_mode || null, trustedSenders: trusted.value.split(',').map(s => s.trim()).filter(Boolean) }); await receptionPanel(); })); target.append(row);
    }
  }
}
async function heldPanel() {
  await renderHeld(panels.get('held'));
}
async function historyPanel() {
  const target = panels.get('history'), choices = select(rooms.map(r => [r.project, r.name])), content = el('div');
  const show = async () => { const project = choices.value, data = await api('GET', `/api/context/${encodeURIComponent(project)}/versions`); content.replaceChildren(table([__('Version'), __('Preview'), __('Actions')], data.versions.map(v => [v.version, el('pre', null, v.summary), button(__('RESTORE VERSION'), async () => { if (confirm(__('Restore this context version?'))) { await api('POST', `/api/context/${encodeURIComponent(project)}/rollback`, { version: v.version }); await show(); } })]))); };
  choices.addEventListener('change', () => act(show)); target.append(field(__('Room'), choices), content); if (rooms.length) await show();
}

async function loadPeople() {
  people = (await api('GET', '/api/admin/people')).people;
  const rows = people.map((p) => {
    const role = select(roleOptions(), p.role);
    const controls = el('div'); controls.append(role, button(__('SAVE'), async () => { await api('PUT', `/api/admin/people/${p.id}/role`, { role: role.value }); await loadPeople(); await loadRoles(); }));
    if (p.role === 'owner' && me.role !== 'owner') controls.querySelectorAll('button,select').forEach((c) => { c.disabled = true; });
    if (me.role === 'owner' && p.id !== me.userId) controls.append(button(__('DELETE ACCOUNT'), async () => {
      if (!confirm(__`Delete the account of ${p.username} for good? Their tokens, passkeys and astronauts go too. This cannot be undone.`)) return;
      const r = await api('POST', `/api/admin/people/${encodeURIComponent(p.id)}/delete`, {});
      if (r.status === 'pending_approval') say($('adminMsg'), __(r.message), 'good');
      await loadPeople(); if (panels.has('changes')) await changesPanel();
    }, true));
    const assignments = el('div');
    for (const r of rooms) {
      const existing = p.roomRoles.find((a) => a.room === r.id)?.role;
      const local = select([['', __('Organization role')], ...roleOptions()], existing || '');
      const row = el('div'); row.append(field(r.name, local), button(__('SAVE'), async () => { await api('PUT', `/api/admin/people/${p.id}/rooms/${r.id}/role`, { role: local.value || null }); await loadPeople(); })); assignments.append(row);
    }
    return [p.username, controls, assignments];
  });
  panels.get('people').replaceChildren(table([__('Person'), __('Organization role'), __('Room roles')], rows));
}

function permissionFields(selected = []) {
  const fields = el('div', 'perm-grid'), checks = new Map();
  for (const p of me.catalog) { const c = input('checkbox'); c.checked = selected.includes(p.id); c.disabled = !can(me, p.id) && !c.checked; checks.set(p.id, c); const l = el('label', 'check'); l.append(c, el('span', null, __(p.label))); fields.append(l); }
  return { fields, values: () => [...checks].filter(([, c]) => c.checked).map(([id]) => id) };
}
async function loadRoles() {
  const data = await api('GET', '/api/admin/roles'); roles = data.roles; me.catalog = data.permissions;
  const target = panels.get('roles'); target.replaceChildren();
  for (const r of roles) {
    const details = el('details'); details.append(el('summary', null, `${r.name}${r.builtin ? ` · ${__('Built-in')}` : ''} · ${r.members}`));
    const name = input('text', r.name), permissions = permissionFields(r.permissions);
    details.append(field(__('Name'), name), permissions.fields);
    const save = button(__('SAVE'), async () => { await api('PUT', `/api/admin/roles/${r.id}`, { name: name.value, permissions: permissions.values() }); await loadRoles(); });
    save.disabled = !can(me, 'admin.roles') || r.id === 'owner' || (r.id === 'admin' && me.role !== 'owner');
    details.append(save);
    if (!r.builtin && can(me, 'admin.roles')) details.append(button(__('DELETE'), async () => { if (confirm(__('Delete this role?'))) { await api('DELETE', `/api/admin/roles/${r.id}`); await loadRoles(); } }, true));
    target.append(details);
  }
  if (can(me, 'admin.roles')) {
    const box = el('details', 'new-role'), form = el('form', 'stack'), name = input(), permissions = permissionFields(); name.required = true; name.maxLength = 40;
    box.append(el('summary', null, __('New role')), form);
    const submit = el('button', null, __('CREATE ROLE')); submit.type = 'submit';
    form.append(field(__('Role name'), name), permissions.fields, submit);
    form.addEventListener('submit', (e) => { e.preventDefault(); act(async () => { await api('POST', '/api/admin/roles', { name: name.value, permissions: permissions.values() }); await loadRoles(); }); }); target.append(box);
  }
  if (panels.has('people')) await loadPeople();
}

async function loadInvites() {
  const target = panels.get('invites'); target.replaceChildren();
  const { invites } = await api('GET', '/api/admin/invites');
  target.append(table([__('Label'), __('Role'), __('Expires'), __('Status'), __('Actions')], invites.map((i) => [i.label, roles.find((r) => r.id === i.role)?.name || '—', date(i.expiresAt), i.revokedAt ? __('Revoked') : i.usedAt ? __('Used') : i.expiresAt < Date.now() ? __('Expired') : __('Available'), button(__('REVOKE'), async () => { await api('POST', `/api/admin/invites/${i.id}/revoke`, {}); await loadInvites(); }, true)])));
  const form = el('form', 'stack'), role = select(roleOptions(), 'member'), label = input(), hours = input('number', '48'); hours.min = 1; hours.max = 720;
  const roomAssignments = el('div'), assignmentSelects = new Map();
  for (const r of rooms.filter((r) => r.kind !== 'bridge')) { const s = select([['', __('No room role')], ...roleOptions()]); assignmentSelects.set(r.id, s); roomAssignments.append(field(r.name, s)); }
  const submit = el('button', null, __('CREATE INVITE')); submit.type = 'submit';
  const code = el('pre', 'secret-box'); code.hidden = !lastInvite;
  if (lastInvite) code.textContent = `${__('Save this invite now. It is shown only once.')}\n${lastInvite.code}\n${new URL(lastInvite.link, location.origin)}`;
  form.append(field(__('Role'), role), field(__('Label'), label), field(__('Hours'), hours), roomAssignments, submit);
  form.addEventListener('submit', (e) => { e.preventDefault(); act(async () => {
    const roomRoles = [...assignmentSelects].filter(([, s]) => s.value).map(([room, s]) => ({ room, role: s.value }));
    const r = await api('POST', '/api/admin/invites', { role: role.value, label: label.value, hours: Number(hours.value), roomRoles });
    lastInvite = r; await loadInvites();
  }); }); target.append(form, code);
}

async function loadTokens() {
  const { tokens } = await api('GET', '/api/admin/tokens');
  panels.get('tokens').replaceChildren(table([__('Name'), __('Owner'), __('Last used'), __('Expires'), __('Actions')], tokens.map((t) => {
    const action = button(t.revoked_at ? __('Revoked') : __('REVOKE'), async () => { if (confirm(__('Revoke this token?'))) { await api('POST', `/api/admin/tokens/${t.id}/revoke`, {}); await loadTokens(); } }, true); action.disabled = Boolean(t.revoked_at);
    const controls = el('div'), details = el('details'), editor = restrictionEditor(rooms, t.restrictions);
    details.append(el('summary', null, __('Token limits')), editor.element, button(__('SAVE'), async () => { await api('PUT', `/api/admin/tokens/${t.id}`, { restrictions: editor.value() }); await loadTokens(); }));
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
    row.append(field(name, choice), button(__('SAVE'), async () => { await api('PUT', path, { rule: choice.value || null }); await approvalRulesPanel(); })); target.append(row);
  };
  target.append(el('p', 'meta', __('Two-person approval requires matching decisions from different eligible people. A rejection stops the request immediately.')));
  control(__('Organization default'), data.organization.rule, '/api/organization/approval-rule', false);
  for (const room of data.rooms) control(room.name, room.rule, `/api/rooms/${room.id}/approval-rule`, true);
}
async function security() {
  const org = await api('GET', '/api/admin/organization'), limit = input('number', String(org.userLimit)); limit.min = org.occupiedSeats; limit.max = 99999;
  const form = el('form', 'stack'), submit = el('button', null, __('SAVE')); submit.type = 'submit'; submit.disabled = !can(me, 'admin.security');
  form.append(field(__('User limit'), limit), el('p', 'meta', __`${org.occupiedSeats} occupied seats`), submit);
  form.addEventListener('submit', (e) => { e.preventDefault(); act(async () => { await api('PUT', '/api/admin/organization/user-limit', { limit: Number(limit.value) }); await security(); }); });
  panels.get('security').replaceChildren(form);
  if (can(me, 'admin.security')) {
    const data = await api('GET', '/api/admin/ip-rules');
    const networks = el('form', 'stack'), humans = el('textarea'), agents = el('textarea');
    for (const [target, area] of [['humans', humans], ['agents', agents]]) { area.rows = 4; area.value = data.rules.filter(r => r.target === target).map(r => r.cidr).join('\n'); }
    networks.append(field(__('Allowed networks for people'), humans), field(__('Allowed networks for agents'), agents), el('p', 'meta', __('One IPv4 or IPv6 range per line. Leave empty to allow every network. Your current address must remain allowed.')));
    const save = el('button', null, __('SAVE')); save.type = 'submit'; networks.append(save);
    networks.addEventListener('submit', e => { e.preventDefault(); act(async () => { const ranges = area => area.value.split('\n').map(v => v.trim()).filter(Boolean); await api('PUT', '/api/admin/ip-rules', { humans: ranges(humans), agents: ranges(agents) }); await security(); }); });
    panels.get('security').append(networks);
    const policy = await api('GET', '/api/admin/security-policy'), known = input('checkbox'), fourEyes = input('checkbox');
    known.checked = policy.requireKnownDevice; fourEyes.checked = policy.fourEyes;
    const safeguards = el('div', 'stack'); safeguards.append(field(__('Require approved browsers'), known), field(__('Require a second administrator for sensitive changes'), fourEyes), el('p', 'meta', __('Approve your current browser and an owner browser first. Double approval requires two active administrators with security and people management permissions.')), button(__('SAVE'), async () => { await api('PUT', '/api/admin/security-policy', { requireKnownDevice: known.checked, fourEyes: fourEyes.checked }); await security(); }));
    panels.get('security').append(safeguards);
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
  const form = el('form','stack'), save = el('button',null,__('SAVE')); save.type = 'submit';
  form.append(field(__('Enable model check'),enabled),field(__('New API key (leave empty to keep the saved key)'),key),field(__('Daily call limit'),limit),field(__('I authorize external text processing and the related usage costs.'),consent),save);
  form.addEventListener('submit',e => { e.preventDefault(); act(async () => {
    const body = { enabled:enabled.checked,dailyLimit:Number(limit.value),acknowledgeExternalProcessing:consent.checked }; if (key.value) body.apiKey = key.value;
    try { await api('PUT','/api/admin/model-check',body); await modelCheckPanel(); } finally { key.value = ''; }
  }); });
  target.append(form,button(__('REMOVE MODEL KEY'),async () => { if (confirm(__('Remove the saved API key and disable the model check?'))) { await api('PUT','/api/admin/model-check',{enabled:false,removeKey:true,dailyLimit:config.dailyLimit}); await modelCheckPanel(); } },true));
}
async function credentialsPanel() {
  const [browsers, keys] = await Promise.all([api('GET', '/api/admin/devices'), api('GET', '/api/admin/passkeys')]), target = panels.get('credentials');
  target.replaceChildren(el('p', 'meta', __('Add your own passkey and register this browser in Account.')));
  const account = el('a', 'links', 'Account'); account.href = '/account'; target.append(account);
  target.append(table([__('Person'), __('Registered browsers'), __('Status'), __('Expires'), __('Actions')], browsers.devices.map(d => {
    const controls = el('div'), expired = d.expires_at <= Date.now(), protectedOwner = d.role === 'owner' && me.role !== 'owner';
    if (d.status !== 'revoked' && !expired) {
      if (d.status === 'pending') { const approve = button(__('APPROVE'), async () => { await api('POST', `/api/admin/devices/${d.id}/decide`, { approve: true }); await credentialsPanel(); }); approve.disabled = protectedOwner; controls.append(approve); }
      const revoke = button(__('REVOKE'), async () => { if (confirm(__('Revoke this browser and close its sessions?'))) { await api('POST', `/api/admin/devices/${d.id}/decide`, { approve: false }); await credentialsPanel(); } }, true); revoke.disabled = protectedOwner; controls.append(revoke);
    }
    return [d.username, d.name, expired ? __('expired') : __(d.status), date(d.expires_at), controls];
  })));
  target.append(el('h3', null, __('Passkeys')), table([__('Person'), __('Name'), __('Last used'), __('Actions')], keys.passkeys.map(k => {
    const revoke = button(__('REVOKE'), async () => { if (confirm(__('Revoke this passkey?'))) { await api('DELETE', `/api/admin/passkeys/${k.id}`); await credentialsPanel(); } }, true); revoke.disabled = k.role === 'owner' && me.role !== 'owner'; return [k.username, k.name, date(k.last_used_at), revoke];
  })));
}
async function changesPanel() {
  const { changes } = await api('GET', '/api/admin/changes'), target = panels.get('changes');
  badge('security', changes.filter((c) => c.status === 'pending').length);
  target.replaceChildren(el('p', 'meta', __('Pending changes expire after 30 minutes. Another administrator must review them. Changes to security settings invalidate earlier requests.')));
  target.append(table([__('Person'), __('Change'), __('Status'), __('Expires'), __('Actions')], changes.map(c => {
    const controls = el('div');
    if (c.status === 'pending') for (const decision of ['approve', 'reject']) {
      const b = button(decision === 'approve' ? __('APPROVE') : __('REJECT'), async () => {
        const r = await api('POST', `/api/admin/changes/${c.id}/decide`, { decision });
        if (r.result?.code) { lastInvite = r.result; if (panels.has('invites')) await loadInvites(); }
        await changesPanel();
        if (r.status === 'approved' && !r.result?.code) location.reload();
      }, decision === 'reject'); b.disabled = decision === 'approve' && c.created_by === me.userId; controls.append(b);
    }
    const description = el('div'); description.append(el('span', null, __(c.title)));
    if (c.proposal) {
      const person = people.find(p => c.proposal.path.includes(`/people/${encodeURIComponent(p.id)}/`));
      const role = roles.find(r => r.id === c.proposal.settings.role);
      const room = rooms.find(r => c.proposal.path.includes(`/rooms/${encodeURIComponent(r.id)}/`));
      const names = [person?.username, role?.name, room?.name].filter(Boolean);
      if (names.length) description.append(el('p', 'meta', names.join(' · ')));
      description.append(el('pre', 'meta', `${c.proposal.method} ${c.proposal.path}\n${JSON.stringify(c.proposal.settings, null, 2)}`));
    }
    return [c.username, description, __(c.status), date(c.expires_at), controls];
  })));
}
async function sessionsPanel() {
  const data = await api('GET', '/api/admin/sessions');
  panels.get('sessions').replaceChildren(table([__('Person'), __('Created'), __('Last used'), __('Expires'), __('Actions')], data.sessions.map(s => {
    const close = button(__('CLOSE SESSION'), async () => { if (confirm(__('Close this sign-in session?'))) { await api('POST', `/api/admin/sessions/${s.id}/close`, {}); if (s.current) location.replace('/login'); else await sessionsPanel(); } }, true);
    close.disabled = s.role === 'owner' && me.role !== 'owner';
    return [s.username + (s.current ? ` (${__('Current session')})` : ''), date(s.created_at), date(s.last_seen), date(s.expires_at), close];
  })));
}
async function alertsPanel() {
  const data = await api('GET', '/api/admin/alerts');
  badge('log', data.alerts.filter((a) => Date.now() - a.at < 86400e3).length);
  panels.get('alerts').replaceChildren(table([__('Event'), __('Person'), __('When')], data.alerts.map(a => [a.event, people.find(p => p.id === a.actor)?.username || a.actor, date(a.at)])));
}
function auditPanel() {
  const target = panels.get('audit'), form = el('form', 'stack'), event = input(), person = select([['', __('Everyone')], ...people.map((p) => [p.id, p.username])]);
  const from = input('date'), to = input('date'), submit = el('button', null, __('FILTER')); submit.type = 'submit';
  const list = el('div'), more = el('button', 'ghost', __('MORE')); more.type = 'button'; more.hidden = true;
  const download = el('button', 'ghost', __('EXPORT')); download.type = 'button';
  let entries = [], before = null;
  async function load(append = false) {
    const p = new URLSearchParams(); if (event.value) p.set('event', event.value); if (person.value) p.set('user', person.value);
    if (from.value) p.set('from', String(Date.parse(`${from.value}T00:00:00`))); if (to.value) p.set('to', String(Date.parse(`${to.value}T23:59:59.999`)));
    if (append && before) p.set('before', before);
    const r = await api('GET', `/api/admin/audit?${p}`); entries = append ? [...entries, ...r.entries] : r.entries; before = r.nextBefore; more.hidden = !before;
    list.replaceChildren(table([__('When'), __('Person'), __('Event'), __('Details')], entries.map((e) => [date(e.at), e.username || '—', e.event, JSON.stringify(e.detail || {})])));
  }
  form.append(field(__('Event'), event), field(__('Person'), person), field(__('From'), from), field(__('To'), to), submit);
  form.addEventListener('submit', (e) => { e.preventDefault(); act(() => load()); }); more.addEventListener('click', () => act(() => load(true)));
  download.addEventListener('click', () => { const url = URL.createObjectURL(new Blob([JSON.stringify(entries, null, 2)], { type: 'application/json' })); const a = el('a'); a.href = url; a.download = 'stazione-audit.json'; a.click(); URL.revokeObjectURL(url); });
  target.append(form, list, more, download, el('p', 'meta', __('Export includes the loaded audit entries. Load more to include older entries.')));
  return load();
}

$('closeAdmin').addEventListener('click', () => act(async () => { await api('POST', '/api/admin/logout', {}); location.replace('/'); }));
// One panel that fails to load shows its error and the others still load.
async function safely(fn) { try { await fn(); } catch (err) { say($('adminMsg'), err.message, 'err'); } }
(async () => {
  try {
    const wanted = location.hash.slice(1); // showGroup rewrites the address: keep the section asked for
    me = await api('GET', '/api/admin/session'); $('who').textContent = me.username;
    $('sessionInfo').textContent = __('Admin access expires after 15 minutes without activity or 8 hours in total. Sign in again when it expires.');
    setupNav(); nav.querySelectorAll('button').forEach((b) => { b.hidden = true; });
    panel('overview', __('Overview'), 'overview', true);
    if (can(me, 'people.manage')) panel('people', __('People'), 'people', true);
    if (can(me, 'people.invite')) panel('invites', __('Invites'), 'people', true);
    panel('roles', __('Roles'), 'people', true);
    await safely(async () => { await overview(); await loadRoles(); await overview(); }); // rooms first, then People (in loadRoles), then owner names
    showGroup(wanted);
    if (can(me, 'people.invite')) await safely(loadInvites);
    if (can(me, 'people.manage')) { panel('sessions', __('Sign-in sessions'), 'people'); await safely(sessionsPanel); panel('credentials', __('Passkeys and browsers'), 'people'); await safely(credentialsPanel); }
    if (can(me, 'claudes.manage')) { panel('tokens', __('Tokens'), 'agents', true); await safely(loadTokens); }
    panel('reception', __('Reception'), 'agents'); await safely(receptionPanel);
    if (can(me, 'approvals.own') || can(me, 'approvals.room')) { panel('held', __('Held content'), 'agents'); await safely(heldPanel); }
    if (can(me, 'rooms.context')) { panel('history', __('Context history'), 'agents', true); await safely(historyPanel); }
    if (['owner','admin'].includes(me.role)) { panel('changes', __('Pending administrative changes'), 'security', true); await safely(changesPanel); }
    panel('security', __('Security'), 'security'); await safely(security);
    if (can(me, 'admin.security')) { panel('approvalRules', __('Approval rules'), 'security'); await safely(approvalRulesPanel); }
    if (can(me, 'admin.security')) { panel('modelCheck',__('Optional model check'), 'security'); await safely(modelCheckPanel); }
    if (can(me, 'admin.audit')) { panel('alerts', __('Security alerts'), 'log', true); await safely(alertsPanel); panel('audit', __('Audit log'), 'log', true); await safely(auditPanel); }
    showGroup(wanted);
  } catch (err) { say($('adminMsg'), err.message, 'err'); }
})();
