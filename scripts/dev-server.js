// Local development server: static files from public/ + the API on an in-process PGlite database.
// Usage: npm run dev   (reads .env.local if present, otherwise generates throwaway dev secrets)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { setDb, pgliteDb } from '../lib/db.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(root, '.env.local');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const gen = (n) => crypto.randomBytes(n).toString('base64');
process.env.PASSWORD_PEPPER ||= gen(32);
process.env.DATA_ENCRYPTION_KEY ||= gen(32);
if (!process.env.INVITE_CODE) {
  process.env.INVITE_CODE = 'dev-invite-' + crypto.randomBytes(6).toString('hex');
  console.log(`Development invite code: ${process.env.INVITE_CODE}`);
}

const dataDir = process.env.DEV_DB_DIR || path.join(root, '.dev-db');
setDb(pgliteDb(await PGlite.create(dataDir, { parsers: { 20: (v) => Number(v) } })));
const { createServer } = await import('../lib/server.js');
const server = createServer({ root, hsts: false });

const port = Number(process.env.PORT || 3000);
server.listen(port, '127.0.0.1', () => console.log(`Stazione in development: http://localhost:${port}`));
