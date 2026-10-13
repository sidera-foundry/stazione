// Logbook, in the Logbook section of the panel: the chosen room's days, newest first — recaps, missions
// closed, decisions and (for the Bridge) the station's releases. Follows the room tabs; fetched at most once a
// minute, or at once when the room or the period changes.
import { el, api, __, locale } from './common.js';

const ICON = { recap: '📄', mission: '✅', decision: '🧭', release: '🚀' };
const KINDS = [['recap', __('Recaps')], ['mission', __('Closed missions')], ['decision', __('Decisions')], ['release', __('Releases')]];
const dayKey = (ts) => new Date(ts).toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const hhmm = (ts) => new Date(ts).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });

/** Builds the logbook inside box; returns update(room, nameOf) to call after every poll. */
export function mountJournal(box) {
  const filters = el('div', 'diary-filters'); filters.setAttribute('role', 'group'); filters.setAttribute('aria-label', __('What to show'));
  const checks = KINDS.map(([v, label]) => {
    const l = el('label'); const i = el('input'); i.type = 'checkbox'; i.value = v; i.checked = true;
    i.addEventListener('change', render); l.append(i, ` ${label}`); filters.append(l); return i;
  });
  const days = el('select'); days.id = 'diaryDays';
  for (const [v, t] of [[7, __('7 days')], [30, __('30 days')], [90, __('90 days')], [365, __('one year')]]) days.append(new Option(t, v, v === 30, v === 30));
  const dl = el('label', 'field days', __('Period')); dl.htmlFor = 'diaryDays'; dl.append(days); filters.append(dl);
  const head = el('p', 'meta'), list = el('div'), msg = el('p', 'status-line'); msg.setAttribute('role', 'status');
  box.replaceChildren(filters, head, msg, list);

  let data = null, key = '', at = 0, names = (id) => id;
  async function load() {
    try { data = await api('GET', `/api/journal?room=${encodeURIComponent(key)}&days=${days.value}`); msg.textContent = ''; render(); }
    catch (err) { msg.textContent = err.message; msg.className = 'status-line err'; }
  }
  days.addEventListener('change', () => { at = Date.now(); load(); });

  function render() {
    if (!data) return;
    const keep = new Set(checks.filter((c) => c.checked).map((c) => c.value));
    const items = data.items.filter((i) => keep.has(i.type));
    head.textContent = `${data.room.name} · ${items.length ? __`${items.length} entries in the last ${data.days} days` : __`nothing to tell in the last ${data.days} days`}`;
    list.replaceChildren();
    let ul = null, cur = '';
    for (const i of items) {
      const k = dayKey(i.at);
      if (k !== cur) { cur = k; const d = el('section', 'day'); d.append(el('h3', null, k.toUpperCase()), ul = el('ul')); list.append(d); }
      const li = el('li', `entry ${i.type}`);
      li.append(el('span', null, ICON[i.type]), el('span', 't', i.title), el('span', 'meta when', `${hhmm(i.at)}${i.by ? ` · ${names(i.by)}` : ''}`));
      if (i.text) li.append(el('div', i.type === 'recap' ? 'body' : 'body meta', i.text));
      ul.append(li);
    }
  }

  return (room, nameOf) => {
    if (nameOf) names = nameOf;
    const k = room || 'bridge';
    if (k !== key || Date.now() - at > 60e3) { key = k; at = Date.now(); load(); }
  };
}
