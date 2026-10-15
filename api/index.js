// Single Vercel Function behind every /api/* path (see the rewrite in vercel.json). The public demo (STAZIONE_DEMO=1,
// no DATABASE_URL) answers with lib/demo.js instead: made-up data in memory, read only.
import { handleRequest } from '../lib/app.js';

const handler = process.env.STAZIONE_DEMO === '1' && !process.env.DATABASE_URL ? (await import('../lib/demo.js')).demoHandler : handleRequest;

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
