// Modules seen from the panel and the admin console. The registry and its rules are in lib/modules.js.
import { fail } from '../http.js';
import { ORG_ID } from '../permissions.js';
import { audit } from '../auth.js';
import { loadModules, enabledModules, moduleById, moduleAsset, modulePage, moduleSettings, cleanSettings } from '../modules.js';

/** A module that is on, or 404 (a switched-off module does not exist for the panel). */
async function onModule(q, id) {
  const m = await moduleById(id);
  if (!m || !(await enabledModules(q)).has(m.id)) fail(404, 'Not found');
  return m;
}

export const moduleRoutes = [
  // What the panel loads: the switched-on modules and their browser files (scripts, styles, translations).
  ['GET', '/api/modules', { auth: 'any', perm: 'station.view' }, async (q) => {
    const on = await enabledModules(q), reg = await loadModules();
    return { modules: reg.list.filter((m) => on.has(m.id)).map((m) => ({ id: m.id, name: m.name, client: m.client || null, scene: m.scene || null, style: m.style || null, page: Boolean(m.page), translations: m.translations })) };
  }],
  // A module's own page (served at /m/<id>; /ideas is kept as an alias for the ideas board).
  ['GET', '/api/modules/:id/page', { auth: 'none', html: true }, async (q, ctx) => {
    const page = modulePage(await onModule(q, ctx.params.id));
    if (!page) fail(404, 'Not found');
    return page;
  }],

  // Browser files of a module that is on, only those listed in its module.json. Public like the core's /js/ files.
  ['GET', '/api/modules/:id/:file', { auth: 'none', asset: true }, async (q, ctx) => {
    const m = await onModule(q, ctx.params.id), asset = moduleAsset(m, ctx.params.file);
    if (!asset) fail(404, 'Not found');
    return asset;
  }],
  // Admin console: every module, on or off, with its settings.
  ['GET', '/api/admin/modules', { auth: 'human', admin: true, perm: 'admin.modules' }, async (q) => {
    const on = await enabledModules(q), reg = await loadModules();
    const list = [];
    for (const m of reg.list) list.push({ id: m.id, name: m.name, description: m.description, version: m.version, builtin: m.builtin, broken: Boolean(m.broken), enabled: on.has(m.id), defaultEnabled: m.defaultEnabled, settings: m.settings, values: await moduleSettings(q, m) });
    return { modules: list };
  }],
  ['PUT', '/api/admin/modules/:id', { auth: 'human', admin: true, perm: 'admin.modules' }, async (q, ctx) => {
    const m = await moduleById(ctx.params.id); if (!m) fail(404, 'Module not found');
    if (typeof ctx.body.enabled !== 'boolean') fail(400, 'enabled must be true or false');
    if (ctx.body.enabled && m.broken) fail(409, 'This module failed to load: check the server log before switching it on');
    const [org] = await q.query('select settings from orgs where id = $1 for update', [ORG_ID]);
    const modules = { ...(org.settings.modules || {}), [m.id]: ctx.body.enabled };
    await q.query('update orgs set settings = settings || $2::jsonb where id = $1', [ORG_ID, JSON.stringify({ modules })]);
    audit(q, ctx, 'module_changed', ctx.principal.userId, { module: m.id, enabled: ctx.body.enabled });
    return { ok: true };
  }],
  ['PUT', '/api/admin/modules/:id/settings', { auth: 'human', admin: true, perm: 'admin.modules' }, async (q, ctx) => {
    const m = await moduleById(ctx.params.id); if (!m) fail(404, 'Module not found');
    const values = cleanSettings(m, ctx.body.settings);
    const [org] = await q.query('select settings from orgs where id = $1 for update', [ORG_ID]);
    const moduleSettingsAll = { ...(org.settings.moduleSettings || {}), [m.id]: { ...(org.settings.moduleSettings?.[m.id] || {}), ...values } };
    await q.query('update orgs set settings = settings || $2::jsonb where id = $1', [ORG_ID, JSON.stringify({ moduleSettings: moduleSettingsAll })]);
    audit(q, ctx, 'module_settings_changed', ctx.principal.userId, { module: m.id, keys: Object.keys(values) });
    return { ok: true };
  }],
];
