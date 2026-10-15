// Modules in the browser. Asks the station which modules are on, adds their translations and styles, and mounts
// their client scripts with a small station API: where to put things (slots), what is happening (events) and the
// usual helpers. A module that fails to load is reported in the console and the panel keeps working without it.
//
// Slots are empty containers the core leaves in the page: header (links next to the bell), station, missions,
// journal and tech (one per section, below the core panels). Events: "room" (the room on screen changed or the
// panel refreshed; detail: the room id, '' for the whole station) and "state" (fresh /api/state; detail: the state).
import { el, api, say, __, can, locale } from './common.js';
import { addTranslations } from './i18n.js';

const SLOTS = { header: 'moduleHeader', station: 'moduleStation', missions: 'moduleMissions', journal: 'moduleJournal', tech: 'moduleTech' };
let listPromise = null;

/** The switched-on modules (cached for the page): [{ id, name, client, scene, style, page, translations }]. */
export function enabledModules() {
  listPromise ??= api('GET', '/api/modules').then((r) => r.modules).catch(() => []);
  return listPromise;
}
// Served at /m/<id>/<file>: on Vercel, clean URLs would turn /api/...js into a redirect.
export const assetUrl = (id, file) => `/m/${encodeURIComponent(id)}/${encodeURIComponent(file)}`;

/** Lets the core tell the modules what happened (see the events above). */
export function emit(name, detail) { window.dispatchEvent(new CustomEvent(`stazione:module:${name}`, { detail })); }

/** Mounts every switched-on module that has a client script. Called once by the page that hosts the slots. */
export async function mountModules() {
  const list = await enabledModules();
  for (const m of list) {
    if (m.translations) addTranslations(m.translations);
    if (m.style) { const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = assetUrl(m.id, m.style); document.head.append(link); }
  }
  for (const m of list.filter((x) => x.client)) {
    const station = Object.freeze({
      id: m.id, api, el, say, __, can, locale,
      slot(name) { const node = document.getElementById(SLOTS[name]); if (!node) throw new Error(`no slot "${name}" on this page`); return node; },
      on(name, fn) { window.addEventListener(`stazione:module:${name}`, (e) => fn(e.detail)); },
    });
    try { const mod = await import(assetUrl(m.id, m.client)); await mod.default?.(station); }
    catch (err) { console.error(`module ${m.id}: ${err?.message || err}`); }
  }
}
