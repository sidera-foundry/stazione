// Self-hosted station: `npm start` (or the Docker image). Same app as on Vercel, served by plain Node on Postgres.
// Every setting comes from the environment (see lib/config.js and docs/INSTALL.md); put HTTPS in front of it with a
// reverse proxy (the login cookies are Secure, so browsers send them only over HTTPS or to localhost).
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkConfig } from './lib/config.js';

const { errors, warnings } = checkConfig();
for (const w of warnings) console.warn(`config: ${w}`);
if (errors.length) {
  for (const e of errors) console.error(`config: ${e}`);
  console.error('Stazione cannot start: fix the settings above (docs/INSTALL.md lists them all).');
  process.exit(1);
}

const root = path.dirname(fileURLToPath(import.meta.url));
const { createServer } = await import('./lib/server.js');
const { handleRequest } = await import('./lib/app.js');
const { db } = await import('./lib/db.js');
await db(); // connects and applies the schema now, so a wrong DATABASE_URL shows up at start-up

const server = createServer({ root, hsts: true, trustProxy: process.env.TRUST_PROXY === '1' });
const host = process.env.HOST || '0.0.0.0', port = Number(process.env.PORT || 3000);
server.listen(port, host, () => console.log(`Stazione listening on http://${host}:${port}`));

// Daily cleanup (expired sessions, old audit entries, stale locks...): on Vercel a cron calls it, here a timer does,
// through the same protected route. Without a CRON_SECRET a random one lives in memory for this process.
process.env.CRON_SECRET ||= crypto.randomBytes(32).toString('base64url');
const cleanup = () => handleRequest(new Request('http://localhost/api/cron/cleanup', { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }))
  .then((r) => { if (!r.ok) console.error(`cleanup failed: ${r.status}`); })
  .catch((err) => console.error(`cleanup failed: ${err?.name || 'Error'}`));
setTimeout(cleanup, 60e3).unref();
setInterval(cleanup, 24 * 3600e3).unref();

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)));
