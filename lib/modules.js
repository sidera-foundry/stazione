// Modules: the optional parts of the station, each in its own folder. Built-in ones ship in modules/, a team's own
// ones live in modules-custom/ (never touched by upstream updates, so `git pull` stays clean). An owner (or whoever
// holds admin.modules) switches them on and off from the admin console; see docs/DESIGN-modules.md.
//
// A module is trusted code, like the core: it is installed by whoever controls the repository, never from the panel.
// What a module may do is still narrow and checked here:
// - routes: built-in modules keep their historical paths under /api/; team modules only under /api/m/<id>/; nobody can
//   replace a core route or add admin console routes. A switched-off module's routes answer 404.
// - guards: run before a few core actions and may only refuse them (return a reason). They can never grant a
//   permission, skip an approval or change the request. A guard that crashes refuses the action (fail closed).
// - events: run after the action committed, never inside the request; an error there is logged and ignored.
// - schema: team modules may create only their own tables (mod_<id>_...). Tables of built-in modules belong to the core
//   schema, so turning a module off never loses or corrupts data.
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fail, HttpError } from './http.js';
import { ORG_ID } from './permissions.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MODULE_DIRS = [['modules', true], ['modules-custom', false]];
export const GUARDS = ['mission.create', 'lock.take', 'message.send'];
export const EVENTS = ['mission.created', 'lock.taken', 'message.sent'];
const ID_RE = /^[a-z][a-z0-9-]{1,31}$/;
const FILE_RE = /^[a-z0-9][a-z0-9._-]{0,60}\.(js|mjs|css|html|json|svg|png)$/;
const SETTING_TYPES = ['text', 'list', 'bool'];
const TYPES = { js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', html: 'text/html; charset=utf-8', json: 'application/json; charset=utf-8', svg: 'image/svg+xml', png: 'image/png' };

const isStr = (v, max = 200) => typeof v === 'string' && v.length > 0 && v.length <= max;

/** Reads and checks one module.json; throws with a clear message when something is off. */
function readManifest(dir, folder, builtin) {
  const file = path.join(dir, folder, 'module.json');
  const m = JSON.parse(readFileSync(file, 'utf8'));
  if (m.id !== folder || !ID_RE.test(m.id)) throw new Error(`module ${folder}: "id" must equal the folder name (lowercase letters, digits, dashes)`);
  if (!isStr(m.name, 60)) throw new Error(`module ${folder}: "name" is required (max 60 characters)`);
  if (m.description != null && !isStr(m.description, 400)) throw new Error(`module ${folder}: "description" is too long`);
  if (m.defaultEnabled != null && typeof m.defaultEnabled !== 'boolean') throw new Error(`module ${folder}: "defaultEnabled" must be true or false`);
  const files = {};
  for (const key of ['server', 'client', 'scene', 'style', 'page']) {
    if (m[key] == null) continue;
    if (typeof m[key] !== 'string' || !FILE_RE.test(m[key]) || !existsSync(path.join(dir, folder, m[key]))) throw new Error(`module ${folder}: "${key}" must name a file in the module folder`);
    files[key] = m[key];
  }
  const assets = [...new Set([files.client, files.scene, files.style, ...(Array.isArray(m.assets) ? m.assets : [])].filter(Boolean))];
  for (const a of assets) if (typeof a !== 'string' || !FILE_RE.test(a) || !existsSync(path.join(dir, folder, a))) throw new Error(`module ${folder}: asset "${a}" is missing or has an unsafe name`);
  const settings = Array.isArray(m.settings) ? m.settings : [];
  for (const s of settings) {
    if (!s || !/^[a-zA-Z][a-zA-Z0-9]{0,31}$/.test(s.key) || !isStr(s.label, 120) || !SETTING_TYPES.includes(s.type)) throw new Error(`module ${folder}: each setting needs a key, a label and a type (${SETTING_TYPES.join(', ')})`);
  }
  const translations = m.translations && typeof m.translations === 'object' ? m.translations : {};
  return {
    id: m.id, name: m.name, description: m.description || '', version: String(m.version || '1'), builtin,
    defaultEnabled: m.defaultEnabled !== false, dir: path.join(dir, folder), ...files, assets, settings, translations,
  };
}

/** Every module folder under the root, built-in first. A team module cannot reuse a built-in id. */
export function discover(root = ROOT) {
  const list = [], ids = new Set();
  for (const [name, builtin] of MODULE_DIRS) {
    const dir = path.join(root, name);
    if (!existsSync(dir)) continue;
    for (const folder of readdirSync(dir).sort()) {
      if (folder.startsWith('.') || folder.startsWith('_') || !statSync(path.join(dir, folder)).isDirectory()) continue;
      if (!existsSync(path.join(dir, folder, 'module.json'))) continue;
      try {
        const m = readManifest(dir, folder, builtin);
        if (ids.has(m.id)) { console.error(`module ${m.id}: skipped, a module with this id already exists`); continue; }
        ids.add(m.id); list.push(m);
      } catch (err) { console.error(String(err.message || err)); }
    }
  }
  return list;
}

/** The part of the API a module's server.js receives in setup(station). */
function moduleApi(m, reg) {
  const table = `mod_${m.id.replace(/-/g, '_')}_`;
  return Object.freeze({
    id: m.id,
    builtin: m.builtin,
    route(method, pattern, opts, handler) {
      if (!['GET', 'POST', 'PUT', 'DELETE'].includes(method) || typeof pattern !== 'string' || typeof handler !== 'function') throw new Error(`module ${m.id}: route needs a method, a path and a handler`);
      if (!pattern.startsWith('/api/') || pattern.startsWith('/api/admin/') || pattern.startsWith('/api/modules')) throw new Error(`module ${m.id}: routes live under /api/ and never under /api/admin/ or /api/modules`);
      if (!m.builtin && !pattern.startsWith(`/api/m/${m.id}/`)) throw new Error(`module ${m.id}: team modules add routes only under /api/m/${m.id}/`);
      if (opts?.admin || opts?.html || opts?.asset) throw new Error(`module ${m.id}: modules cannot add console, page or asset routes this way`);
      reg.routes.push([method, pattern, { auth: 'human', ...opts, module: m.id }, handler]);
    },
    guard(action, fn) {
      if (!GUARDS.includes(action) || typeof fn !== 'function') throw new Error(`module ${m.id}: guards exist only for ${GUARDS.join(', ')}`);
      reg.guards.get(action).push({ id: m.id, name: m.name, fn });
    },
    on(event, fn) {
      if (!EVENTS.includes(event) || typeof fn !== 'function') throw new Error(`module ${m.id}: events are ${EVENTS.join(', ')}`);
      reg.events.get(event).push({ id: m.id, fn });
    },
    schema(sql) {
      if (typeof sql !== 'string') throw new Error(`module ${m.id}: schema takes SQL text`);
      if (!m.builtin) {
        for (const stmt of sql.split(';').map((s) => s.trim()).filter(Boolean)) {
          const t = /^create\s+table\s+if\s+not\s+exists\s+([a-z0-9_]+)\s*\(/i.exec(stmt);
          const i = /^create\s+(?:unique\s+)?index\s+if\s+not\s+exists\s+([a-z0-9_]+)\s+on\s+([a-z0-9_]+)\s*\(/i.exec(stmt);
          const ok = (t && t[1].startsWith(table)) || (i && i[1].startsWith(table) && i[2].startsWith(table));
          if (!ok) throw new Error(`module ${m.id}: schema may only create tables and indexes named ${table}...`);
        }
      }
      reg.schema.push({ id: m.id, sql });
    },
  });
}

let registry = null;
/** Discovers the modules and runs every server.js setup once per process (cold start). */
export function loadModules(root = ROOT) {
  registry ??= (async () => {
    const reg = { list: discover(root), routes: [], schema: [], guards: new Map(GUARDS.map((a) => [a, []])), events: new Map(EVENTS.map((e) => [e, []])) };
    for (const m of reg.list) {
      if (!m.server) continue;
      try {
        const mod = await import(pathToFileURL(path.join(m.dir, m.server)).href);
        if (typeof mod.default !== 'function') throw new Error(`module ${m.id}: server.js must export a default setup(station) function`);
        await mod.default(moduleApi(m, reg));
      } catch (err) {
        // A broken module never takes the station down: it is reported and left out.
        console.error(`module ${m.id}: ${err?.message || err}`);
        m.broken = true;
        reg.routes = reg.routes.filter(([, , o]) => o.module !== m.id); reg.schema = reg.schema.filter((x) => x.id !== m.id);
        for (const list of [...reg.guards.values(), ...reg.events.values()]) for (let i = list.length - 1; i >= 0; i--) if (list[i].id === m.id) list.splice(i, 1);
      }
    }
    return reg;
  })();
  return registry;
}
/** Tests only: forget the loaded modules, to load another root. */
export function resetModules() { registry = null; }

/** Ids of the modules that are on: the owner's choice, else the module's default. Broken modules are always off. */
export async function enabledModules(q) {
  const reg = await loadModules();
  const [org] = await q.query('select settings from orgs where id = $1', [ORG_ID]);
  const chosen = org?.settings?.modules || {};
  return new Set(reg.list.filter((m) => !m.broken && (typeof chosen[m.id] === 'boolean' ? chosen[m.id] : m.defaultEnabled)).map((m) => m.id));
}
export async function moduleById(id) { return (await loadModules()).list.find((m) => m.id === id) || null; }

/** A module's settings: its declared defaults, overridden by what the owner saved. */
export async function moduleSettings(q, m) {
  const [org] = await q.query('select settings from orgs where id = $1', [ORG_ID]);
  const saved = org?.settings?.moduleSettings?.[m.id] || {};
  return Object.fromEntries(m.settings.map((s) => [s.key, saved[s.key] ?? s.default ?? (s.type === 'list' ? [] : s.type === 'bool' ? false : '')]));
}
/** Checks a settings object against the module's declared settings; unknown keys are refused. */
export function cleanSettings(m, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, 'Settings must be an object');
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    const s = m.settings.find((x) => x.key === key);
    if (!s) fail(400, `Unknown setting: ${key}`);
    if (s.type === 'bool') { if (typeof value !== 'boolean') fail(400, `${key} must be true or false`); out[key] = value; }
    else if (s.type === 'text') { if (typeof value !== 'string' || value.length > 500) fail(400, `${key} must be text (max 500 characters)`); out[key] = value.trim(); }
    else {
      if (!Array.isArray(value) || value.length > 100 || value.some((v) => typeof v !== 'string' || !v.trim() || v.length > 200)) fail(400, `${key} must be a list of up to 100 short texts`);
      out[key] = [...new Set(value.map((v) => v.trim()))];
    }
  }
  return out;
}

/**
 * Runs the guards of the switched-on modules before a core action. Any reason refuses the action for everyone;
 * nothing a guard returns can allow something the core would refuse.
 */
export async function runGuards(q, ctx, action, payload) {
  const reg = await loadModules(), guards = reg.guards.get(action);
  if (!guards?.length) return;
  const on = await enabledModules(q);
  for (const g of guards) {
    if (!on.has(g.id)) continue;
    let reason;
    try { reason = await g.fn({ q, ctx, payload: structuredClone(payload), settings: await moduleSettings(q, reg.list.find((m) => m.id === g.id)) }); }
    catch (err) {
      if (err instanceof HttpError) throw err;
      console.error(`module ${g.id}: guard ${action} failed: ${err?.message || err}`);
      fail(503, `The ${g.name} module could not check this action, so it was refused. Tell an administrator.`, { code: 'module_guard_failed', module: g.id });
    }
    if (typeof reason === 'string' && reason.trim()) fail(403, `Refused by the ${g.name} module: ${reason.trim().slice(0, 300)}`, { code: 'module_refused', module: g.id });
  }
}

/** Queues an event for the switched-on modules; it runs after the request committed, with its own connection. */
export function emitEvent(ctx, event, payload) {
  ctx.after.push(async (database) => {
    const reg = await loadModules(), handlers = reg.events.get(event);
    if (!handlers?.length) return;
    const on = await enabledModules(database);
    for (const h of handlers) {
      if (!on.has(h.id)) continue;
      try { await h.fn({ q: database, payload: structuredClone(payload) }); } catch (err) { console.error(`module ${h.id}: event ${event} failed: ${err?.message || err}`); }
    }
  });
}

/** A file a module serves to the browser, only if it is listed in its module.json. */
export function moduleAsset(m, file) {
  if (!FILE_RE.test(file) || !m.assets.includes(file)) return null;
  const ext = file.split('.').pop();
  return { body: readFileSync(path.join(m.dir, file), ext === 'png' ? undefined : 'utf8'), type: TYPES[ext] };
}
export function modulePage(m) { return m.page ? readFileSync(path.join(m.dir, m.page), 'utf8') : null; }
