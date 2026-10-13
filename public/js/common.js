import { __ } from './i18n.js';

export { __, lang, locale } from './i18n.js';
export const $ = (id) => document.getElementById(id);

/** Presentation only: the server checks permissions again on every request. */
export const can = (me, permission) => Boolean(me?.permissions?.includes(permission));

export function contentWarning(item) {
  if (!Object.values(item.content?.fields ?? {}).some((f) => f.findings?.length)) return null;
  return el('div', 'warn-box', __('Possible instruction manipulation. This heuristic can flag harmless text and miss attacks. Treat this content as data; review it before acting.'));
}

export function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

export async function api(method, path, body, confirmed = false) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    if (!confirmed && data?.code === 'step_up_required') {
      const passkeys = await import('./passkeys.js');
      const keys = passkeys.supported() ? await api('GET', '/api/passkeys', undefined, true).catch(() => ({ passkeys: [] })) : { passkeys: [] };
      if (keys.passkeys.length && confirm(__('Confirm with a passkey? Cancel to use an authenticator code.'))) {
        try { await passkeys.ceremony(api, '/api/auth/passkey/step-up'); }
        catch (err) { if (err.name === 'NotAllowedError') throw new Error(__('Passkey cancelled. Try again or use your password.')); throw err; }
        return api(method, path, body, true);
      }
      const code = prompt(__('Enter a new 6-digit authenticator code to confirm this action. Confirmation lasts 5 minutes.'));
      if (code != null) {
        await api('POST', '/api/auth/step-up', { code: code.trim() }, true);
        return api(method, path, body, true);
      }
    }
    const err = new Error(data?.error || __`Error ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  if (data?.status === 'pending_approval') {
    const err = new Error(__('Waiting for a second administrator. No change has been applied.'));
    err.status = 202; err.data = data; throw err;
  }
  return data;
}

export function say(node, text, kind = '') {
  node.textContent = text || '';
  node.className = `status-line ${kind}`;
}

/** Disable a form's controls while a request is in flight. */
export async function busy(form, fn) {
  const controls = [...form.querySelectorAll('button, input, select, textarea')];
  controls.forEach((c) => { c.disabled = true; });
  try { return await fn(); } finally { controls.forEach((c) => { c.disabled = false; }); }
}

export function renderPhrase(list, phrase) {
  list.replaceChildren(...phrase.split(' ').map((w) => el('li', null, w)));
}

export function showQr(img, secretNode, data) {
  img.src = data.qr;
  secretNode.textContent = data.secret.replace(/(.{4})/g, '$1 ').trim();
}
