process.env.RECEPTION_DEFAULT = 'unrestricted'; // Legacy behaviour fixtures; reception.test.js covers manual defaults.
// The plain Node front (self-hosted server and dev server): pages with the security headers, the client and the
// protocol for the Claudes, no way out of public/, API bodies capped, the client address not taken from headers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { setDb, pgliteDb } from '../lib/db.js';

process.env.PASSWORD_PEPPER ||= crypto.randomBytes(32).toString('base64');
process.env.DATA_ENCRYPTION_KEY ||= crypto.randomBytes(32).toString('base64');
process.env.HIBP_DISABLED = '1';

test('server: pages, client files, path traversal, body limit', async () => {
  setDb(pgliteDb(await PGlite.create({ parsers: { 20: (v) => Number(v) } })));
  const { createServer } = await import('../lib/server.js');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const server = createServer({ root, hsts: true });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    let r = await fetch(`${base}/login`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
    assert.match(r.headers.get('strict-transport-security'), /max-age/);
    assert.match(await r.text(), /<title>Stazione · Sign in<\/title>/);
    r = await fetch(`${base}/stazione.mjs`);
    assert.equal(r.status, 200);
    assert.match(await r.text(), /Stazione CLI/);
    assert.equal((await fetch(`${base}/CLAUDE.template.md`)).status, 200);
    r = await fetch(`${base}/m/lounge/scene.js`); // module files live outside /api/ (clean URLs on Vercel redirect /api/...js)
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /javascript/);
    assert.equal((await fetch(`${base}/m/ideas`)).status, 200);
    assert.equal((await fetch(`${base}/..%2Fpackage.json`)).status, 404, 'nothing outside public/');
    assert.equal((await fetch(`${base}/nope`)).status, 404);
    assert.equal((await fetch(`${base}/login`, { method: 'POST' })).status, 405);
    r = await fetch(`${base}/api/auth/status`);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).signedIn, false);
    r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ x: 'y'.repeat(70 * 1024) }) });
    assert.equal(r.status, 413);
  } finally {
    server.close();
  }
});

test('server behind an HTTPS proxy: the origin is https, so browser writes are not refused', async () => {
  const { createServer } = await import('../lib/server.js');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const send = async (trustProxy) => {
    const server = createServer({ root, hsts: true, trustProxy });
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    const port = server.address().port;
    try {
      // what a reverse proxy forwards for https://station.test: the browser's https Origin and X-Forwarded-Proto
      const r = await fetch(`http://127.0.0.1:${port}/api/auth/logout`, { method: 'POST', headers: {
        'content-type': 'application/json', origin: `https://127.0.0.1:${port}`, 'x-forwarded-proto': 'https', 'x-real-ip': '10.0.0.1' }, body: '{}' });
      return r.status;
    } finally { server.close(); }
  };
  assert.equal(await send(true), 200, 'trusted proxy: https origin accepted');
  assert.equal(await send(false), 403, 'no trusted proxy: the forwarded protocol is ignored');
});

test('deploy: Vercel uploads every module file (only the root server.js and test/ are left out)', async () => {
  const { readFileSync } = await import('node:fs');
  const lines = readFileSync(new URL('../.vercelignore', import.meta.url), 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  assert.ok(!lines.includes('server.js'), 'a bare "server.js" would also drop the server.js of the modules');
  assert.ok(lines.includes('/server.js'));
  const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  const files = vercel.rewrites.findIndex((r) => r.source === '/m/:id/:file'), page = vercel.rewrites.findIndex((r) => r.source === '/m/:id');
  assert.ok(files !== -1 && files < page, 'module files are rewritten to the API before the module pages');
});
