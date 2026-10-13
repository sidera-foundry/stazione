// For the humans: the recaps the agents write for each room, the opinions they ask for, and the bell that collects
// everything waiting for a human (new recaps, sensitive data to authorise, permissions, opinions, blocked missions).
import { $, el, api, __, can } from './common.js';
import { show } from './views.js';

const SEEN_KEY = 'stazione.notifications.seen';
const readSeen = () => { try { return Number(localStorage.getItem(SEEN_KEY)) || 0; } catch { return 0; } };
const writeSeen = (t) => { try { localStorage.setItem(SEEN_KEY, String(t)); } catch { /* private window: badge only */ } };

/**
 * h: helpers from the board — state, nameOf, roomName, roomTint, inFilter, goRoom, ago, left, poll.
 * Returns render(), called after every poll.
 */
export function initNotifications(h) {
  let seen = readSeen();
  let opinions = [], permissions = 0, open = false, bellKey = '', opinionsKey = '';
  const bell = $('bell'), pop = $('bellPop');

  const toggle = (v) => {
    open = v; pop.hidden = !v; bell.setAttribute('aria-expanded', String(v));
    if (v) { seen = Date.now(); writeSeen(seen); render(); }
  };
  bell.addEventListener('click', (e) => { e.stopPropagation(); toggle(!open); });
  document.addEventListener('click', (e) => { if (open && !pop.contains(e.target)) toggle(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && open) { toggle(false); bell.focus(); } });

  const jump = (id, project) => () => {
    toggle(false);
    if (project !== undefined) h.goRoom(project);
    const t = $(id); if (!t) return;
    const view = t.closest('[data-view]'); if (view?.hidden) show(view.dataset.view); // the panel may be in another section
    if (t.tagName === 'DETAILS') t.open = true;
    t.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  async function loadOpinions() {
    try {
      const all = (await api('GET', '/api/asks')).asks;
      opinions = all.filter((a) => a.kind === 'opinion'); permissions = all.length - opinions.length;
    } catch { /* next poll */ }
  }

  function renderRecaps() {
    const s = h.state, box = $('recapList');
    const rs = (s.recaps || []).filter((r) => h.inFilter(r.project));
    $('recapCount').textContent = rs.length ? String(rs.length) : '';
    const wasOpen = new Set([...box.querySelectorAll('details[open]')].map((d) => d.id));
    box.replaceChildren();
    if (!rs.length) { box.append(el('p', 'empty', __('No recaps. The agents write one at the end of a mission with "recap".'))); return; }
    rs.forEach((r, i) => {
      const d = el('details', 'recap'); d.id = `recap-${r.id}`;
      d.style.setProperty('--rc', h.roomTint(r.project));
      d.open = wasOpen.has(d.id) || (i === 0 && !wasOpen.size);
      const sum = el('summary');
      if (r.createdAt > seen) sum.append(el('span', 'chip pink', __('NEW')));
      sum.append(el('b', null, r.title), el('span', 'meta', `${h.state.filter ? '' : `${h.roomName(r.project)} · `}${h.nameOf(r.by)} · ${h.ago(r.createdAt)}`));
      d.append(sum, el('div', 'body', r.body));
      box.append(d);
    });
  }

  function renderOpinions() {
    const list = $('opinionsList');
    $('opinionsPanel').hidden = !opinions.length;
    $('opinionsCount').textContent = opinions.length ? String(opinions.length) : '';
    const key = opinions.map((a) => a.id).join();
    if (key === opinionsKey) return; // same requests: keep the forms, and any answer being typed
    opinionsKey = key;
    list.replaceChildren();
    for (const a of opinions) {
      const li = el('li', 'approval'); li.id = `opinion-${a.id}`;
      const f = el('form', 'stack');
      const ta = el('textarea'); ta.rows = 2; ta.maxLength = 2000; ta.required = true; ta.placeholder = __('Your opinion');
      ta.setAttribute('aria-label', __`Opinion for ${h.nameOf(a.claude)}`);
      const b = el('button', null, __('ANSWER')); b.type = 'submit';
      const err = el('div', 'status-line err');
      f.append(ta, b, err);
      f.addEventListener('submit', async (e) => {
        e.preventDefault(); b.disabled = true;
        try {
          await api('POST', `/api/asks/${encodeURIComponent(a.id)}`, { answer: ta.value.trim() });
          opinions = opinions.filter((x) => x.id !== a.id); ta.blur(); render(); h.poll();
        } catch (x) { b.disabled = false; err.textContent = x.message; }
      });
      li.append(
        el('div', null, `${h.nameOf(a.claude)}${a.project ? ` · ${h.roomName(a.project)}` : ''}`),
        el('div', 'revealed', a.text),
        el('div', 'meta', __`Asked ${h.ago(a.createdAt)} · expires in ${h.left(a.expiresAt)}`),
        f,
      );
      list.append(li);
    }
  }

  function renderBell() {
    const s = h.state;
    const items = [];
    if (s.pendingApprovals) items.push({ icon: '🔐', text: s.pendingApprovals === 1 ? __('One piece of sensitive data to approve') : __`${s.pendingApprovals} pieces of sensitive data to approve`, go: jump('approvalsPanel') });
    if (permissions) items.push({ icon: '🛑', text: permissions === 1 ? __('One permission for a drastic action') : __`${permissions} permissions for drastic actions`, go: jump('asksPanel') });
    for (const a of opinions) items.push({ icon: '💬', text: __`${h.nameOf(a.claude)} asks for an opinion: ${a.text}`, go: jump(`opinion-${a.id}`) });
    const ties = (s.polls || []).filter((p) => p.status === 'tie');
    for (const p of ties) items.push({ icon: '⚖️', text: __`Tied poll, you choose: ${p.question}`, go: jump(`poll-${p.id}`) });
    for (const p of (s.polls || []).filter((x) => x.status === 'open')) items.push({ icon: '🗳️', text: __`Open poll: ${p.question}`, go: jump(`poll-${p.id}`) });
    for (const t of s.tasks.filter((x) => x.status === 'blocked')) items.push({ icon: '⛔', text: __`Blocked mission: ${t.title}` + (t.note ? ` (${t.note})` : ''), go: jump('taskCount', t.project) });
    const fresh = (s.recaps || []).filter((r) => r.createdAt > seen);
    for (const r of (s.recaps || []).slice(0, 8)) {
      items.push({ icon: '📄', text: __`Recap ${h.roomName(r.project)}: ${r.title}`, when: r.createdAt, isNew: r.createdAt > seen, go: jump(`recap-${r.id}`, r.project) });
    }
    const n = (s.pendingApprovals || 0) + permissions + opinions.length + ties.length + fresh.length;
    $('bellCount').textContent = n > 99 ? '99+' : String(n);
    $('bellCount').hidden = !n;
    bell.setAttribute('aria-label', n ? __`Notifications: ${n} to see` : __('Notifications'));
    const key = JSON.stringify(items.map((it) => [it.text, it.isNew, it.when && h.ago(it.when)]));
    if (key === bellKey) return; // rebuilt only on change: clicks and keyboard focus survive the poll
    bellKey = key;
    const list = $('bellList'); list.replaceChildren();
    if (!items.length) { list.append(el('li', 'empty', __('Nothing to see: all quiet.'))); return; }
    for (const it of items) {
      const b = el('button', `note${it.isNew ? ' new' : ''}`); b.type = 'button';
      b.append(el('span', 'ic', it.icon), el('span', 'tx', it.text));
      if (it.when) b.append(el('span', 'meta', h.ago(it.when)));
      b.addEventListener('click', it.go);
      const li = el('li'); li.append(b); list.append(li);
    }
  }

  async function render(fetchAsks) {
    if (fetchAsks) {
      if (h.state.me?.type === 'human' && (h.state.pendingAsks || opinions.length || permissions)) await loadOpinions(); else { opinions = []; permissions = 0; }
    }
    renderRecaps(); renderOpinions(); renderBell();
  }
  return render;
}
