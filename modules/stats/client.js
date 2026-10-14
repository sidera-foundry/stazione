// Statistics module, in the Tech section: missions closed day by day and per session (two hand-drawn SVG bar charts
// with a hover tooltip), plus the full numbers in tables (sessions and rooms). Follows the room tabs; fetched at
// most once a minute, or at once when the room or the period changes. One series per chart: one colour, no legend.
import { el, api, __, locale } from '/js/common.js';

const NS = 'http://www.w3.org/2000/svg';
const BAR = '#27a891', BAR_HOT = '#3ee6c9'; // validated against the panel surface (lightness band, contrast >= 3:1)
const svg = (tag, attrs = {}) => { const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; };
const dayKey = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const dayLabel = (key) => new Date(`${key}T12:00:00`).toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short' });
const dur = (min) => (min == null ? '—' : min < 60 ? `${min} min` : min < 1440 ? `${(min / 60).toFixed(1)} h` : __`${(min / 1440).toFixed(1)} d`);

/** Rounded data-end bar anchored on the baseline: 4px radius only at the far end. */
function barPath(x, y, w, h, horizontal) {
  const r = Math.min(4, horizontal ? h / 2 : w / 2, horizontal ? w : h);
  if (w <= 0 || h <= 0) return '';
  return horizontal
    ? `M${x},${y}h${w - r}a${r},${r} 0 0 1 ${r},${r}v${h - 2 * r}a${r},${r} 0 0 1 -${r},${r}h-${w - r}z`
    : `M${x},${y + h}v-${h - r}a${r},${r} 0 0 1 ${r},-${r}h${w - 2 * r}a${r},${r} 0 0 1 ${r},${r}v${h - r}z`;
}

/** Shared tooltip: follows the pointer over a chart, also shown on keyboard focus. */
function tooltip(host) {
  const tip = el('div', 'chart-tip'); tip.hidden = true; tip.setAttribute('role', 'status'); host.append(tip);
  return {
    show(text, ev, target) {
      tip.textContent = text; tip.hidden = false;
      const hb = host.getBoundingClientRect();
      const tb = target.getBoundingClientRect();
      const x = ev?.clientX ?? tb.left + tb.width / 2, y = ev?.clientY ?? tb.top;
      tip.style.left = `${Math.min(hb.width - tip.offsetWidth - 4, Math.max(4, x - hb.left + 12))}px`;
      tip.style.top = `${Math.max(4, y - hb.top - tip.offsetHeight - 10)}px`;
    },
    hide() { tip.hidden = true; },
  };
}

function hoverable(node, mark, text, tip) {
  node.setAttribute('tabindex', '0'); node.setAttribute('role', 'img'); node.setAttribute('aria-label', text);
  const on = (ev) => { mark.setAttribute('fill', BAR_HOT); tip.show(text, ev, node); };
  const off = () => { mark.setAttribute('fill', BAR); tip.hide(); };
  node.addEventListener('pointermove', on); node.addEventListener('pointerleave', off);
  node.addEventListener('focus', (e) => on(null, e)); node.addEventListener('blur', off);
}

/** Missions closed per local day over the period: vertical bars, the whole day column is the hit target. */
function perDay(box, stamps, days, tip) {
  const counts = new Map();
  for (let i = days - 1; i >= 0; i--) counts.set(dayKey(Date.now() - i * 86400e3), 0);
  for (const t of stamps) { const k = dayKey(t); if (counts.has(k)) counts.set(k, counts.get(k) + 1); }
  const keys = [...counts.keys()], max = Math.max(1, ...counts.values());
  const W = 640, H = 180, L = 28, B = 22, T = 8, pw = W - L - 4, ph = H - B - T;
  const step = pw / keys.length, bw = Math.max(2, step - 2); // 2px surface gap between bars
  const g = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', 'aria-label': __`Missions closed per day, last ${days} days` });
  const ticks = max <= 4 ? Array.from({ length: max + 1 }, (_, i) => i) : [0, Math.round(max / 2), max];
  for (const v of ticks) {
    const y = T + ph - (v / max) * ph;
    g.append(svg('line', { x1: L, x2: W - 4, y1: y, y2: y, class: 'grid' }));
    const tx = svg('text', { x: L - 6, y: y + 4, class: 'axis', 'text-anchor': 'end' }); tx.textContent = v; g.append(tx);
  }
  keys.forEach((k, i) => {
    const n = counts.get(k), x = L + i * step + 1, h = (n / max) * ph;
    const hit = svg('g'); const mark = svg('path', { d: barPath(x, T + ph - h, bw, h, false), fill: BAR });
    hit.append(svg('rect', { x: L + i * step, y: T, width: step, height: ph, fill: 'transparent' }), mark);
    hoverable(hit, mark, (n === 1 ? __`${dayLabel(k)}: 1 mission closed` : __`${dayLabel(k)}: ${n} missions closed`), tip);
    g.append(hit);
    if (i % Math.ceil(keys.length / 6) === 0 || i === keys.length - 1) {
      const tx = svg('text', { x: x + bw / 2, y: H - 6, class: 'axis', 'text-anchor': 'middle' }); tx.textContent = dayLabel(k).replace(/^\S+ /, ''); g.append(tx);
    }
  });
  box.append(g);
}

/** Missions closed per session: horizontal bars, name on the left, value at the bar's end. */
function perSession(box, sessions, tip) {
  const rows = sessions.filter((s) => s.closed > 0).slice(0, 12);
  if (!rows.length) { box.append(el('p', 'empty', __('No missions closed in the period.'))); return; }
  const max = Math.max(...rows.map((s) => s.closed));
  const W = 640, rowH = 26, L = 150, R = 40, H = rows.length * rowH + 4;
  const g = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', 'aria-label': __('Missions closed per session') });
  rows.forEach((s, i) => {
    const y = 2 + i * rowH, w = Math.max(2, (s.closed / max) * (W - L - R));
    const name = svg('text', { x: L - 8, y: y + 16, class: 'label', 'text-anchor': 'end' }); name.textContent = s.name.length > 18 ? `${s.name.slice(0, 17)}…` : s.name;
    const hit = svg('g'); const mark = svg('path', { d: barPath(L, y + 4, w, rowH - 10, true), fill: BAR });
    hit.append(svg('rect', { x: 0, y, width: W, height: rowH, fill: 'transparent' }), mark);
    const val = svg('text', { x: L + w + 6, y: y + 16, class: 'value' }); val.textContent = s.closed;
    hoverable(hit, mark, __`${s.name}: ${s.closed} closed (${s.closed7} in the last 7 days) · average time ${dur(s.avgMinutes)} · ${s.blocked} blocked · ${s.votes} votes`, tip);
    g.append(name, hit, val);
  });
  box.append(g);
}

function table(head, rows) {
  const t = el('table', 'stats-table'); const tr = el('tr');
  for (const h of head) tr.append(el('th', null, h));
  const thead = el('thead'); thead.append(tr); const tb = el('tbody');
  for (const r of rows) { const row = el('tr'); r.forEach((c, i) => row.append(el(i ? 'td' : 'th', null, String(c)))); tb.append(row); }
  t.append(thead, tb);
  const w = el('div', 'table-wrap'); w.append(t); return w;
}

/** Builds the statistics inside box; returns update(room) to call after every poll ('' = whole station). */
export function mountStats(box) {
  const bar = el('div', 'stats-bar');
  const sel = el('select'); sel.id = 'statsDays';
  for (const [v, t] of [[7, __('7 days')], [30, __('30 days')], [90, __('90 days')]]) sel.append(new Option(t, v, v === 30, v === 30));
  const lab = el('label', 'field', __('Period')); lab.htmlFor = 'statsDays'; lab.append(sel); bar.append(lab);
  const body = el('div', 'stats-body'); const msg = el('p', 'status-line'); msg.setAttribute('role', 'status');
  box.replaceChildren(bar, msg, body);
  const tip = tooltip(box);
  let key = null, at = 0;

  async function load() {
    let d;
    try { d = await api('GET', `/api/stats?days=${sel.value}${key ? `&room=${encodeURIComponent(key)}` : ''}`); msg.textContent = ''; }
    catch (err) { msg.textContent = err.message; msg.className = 'status-line err'; return; }
    body.replaceChildren();
    const total = d.closedAt.length;
    const f1 = el('figure', 'stats-fig'); f1.append(el('figcaption', null, __`Missions closed per day · ${total} in ${d.days} days` + (d.room ? ` · ${d.room.name}` : '')));
    perDay(f1, d.closedAt, d.days, tip);
    const f2 = el('figure', 'stats-fig'); f2.append(el('figcaption', null, __('Missions closed per session')));
    perSession(f2, d.sessions, tip);
    body.append(f1, f2);
    if (d.sessions.length) {
      body.append(el('h3', 'stats-h', __('PER SESSION')), table([__('Session'), __('Closed (7 d)'), __`Closed (${d.days} d)`, __('Average time'), __('Blocked'), __('Votes')],
        d.sessions.map((s) => [s.name, s.closed7, s.closed, dur(s.avgMinutes), s.blocked, s.votes])));
    }
    if (!d.room && d.rooms.length) {
      body.append(el('h3', 'stats-h', __('PER ROOM')), table([__('Room'), __('Closed (7 d)'), __`Closed (${d.days} d)`, __('Average time'), __('Blocked')],
        d.rooms.map((s) => [s.name, s.closed7, s.closed, dur(s.avgMinutes), s.blocked])));
    }
    body.append(el('p', 'meta', __('Average time: from when an agent takes the mission to when it closes it.')));
  }
  sel.addEventListener('change', () => { at = Date.now(); load(); });

  return (room) => {
    const k = room || '';
    if (k !== key || Date.now() - at > 60e3) { key = k; at = Date.now(); load(); }
  };
}

/** Module entry: a Statistics panel in the Tech section, following the room on screen. */
export default function mount(station) {
  const section = el('section', 'panel stats');
  section.append(el('h2', null, __('STATISTICS')), el('p', 'meta', __('Of the room chosen above (or of the whole station). Hover over the bars for details.')));
  const box = el('div'); box.id = 'stats'; section.append(box);
  station.slot('tech').append(section);
  const update = mountStats(box);
  station.on('room', (room) => update(room));
}
