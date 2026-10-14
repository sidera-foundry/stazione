// Ideas board: a chat-like board for the humans, with ideas pinned on top. Humans only: the API refuses
// Claude tokens and none of this is in /api/state.
import { $, el, api, say, __, locale } from '/js/common.js';
import { avatarKey, drawAvatar, animateAvatar } from '/js/avatar.js';

let me = { avatar: 'astronaut' };
let boardId = '', categoryId = '', categories = [];
const filters = el('div', 'panel');
const boardSelect = el('select'), categorySelect = el('select'), writeSelect = el('select');
const label = (text, control) => { const l = el('label', null, text); l.append(control); return l; };
filters.append(label(__('Board'), boardSelect), label(__('Category'), categorySelect));
document.querySelector('.ideas').prepend(filters);
$('noteForm').prepend(label(__('Post in category'), writeSelect));
const manager = el('form', 'panel');
const categoryName = el('input'); categoryName.maxLength = 60; categoryName.required = true;
const roleChecks = el('div');
const createCategory = el('button', null, __('CREATE CATEGORY')); createCategory.type = 'submit';
const updateCategory = el('button', null, __('UPDATE CATEGORY')); updateCategory.type = 'button';
manager.append(label(__('Category name'), categoryName), roleChecks, createCategory, updateCategory);
filters.append(manager); manager.hidden = true;
const checks = new Map();
function categoryBody() {
  return { room: boardId || null, name: categoryName.value, viewRoles: [...checks].filter(([, c]) => c.view.checked).map(([id]) => id), writeRoles: [...checks].filter(([, c]) => c.write.checked).map(([id]) => id) };
}
manager.addEventListener('submit', async (e) => {
  e.preventDefault();
  try { await api('POST', '/api/idea-categories', categoryBody()); await load(); } catch (err) { say($('noteMsg'), err.message, 'err'); }
});
updateCategory.addEventListener('click', async () => {
  if (!categoryId) return;
  try { await api('PUT', `/api/idea-categories/${categoryId}`, categoryBody()); await load(); } catch (err) { say($('noteMsg'), err.message, 'err'); }
});
boardSelect.addEventListener('change', () => { boardId = boardSelect.value; categoryId = ''; all = false; lastJson = ''; load(); });
categorySelect.addEventListener('change', () => {
  categoryId = categorySelect.value;
  const c = categories.find((c) => c.id === categoryId);
  if (c) { categoryName.value = c.name; for (const [id, fields] of checks) { fields.view.checked = c.viewRoles.includes(id); fields.write.checked = c.writeRoles.includes(id); } }
  else categoryName.value = ''; // no category selected: Create must not reuse the previous name
  updateCategory.disabled = !c;
  lastJson = ''; load();
});
animateAvatar($('avatar'), () => me.avatar);

function ago(ts) {
  const d = Math.max(0, Date.now() - ts);
  if (d < 60e3) return __('now');
  if (d < 3600e3) return __`${Math.floor(d / 60e3)} min ago`;
  if (d < 86400e3) return __`${Math.floor(d / 3600e3)} h ago`;
  return new Date(ts).toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' });
}

const minis = []; // small animated avatars next to each idea
function note(n) {
  const li = el('li', `note${n.mine ? ' mine' : ''}${n.pinned ? ' pinned' : ''}`);
  const c = el('canvas', 'note-avatar'); c.width = 32; c.height = 32; minis.push({ c, key: avatarKey(n.avatar) });
  const body = el('div', 'note-body');
  const head = el('div', 'hdr');
  const when = el('span', 'when', `· ${ago(n.createdAt)}`); when.dataset.ts = n.createdAt;
  head.append(el('b', null, n.author), when);
  const acts = el('span', 'note-acts');
  const pin = el('button', 'ghost', n.pinned ? __('UNPIN') : __('📌 PIN')); pin.type = 'button';
  pin.title = n.pinned ? __('Remove from the pinned ones') : __('Keep it on top');
  pin.addEventListener('click', () => act(`/api/notes/${n.id}/pin`, { pinned: !n.pinned }));
  if (n.canWrite) acts.append(pin);
  if (n.mine && n.canWrite) {
    const del = el('button', 'ghost danger', __('DELETE')); del.type = 'button';
    del.addEventListener('click', () => { if (confirm(__('Delete this idea?'))) act(`/api/notes/${n.id}/delete`, {}); });
    acts.append(del);
  }
  head.append(acts);
  body.append(head, el('div', 'txt', n.text));
  li.append(c, body);
  return li;
}

async function act(path, body) {
  try { await api('POST', path, body); await load(); } catch (err) { say($('noteMsg'), err.message, 'err'); }
}

let lastJson = '', all = false;
async function load() {
  let r;
  const params = new URLSearchParams();
  if (all) params.set('all', '1'); if (boardId) params.set('room', boardId); if (categoryId) params.set('category', categoryId);
  try { r = await api('GET', `/api/notes?${params}`); } catch (err) {
    if (err.status === 401) location.replace('/login');
    else say($('noteMsg'), err.message, 'err');
    return;
  }
  categories = r.categories;
  const option = (id, text) => { const o = el('option', null, text); o.value = id; return o; };
  categorySelect.replaceChildren(option('', __('All categories')), ...categories.map((c) => option(c.id, c.name)));
  categorySelect.value = categoryId;
  const previousWrite = writeSelect.value;
  writeSelect.replaceChildren(...categories.filter((c) => c.canWrite).map((c) => option(c.id, c.name)));
  if (categories.some((c) => c.id === previousWrite && c.canWrite)) writeSelect.value = previousWrite;
  $('noteForm').hidden = !writeSelect.options.length;
  manager.hidden = !r.canManage; updateCategory.disabled = !categoryId;
  const json = JSON.stringify(r.notes);
  if (json === lastJson) return; // nothing new: keep the page still (and the text you are reading)
  lastJson = json;
  minis.length = 0;
  const pinned = r.notes.filter((n) => n.pinned);
  const rest = r.notes.filter((n) => !n.pinned);
  $('pinCount').textContent = pinned.length ? String(pinned.length) : '';
  $('noteCount').textContent = rest.length ? String(rest.length) : '';
  $('pinned').replaceChildren(...(pinned.length ? pinned.map(note) : [el('li', 'empty', __('No pinned ideas. Use the pin on an idea to keep it up here.'))]));
  $('notes').replaceChildren(...(rest.length ? rest.map(note) : [el('li', 'empty', __('No ideas yet.'))]));
  const hidden = r.total - r.notes.length;
  $('noteMore').hidden = hidden <= 0;
  $('noteMoreText').textContent = __`There are ${hidden} more older ideas.`;
}
$('noteMoreBtn').addEventListener('click', () => { all = true; lastJson = ''; load(); });
// Relative times move on by themselves, without redrawing the ideas (and losing the text you are selecting).
setInterval(() => { for (const w of document.querySelectorAll('.notes .when')) w.textContent = `· ${ago(Number(w.dataset.ts))}`; }, 60e3);

$('noteForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('noteText').value.trim();
  const btn = e.submitter || $('noteForm').querySelector('button');
  if (!text || btn.disabled) return;
  btn.disabled = true; // one idea per click, even on a double Enter
  try {
    await api('POST', '/api/notes', { text, room: boardId || null, category: writeSelect.value });
    $('noteText').value = ''; say($('noteMsg'), '');
    await load();
  } catch (err) { say($('noteMsg'), err.message, 'err'); } finally { btn.disabled = false; }
});
$('noteText').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('noteForm').requestSubmit(); } });
$('logout').addEventListener('click', async () => { try { await api('POST', '/api/auth/logout', {}); } finally { location.replace('/login'); } });

(async () => {
  try { me = await api('GET', '/api/me'); } catch (err) { if (err.status === 401) { location.replace('/login'); return; } }
  try {
    const { rooms } = await api('GET', '/api/rooms');
    for (const r of [{ id: '', name: __('Organization board') }, ...rooms.filter((r) => r.kind !== 'bridge')]) { const o = el('option', null, r.name); o.value = r.id; boardSelect.append(o); }
    const { roles } = await api('GET', '/api/roles');
    for (const r of roles) {
      const view = el('input'), write = el('input'); view.type = write.type = 'checkbox';
      checks.set(r.id, { view, write }); view.checked = write.checked = r.id !== 'guest';
      const row = el('div'); row.append(el('b', null, r.name), label(__('Can view'), view), label(__('Can write'), write)); roleChecks.append(row);
    }
  } catch (err) { say($('noteMsg'), err.message, 'err'); }
  await load();
  setInterval(() => { if (!document.hidden) load(); }, 8000);
  const loop = (t) => { for (const m of minis) drawAvatar(m.c, m.key, t); requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
})();
