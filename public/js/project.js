// Project page: for each room the goal the humans set, the milestones on the way and the next things to do.
// On "All rooms" one line per room with its progress; inside a room the whole page, editable.
import { $, el, api, __, can } from './common.js';

const RANK = { high: 0, normal: 1, low: 2 };

/** h: helpers from the board — state, roomName, roomTint, goRoom, nameOf, poll. Returns render(). */
export function initProject(h) {
  let key = '';
  const panel = $('projectPanel'), box = $('projectBody');

  const save = async (room, body, errNode) => {
    if (!can(h.state.me, 'rooms.project')) return;
    try { await api('PUT', `/api/rooms/${encodeURIComponent(room.id)}/project`, body); key = ''; h.poll(); } catch (err) { errNode.textContent = err.message; }
  };
  const bar = (done, total) => {
    const b = el('div', 'ttl'); const i = el('i'); i.style.width = `${total ? (done / total) * 100 : 0}%`; b.append(i); return b;
  };

  function overview(rooms) {
    const list = el('ul', 'list');
    for (const r of rooms) {
      const done = r.milestones.filter((m) => m.done).length;
      const b = el('button', 'card proj-row'); b.type = 'button'; b.style.setProperty('--rc', h.roomTint(r.project));
      b.append(el('b', null, r.name), el('span', 'meta', r.goal || __('No goal written')));
      if (r.milestones.length) b.append(bar(done, r.milestones.length), el('span', 'meta', __`${done}/${r.milestones.length} milestones`));
      b.addEventListener('click', () => h.goRoom(r.project));
      const li = el('li'); li.append(b); list.append(li);
    }
    box.replaceChildren(list);
  }

  function page(room) {
    const editable = can(h.state.me, 'rooms.project');
    const err = el('div', 'status-line err');
    const ms = room.milestones, done = ms.filter((m) => m.done).length;
    // goal: shown, and edited in place
    const goal = el('form', 'proj-goal');
    const input = el('input'); input.maxLength = 300; input.value = room.goal; input.placeholder = __('Write the room\'s goal here (e.g. first public version by the end of the month)');
    input.setAttribute('aria-label', __('Room goal'));
    const ok = el('button', 'ghost', __('SAVE')); ok.type = 'submit';
    goal.append(input, ok);
    input.readOnly = !editable; ok.hidden = !editable;
    goal.addEventListener('submit', (e) => { e.preventDefault(); input.blur(); save(room, { goal: input.value.trim() }, err); });

    const list = el('ul', 'list proj-ms');
    ms.forEach((m, i) => {
      const li = el('li', m.done ? 'done' : '');
      const cb = el('input'); cb.type = 'checkbox'; cb.checked = m.done; cb.id = `ms-${room.id}-${i}`;
      cb.disabled = !editable;
      cb.addEventListener('change', () => save(room, { milestones: ms.map((x, k) => (k === i ? { ...x, done: cb.checked } : x)) }, err));
      const lab = el('label', null, m.text); lab.htmlFor = cb.id;
      const del = el('button', 'ghost', '×'); del.type = 'button'; del.title = __('Remove this milestone'); del.setAttribute('aria-label', __`Remove the milestone ${m.text}`);
      del.hidden = !editable;
      del.addEventListener('click', () => save(room, { milestones: ms.filter((_, k) => k !== i) }, err));
      li.append(cb, lab, del); list.append(li);
    });
    const add = el('form', 'proj-goal');
    const ni = el('input'); ni.maxLength = 120; ni.placeholder = __('New milestone'); ni.required = true; ni.setAttribute('aria-label', __('New milestone'));
    const nb = el('button', 'ghost', __('ADD')); nb.type = 'submit';
    add.append(ni, nb);
    add.hidden = !editable;
    add.addEventListener('submit', (e) => { e.preventDefault(); const text = ni.value.trim(); ni.blur(); if (text) save(room, { milestones: [...ms, { text, done: false }] }, err); });

    const next = h.state.tasks.filter((t) => t.project === room.project && t.status !== 'done')
      .sort((a, b) => (RANK[a.priority] ?? 1) - (RANK[b.priority] ?? 1) || (a.due || '9').localeCompare(b.due || '9') || a.createdAt - b.createdAt).slice(0, 3);
    const nx = el('ul', 'list');
    for (const t of next) nx.append(el('li', 'meta', `▸ ${t.title}${t.owner ? ` — ${h.nameOf(t.owner)}` : __(' — to assign')}`));
    if (!next.length) nx.append(el('li', 'empty', __('No open missions: launch one from the Missions section.')));

    box.replaceChildren(
      el('h3', null, __('GOAL')), goal,
      el('h3', null, ms.length ? __`MILESTONES ${done}/${ms.length}` : __('MILESTONES')), ...(ms.length ? [bar(done, ms.length)] : []), list, add,
      el('h3', null, __('NEXT MOVES')), nx, err,
    );
  }

  return function render() {
    const s = h.state;
    const rooms = (s.rooms || []).filter((r) => r.kind !== 'bridge');
    const room = s.filter ? (s.rooms || []).find((r) => r.project === s.filter) : null;
    panel.hidden = s.filter ? !room : !rooms.length;
    if (panel.hidden) return;
    if (can(s.me, 'rooms.project') && box.contains(document.activeElement) && document.activeElement.tagName === 'INPUT' && document.activeElement.type !== 'checkbox') return; // someone is typing
    const k = JSON.stringify([s.me?.permissions, room
      ? [room.id, room.goal, room.milestones, s.tasks.filter((t) => t.project === room.project && t.status !== 'done').map((t) => [t.id, t.owner, t.priority, t.due])]
      : rooms.map((r) => [r.id, r.name, r.goal, r.milestones])]);
    if (k === key) return;
    key = k;
    $('projectTitle').textContent = room ? __`PROJECT ${room.name.toUpperCase()}` : __('PROJECTS');
    if (room) page(room); else overview(rooms);
  };
}
