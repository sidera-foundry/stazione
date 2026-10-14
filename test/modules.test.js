process.env.RECEPTION_DEFAULT = 'unrestricted';
// Modules: built-in ones are found and can be switched off (their routes, pages and files disappear) and on again;
// switching needs admin.modules and a confirmed identity; a guard can only refuse; the browser gets only the files a
// module lists; team modules are held to their rules (routes under /api/m/<id>/, own tables) and a broken one is
// left out instead of taking the station down.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { TOTP, Secret } from 'otpauth';
import { setDb, pgliteDb } from '../lib/db.js';
import { discover, loadModules, resetModules, runGuards, ROOT } from '../lib/modules.js';

process.env.PASSWORD_PEPPER ||= crypto.randomBytes(32).toString('base64');
process.env.DATA_ENCRYPTION_KEY ||= crypto.randomBytes(32).toString('base64');
process.env.INVITE_CODE ||= 'test-invite-code-0123456789';
process.env.HIBP_DISABLED = '1';
process.env.MAX_USERS = '10';

test('modules: built-in ones switch off and on, admin rights, guards, files', async () => {
  resetModules();
  setDb(pgliteDb(await PGlite.create({ parsers: { 20: (v) => Number(v) } })));
  const { handleRequest } = await import('../lib/app.js');
  let issuer = null;
  const person = async (username, ip) => {
    const jar = new Map();
    let secret = null;
    const call = async (method, p, body, token) => {
      const headers = new Headers({ 'x-real-ip': ip, 'content-type': 'application/json' });
      if (token) headers.set('authorization', `Bearer ${token}`); else headers.set('origin', 'http://localhost');
      if (jar.size && !token) headers.set('cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '));
      const res = await handleRequest(new Request(`http://localhost${p}`, { method, headers, body: body && JSON.stringify(body) }));
      for (const c of res.headers.getSetCookie()) { const [k, v] = c.split(';')[0].split('='); jar.set(k, v); }
      const text = await res.text(), type = res.headers.get('content-type') || '';
      return { status: res.status, type, body: type.startsWith('application/json') && text ? JSON.parse(text) : text };
    };
    const invite = issuer ? (await issuer('POST', '/api/invites', { role: 'member' })).body.code : process.env.INVITE_CODE;
    const start = await call('POST', '/api/auth/register/start', { invite, username, password: 'correct horse battery staple 42' });
    secret = start.body.secret;
    await call('POST', '/api/auth/register/confirm', { code: new TOTP({ secret: Secret.fromBase32(secret) }).generate() });
    const token = (await call('POST', '/api/tokens', { name: 'pc' })).body?.token;
    issuer ??= call;
    return { call, token, C: (m, p, b) => call(m, p, b, token) };
  };
  const boss = await person('boss', '10.30.0.1');
  const ann = await person('ann', '10.30.0.2');

  // Built-in modules are found; the example rule is off until someone switches it on.
  const listed = (await boss.call('GET', '/api/modules')).body.modules.map((m) => m.id);
  assert.deepEqual(listed.sort(), ['ideas', 'lounge', 'stats']);
  const all = (await boss.call('GET', '/api/admin/modules')).body.modules;
  assert.deepEqual(all.map((m) => [m.id, m.enabled, m.builtin]).sort(), [['ideas', true, true], ['lounge', true, true], ['protected-paths', false, true], ['stats', true, true]]);

  // Only who holds admin.modules sees and switches modules (the console hides itself from the others).
  assert.equal((await ann.call('GET', '/api/admin/modules')).status, 404);
  assert.equal((await ann.call('PUT', '/api/admin/modules/ideas', { enabled: false })).status, 404);

  // Browser files: only the ones a module lists, with their type; nothing else, no way out of the folder.
  const script = await ann.call('GET', '/api/modules/stats/client.js');
  assert.equal(script.status, 200); assert.match(script.type, /javascript/); assert.match(script.body, /export default function mount/);
  for (const p of ['/api/modules/stats/server.js', '/api/modules/stats/module.json', '/api/modules/stats/..%2Fideas%2Fserver.js', '/api/modules/nope/client.js']) assert.equal((await ann.call('GET', p)).status, 404, p);
  assert.equal((await ann.call('GET', '/api/modules/ideas/page')).status, 200);

  // Switching a module off: its API, page and files are gone for everybody; the data stays and comes back.
  assert.equal((await ann.call('POST', '/api/notes', { text: 'Keep the coffee machine' })).status, 200);
  assert.equal((await boss.call('PUT', '/api/admin/modules/ideas', { enabled: 'no' })).status, 400);
  assert.equal((await boss.call('PUT', '/api/admin/modules/ideas', { enabled: false })).status, 200);
  assert.equal((await ann.call('GET', '/api/notes')).status, 404);
  assert.equal((await ann.call('GET', '/api/modules/ideas/page')).status, 404);
  assert.equal((await ann.call('GET', '/api/modules/ideas/ideas.js')).status, 404);
  assert.ok(!(await ann.call('GET', '/api/modules')).body.modules.some((m) => m.id === 'ideas'));
  assert.equal((await boss.call('PUT', '/api/admin/modules/ideas', { enabled: true })).status, 200);
  assert.equal((await ann.call('GET', '/api/notes')).body.notes[0].text, 'Keep the coffee machine', 'data survives a module switched off');
  assert.equal((await boss.call('PUT', '/api/admin/modules/stats', { enabled: false })).status, 200);
  assert.equal((await ann.call('GET', '/api/stats')).status, 404);

  // A rule from a module only refuses. Protected paths: off by default, then on with its settings.
  await ann.C('POST', '/api/claudes/heartbeat', { as: 'annbot', name: 'Ann bot', new: true, join: { project: 'Shop' } });
  assert.equal((await ann.C('POST', '/api/locks', { as: 'annbot', project: 'Shop', resources: ['config/.env'] })).status, 200, 'off: no rule');
  await ann.C('POST', '/api/locks/release', { as: 'annbot', project: 'Shop', resources: ['config/.env'] });
  assert.equal((await boss.call('PUT', '/api/admin/modules/protected-paths/settings', { settings: { patterns: ['.env*', 'infra/**'], bogus: 1 } })).status, 400);
  assert.equal((await boss.call('PUT', '/api/admin/modules/protected-paths/settings', { settings: { patterns: ['.env*', 'infra/**'] } })).status, 200);
  assert.equal((await boss.call('PUT', '/api/admin/modules/protected-paths', { enabled: true })).status, 200);
  const refused = await ann.C('POST', '/api/locks', { as: 'annbot', project: 'Shop', resources: ['src/app.js', 'config/.env.local'] });
  assert.equal(refused.status, 403); assert.equal(refused.body.code, 'module_refused'); assert.match(refused.body.error, /config\/\.env\.local/);
  assert.equal((await ann.C('POST', '/api/locks', { as: 'annbot', project: 'Shop', resources: ['infra/deploy/prod.yml'] })).status, 403);
  for (const folder of ['infra', 'INFRA', './infra/', 'infra\\deploy']) assert.equal((await ann.C('POST', '/api/locks', { as: 'annbot', project: 'Shop', resources: [folder] })).status, 403, `a lock on ${folder} would cover protected files`);
  assert.equal((await ann.C('POST', '/api/locks', { as: 'annbot', project: 'Shop', resources: ['infrastructure/notes.md'] })).status, 200, 'a similar name is not the folder');
  assert.equal((await ann.C('POST', '/api/locks', { as: 'annbot', project: 'Shop', resources: ['src/app.js'] })).status, 200, 'other files are untouched');
  assert.equal((await ann.C('POST', '/api/tasks', { as: 'annbot', title: 'Rotate keys', project: 'Shop', resources: ['.env'] })).status, 403);
  assert.equal((await ann.C('POST', '/api/tasks', { as: 'annbot', title: 'Tidy the shop', project: 'Shop', resources: ['src/app.js'] })).status, 200);

  // Every switch is in the audit log.
  const audit = (await boss.call('GET', '/api/admin/audit?event=module_changed')).body.entries;
  assert.ok(audit.length >= 4 && audit.every((e) => e.event === 'module_changed'));
});

test('modules: switching needs a confirmed identity, like every sensitive console action', async () => {
  const { criticalAction } = await import('../lib/admin.js');
  assert.equal(criticalAction('PUT', '/api/admin/modules/:id'), true);
  assert.equal(criticalAction('PUT', '/api/admin/modules/:id/settings'), true);
  assert.equal(criticalAction('GET', '/api/admin/modules'), false);
});

test('modules: team modules keep to their rules, a broken one is left out', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'stazione-modules-'));
  const mod = (dir, id, json, server) => {
    mkdirSync(path.join(root, dir, id), { recursive: true });
    writeFileSync(path.join(root, dir, id, 'module.json'), JSON.stringify({ id, name: id, server: server ? 'server.js' : undefined, ...json }));
    if (server) writeFileSync(path.join(root, dir, id, 'server.js'), server);
  };
  try {
    mod('modules', 'core-one', {}, "export default (s) => s.route('GET', '/api/core-one/x', {}, async () => ({ ok: 1 }));");
    mod('modules-custom', 'good', {}, "export default (s) => { s.route('GET', '/api/m/good/hi', {}, async () => ({ hi: 1 })); s.schema('create table if not exists mod_good_items (id text primary key)'); s.guard('lock.take', () => 'no'); };");
    mod('modules-custom', 'outside', {}, "export default (s) => s.route('GET', '/api/outside', {}, async () => ({}));");
    mod('modules-custom', 'steals-table', {}, "export default (s) => s.schema('create table if not exists users_copy (id text)');");
    mod('modules-custom', 'console', {}, "export default (s) => s.route('GET', '/api/admin/evil', {}, async () => ({}));");
    mod('modules-custom', 'crashes', {}, "export default (s) => s.guard('lock.take', () => { throw new Error('boom'); });");
    mod('modules-custom', 'core-one', {}, "export default () => {};"); // same id as a built-in: ignored
    mod('modules-custom', 'Bad_Name', {});
    mod('modules-custom', 'no-file', { client: 'missing.js' });

    const found = discover(root);
    assert.deepEqual(found.map((m) => m.id), ['core-one', 'console', 'crashes', 'good', 'outside', 'steals-table']);
    assert.equal(found.find((m) => m.id === 'core-one').builtin, true, 'a team module cannot take a built-in id');

    resetModules();
    const reg = await loadModules(root);
    const broken = reg.list.filter((m) => m.broken).map((m) => m.id).sort();
    assert.deepEqual(broken, ['console', 'outside', 'steals-table']);
    assert.deepEqual(reg.routes.map((r) => r[1]).sort(), ['/api/core-one/x', '/api/m/good/hi']);
    assert.deepEqual(reg.schema.map((x) => x.id), ['good']);

    // Guards: any reason refuses; a crashing guard refuses too (fail closed); a switched-off module is skipped.
    const q = (chosen) => ({ query: async () => [{ settings: { modules: chosen } }] });
    const ctx = { after: [] };
    await assert.rejects(runGuards(q({ good: true, crashes: false }), ctx, 'lock.take', { resources: ['a'] }), (e) => e.status === 403 && e.extra.code === 'module_refused');
    await assert.rejects(runGuards(q({ good: false, crashes: true }), ctx, 'lock.take', { resources: ['a'] }), (e) => e.status === 503 && e.extra.code === 'module_guard_failed');
    await runGuards(q({ good: false, crashes: false }), ctx, 'lock.take', { resources: ['a'] });
  } finally {
    rmSync(root, { recursive: true, force: true });
    resetModules(); await loadModules(ROOT);
  }
});
