import { $, el, api, say, __, locale, can, contentWarning } from './common.js';
import { initNotifications } from './notifications.js';
import { mountJournal } from './journal.js';
import { mountStats } from './stats.js';
import { initPolls } from './polls.js';
import { initProject } from './project.js';
import { initSounds, play } from './sounds.js';
import { suit, hat, tool, roleOf } from './roles.js';
import { animateAvatar } from './avatar.js';
import { drawFireworks, dayTint, nightLevel, drawLights, PARTY_MS, drawBin, roomColor, drawMap, drawFurniture, paintBridge, drawBridgeScreen, drawBridgeTable, drawBallotBox } from './rooms.js';
import { LOUNGE, SEATS, STAND, DOOR, FRIDGE_SPOT, SOFA_Y, BEAN_Y, FOOS_Y, paintLounge, drawLounge, drawSofa, drawBean, drawSeated, drawFoosball } from './lounge.js';

const PALETTE = ['#ffb547', '#3ee6c9', '#ff5fa2', '#8fa8ff', '#b6f24a', '#ff7a45', '#c792ff', '#5fd0ff'];
const AWAY_MS = 10 * 60e3, HUB_RECENT_MS = 120e3, BUBBLE_MS = 5 * 60e3, POLL_MS = 4000;
const state = { me: null, users: [], claudes: [], tasks: [], locks: [], messages: [], decisions: [], contexts: [], pendingApprovals: 0, filter: '' };
const adminLink = el('a', 'btn ghost', __('ADMIN CONSOLE')); adminLink.href = '/admin'; adminLink.hidden = true;
document.querySelector('.bar').append(adminLink);
$('newTask').hidden = true;
document.querySelector('a[href="/ideas"]').hidden = true;
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------- helpers ----------
function hash(s) { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) | 0; return Math.abs(h); }
const colorOf = (c) => (/^#[0-9a-f]{6}$/i.test(c?.color || '') ? c.color : PALETTE[hash(c?.id || '') % PALETTE.length]); // the chosen colour, else one from the id
function shade(hex, f) { const n = parseInt(hex.slice(1), 16); return `rgb(${Math.round(((n >> 16) & 255) * f)},${Math.round(((n >> 8) & 255) * f)},${Math.round((n & 255) * f)})`; }
function ago(ts) { if (!ts) return '—'; const d = Math.max(0, Date.now() - ts); if (d < 60e3) return __('now'); if (d < 3600e3) return __`${Math.floor(d / 60e3)} min ago`; if (d < 86400e3) return __`${Math.floor(d / 3600e3)} h ago`; return __`${Math.floor(d / 86400e3)} d ago`; }
function left(ts) { const d = ts - Date.now(); if (d <= 0) return __('expired'); if (d < 3600e3) return `${Math.ceil(d / 60e3)} min`; return `${(d / 3600e3).toFixed(1)} h`; }
const claudeById = () => Object.fromEntries(state.claudes.map((c) => [c.id, c]));
const userName = (id) => state.users.find((u) => u.id === id)?.username || '?';
/** Display name: sessions that share a name get their session number ("Atlas #2"). */
function label(c) {
  const n = c.name || c.id; const k = c.id.match(/-(\d+)$/);
  return k && state.claudes.some((o) => o.id !== c.id && (o.name || o.id) === n) ? `${n} #${k[1]}` : n;
}
function nameOf(id) {
  if (id === '*') return __('everyone in the room');
  if (id === '**') return __('the whole station');
  if (String(id).startsWith('human:')) return __`${id.slice(6)} (human)`;
  const c = claudeById()[id];
  return c ? label(c) : id || '?';
}
const inFilter = (p) => !state.filter || (p || '') === state.filter;
/** The room filter: only the astronauts of the chosen room (its sessions are bound to that project). */
const inRoom = (c) => !state.filter || c.project === state.filter;
const roomOf = (c) => (state.rooms || []).find((r) => r.id === c.room);
/** Rooms are keyed by project on the board: the filter is a project, old projects without a room still get a tab. */
const roomByProject = (p) => (state.rooms || []).find((r) => r.project === p);
const roomName = (p) => roomByProject(p)?.name ?? (p || __('No project'));
const roomTint = (p) => roomColor(roomByProject(p) ?? (p ? { id: `p:${p}` } : null));
const projOfClaude = (c) => roomOf(c)?.project ?? c.project ?? '';
const roomRank = (p) => (roomByProject(p)?.kind === 'bridge' ? '0' : p ? `1${roomName(p).toLowerCase()}` : '2');
/**
 * Fills a list: inside a room just the items, on "All rooms" the items grouped under one header per room
 * (Bridge first, things without a project last), so the whole station reads room by room.
 */
function grouped(list, items, projOf, render) {
  if (state.filter) { for (const x of items) list.append(render(x)); return; }
  const groups = new Map();
  for (const x of items) { const p = projOf(x) || ''; if (!groups.has(p)) groups.set(p, []); groups.get(p).push(x); }
  for (const p of [...groups.keys()].sort((a, b) => roomRank(a).localeCompare(roomRank(b)))) {
    const h = el('li', 'group', roomName(p).toUpperCase()); h.style.setProperty('--g', roomTint(p));
    list.append(h, ...groups.get(p).map(render));
  }
}
const isAway = (c) => c.status === 'offline' || !c.lastSeen || Date.now() - c.lastSeen > AWAY_MS;
const unreadFor = (c) => state.messages.filter((m) => (m.to === c.id || m.to === '**' || (m.to === '*' && (!m.room || !c.room || m.room === c.room))) && m.from !== c.id && (m.createdAt || 0) > (c.inboxReadAt || 0)).length;
const lastSent = (c) => state.messages.find((m) => m.from === c.id);
function atHub(c) { if (isAway(c)) return false; if (c.status === 'comms') return true; const m = lastSent(c); return !!m && Date.now() - (m.createdAt || 0) < HUB_RECENT_MS; }
function statusLabel(c) { if (isAway(c)) return [__('Offline'), 'dim']; if (atHub(c)) return [__('In comms'), 'pink']; if (c.status === 'working') return [__('Working'), 'ok']; return [__('Waiting'), 'warn']; }
function swatch(color) { const s = el('span', 'sw'); s.style.background = color; return s; }

// ---------- panels ----------
function renderCrew() {
  const list = $('crewList'); list.replaceChildren();
  const crew = state.claudes.filter(inRoom).sort((a, b) => (isAway(a) - isAway(b)) || (b.lastSeen || 0) - (a.lastSeen || 0));
  $('crewCount').textContent = crew.length ? __`${crew.filter((c) => !isAway(c)).length}/${crew.length} active` : '';
  if (!crew.length) { list.append(el('li', 'empty', __('No agent on board. The first one registers itself when its session starts.'))); return; }
  const tasks = Object.fromEntries(state.tasks.map((t) => [t.id, t]));
  grouped(list, crew, projOfClaude, (c) => {
    const li = el('li'); const [lab, cls] = statusLabel(c);
    const mid = el('div'); mid.style.minWidth = '0';
    mid.append(el('div', 'name', label(c)));
    const t = c.taskId && tasks[c.taskId];
    const act = c.activity || (t ? t.title : '');
    if (act) mid.append(el('div', 'meta', act));
    const nLocks = state.locks.filter((l) => l.owner === c.id && l.expiresAt > Date.now()).length;
    const nUnread = unreadFor(c);
    const bits = [`ID ${c.id}`, __`of ${userName(c.owner)}`, roleOf(c) && __`role ${__(roleOf(c))}`, roomOf(c) ? __`room ${roomOf(c).name}` : c.project && __`project ${c.project}`, c.host && __`host ${c.host}`, t && __`mission ${t.id}`, nLocks && __`${nLocks} locks`, nUnread && __`${nUnread} unread`, __`seen ${ago(c.lastSeen)}`].filter(Boolean);
    mid.append(el('div', 'meta', bits.join(' · ')));
    li.append(swatch(colorOf(c)), mid, el('span', `chip ${cls}`, lab));
    // Your own astronaut that is gone (old session): remove it, which frees its id. Nothing is ever removed by itself.
    if (can(state.me, 'claudes.tokens') && isAway(c) && c.owner === state.me?.userId) {
      const b = el('button', 'ghost forget', __('REMOVE')); b.type = 'button';
      b.title = __('Remove this astronaut (closed session): its missions become free again and its id is freed');
      b.addEventListener('click', async () => {
        if (!confirm(__`Remove ${label(c)} (${c.id}) from the station? Do it only if that session is closed: its missions go back to be assigned.`)) return;
        b.disabled = true;
        try { await api('POST', `/api/claudes/${encodeURIComponent(c.id)}/forget-human`, {}); poll(); } catch (err) { b.disabled = false; alert(err.message); }
      });
      li.append(b);
    }
    return li;
  });
}

const revealed = new Map(); // secure id -> plaintext, shown briefly then dropped

async function reveal(id, btn) {
  btn.disabled = true;
  try {
    const r = await api('POST', `/api/secure/${encodeURIComponent(id)}/reveal`, {});
    revealed.set(id, r.text);
    setTimeout(() => { revealed.delete(id); renderMsgs(); }, 60e3);
    renderMsgs();
    if (r.consumed) poll();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = err.message;
  }
}

function renderMsgs() {
  const list = $('msgList'); list.replaceChildren();
  const room = roomByProject(state.filter);
  const crewIds = new Set(state.claudes.filter(inRoom).map((c) => c.id));
  const inRoomChannel = (m) => m.to === '**' || crewIds.has(m.to) || crewIds.has(m.from) || (room ? m.room === room.id : !m.room && inFilter(m.project));
  const msgs = state.messages.filter((m) => !state.filter || inRoomChannel(m)).slice(0, 40);
  $('msgCount').textContent = msgs.length ? String(msgs.length) : '';
  if (!msgs.length) { list.append(el('li', 'empty', __('No messages on the channel.'))); return; }
  const map = claudeById();
  for (const m of msgs) {
    const li = el('li', m.secure ? 'secure' : null);
    if (!m.secure) li.style.setProperty('--c', colorOf(map[m.from] || { id: m.from }));
    const h = el('div', 'hdr');
    h.append(el('b', null, nameOf(m.from)), el('span', null, '→'), el('b', null, nameOf(m.to)), el('span', null, `· ${ago(m.createdAt)}`));
    const mp = (state.rooms || []).find((r) => r.id === m.room)?.project ?? m.project;
    if (!state.filter && (mp || m.room)) { const t = el('span', 'rt', roomName(mp)); t.style.color = roomTint(mp); h.append(t); }
    li.append(h, el('div', 'txt', m.text || ''));
    const warning = contentWarning(m); if (warning) li.append(warning);
    if (m.secure) {
      const s = m.secure;
      const tags = el('div', 'tags');
      tags.append(el('span', 'chip pink', __(s.statusLabel || s.status)));
      if (s.detected?.length) tags.append(el('span', 'meta', s.detected.join(', ')));
      li.append(tags);
      if (revealed.has(s.id)) li.append(el('div', 'revealed', revealed.get(s.id)));
      else if (s.canReveal) {
        const b = el('button', 'ghost', s.policy === 'once_human' ? __('SHOW (ONCE ONLY)') : __('SHOW'));
        b.type = 'button';
        b.addEventListener('click', () => reveal(s.id, b));
        li.append(b);
      }
    }
    list.append(li);
  }
}

// ---------- urgency: priority and deadline (a calendar day, local time) ----------
const RANK = { high: 0, normal: 1, low: 2 };
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const daysTo = (day) => Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${today()}T00:00:00Z`)) / 86400e3);
const byUrgency = (a, b) => (RANK[a.priority] ?? 1) - (RANK[b.priority] ?? 1) || (a.due || '9').localeCompare(b.due || '9');
/** Deadline as people say it ("due today", "overdue since Oct 5", "due Oct 5") and how alarming it is. */
function dueLabel(day) {
  const n = daysTo(day), dm = new Date(`${day}T12:00:00`).toLocaleDateString(locale, { day: 'numeric', month: 'short' });
  if (n < 0) return [__`overdue since ${dm}`, 'bad'];
  if (n === 0) return [__('due today'), 'bad'];
  if (n === 1) return [__('due tomorrow'), 'warn'];
  return [__`due ${dm}`, n <= 3 ? 'warn' : 'dim'];
}

function taskCard(t) {
  const map = claudeById(); const li = el('li', 'card'); li.style.setProperty('--rc', roomTint(t.project));
  const top = el('div', 'tags'); top.append(el('span', 'meta', t.id));
  if (t.project && !state.filter) { const c = el('span', 'chip', roomName(t.project)); c.style.color = roomTint(t.project); top.append(c); }
  if (t.status === 'blocked') top.append(el('span', 'chip bad', __('blocked')));
  if (t.priority === 'high') top.append(el('span', 'chip bad', __('HIGH PRIORITY')));
  else if (t.priority === 'low') top.append(el('span', 'chip dim', __('low priority')));
  if (t.due && t.status !== 'done') { const [txt, cls] = dueLabel(t.due); top.append(el('span', `chip ${cls}`, txt)); }
  if (t.assignee && t.status === 'open') top.append(el('span', 'chip pink', __`for ${nameOf(t.assignee)}`));
  li.append(top, el('div', 't', t.title || __('(untitled)')));
  const warning = contentWarning(t); if (warning) li.append(warning);
  if (t.owner) {
    const o = el('div', 'meta tags');
    o.append(swatch(colorOf(map[t.owner] || { id: t.owner })), document.createTextNode(`${nameOf(t.owner)} · ${ago(t.updatedAt || t.createdAt)}`));
    li.append(o);
  }
  if ((t.resources || []).length) { const r = el('div', 'tags'); for (const x of t.resources) r.append(el('code', 'res', x)); li.append(r); }
  if (t.note) li.append(el('div', 'meta', t.note));
  return li;
}

function renderTasks() {
  const tasks = state.tasks.filter((t) => inFilter(t.project));
  const open = tasks.filter((t) => t.status === 'open').sort((a, b) => byUrgency(a, b) || a.createdAt - b.createdAt);
  const act = tasks.filter((t) => t.status === 'claimed' || t.status === 'blocked').sort((a, b) => byUrgency(a, b) || b.updatedAt - a.updatedAt);
  const done = tasks.filter((t) => t.status === 'done').sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 12);
  $('taskCount').textContent = __`${open.length} to assign · ${act.length} in progress`;
  for (const [id, arr, empty] of [['colOpen', open, __('No missions waiting.')], ['colActive', act, __('Nobody is working on a mission.')], ['colDone', done, __('No missions completed yet.')]]) {
    const ul = $(id); ul.replaceChildren();
    if (!arr.length) ul.append(el('li', 'empty', empty));
    for (const t of arr) ul.append(taskCard(t));
  }
}

function renderLocks() {
  const list = $('lockList'); list.replaceChildren(); const map = claudeById(); const now = Date.now();
  const locks = state.locks.filter((l) => inFilter(l.project));
  $('lockCount').textContent = locks.length ? __`${locks.filter((l) => l.expiresAt > now).length} active` : '';
  if (!locks.length) { list.append(el('li', 'empty', __('No resource locked.'))); return; }
  grouped(list, locks, (l) => l.project, (l) => {
    const li = el('li');
    li.style.setProperty('--c', l.expiresAt > now ? colorOf(map[l.owner] || { id: l.owner }) : 'var(--bad)');
    const top = el('div', 'tags'); top.append(el('code', 'res', l.resource));
    li.append(top, el('div', 'meta', `${nameOf(l.owner)} · ${l.reason || __('no reason')} · ${left(l.expiresAt)}`));
    // Your own agent's lock (e.g. it ran out of tokens): you can release it; others' locks are not yours to free.
    if (can(state.me, 'claudes.tokens') && state.me?.type === 'human' && map[l.owner]?.owner === state.me.userId && l.expiresAt > now) {
      const b = el('button', 'ghost danger', __('RELEASE')); b.type = 'button';
      b.title = __`Release ${nameOf(l.owner)}'s lock on ${l.resource}`;
      b.addEventListener('click', async () => {
        if (!confirm(__`Release ${nameOf(l.owner)}'s lock on ${l.resource}? The agent is told.`)) return;
        b.disabled = true;
        try { await api('POST', '/api/locks/release-human', { owner: l.owner, project: l.project, resource: l.resource }); poll(); } catch (err) { b.disabled = false; b.textContent = err.message; }
      });
      top.append(b);
    }
    const bar = el('div', 'ttl'); const i = el('i');
    i.style.width = `${Math.max(0, Math.min(100, ((l.expiresAt - now) / Math.max(1, l.expiresAt - l.createdAt)) * 100))}%`;
    bar.append(i); li.append(bar); return li;
  });
}

function renderDecisions() {
  const list = $('decList'); list.replaceChildren();
  const ds = state.decisions.filter((d) => inFilter(d.project));
  $('decCount').textContent = ds.length ? String(ds.length) : '';
  if (!ds.length) { list.append(el('li', 'empty', __('No decisions recorded.'))); return; }
  grouped(list, ds, (d) => d.project, (d) => {
    const li = el('li', 'card'); li.style.setProperty('--rc', roomTint(d.project));
    li.append(el('div', 'meta', `${nameOf(d.by)} · ${ago(d.createdAt)}`), el('div', 't', d.text)); return li;
  });
}

let ctxKey = '';
function renderContext() {
  const box = $('ctxList');
  const cs = state.contexts.filter((c) => inFilter(c.project));
  // Rebuilt only when something changed (not every 4 s), and what the reader opened stays open.
  const key = JSON.stringify(cs.map((c) => [c.project, c.version, c.updatedBy, ago(c.updatedAt), roomName(c.project), c.content]));
  if (key === ctxKey) return;
  ctxKey = key;
  const wasOpen = new Set([...box.querySelectorAll('details[open]')].map((d) => d.dataset.project));
  box.replaceChildren();
  if (!cs.length) { box.append(el('p', 'empty', __('No context saved. The first agent working on a project writes it here.'))); return; }
  for (const c of cs) { const d = el('details'); d.dataset.project = c.project; d.open = wasOpen.has(c.project); d.style.setProperty('--rc', roomTint(c.project)); d.append(el('summary', null, __`${roomName(c.project)} — v${c.version}, updated ${ago(c.updatedAt)} by ${nameOf(c.updatedBy)}`), el('pre', null, c.summary)); const warning = contentWarning(c); if (warning) d.append(warning); box.append(d); }
}

/** Room tabs: "All rooms", the Bridge, one per room (with who is inside), then old projects without a room. */
let tabsKey = '';
function renderFilter() {
  const rooms = [...(state.rooms || [])].sort((a, b) => roomRank(a.project).localeCompare(roomRank(b.project)));
  const tabs = rooms.map((r) => ({ p: r.project, name: r.name, n: state.claudes.filter((c) => c.room === r.id && !isAway(c)).length }));
  const known = new Set(rooms.map((r) => r.project));
  const legacy = new Set();
  for (const arr of [state.tasks, state.locks, state.decisions, state.contexts, state.claudes]) for (const x of arr) if (x.project && !known.has(x.project)) legacy.add(x.project);
  for (const p of [...legacy].sort()) tabs.push({ p, name: __`${p} (no room)`, n: state.claudes.filter((c) => !c.room && c.project === p && !isAway(c)).length });
  tabs.unshift({ p: '', name: __('All rooms'), n: state.claudes.filter((c) => !isAway(c)).length });
  if (!tabs.some((t) => t.p === state.filter)) state.filter = '';
  const key = JSON.stringify([tabs, state.filter]);
  if (key !== tabsKey) { // rebuilt only on change, so keyboard focus survives the 4 s poll
    tabsKey = key;
    $('roomTabs').replaceChildren(...tabs.map((t) => {
      const b = el('button', null, t.name); b.type = 'button';
      b.style.setProperty('--rc', t.p ? roomTint(t.p) : 'var(--teal)');
      b.setAttribute('aria-pressed', String(t.p === state.filter));
      b.append(el('span', 'n', String(t.n)));
      b.addEventListener('click', () => goRoom(t.p));
      return b;
    }));
  }
  // Summary of the room on screen (or of the whole station) and its colour on the panel titles.
  const f = state.filter, now = Date.now();
  const crew = state.claudes.filter(inRoom);
  const tasks = state.tasks.filter((t) => inFilter(t.project));
  const room = roomByProject(f);
  const bits = [
    !f && __`${rooms.length} rooms`,
    __`${crew.filter((c) => !isAway(c)).length} on board`,
    __`${crew.filter((c) => !isAway(c) && c.status === 'working').length} working`,
    __`${tasks.filter((t) => t.status === 'open').length} missions to assign`,
    __`${tasks.filter((t) => t.status === 'claimed' || t.status === 'blocked').length} in progress`,
    __`${state.locks.filter((l) => l.expiresAt > now && inFilter(l.project)).length} locks`,
    room?.type && room.kind !== 'bridge' && __`${room.type} project`,
  ].filter(Boolean);
  const bar = $('roomBar');
  // The room's logbook: the Bridge's when looking at the whole station.
  const diary = el('a', 'diary-link', __('📜 Logbook')); diary.href = '#journal';
  bar.replaceChildren(el('b', null, f ? roomName(f).toUpperCase() : __('THE WHOLE STATION')), bits.join(' · '), ' · ', diary);
  const wrap = document.querySelector('.wrap');
  if (f) wrap.style.setProperty('--room', roomTint(f)); else wrap.style.removeProperty('--room');
}

// ---------- log: recent commits + current deploy (written by the deploy workflow) ----------
animateAvatar($('avatar'), () => state.me?.avatar); // header avatar, the account's choice
let lastDeploy = null;
let partyFrom = -1e9; // performance.now() of the last deploy party
async function loadLog() {
  const info = $('deployInfo'); const list = $('commitList');
  let log;
  try { log = await api('GET', '/api/log'); } catch { info.textContent = __('Log not available.'); return; }
  const d = log.deploy;
  if (d && lastDeploy && d.sha !== lastDeploy.sha) play('sting'); // a new version went live
  lastDeploy = d;
  if (d) {
    let seen = null;
    try { seen = localStorage.getItem('stazione.deploySeen'); localStorage.setItem('stazione.deploySeen', d.sha); } catch { /* not remembered */ }
    if (seen && seen !== d.sha && !reduced) partyFrom = performance.now(); // first visit: nothing to celebrate
  }
  list.replaceChildren();
  $('logCount').textContent = log.commits.length ? String(log.commits.length) : '';
  if (!d) { info.textContent = __('No deploy recorded: the log fills up at the next deploy that writes build-info.json.'); return; }
  const link = (href, text) => { const a = el('a', null, text); a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; return a; };
  const when = new Date(d.at).toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' });
  info.replaceChildren(__('Last deploy: '), link(`${d.repo}/commit/${d.sha}`, d.sha.slice(0, 7)), __` · ${when} (${ago(d.at)}) · started by ${d.by}`, ...(d.run ? [' · ', link(d.run, __('details'))] : []));
  for (const c of log.commits) {
    const li = el('li', `commit${c.sha === d.sha.slice(0, 7) ? ' live' : ''}`);
    li.append(link(`${d.repo}/commit/${c.sha}`, c.sha), el('span', 't', c.subject), el('span', 'meta', `${c.author} · ${ago(c.at)}`));
    list.append(li);
  }
}
loadLog();
setInterval(loadLog, 2 * 60e3);

// ---------- approvals ----------
let approvals = [];
let policies = [];
async function loadApprovals() {
  if (state.me?.type !== 'human') { approvals = []; $('approvalsPanel').hidden = true; return; }
  if (!state.pendingApprovals && !approvals.length) { $('approvalsPanel').hidden = true; return; }
  try {
    const r = await api('GET', '/api/approvals');
    approvals = r.approvals; policies = r.policies;
    renderApprovals();
  } catch { /* shown on next poll */ }
}

function renderApprovals() {
  const panel = $('approvalsPanel'); const list = $('apList');
  panel.hidden = approvals.length === 0;
  $('apCount').textContent = approvals.length ? String(approvals.length) : '';
  list.replaceChildren();
  for (const a of approvals) {
    const li = el('li', 'approval');
    li.append(
      el('div', null, `${a.from_name || a.from_claude} → ${nameOf(a.to_target)}${a.project ? ` · ${a.project}` : ''}`),
      el('div', 'meta', __`Detected: ${(a.detected || []).join(', ')} · expires in ${left(a.approval_expires_at)}`),
    );
    if (a.reason) li.append(el('div', 'meta', __`Reason: ${a.reason}`));
    if (a.review?.required === 2) li.append(el('div', 'meta', __`Approvals: ${a.review.approvals} / ${a.review.required}`));
    li.append(el('div', 'revealed', revealed.get(a.id) || a.preview));
    const opts = el('div', 'opts');
    const view = el('button', 'ghost', revealed.has(a.id) ? __('CONTENT SHOWN') : __('SEE FULL CONTENT'));
    view.type = 'button'; view.disabled = revealed.has(a.id);
    view.addEventListener('click', () => reveal(a.id, view).then(renderApprovals));
    opts.append(view);
    for (const p of policies) {
      const b = el('button', p.id === 'deny' ? 'danger' : '', __(p.label).toUpperCase());
      b.type = 'button';
      b.disabled = p.id !== 'deny' && Boolean(a.review?.voted || (a.review?.proposal && a.review.proposal !== p.id));
      b.addEventListener('click', async () => {
        opts.querySelectorAll('button').forEach((x) => { x.disabled = true; });
        try {
          const result = await api('POST', `/api/approvals/${encodeURIComponent(a.id)}`, { policy: p.id });
          revealed.delete(a.id);
          if (result.status === 'pending') a.review = result.review; else approvals = approvals.filter((x) => x.id !== a.id);
          renderApprovals(); poll();
        } catch (err) {
          opts.querySelectorAll('button').forEach((x) => { x.disabled = false; });
          li.append(el('div', 'status-line err', err.message));
        }
      });
      opts.append(b);
    }
    li.append(opts);
    list.append(li);
  }
}

// ---------- asks: permission for drastic actions (fallback when Telegram is not linked) ----------
let asks = [];
async function loadAsks() { // opinions are shown by notifications.js
  if (state.me?.type !== 'human') { asks = []; $('asksPanel').hidden = true; return; }
  if (!state.pendingAsks && !asks.length) { $('asksPanel').hidden = true; return; }
  try { asks = (await api('GET', '/api/asks')).asks.filter((a) => a.kind !== 'opinion'); renderAsks(); } catch { /* shown on next poll */ }
}
function renderAsks() {
  const list = $('askList');
  $('asksPanel').hidden = asks.length === 0;
  $('askCount').textContent = asks.length ? String(asks.length) : '';
  list.replaceChildren();
  for (const a of asks) {
    const li = el('li', 'approval');
    li.append(
      el('div', null, `${nameOf(a.claude)}${a.project ? ` · ${a.project}` : ''}`),
      el('div', 'revealed', a.text),
      el('div', 'meta', __`Asked ${ago(a.createdAt)} · expires in ${left(a.expiresAt)}`),
    );
    if (a.review?.required === 2) li.append(el('div', 'meta', __`Approvals: ${a.review.approvals} / ${a.review.required}`));
    const opts = el('div', 'opts');
    for (const [label, approve, cls] of [[__('APPROVE'), true, ''], [__('REJECT'), false, 'danger']]) {
      const b = el('button', cls, label); b.type = 'button';
      b.disabled = approve && Boolean(a.review?.voted);
      b.addEventListener('click', async () => {
        opts.querySelectorAll('button').forEach((x) => { x.disabled = true; });
        try {
          const result = await api('POST', `/api/asks/${encodeURIComponent(a.id)}`, { approve });
          if (result.status === 'pending') a.review = result.review; else asks = asks.filter((x) => x.id !== a.id); renderAsks(); poll();
        } catch (err) {
          opts.querySelectorAll('button').forEach((x) => { x.disabled = false; });
          li.append(el('div', 'status-line err', err.message));
        }
      });
      opts.append(b);
    }
    li.append(opts);
    list.append(li);
  }
}

/** "Assign to" in the new-mission form: every registered agent, keeping the current choice across polls. */
function renderAssignees() {
  const sel = $('fTo'); const cur = sel.value;
  const crew = state.claudes.filter(inRoom).sort((a, b) => (isAway(a) - isAway(b)) || (a.name || a.id).localeCompare(b.name || b.id));
  sel.replaceChildren(new Option(__('Whoever is free'), ''), ...crew.map((c) => new Option(`${label(c)}${isAway(c) ? __(' (offline)') : ''}`, c.id)));
  sel.value = crew.some((c) => c.id === cur) ? cur : '';
}

function renderAll() { renderAssignees(); renderFilter(); renderCrew(); renderMsgs(); renderTasks(); renderLocks(); renderDecisions(); renderContext(); renderPolls(); renderProject(); renderNotifications(); updateJournal(roomByProject(state.filter)?.id ?? (state.filter || 'bridge'), nameOf); updateStats(roomByProject(state.filter)?.id ?? state.filter); }

// ---------- data ----------
const conn = $('conn');
const setConn = (txt, cls) => { conn.textContent = txt; conn.className = `chip ${cls}`; };
let timer = null;
const updateJournal = mountJournal($('journal'));
const updateStats = mountStats($('stats'));
const renderPolls = initPolls({ state, nameOf, roomName, roomTint, inFilter, roomByProject, ago, left, poll: () => poll() });
const renderProject = initProject({ state, nameOf, roomName, roomTint, goRoom: (p) => goRoom(p), poll: () => poll() });
const renderNotifications = initNotifications({ state, nameOf, roomName, roomTint, inFilter, goRoom: (p) => goRoom(p), ago, left, poll: () => poll() });
/** Sounds for what changed since the last poll (nothing on the first load): messages, finished missions, recaps. */
let heard = null;
function soundsFor(s) {
  const now = { msg: Math.max(0, ...s.messages.map((m) => m.id)), done: new Set(s.tasks.filter((t) => t.status === 'done').map((t) => t.id)), recap: Math.max(0, ...(s.recaps || []).map((r) => r.id)) };
  if (heard) {
    if ([...now.done].some((id) => !heard.done.has(id))) play('game');
    else if (now.recap > heard.recap) play('swish');
    else if (now.msg > heard.msg) play('blip');
  }
  heard = now;
}
initSounds();
async function poll() {
  clearTimeout(timer);
  try {
    const s = await api('GET', '/api/state');
    soundsFor(s);
    Object.assign(state, s);
    state.organizationMe = s.me;
    adminLink.hidden = !can(s.me, 'admin.console');
    applyRoomPermissions();
    $('newTask').hidden = !can(state.me, 'missions.create');
    for (const id of ['fTo', 'fPrio', 'fDue']) {
      $(id).closest('label').hidden = !can(state.me, 'missions.assign');
      $(id).disabled = !can(state.me, 'missions.assign');
    }
    document.querySelector('a[href="/ideas"]').hidden = !can(s.me, 'ideas.use') && !s.rooms.some((r) => r.permissions?.includes('ideas.use'));
    $('who').textContent = s.me.username; $('who').hidden = false;
    setConn(__('Connected'), 'ok');
    renderAll();
    loadApprovals(); loadAsks(); renderNotifications(true);
  } catch (err) {
    if (err.status === 401) { location.replace('/login'); return; }
    setConn(__('Connection lost'), 'bad');
  }
  if (!document.hidden) timer = setTimeout(poll, POLL_MS);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
poll();

$('logout').addEventListener('click', async () => {
  try { await api('POST', '/api/auth/logout', {}); } finally { location.replace('/login'); }
});

$('newTask').addEventListener('submit', async (e) => {
  e.preventDefault(); const msg = $('formMsg');
  if (!can(state.me, 'missions.create')) return;
  const title = $('fTitle').value.trim(); if (!title) return;
  try {
    const to = can(state.me, 'missions.assign') ? $('fTo').value : '';
    const assignment = can(state.me, 'missions.assign') ? { priority: $('fPrio').value, due: $('fDue').value, ...(to && { to }) } : {};
    const r = await api('POST', '/api/tasks', { title, project: $('fProject').value.trim() || state.filter, resources: $('fRes').value, ...assignment });
    say(msg, to ? __`Mission ${r.id} launched and assigned to ${nameOf(to)}.` : __`Mission ${r.id} launched.`, 'good'); $('fTitle').value = ''; $('fRes').value = ''; $('fDue').value = ''; $('fPrio').value = 'normal'; poll();
  } catch (err) { say(msg, err.message, 'err'); }
});

// ---------- scene ----------
const W = 320, H = 180, S = 2, SH_ = LOUNGE.y0 + LOUNGE.h; // H: main room; SH_: whole scene with the lounge below
const cv = $('scene'), g = cv.getContext('2d'); g.imageSmoothingEnabled = false;
const R = (x, y, w, h, c) => { g.fillStyle = c; g.fillRect(Math.round(x) * S, Math.round(y) * S, w * S, h * S); };
const T = (txt, x, y, c, size = 16, align = 'center') => { g.font = `${size}px VT323, Consolas, monospace`; g.textAlign = align; g.textBaseline = 'alphabetic'; g.fillStyle = c; g.fillText(txt, x * S, y * S); };
const SLOT_X = [30, 82, 134, 186, 238, 290];
const TOP_FY = 54, BOT_FY = 168, HUB = { x: 160, y: 104, rx: 48, ry: 18 };
const WIN = { x: 104, y: 5, w: 112, h: 24 };
const FRIDGE = FRIDGE_SPOT; // the mini fridge stands in the lounge
const FRIDGE_EVERY = 75e3, FRIDGE_STAY = 11e3; // an idle agent walks to the fridge for a drink once in a while
const SIP_EVERY = 11e3, SIP_FOR = 1400;
const CAN = '#ece6d2'; // coffee mug
const SH = { R, T, shade }; // drawing helpers handed to lounge.js
const clip = (s, n) => { s = String(s || ''); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

// Stars seen through the window (they twinkle), kept inside the glass and away from the planet.
const stars = Array.from({ length: 46 }, (_, i) => ({ x: WIN.x + 1 + (hash(`x${i}`) % (WIN.w - 2)), y: WIN.y + 1 + (hash(`y${i}`) % (WIN.h - 2)), b: hash(`b${i}`) % 3 }))
  .filter((s) => (s.x - 192) ** 2 + (s.y - 33) ** 2 > 21 ** 2 && Math.abs(s.x - 160) > 1);

const bg = document.createElement('canvas'); bg.width = W * S; bg.height = SH_ * S;
(function paintBg() {
  const b = bg.getContext('2d'); const P = (x, y, w, h, c) => { b.fillStyle = c; b.fillRect(x * S, y * S, w * S, h * S); };
  // floor: bevelled metal plates, darker towards the walls
  P(0, 0, W, H, '#0d1336');
  for (let y = 35; y < H; y += 14) for (let x = 0; x < W; x += 20) {
    const alt = ((x / 20) + Math.floor(y / 14)) % 2;
    P(x, y, 20, 14, alt ? '#121a48' : '#10173f'); P(x, y, 20, 1, '#1b245a'); P(x, y, 1, 14, '#18214f'); P(x, y + 13, 20, 1, '#0a0f2e');
    if ((hash(`${x}:${y}`) % 5) === 0) { P(x + 2, y + 2, 1, 1, '#24306e'); P(x + 17, y + 2, 1, 1, '#24306e'); P(x + 2, y + 11, 1, 1, '#24306e'); P(x + 17, y + 11, 1, 1, '#24306e'); }
  }
  // walkway from the door (left) to the hub and beyond, with guide lights
  P(0, HUB.y - 3, W, 7, '#151d4d'); P(0, HUB.y - 3, W, 1, '#202a63'); P(0, HUB.y + 3, W, 1, '#0a0f2e');
  for (let x = 4; x < W; x += 12) if (Math.abs(x - HUB.x) > HUB.rx + 8) P(x, HUB.y, 2, 1, '#2a6f7a');
  // back wall: panels, seams, rivets, ceiling pipes
  P(0, 0, W, 34, '#1b2254');
  for (let x = 0; x < W; x += 32) { P(x, 0, 1, 34, '#131944'); P(x + 1, 0, 1, 34, '#252f6b'); for (const yy of [5, 28]) { P(x + 4, yy, 1, 1, '#3a4585'); P(x + 27, yy, 1, 1, '#3a4585'); } }
  P(0, 0, W, 3, '#2b3574'); P(0, 1, W, 1, '#39447f'); P(0, 3, W, 1, '#0e1438');
  for (let x = 10; x < W; x += 60) { P(x, 0, 4, 4, '#4a5494'); P(x, 4, 4, 1, '#0e1438'); }
  // hazard strip at the base of the wall
  for (let x = 0; x < W; x += 8) { P(x, 32, 4, 3, '#b5822f'); P(x + 4, 32, 4, 3, '#2a2352'); }
  P(0, 31, W, 1, '#39447f');
  // big window: deep space gradient, faint nebula, a ringed planet and a small moon
  P(WIN.x - 3, WIN.y - 2, WIN.w + 6, WIN.h + 4, '#4a5494'); P(WIN.x - 2, WIN.y - 1, WIN.w + 4, WIN.h + 2, '#2b3574');
  const sky = ['#020312', '#030418', '#04061d', '#060823', '#080a2a', '#0a0c31'];
  for (let y = 0; y < WIN.h; y++) P(WIN.x, WIN.y + y, WIN.w, 1, sky[Math.min(sky.length - 1, Math.floor(y / 4))]);
  for (let i = 0; i < 90; i++) { const x = hash(`nx${i}`) % 60, y = hash(`ny${i}`) % WIN.h; if ((x - 30) ** 2 / 900 + (y - 10) ** 2 / 100 < 1) P(WIN.x + 6 + x, WIN.y + y, 1, 1, i % 3 ? '#1a1240' : '#2a1850'); }
  const PX = 192, PY = 33, PR = 20;
  for (let y = -PR; y <= PR; y++) for (let x = -PR; x <= PR; x++) {
    const d = x * x + y * y; if (d > PR * PR) continue; const sx = PX + x, sy = PY + y;
    if (sx < WIN.x || sx >= WIN.x + WIN.w || sy < WIN.y || sy >= WIN.y + WIN.h) continue;
    const light = (-x - y) / PR + (1 - Math.sqrt(d) / PR) * 0.8; const band = Math.floor((y + 40) / 5) % 2;
    P(sx, sy, 1, 1, light > 1.0 ? '#ffb08a' : light > 0.55 ? (band ? '#f0806a' : '#e46f64') : light > 0.1 ? (band ? '#b8485c' : '#a8435a') : light > -0.4 ? '#732c50' : '#43193c');
  }
  for (let x = -34; x <= 34; x++) { const y = Math.round(x * 0.22 + Math.sqrt(Math.max(0, 1 - (x / 34) ** 2)) * 3); const sx = PX + x, sy = PY - 4 + y; if (sx >= WIN.x && sx < WIN.x + WIN.w && sy >= WIN.y && sy < WIN.y + WIN.h && (x * x + (sy - PY) ** 2 > PR * PR || y > 0)) P(sx, sy, 1, 1, Math.abs(x) > 28 ? '#a88a66' : '#ffd9a0'); }
  for (let y = -3; y <= 3; y++) for (let x = -3; x <= 3; x++) if (x * x + y * y <= 9) P(126 + x, 12 + y, 1, 1, x + y < -1 ? '#eef2ff' : x + y < 2 ? '#b9c1e0' : '#6f78a6');
  P(WIN.x + WIN.w / 2 - 1, WIN.y, 2, WIN.h, '#4a5494'); P(WIN.x, WIN.y + 11, WIN.w, 1, '#2b357455');
  P(WIN.x + 2, WIN.y + 2, 10, 1, '#ffffff22'); P(WIN.x + 2, WIN.y + 3, 6, 1, '#ffffff14');
  // deck signs and the door on the left wall
  for (const x of [12, 238]) { P(x, 8, 70, 12, '#0a0f2c'); P(x, 8, 70, 1, '#39447f'); P(x, 19, 70, 1, '#05081c'); }
  // soft glow under the hub and a dark vignette at the edges
  const glow = b.createRadialGradient(HUB.x * S, HUB.y * S, 4, HUB.x * S, HUB.y * S, 90 * S);
  glow.addColorStop(0, '#3ee6c92a'); glow.addColorStop(1, '#3ee6c900'); b.fillStyle = glow; b.fillRect(0, 34 * S, W * S, (H - 34) * S);
  const vig = b.createRadialGradient(W * S / 2, H * S / 2, 60 * S, W * S / 2, H * S / 2, 200 * S);
  vig.addColorStop(0, '#00000000'); vig.addColorStop(1, '#00000070'); b.fillStyle = vig; b.fillRect(0, 0, W * S, H * S);
  // hub platform: bevelled ring with a lit rim
  for (let y = -HUB.ry - 3; y <= HUB.ry + 3; y++) for (let x = -HUB.rx - 6; x <= HUB.rx + 6; x++) {
    const e = (x * x) / ((HUB.rx + 6) ** 2) + (y * y) / ((HUB.ry + 3) ** 2); const e2 = (x * x) / (HUB.rx ** 2) + (y * y) / (HUB.ry ** 2);
    if (e <= 1) { let c = e2 <= 1 ? ((Math.abs(x) + Math.abs(y * 2)) % 10 < 5 ? '#1f2963' : '#1b2459') : '#2e3a80'; if (e2 > 0.86 && e2 <= 1) c = '#3ee6c9'; if (e2 > 0.95 && e2 <= 1 && ((x + 60) % 8 < 4)) c = '#1c7a70'; P(HUB.x + x, HUB.y + y, 1, 1, c); }
  }
  for (let y = 0; y < 4; y++) for (let x = -HUB.rx - 6; x <= HUB.rx + 6; x++) { const yy = Math.round((HUB.ry + 3) * Math.sqrt(Math.max(0, 1 - (x * x) / ((HUB.rx + 6) ** 2)))); P(HUB.x + x, HUB.y + yy + y, 1, 1, y < 2 ? '#26306e' : '#161d4c'); }
  paintLounge(P);
})();
const BRIDGE_TABLE = { x: HUB.x, y: HUB.y, rx: 26, ry: 8 }; // the hub's place: whoever is in comms stands around it
const bgBridge = document.createElement('canvas'); bgBridge.width = bg.width; bgBridge.height = bg.height;
(function paintBridgeBg() {
  const b = bgBridge.getContext('2d'); b.drawImage(bg, 0, 0);
  paintBridge((x, y, w, h, c) => { b.fillStyle = c; b.fillRect(x * S, y * S, w * S, h * S); }, W, H, BRIDGE_TABLE);
})();

// ---------- rooms: which one is on screen, the station map, clicks ----------
/** The room on screen, or null for the station map ("All rooms"). A project without a room gets a plain office. */
const currentRoom = () => (!state.filter ? null
  : (state.rooms || []).find((r) => r.project === state.filter) ?? { id: `p:${state.filter}`, name: state.filter, kind: 'project', project: state.filter });
const crewStatus = (c) => (isAway(c) ? 'offline' : atHub(c) ? 'comms' : c.status === 'working' ? 'working' : 'idle');
function mapModel() {
  const rooms = [...(state.rooms || [])];
  for (const c of state.claudes) if (!c.room && c.project && !rooms.some((r) => r.project === c.project)) rooms.push({ id: `p:${c.project}`, name: c.project, kind: 'project', project: c.project });
  return rooms.map((room) => ({
    room,
    crew: state.claudes.filter((c) => (c.room === room.id || (!c.room && c.project === room.project)) && crewStatus(c) !== 'idle').map((c) => ({ id: c.id, color: colorOf(c), status: crewStatus(c), role: roleOf(c) })),
    tasks: state.tasks.filter((t) => t.project === room.project && t.status !== 'done').length,
    milestones: room.milestones?.length ? [room.milestones.filter((m) => m.done).length, room.milestones.length] : null,
    vote: voteFor(room),
  }));
}
/** The vote a room should notice: an open one (its own or station-wide), else the one that needs a human. */
const voteFor = (room) => (state.polls || []).find((p) => p.status !== 'closed' && (!p.room || p.room === room?.id)) || null;
function bridgeInfo() {
  const now = Date.now();
  return {
    open: state.tasks.filter((t) => t.status === 'open').length,
    active: state.tasks.filter((t) => t.status === 'claimed' || t.status === 'blocked').length,
    locks: state.locks.filter((l) => l.expiresAt > now).length,
    // The most urgent unfinished mission, shown on the big screen when it is high priority or due within 2 days.
    urgent: (() => {
      const t = state.tasks.filter((x) => x.status !== 'done' && (x.priority === 'high' || (x.due && daysTo(x.due) <= 2))).sort(byUrgency)[0];
      return t && { title: t.title, due: t.due && dueLabel(t.due)[0] };
    })(),
    deploy: lastDeploy && `${lastDeploy.sha.slice(0, 7)} ${ago(lastDeploy.at)}`,
    // The vote going on (with who is ahead), or the result of the last one of the day.
    vote: (() => {
      const p = (state.polls || []).find((x) => x.status !== 'closed') || (state.polls || []).find((x) => x.winner && now - x.closedAt < 86400e3);
      if (!p) return null;
      const top = Math.max(...p.counts);
      return { open: p.status === 'open', tie: p.status === 'tie', question: p.question, line: p.winner ? __`WINNER: ${p.winner}` : p.status === 'tie' ? __('TIE: YOU CHOOSE') : __`${p.ballots.length} VOTES` + (top ? __` · AHEAD: ${p.options[p.counts.indexOf(top)]}` : '') };
    })(),
    rooms: (state.rooms || []).map((r) => ({ color: roomColor(r), busy: state.claudes.filter((c) => c.room === r.id && crewStatus(c) === 'working').length })),
  };
}
let mapBoxes = [], hoverProject = null;
const BACK = { x: 238, y: 8, w: 70, h: 12 }; // the right-hand sign in a room: back to the map
const inside = (p, b) => p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
function applyRoomPermissions() {
  const room = roomByProject(state.filter);
  state.me = room?.permissions ? { ...state.organizationMe, role: room.role, roleName: room.roleName, permissions: room.permissions } : state.organizationMe;
  $('newTask').hidden = !can(state.me, 'missions.create');
  for (const id of ['fTo', 'fPrio', 'fDue']) { $(id).closest('label').hidden = !can(state.me, 'missions.assign'); $(id).disabled = !can(state.me, 'missions.assign'); }
}
function goRoom(project) { if (project !== state.filter) play('whoosh'); state.filter = project; applyRoomPermissions(); renderAll(); }

// Astronaut, 14 px wide, facing right. o outline, W suit, s suit shade, c/C crew colour, v visor, h visor glint,
// p backpack, g gloves and boots, l antenna light.
const HEAD = [
  '......l.......',
  '......o.......',
  '.....oooo.....',
  '...ooWWWWoo...',
  '..oWWvvvvvWo..',
  '..oWvhvvvvvWo.',
  '..oWvvvvvvvWo.',
  '..oWWvvvvvWWo.',
  '...oWWWWWWWo..',
  '..oocccccccoo.',
  '.opWWWWWWWWWo.',
  '.opWcCWWWWsWo.',
  '.opWCcWWWWsWo.',
  '.opWWWWWWWWgo.',
  '..oWWWWWWWWo..',
  '..occcccccco..',
  '..oWWWsoWWWo..',
];
const LEGS = [
  ['..oWWso.oWWo..', '..oWWo..oWWo..', '..oggo..oggo..', '..oooo..oooo..'],
  ['..oWWo...oWWo.', '.oWWo.....oWWo', '.oggo.....oggo', '.oooo.....oooo'],
  ['...oWWooWWo...', '...oWWooWWo...', '...oggooggo...', '...oooooooo...'],
];
/** o: { t, sleep, legs (0 still, 1-2 walk), face (1 right, -1 left), typing, sipping, holdingCan, bob } */
function drawBot(x, y, color, o) {
  const rows = HEAD.concat(LEGS[o.legs || 0]); const top = Math.round(y - 19 + (o.bob || 0)), lft = Math.round(x - 7);
  const pal = {
    o: '#070a1f', ...suit(o.role), c: color, C: shade(color, 0.62), p: '#5d6590', g: '#3b4270',
    v: o.sleep ? '#0c1130' : '#1b2a66', h: o.sleep ? '#1f2a55' : '#8fe9ff', l: (o.t % 1000 < 500) ? color : '#3a3f66',
  };
  g.globalAlpha = o.sleep ? 0.6 : 1;
  R(lft + 2, Math.round(y) + 1, 10, 1, '#0000004d'); // shadow on the floor
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    for (let c = 0; c < 14; c++) { const ch = row[c]; if (ch !== '.') R(lft + (o.face < 0 ? 13 - c : c), top + r, 1, 1, pal[ch]); }
  }
  const side = (c) => lft + (o.face < 0 ? 13 - c : c); // mirrored column
  hat(R, o.role, side, top);
  if (o.sipping) { R(side(12), top + 9, 1, 3, pal.g); drawCan(side(12) - (o.face < 0 ? 1 : 0), top + 5); }
  else if (o.typing) { const up = Math.floor(o.t / 160) % 2; R(side(13), top + 11 + up, 1, 2, pal.g); }
  else if (o.holdingCan) drawCan(side(13) - (o.face < 0 ? 1 : 0), top + 11);
  g.globalAlpha = o.sleep ? 0.6 : 1;
  if (!o.sipping && !o.typing && !o.holdingCan) tool(R, o.role, side(13), top + 12, o.face < 0 ? -1 : 1, o.t);
  g.globalAlpha = 1;
}
function drawCan(x, y) { R(x, y + 1, 2, 3, CAN); R(x, y + 1, 2, 1, '#5a3a22'); R(x + 2, y + 2, 1, 1, CAN); } // mug of coffee

function drawChair(x, fy) {
  const cx = x - 4, top = fy - 16;
  R(cx - 8, top, 16, 11, '#070a1f'); R(cx - 7, top + 1, 14, 9, '#2a3270'); R(cx - 7, top + 1, 14, 1, '#3d478c'); R(cx - 6, top + 3, 12, 1, '#232a60');
  R(cx - 1, top + 11, 2, 4, '#3b4270');
}
function drawDesk(x, fy, color, occ, t) {
  const top = fy - 6; const on = occ && occ.working;
  // monitor with a glow when someone is working
  if (on) R(x + 3, top - 15, 18, 14, `${color}22`);
  R(x + 5, top - 13, 14, 11, '#070a1f'); R(x + 6, top - 12, 12, 9, '#39447f'); R(x + 7, top - 11, 10, 7, on ? '#07282a' : '#0a0f2c');
  if (on) { for (let i = 0; i < 3; i++) { const w = 2 + ((hash(x + i) + Math.floor(t / 180)) % 7); R(x + 8, top - 10 + i * 2, Math.min(8, w), 1, i === 1 ? '#ece6d2' : color); } }
  else if (occ && !occ.sleep && t % 1000 < 500) R(x + 8, top - 10, 1, 2, color);
  else if (!occ) { R(x + 8, top - 10, 3, 1, '#1b2459'); }
  R(x + 11, top - 3, 2, 3, '#39447f'); R(x + 9, top - 1, 6, 1, '#4a5494');
  // desk top, keyboard, mug
  R(x - 18, top, 36, 1, '#070a1f'); R(x - 18, top + 1, 36, 2, '#5a66a8'); R(x - 18, top + 3, 36, 1, '#3a4585');
  R(x - 9, top, 10, 1, '#9aa3c7'); R(x - 9, top + 1, 10, 1, '#6f78a6');
  if (occ && !occ.sipping) drawCan(x - 15, top - 4);
  // front panel with status LEDs
  R(x - 17, top + 4, 34, 7, '#222a5e'); R(x - 17, top + 4, 34, 1, '#2e3875'); R(x - 17, top + 10, 34, 1, '#0a0e2a');
  R(x + 15, top + 5, 1, 1, occ ? (occ.sleep ? '#ffb547' : '#b6f24a') : '#3a3f66'); R(x + 15, top + 8, 1, 1, on && t % 700 < 350 ? color : '#3a3f66');
  if (occ) {
    R(x - 16, top + 5, 30, 5, '#0a0f2c'); R(x - 16, top + 5, 30, 1, shade(color, 0.7));
    if (occ.locks > 0) { const lx = x + 2, ly = top - 5; R(lx, ly + 2, 5, 4, '#ffb547'); R(lx + 1, ly, 3, 1, '#ffb547'); R(lx + 1, ly + 1, 1, 1, '#ffb547'); R(lx + 3, ly + 1, 1, 1, '#ffb547'); R(lx + 2, ly + 3, 1, 2, '#7a3b00'); }
  }
}
function drawFridge(open, t) {
  const x = FRIDGE.x - 7, y = FRIDGE.y - 18;
  R(x + 1, FRIDGE.y + 1, 13, 1, '#0000004d');
  R(x, y, 14, 18, '#070a1f'); R(x + 1, y + 1, 12, 16, '#c9cfe6'); R(x + 1, y + 1, 12, 1, '#eef2ff'); R(x + 1, y + 6, 12, 1, '#8a93b8');
  R(x + 3, y + 3, 5, 1, '#8fe9ff'); R(x + 3, y + 2, 1, 1, '#070a1f');
  if (!open) { R(x + 11, y + 8, 1, 5, '#5d6590'); return; }
  // door swung open to the right, lit interior with water bottles and juice
  R(x + 1, y + 7, 12, 10, '#dff9ff');
  for (let r = 0; r < 2; r++) for (let c = 0; c < 4; c++) R(x + 2 + c * 3, y + 8 + r * 4, 2, 3, (c + r) % 3 === 2 ? '#ffb547' : '#8fe9ff');
  R(x + 1, y + 11, 12, 1, '#8a93b8');
  R(x + 14, y + 6, 3, 12, '#070a1f'); R(x + 14, y + 7, 2, 10, '#a9b0cc');
  g.globalAlpha = 0.1 + (t % 1200 < 600 ? 0.03 : 0); R(x + 1, FRIDGE.y + 1, 16, 3, '#dff9ff'); g.globalAlpha = 1;
}
function drawRack(x, t) {
  R(x, 5, 12, 26, '#070a1f'); R(x + 1, 6, 10, 24, '#262e66');
  for (let i = 0; i < 5; i++) {
    const y = 7 + i * 5; R(x + 2, y, 8, 3, '#141a45');
    const blink = (Math.floor(t / (300 + i * 70)) + i + x) % 3;
    R(x + 3, y + 1, 1, 1, blink === 0 ? '#b6f24a' : '#2a4020'); R(x + 5, y + 1, 1, 1, blink === 1 ? '#3ee6c9' : '#1c3a40'); R(x + 7, y + 1, 2, 1, '#39447f');
  }
}
function drawPlant(x, y, t) {
  const sway = reduced ? 0 : (Math.floor(t / 900) % 2);
  R(x - 4, y - 5, 8, 6, '#070a1f'); R(x - 3, y - 4, 6, 5, '#8a5a3c'); R(x - 3, y - 4, 6, 1, '#a8704a');
  const leaves = [[-1, -8], [0, -10], [1, -8], [-3, -7], [3, -7], [-2, -11], [2, -11], [0, -13], [-4, -9], [4, -9]];
  for (const [dx, dy] of leaves) R(x + dx + (dy < -9 ? sway : 0), y + dy, 1, 3, dy < -9 ? '#7fd66a' : '#3f9a54');
}
function drawHolo(t) {
  const cx = HUB.x, base = HUB.y - 4;
  R(cx - 9, base - 2, 18, 5, '#070a1f'); R(cx - 8, base - 1, 16, 3, '#39447f'); R(cx - 8, base - 1, 16, 1, '#4a5494'); R(cx - 5, base - 3, 10, 1, '#3ee6c9');
  for (let i = 0; i < 14; i++) { const w = 6 + Math.round(i * 1.2); R(cx - w / 2, base - 4 - i, w, 1, '#3ee6c91c'); }
  const gy = base - 27, r = 11, spin = reduced ? 0.6 : t / 1400;
  for (let y = -r; y <= r; y++) { const w = Math.round(Math.sqrt(r * r - y * y)); R(cx - w, gy + y, w * 2 + 1, 1, '#3ee6c91a'); }
  for (let k = 0; k < 64; k++) {
    const a = (k / 64) * Math.PI * 2;
    R(cx + Math.round(Math.cos(a) * r), gy + Math.round(Math.sin(a) * r), 1, 1, '#3ee6c9');
    for (const m of [0, Math.PI / 2]) { const ph = spin + m; const mx = Math.round(Math.sin(a) * r * Math.cos(ph)); if (Math.cos(a) > -1) R(cx + mx, gy + Math.round(Math.cos(a) * r), 1, 1, Math.sin(ph) > 0 ? '#8ff5e4' : '#3ee6c966'); }
    if (k % 2 === 0) R(cx + Math.round(Math.cos(a) * r), gy + Math.round(Math.sin(a) * 3), 1, 1, Math.sin(a) > 0 ? '#8ff5e4' : '#3ee6c966');
  }
  R(cx, gy - r - 2, 1, 1, (t % 900 < 450) ? '#ff5fa2' : '#5a2040');
}

/** Draws queued bubbles last, pushing each one up until it no longer covers one already placed. */
function drawBubbles(list) {
  const placed = [];
  g.font = '14px VT323, Consolas, monospace';
  for (const b of list.sort((p, q) => q.y - p.y)) {
    const w = Math.ceil(g.measureText(b.text).width / S) + 6, h = 9;
    const bx = Math.round(Math.min(W - w - 2, Math.max(2, b.x - w / 2)));
    let by = Math.round(b.y - h - 4);
    while (by > 34 && placed.some((r) => bx < r.x + r.w + 1 && r.x < bx + w + 1 && by < r.y + r.h + 1 && r.y < by + h + 1)) by -= 1;
    placed.push({ x: bx, y: by, w, h });
    bubble(b.x, b.y, b.text, b.color, bx, by, w, h);
  }
}
function bubble(x, y, text, color, bx, by, w, h) {
  if (by + h + 2 < y - 4) R(Math.round(x), by + h + 1, 1, Math.round(y - 4 - (by + h + 1)), '#ece6d288'); // tail stretched when pushed up
  R(bx, by, w, h, '#ece6d2'); R(bx, by, w, 1, color); R(Math.round(x) - 1, by + h, 3, 1, '#ece6d2'); R(Math.round(x), by + h + 1, 1, 1, '#ece6d2');
  T(text, bx + 3, by + 7, '#10163a', 14, 'left');
}

/** True while an idle (not offline) agent is on its periodic trip to the fridge. */
function fridgeTrip(c) {
  if (reduced || c.status !== 'idle' || isAway(c) || atHub(c)) return false;
  return (Date.now() + hash(c.id) * 997) % FRIDGE_EVERY < FRIDGE_STAY;
}

const actors = new Map();
let last = performance.now();
function layout() {
  const byJoin = (a, b) => (a.joinedAt || 0) - (b.joinedAt || 0) || a.id.localeCompare(b.id);
  const members = state.claudes.filter(inRoom).sort(byJoin);
  // The game room is common: whoever is idle in another room is down there too (never at a desk or the hub here).
  const guests = state.claudes.filter((c) => !inRoom(c) && !isAway(c) && !atHub(c) && c.status !== 'working').sort(byJoin);
  const crew = [...members, ...guests];
  const hubbers = crew.filter(atHub).sort((a, b) => a.id.localeCompare(b.id));
  const thirsty = crew.filter(fridgeTrip); // queue in front of the fridge
  const idle = crew.filter((c) => !isAway(c) && !atHub(c) && c.status !== 'working' && !fridgeTrip(c)); // off to the lounge
  // Stable lounge spots: whoever already has one keeps it, newcomers take the first free one.
  const spot = new Map(), taken = new Set();
  for (const c of [...idle, ...thirsty]) { const k = actors.get(c.id)?.spot; if (k != null && !taken.has(k)) { spot.set(c.id, k); taken.add(k); } } // a fridge run keeps the seat
  for (const c of idle) if (!spot.has(c.id)) { let k = 0; while (taken.has(k)) k++; spot.set(c.id, k); taken.add(k); }
  for (const [id, a] of actors) a.spot = spot.get(id);
  return crew.map((c) => {
    const i = members.indexOf(c), guest = i < 0;
    const desk = !guest && i < 12 ? { x: SLOT_X[i % 6], fy: i < 6 ? TOP_FY : BOT_FY } : null;
    let target; let seat = false;
    if (atHub(c)) { const k = hubbers.indexOf(c), n = hubbers.length, a = (Math.PI * 2 * k / n) + (n > 1 ? 0 : 0.6); target = { x: HUB.x + Math.cos(a) * (HUB.rx - 12), y: HUB.y + Math.sin(a) * (HUB.ry - 5) }; }
    else if (fridgeTrip(c)) return { c, desk, target: { x: FRIDGE.x - 14 - thirsty.indexOf(c) * 14, y: FRIDGE.y + 2 }, seat, fridge: true };
    else if (spot.has(c.id) && !thirsty.includes(c)) { const k = spot.get(c.id); return { c, desk, target: k < SEATS.length ? SEATS[k] : STAND[(k - SEATS.length) % STAND.length], seat, lounge: k }; }
    else if (desk) { target = { x: desk.x - 4, y: desk.fy }; seat = true; }
    else target = { x: 20 + ((i - 12) % 12) * 26, y: 136 };
    return { c, desk, target, seat };
  });
}
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000); last = now; const t = now;
  const party = now - partyFrom < PARTY_MS;
  g.clearRect(0, 0, cv.width, cv.height);
  const room = currentRoom();
  if (!room) {
    const astro = (x, y, c, k, walk) => {
      const st = c.status, sleep = st === 'offline';
      if (walk) { drawBot(x, y, c.color, { role: c.role, t, face: walk.face, legs: reduced ? 0 : (Math.floor(t / 140) % 2 ? 1 : 2) }); return; }
      drawBot(x, y, c.color, { role: c.role, t: t + k * 311, sleep, face: k % 2 ? -1 : 1, typing: st === 'working' && !reduced, bob: !reduced && !sleep ? Math.floor((t + k * 400) / (st === 'working' ? 260 : 900)) % 2 : 0 });
      if (sleep) T('z', x + 7, y - 18, '#8a94c6', 12, 'left');
    };
    const lounge = state.claudes.filter((c) => crewStatus(c) === 'idle').map((c) => ({ id: c.id, color: colorOf(c), status: 'idle', role: roleOf(c) }));
    mapBoxes = drawMap(SH, t, mapModel(), SH_, hoverProject, astro, lounge);
    drawFireworks(SH, t, partyFrom, { x: 0, y: 0, w: W, h: 116 });
    const tint = dayTint(); if (tint) R(0, 0, W, SH_, tint);
    // at night every pod has its lights on: a warm glow inside, through the portholes
    drawLights(mapBoxes.map((b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2, r: 32, color: 'rgba(255, 236, 190, A)', a: 0.1 })), nightLevel(), t);
    requestAnimationFrame(frame); return;
  }
  const bridge = room.kind === 'bridge', rc = roomColor(room);
  g.drawImage(bridge ? bgBridge : bg, 0, 0);
  if (bridge) drawBridgeScreen(SH, t, bridgeInfo());
  else for (const s of stars) { const tw = (Math.floor(t / 400) + s.b) % 5 === 0; R(s.x, s.y, 1, 1, tw ? '#ffffff' : (s.b ? '#8a94c6' : '#4a5494')); }
  drawRack(88, t); drawRack(220, t);
  if (!bridge) drawFurniture(SH, t, room, reduced);
  R(0, 31, W, 1, rc); R(0, 0, W, 1, rc); // the room's light strips
  T(clip(bridge ? __('◆ BRIDGE') : room.name.toUpperCase(), 13), 47, 17, rc, 14);
  T(hoverProject === '' ? __('◀ TO THE MAP') : __('◀ MAP'), 273, 17, hoverProject === '' ? '#ece6d2' : '#8a94c6', 14);
  const drawables = []; const bubbles = []; const loungers = []; let foosers = 0; const nowMs = Date.now(); const deskOcc = new Map(); let fridgeOpen = false;
  for (const it of layout()) {
    const { c } = it; let a = actors.get(c.id); if (!a) { a = { x: it.target.x, y: it.target.y, face: 1 }; actors.set(c.id, a); }
    // Through the doorway in two legs: line up in front of it on your side, then step through to the other side.
    const line = LOUNGE.y0 + 14; // bottom of the dividing wall
    const lane = DOOR.x + ((hash(c.id) % 5) - 2) * 4; // everyone has a lane, so nobody blocks the doorway
    const up = a.y < line, crossing = up !== (it.target.y < line), aligned = Math.abs(a.x - lane) <= 1;
    const near = up ? LOUNGE.y0 - 6 : LOUNGE.y0 + 18, far = up ? LOUNGE.y0 + 18 : LOUNGE.y0 - 6;
    const target = crossing ? { x: lane, y: aligned ? far : near } : it.target;
    const dx = target.x - a.x, dy = target.y - a.y, d = Math.hypot(dx, dy), sp = 60 * dt;
    const moving = d > 0.5 && !reduced; if (reduced || d <= sp) { a.x = target.x; a.y = target.y; } else { a.x += dx / d * sp; a.y += dy / d * sp; }
    if (moving && Math.abs(dx) > 0.5) a.face = dx < 0 ? -1 : 1;
    const color = colorOf(c), sleep = isAway(c), hub = atHub(c), working = !sleep && c.status === 'working' && !hub && !moving;
    const seatedNow = it.seat && !moving && Math.abs(a.y - it.desk.fy) < 1;
    const sipping = working && seatedNow && !reduced && (t + hash(c.id) * 131) % SIP_EVERY < SIP_FOR;
    const atFridge = it.fridge && !moving && !crossing;
    const onSofa = it.lounge != null && it.lounge < SEATS.length && !moving && !crossing;
    if (atFridge) fridgeOpen = true;
    if (atFridge) a.can = true; else if (seatedNow || hub || onSofa) a.can = false;
    const holdingCan = a.can && !atFridge; // walking back to the desk with a fresh coffee
    const locks = state.locks.filter((l) => l.owner === c.id && l.expiresAt > nowMs).length;
    if (it.desk) deskOcc.set(`${it.desk.x}:${it.desk.fy}`, { c, color, working, sleep, locks, sipping });
    const seated = it.seat && !moving && Math.abs(a.y - it.desk.fy) < 1;
    if (seated) a.face = 1;
    if (hub && !moving) a.face = a.x < HUB.x ? 1 : -1; // look at the hologram
    if (atFridge) a.face = 1; // look into the fridge
    if (onSofa) { loungers.push({ k: it.lounge, color, id: c.id }); drawables.push({ y: a.y, draw: () => drawSeated(SH, a.x, a.y, color, t + hash(c.id) % 900, reduced, it.lounge < 2, roleOf(c)) }); continue; }
    const standing = it.lounge != null && !moving && !crossing; // lounge full: foosball for two, the rest watch
    const spotInfo = standing ? STAND[(it.lounge - SEATS.length) % STAND.length] : null, foos = !!spotInfo?.foos;
    if (spotInfo?.face) a.face = spotInfo.face;
    if (foos) foosers++;
    drawables.push({ y: a.y, draw: () => {
      drawBot(a.x, a.y, color, { role: roleOf(c), t: t + hash(c.id) % 900, sleep, face: a.face, typing: (working && seated || foos) && !reduced, sipping, holdingCan, legs: moving ? (Math.floor(t / 140) % 2 ? 1 : 2) : 0, bob: party && !sleep && !moving ? -Math.abs(Math.round(Math.sin((t + hash(c.id)) / 140) * 4)) : !moving && !reduced && !sleep ? (Math.floor((t + hash(c.id)) / (working ? 260 : 900)) % 2) : 0 });
      const headY = a.y - 20;
      if (sleep) { const z = Math.floor(t / 600) % 3; T('Z'.repeat(z + 1), a.x + 9, headY + 4 - z, '#8a94c6', 14, 'left'); }
      const un = unreadFor(c); if (un && !sleep && Math.floor(t / 400) % 2) { R(a.x - 1, headY - 7, 3, 5, '#ff5fa2'); R(a.x - 1, headY - 1, 3, 1, '#ff5fa2'); }
      if (hub) {
        const m = lastSent(c);
        if (m && nowMs - (m.createdAt || 0) < BUBBLE_MS) bubbles.push({ x: a.x, y: headY - (un ? 8 : 0), text: m.secure ? __`→${clip(nameOf(m.to), 10)}: [protected data]` : `→${clip(nameOf(m.to), 10)}: ${clip(m.text, 26)}`, color });
        T(clip(label(c), 14), a.x, a.y + 9, color, 14);
      } else if (!seated && !(it.desk && (a.can || !it.seat))) T(clip(label(c), 14), a.x, a.y + 9, color, 14); // on a fridge run the desk plate names them
    } });
  }
  for (let i = 0; i < 12; i++) {
    const x = SLOT_X[i % 6], fy = i < 6 ? TOP_FY : BOT_FY;
    drawables.push({ y: fy - 0.5, draw: () => drawChair(x, fy) });
    drawables.push({ y: fy + 0.5, draw: () => { const o = deskOcc.get(`${x}:${fy}`); drawDesk(x, fy, o ? o.color : '#3a3f66', o, t); drawBin(R, x + 21, fy + 4, o ? 1 + (hash(o.c.id) % 4) : 0); if (o) T(clip(label(o.c), 12), x - 1, fy + 3.5, o.color, 13); } });
  }
  drawables.push({ y: FRIDGE.y, draw: () => drawFridge(fridgeOpen, t) });
  drawables.push({ y: LOUNGE.y0 + 34, draw: () => drawBin(R, 132, LOUNGE.y0 + 34, 5) });
  const players = loungers.filter((p) => p.k < 2).sort((p, q) => p.k - q.k); // the two on the left hold the controllers
  drawables.push({ y: LOUNGE.y0 + 1, draw: () => drawLounge(SH, t, players, reduced) });
  drawables.push({ y: SOFA_Y, draw: () => drawSofa(SH) });
  drawables.push({ y: BEAN_Y, draw: () => drawBean(SH) }); // over the legs of whoever sits on it
  drawables.push({ y: FOOS_Y, draw: () => drawFoosball(SH, t, reduced, foosers > 0) });
  for (const [px, py] of [[10, 96], [310, 96], [10, 150], [310, 150]]) drawables.push({ y: py, draw: () => drawPlant(px, py, t + px) });
  drawables.push({ y: HUB.y - 2, draw: () => {
    if (bridge) drawBridgeTable(SH, t, BRIDGE_TABLE, reduced); else drawHolo(t);
    drawBallotBox(SH, t, 195, HUB.y + 17, voteFor(room), reduced);
    if (!state.claudes.length) T(__('NO AGENT ON BOARD'), 160, HUB.y + 34, '#8a94c6', 16);
  } });
  T(bridge ? __('MEETING TABLE') : __('COMMS HUB'), 160, HUB.y + HUB.ry + 11, bridge ? '#ffb547' : '#3ee6c9', 14);
  drawables.sort((p, q) => p.y - q.y).forEach((d) => d.draw());
  // wall lights (applique): under the deck signs in every room, and on the game room wall; lit only at night
  const night = nightLevel();
  const SCONCES = [[47, 24], [273, 24], [112, LOUNGE.y0 + 4], [302, LOUNGE.y0 + 4]];
  for (const [sx, sy] of SCONCES) { R(sx - 1, sy - 2, 3, 2, '#2b3574'); R(sx - 3, sy, 7, 3, night > 0.3 ? '#ffe6a8' : '#6a5a40'); R(sx - 2, sy + 3, 5, 1, night > 0.3 ? '#ffc870' : '#4a3e2c'); }
  const tint = dayTint(); if (tint) R(0, 0, W, SH_, tint); // real time of day
  if (night > 0) { // artificial lights, soft: only what is really on gives light
    const L = LOUNGE.y0, lights = [];
    for (const [sx, sy] of SCONCES) lights.push({ x: sx, y: sy + 5, r: 20, color: 'rgba(255, 200, 130, A)', a: 0.22 });
    for (let i = 0; i < 12; i++) {
      const x = SLOT_X[i % 6], fy = i < 6 ? TOP_FY : BOT_FY, o = deskOcc.get(`${x}:${fy}`);
      if (o?.working) lights.push({ x: x + 12, y: fy - 14, r: 12, color: 'rgba(80, 230, 210, A)', a: 0.22 }); // monitor on
      if (o && !o.sleep) lights.push({ x: x - 2, y: fy - 6, r: 20, color: 'rgba(205, 225, 255, A)', a: 0.06 }); // desk lamp of whoever is there
    }
    if (bridge) lights.push({ x: 160, y: 98, r: 40, color: 'rgba(255, 220, 160, A)', a: 0.18 }, { x: 160, y: 18, r: 36, color: 'rgba(120, 200, 255, A)', a: 0.14 });
    else lights.push({ x: HUB.x, y: HUB.y - 10, r: 44, color: 'rgba(62, 230, 201, A)', a: 0.1, flicker: true });
    lights.push(
      { x: 262, y: L + 22, r: 38, color: 'rgba(255, 210, 130, A)', a: 0.3 },                          // floor lamp
      { x: 92, y: L + 16, r: 16, color: 'rgba(255, 95, 180, A)', a: 0.18 },                           // arcade (always on)
      { x: 53, y: L + 7, r: 18, color: 'rgba(255, 95, 162, A)', a: 0.16 },                            // neon sign
    );
    if (players.length) lights.push({ x: 219, y: L + 16, r: 28, color: 'rgba(110, 160, 255, A)', a: 0.2, flicker: true }); // TV, only during a game
    drawLights(lights, night, t);
    R(259, L + 12, 7, 5, '#fff6c8'); R(260, L + 17, 5, 1, '#ffd27a');                                // the lamp itself, switched on
  } else R(259, LOUNGE.y0 + 12, 7, 5, '#8a7a5a');                                                     // by day the lamp is off
  drawFireworks(SH, t, partyFrom, bridge ? { x: 99, y: 5, w: 122, h: 24 } : WIN);
  drawBubbles(bubbles);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
const toScene = (e) => { const r = cv.getBoundingClientRect(); return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * SH_ }; };
cv.addEventListener('click', (e) => {
  const p = toScene(e);
  if (!state.filter) { const b = mapBoxes.find((x) => inside(p, x)); if (b) goRoom(b.project); }
  else if (inside(p, BACK)) goRoom('');
});
cv.addEventListener('mousemove', (e) => {
  const p = toScene(e);
  hoverProject = !state.filter ? (mapBoxes.find((x) => inside(p, x))?.project ?? null) : (inside(p, BACK) ? '' : null);
  cv.style.cursor = hoverProject != null ? 'pointer' : '';
});
cv.addEventListener('mouseleave', () => { hoverProject = null; cv.style.cursor = ''; });
setInterval(() => { renderCrew(); renderLocks(); }, 15000);
