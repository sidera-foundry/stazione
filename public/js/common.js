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
    if (!confirmed && data?.code === 'step_up_required' && await confirmIdentity(data.error)) return api(method, path, body, true);
    const err = new Error(data?.error || __`Error ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('stazione:api')); // activity, for the admin timer
  if (data?.status === 'pending_approval') {
    const err = new Error(__('Waiting for a second administrator. No change has been applied.'));
    err.status = 202; err.data = data; throw err;
  }
  return data;
}

/**
 * Asks the person to prove it is them again, inside the page: a 6-digit authenticator code, or a passkey when one is
 * registered. Used before sensitive actions and when the admin access timed out; nobody has to sign out and back in.
 * Resolves true once the server accepted the confirmation (it lasts 5 minutes), false if the person cancelled.
 */
let pending = null; // several requests failing together share one dialog
export function confirmIdentity(reason) {
  pending ??= (async () => {
    const passkeys = await import('./passkeys.js');
    const keys = passkeys.supported() ? await api('GET', '/api/passkeys', undefined, true).catch(() => ({ passkeys: [] })) : { passkeys: [] };
    const dialog = el('dialog', 'identity-dialog'), form = el('form'), msg = el('p', 'status-line');
    const code = el('input'); code.inputMode = 'numeric'; code.autocomplete = 'one-time-code'; code.maxLength = 6; code.pattern = '[0-9]{6}'; code.required = true;
    const label = el('label', 'field', __('6-digit code from your authenticator app')); label.append(code);
    const ok = el('button', null, __('Confirm')), cancel = el('button', 'ghost', __('Cancel')); cancel.type = 'button';
    const actions = el('div', 'identity-actions'); actions.append(ok);
    const usePasskey = keys.passkeys.length ? el('button', 'ghost', __('Use a passkey instead')) : null;
    if (usePasskey) { usePasskey.type = 'button'; actions.append(usePasskey); }
    actions.append(cancel);
    form.append(el('h2', null, __('Confirm it’s you')),
      el('p', null, reason === 'Admin access timed out. Confirm your identity to continue.'
        ? __('For security, admin access closes after 15 minutes without activity or 8 hours in total. Confirm it’s you to continue where you were: you don’t need to sign out.')
        : __('This is a sensitive action. Confirm it’s you; the confirmation lasts 5 minutes.')),
      label, msg, actions);
    dialog.append(form); document.body.append(dialog);
    return new Promise((resolve) => {
      const done = (result) => { dialog.close(); dialog.remove(); resolve(result); };
      const attempt = async (fn) => {
        for (const b of actions.querySelectorAll('button')) b.disabled = true;
        try { await fn(); window.dispatchEvent(new Event('stazione:confirmed')); done(true); }
        catch (err) { say(msg, err.name === 'NotAllowedError' ? __('Passkey cancelled. Try again or use the code.') : __(err.message), 'err'); }
        finally { for (const b of actions.querySelectorAll('button')) b.disabled = false; }
      };
      form.addEventListener('submit', (e) => { e.preventDefault(); attempt(() => api('POST', '/api/auth/step-up', { code: code.value.trim() }, true)); });
      usePasskey?.addEventListener('click', () => attempt(() => passkeys.ceremony(api, '/api/auth/passkey/step-up')));
      cancel.addEventListener('click', () => done(false));
      dialog.addEventListener('cancel', (e) => { e.preventDefault(); done(false); });
      dialog.showModal(); code.focus();
    });
  })().finally(() => { pending = null; });
  return pending;
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
