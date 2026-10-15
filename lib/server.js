// Plain Node HTTP front for the station, used by the self-hosted server (server.js) and the development server: static
// pages from public/, the client and the protocol for the Claudes, and every /api/* path through lib/app.js. Security
// headers are the ones vercel.json gives the pages on Vercel, so both ways of running it behave the same.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { handleRequest } from './app.js';

const MAX_BODY = 64 * 1024; // lib/app.js refuses bigger bodies too; here they are not even read
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.ico': 'image/x-icon', '.ps1': 'text/plain; charset=utf-8', '.sh': 'text/plain; charset=utf-8',
};

/**
 * root: the repository folder. hsts: send Strict-Transport-Security (only behind HTTPS). trustProxy: take the client
 * address from X-Real-IP / X-Forwarded-For (only behind a proxy that sets them; otherwise anyone could fake them).
 */
export function createServer({ root, hsts = true, trustProxy = false, handler = handleRequest }) {
  const publicDir = path.join(root, 'public');
  // On Vercel the build copies these two next to the pages: the connect scripts and the Claudes download them.
  const extra = { '/stazione.mjs': path.join(root, 'client', 'stazione.mjs'), '/CLAUDE.template.md': path.join(root, 'docs', 'CLAUDE.template.md'), '/AGENTS.template.md': path.join(root, 'docs', 'AGENTS.template.md') };
  const pageHeaders = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8')).headers[0].headers
    .filter((h) => hsts || h.key.toLowerCase() !== 'strict-transport-security')
    .map((h) => [h.key, hsts ? h.value : h.value.replace('; upgrade-insecure-requests', '')]);

  return http.createServer(async (req, res) => {
    try {
      // Behind a trusted HTTPS proxy the browser's Origin is https://...: build the same origin, or every write gets 403.
      const proto = trustProxy && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() === 'https' ? 'https' : 'http';
      const url = new URL(req.url, `${proto}://${req.headers.host || 'localhost'}`);
      if (['/admin', '/admin/', '/admin.html'].includes(url.pathname)) url.pathname = '/api/admin/page';
      // Pages of modules (/m/<id>), and the old address of the ideas board.
      if (['/ideas', '/ideas/', '/ideas.html'].includes(url.pathname)) url.pathname = '/m/ideas';
      const modulePage = /^\/m\/([a-z][a-z0-9-]{1,31})\/?$/.exec(url.pathname);
      if (modulePage) url.pathname = `/api/modules/${modulePage[1]}/page`;
      const moduleFile = /^\/m\/([a-z][a-z0-9-]{1,31})\/([a-z0-9][a-z0-9._-]{0,60})$/.exec(url.pathname);
      if (moduleFile) url.pathname = `/api/modules/${moduleFile[1]}/${moduleFile[2]}`;
      if (url.pathname.startsWith('/api/')) {
        if (Number(req.headers['content-length'] || 0) > MAX_BODY) { res.writeHead(413, { 'content-type': 'application/json' }); res.end('{"error":"Request too large"}'); return; }
        const chunks = []; let size = 0;
        for await (const c of req) {
          size += c.length;
          if (size > MAX_BODY) { res.writeHead(413, { 'content-type': 'application/json' }); res.end('{"error":"Request too large"}'); req.destroy(); return; }
          chunks.push(c);
        }
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers)) if (v != null) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
        if (!trustProxy) { headers.delete('x-forwarded-for'); headers.set('x-real-ip', req.socket.remoteAddress || 'unknown'); }
        const body = ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks);
        const response = await handler(new Request(url, { method: req.method, headers, body }));
        const out = {};
        response.headers.forEach((v, k) => { if (k !== 'set-cookie') out[k] = v; });
        const cookies = response.headers.getSetCookie();
        if (cookies.length) out['set-cookie'] = cookies;
        res.writeHead(response.status, out);
        res.end(Buffer.from(await response.arrayBuffer()));
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { allow: 'GET, HEAD' }); res.end(); return; }
      let rel = decodeURIComponent(url.pathname);
      let file = extra[rel];
      if (!file) {
        if (rel === '/') rel = '/index.html';
        if (!path.extname(rel)) rel += '.html'; // clean URLs, as on Vercel
        file = path.join(publicDir, path.normalize(rel));
        if (!file.startsWith(publicDir + path.sep)) file = null;
      }
      if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }
      const headers = { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' };
      for (const [k, v] of pageHeaders) headers[k] = v;
      res.writeHead(200, headers);
      if (req.method === 'HEAD') { res.end(); return; }
      fs.createReadStream(file).pipe(res);
    } catch (err) {
      console.error(`server error: ${err?.name || 'Error'}`);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
}
