import { $, el, api, say, busy, __, locale, can } from './common.js';
import { AVATARS, avatarKey, drawAvatar, animateAvatar } from './avatar.js';
import { renderHeld } from './reception.js';
import { restrictionEditor } from './token-restrictions.js';
import { supported, ceremony } from './passkeys.js';
let tokenRooms = [], creationRestrictions;

const fmt = (ts) => (ts ? new Date(ts).toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' }) : '—');
$('tokForm').closest('section').hidden = true;

async function guard() {
  try {
    const me = await api('GET', '/api/me');
    myAccess = me;
    tokenRooms = (await api('GET', '/api/rooms')).rooms;
    creationRestrictions = restrictionEditor(tokenRooms);
    $('tokForm').insertBefore(creationRestrictions.element, $('tokForm').querySelector('button[type="submit"]'));
    if (can(me, 'approvals.own') || can(me, 'approvals.room')) { $('heldSection').hidden = false; await renderHeld($('heldContent')); }
    $('tokForm').closest('section').hidden = !can(me, 'claudes.tokens');
    $('who').textContent = me.username;
    $('who').hidden = false;
    myAvatar = avatarKey(me.avatar);
    renderAvatars();
  } catch (err) {
    if (err.status === 401) location.replace('/login');
  }
}

// ---------- avatar ----------
let myAvatar = 'astronaut';
let myAccess = null;
animateAvatar($('avatar'), () => myAvatar);
const pickers = [];
function renderAvatars() {
  const box = $('avatarPick');
  if (!pickers.length) {
    for (const a of AVATARS) {
      const b = el('button', 'avatar-choice'); b.type = 'button'; b.title = a.label;
      const c = el('canvas'); c.width = 96; c.height = 96;
      b.append(c, el('span', null, a.label));
      b.addEventListener('click', async () => {
        try {
          await api('POST', '/api/avatar', { avatar: a.key });
          myAvatar = a.key; renderAvatars(); say($('avatarMsg'), __`Avatar updated: ${a.label}.`, 'good');
        } catch (err) { say($('avatarMsg'), err.message, 'err'); }
      });
      box.append(b); pickers.push({ a, b, c });
    }
    const loop = (t) => { for (const p of pickers) drawAvatar(p.c, p.a.key, t); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }
  for (const p of pickers) p.b.classList.toggle('on', p.a.key === myAvatar);
}

async function loadTokens() {
  if (!can(myAccess, 'claudes.tokens')) return;
  const { tokens } = await api('GET', '/api/tokens');
  const body = $('tokList');
  body.replaceChildren();
  if (!tokens.length) {
    const tr = el('tr'); const td = el('td', 'empty', __('No tokens. Create one for every computer that runs one of your agents.')); td.colSpan = 5; tr.append(td); body.append(tr);
    return;
  }
  for (const t of tokens) {
    const tr = el('tr');
    const dead = t.revoked_at || t.expires_at < Date.now();
    tr.append(el('td', null, t.name), el('td', null, fmt(t.created_at)), el('td', null, fmt(t.last_used_at)),
      el('td', null, t.revoked_at ? __('revoked') : t.expires_at < Date.now() ? __('expired') : fmt(t.expires_at)));
    const td = el('td');
    if (!dead) {
      const details = el('details'); details.append(el('summary', null, __('Token limits')));
      const editor = restrictionEditor(tokenRooms, t.restrictions), save = el('button', 'ghost', __('SAVE')); save.type = 'button';
      save.addEventListener('click', async () => { save.disabled = true; try { await api('PUT', `/api/tokens/${encodeURIComponent(t.id)}`, { restrictions: editor.value() }); say($('tokMsg'), __('Token limits saved.'), 'good'); await loadTokens(); } catch (err) { say($('tokMsg'), err.message, 'err'); save.disabled = false; } });
      details.append(editor.element, save); td.append(details);
      const b = el('button', 'danger', __('REVOKE')); b.type = 'button';
      b.addEventListener('click', async () => {
        b.disabled = true;
        try { await api('DELETE', `/api/tokens/${encodeURIComponent(t.id)}`); say($('tokMsg'), __`Token "${t.name}" revoked.`, 'good'); loadTokens(); }
        catch (err) { b.disabled = false; say($('tokMsg'), err.message, 'err'); }
      });
      td.append(b);
    }
    tr.append(td);
    body.append(tr);
  }
}

$('tokForm').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!can(myAccess, 'claudes.tokens')) return;
  busy(e.target, async () => {
    try {
      const r = await api('POST', '/api/tokens', { name: $('tokName').value.trim(), days: Number($('tokDays').value), restrictions: creationRestrictions.value() });
      $('tokValue').textContent = r.token;
      $('newTok').hidden = false;
      $('tokName').value = '';
      say($('tokMsg'), '');
      loadTokens();
    } catch (err) { say($('tokMsg'), err.message, 'err'); }
  });
});

$('copyTok').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('tokValue').textContent); say($('tokMsg'), __('Token copied to the clipboard.'), 'good'); }
  catch { getSelection().selectAllChildren($('tokValue')); say($('tokMsg'), __('Copy not available: the token is selected, use Ctrl+C.')); }
});

async function loadTelegram() {
  const t = await api('GET', '/api/telegram');
  if (!t.configured) { say($('tgState'), __('The bot is not configured on the server yet.'), 'err'); return; }
  say($('tgState'), t.linked ? __('Telegram linked: you will get the approval requests there.') : __('Telegram not linked.'), t.linked ? 'good' : '');
  $('tgLink').hidden = t.linked;
  $('tgUnlink').hidden = !t.linked;
  $('tgBot').textContent = t.botUsername ? `@${t.botUsername}` : __('of the Stazione');
}

$('tgCode').addEventListener('click', async () => {
  try {
    const r = await api('POST', '/api/telegram/code', {});
    $('tgCmd').textContent = `/link ${r.code}`;
    $('tgCodeBox').hidden = false;
  } catch (err) { say($('tgMsg'), err.message, 'err'); }
});

$('tgUnlink').addEventListener('click', async () => {
  try { await api('POST', '/api/telegram/unlink', {}); loadTelegram(); } catch (err) { say($('tgMsg'), err.message, 'err'); }
});

$('logout').addEventListener('click', async () => {
  try { await api('POST', '/api/auth/logout', {}); } finally { location.replace('/login'); }
});

async function credentialsPanel() {
  const section = el('section', 'panel'), keys = el('div'), devices = el('div'), message = el('p', 'status-line');
  section.append(el('h2', null, __('Passkeys and browsers')), el('p', 'meta', __('A passkey can confirm your identity without an authenticator code. Synced passkeys can work on several devices. Administrators are encouraged to add one.')), keys, devices, message);
  $('tokForm').closest('section').before(section);
  const action = (text, fn) => { const b = el('button', 'ghost', text); b.type = 'button'; b.addEventListener('click', async () => { b.disabled = true; try { await fn(); await load(); say(message, __('Saved.'), 'good'); } catch (err) { say(message, err.name === 'NotAllowedError' ? __('Passkey cancelled. Try again or use your password.') : err.message, 'err'); } finally { b.disabled = false; } }); return b; };
  async function load() {
    const data = await api('GET', '/api/passkeys'), browsers = await api('GET', '/api/devices');
    keys.replaceChildren(el('h3', null, __('Passkeys')));
    for (const key of data.passkeys) { const row = el('div', 'stack'); row.append(el('span', null, `${key.name} · ${fmt(key.last_used_at)}${key.backed_up ? ` · ${__('Synced')}` : ''}`), action(__('REVOKE'), async () => { if (confirm(__('Revoke this passkey?'))) await api('DELETE', `/api/passkeys/${encodeURIComponent(key.id)}`); })); keys.append(row); }
    if (!data.passkeys.length) keys.append(el('p', 'meta', __('No passkey registered.')));
    const name = el('input'); name.maxLength = 60; name.value = __('My passkey');
    const label = el('label', 'field', __('Name')); label.append(name);
    const add = action(__('ADD PASSKEY'), () => ceremony(api, '/api/passkeys/register', { name: name.value.trim() }, true)); add.disabled = !supported();
    keys.append(label, add);
    devices.replaceChildren(el('h3', null, __('Registered browsers')), el('p', 'meta', __('Approval is granted by an administrator. Browser registration uses a private cookie that expires after 90 days.')));
    if (!browsers.current) devices.append(action(__('REGISTER THIS BROWSER'), async () => { const r = await api('POST', '/api/devices/register', {}); if (r.next === 'device') location.replace('/login'); }));
    for (const device of browsers.devices) { const row = el('div', 'stack'), name = el('input'); name.value = device.name; name.maxLength = 60;
      row.append(name, el('span', 'meta', `${__(device.status)} · ${fmt(device.expires_at)}${device.id === browsers.current ? ` · ${__('Current browser')}` : ''}`), action(__('SAVE'), () => api('PUT', `/api/devices/${encodeURIComponent(device.id)}`, { name: name.value.trim() }))); devices.append(row); }
  }
  await load();
}
guard().then(() => Promise.all([loadTokens(), loadTelegram(), credentialsPanel()])).catch(() => {});

// ---------- delete the account (password and authenticator code again, then gone for good) ----------
$('delForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!confirm(__('Delete your account for good? This cannot be undone.'))) return;
  say($('delMsg'), '');
  try {
    await api('POST', '/api/account/delete', { confirm: $('delConfirm').value.trim(), password: $('delPassword').value, code: $('delCode').value.trim() });
    location.replace('/login');
  } catch (err) {
    $('delPassword').value = ''; $('delCode').value = '';
    say($('delMsg'), err.message, 'err');
  }
});
