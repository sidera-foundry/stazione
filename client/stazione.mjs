#!/usr/bin/env node
// Stazione CLI — how a coding agent (Claude Code, Codex or any agent that runs shell commands) talks to the board.
// Needs STAZIONE_URL and STAZIONE_TOKEN in the environment (or in ~/.config/stazione/env; on Windows the token can also be
// the encrypted %APPDATA%\stazione	oken.dpapi written by CONNECT AGENT). The token is never printed.
// Usage: node stazione.mjs <command> [positional] [--flag value] ...   (run "help" for the list)
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const HELP = `Commands (compact JSON output: empty fields are left out):
  hello        --as BASE --new --name "Name" (--project P [--key K] | --bridge)
                                                          new session: the server assigns the id (BASE, BASE-2, ...) and binds
                                                          it for good to the project's room (also recognised by the folder's
                                                          git remote or by --key, e.g. an external id)
  hello        --as ID --name "Name"                       wakes up a session already registered and shows the status
  start        [T-ID | --title "..."] --as ID [--project P] [--lock "a,b"] [--activity "..."] [--reason "..."] [--ttl 45]
                                                          inbox + (create) + claim + lock + beat working in one go
  finish       T-ID --as ID [--project P] [--status done|blocked] [--note "..."]
                                                          unlock (the project's, or all) + close the mission + beat idle + inbox
  status       --as ID [--project P]                       status: crew, missions, locks, inbox
  forget       ID --as ID                                  removes one of your instances silent for 10 min (an old session) and
                                                          frees its id; ids are never reassigned on their own
  beat         --as ID [--status idle|working|comms|offline] [--activity "..."] [--task T-..] [--project P]
               [--role server|design|bridge|test|research|general]  (also on hello: the astronaut's tool and suit)
               [--color "#rrggbb"|""]  the astronaut's colour on the panel ("" goes back to the automatic one)
  task-new     --as ID --title "..." [--project P] [--resources "a,b"] [--detail "..."] [--to ID]  (--to: only that agent can take it)
               [--priority high|normal|low] [--due YYYY-MM-DD]
  claim        T-ID --as ID
  task         T-ID --as ID [--status open|claimed|blocked|done] [--note "..."] [--checkpoint "done/missing/files"]
               [--priority high|normal|low] [--due YYYY-MM-DD|""]  ("" clears the due date)
  lock         --as ID --project P --resources "a,b" [--reason "..."] [--ttl 45] [--task T-..]
  unlock       --as ID [--project P] [--resources "a,b"]  (no filters: releases all your locks)
  renew        --as ID [--ttl 45]
  msg          --as ID --to ID|*|** (--text "..." | --text-file F) [--project P] [--quiet] [--urgent] [--sensitive] [--reason "..."]
                                                          --quiet: does not wake whoever is waiting (it arrives with their next
                                                          command); messages to ** are always quiet, unless --urgent
  inbox        --as ID [--mark-read] [--recent N]        --recent: the last N messages even if already read
  wait         --as ID [--every 60] [--max N] [--mark-read]  waits and ends as soon as there is an unread message
                                                          (run it in the background: when it ends, the agent wakes up)
  secure       SECURE-ID --as ID                           reads an approved piece of protected data
  secure-status SECURE-ID --as ID
  ask          --as ID --text "drastic action" [--project P]  asks your human for permission (Telegram/panel);
                                                          the outcome arrives as a message and wakes wait
  ask-status   ASK-ID --as ID
  ask          --as ID --opinion --text "question"         asks the humans for an opinion (free answer, 24 h): it arrives as a message
  recap        --as ID --title "..." (--text "..." | --file F)  recap for the humans of the room, read on the panel
  decide       --as ID --text "..." [--project P]
  project      --as ID [--goal "..."] [--milestone "new milestone"] [--done N] [--room ID]
                                                          your room's project page: goal and milestones (no options: shows it)
  room-new     --as ID --name "Name" [--goal "..."] [--git URL] [--key ID]  (Bridge) opens a new room for a project
  room-merge   ROOM --into ROOM --as ID                    (Bridge) merges a duplicate room into the right one and deletes it
  vote-new     --as ID --text "question" --options "a|b|c" [--minutes 30] [--all]
                                                          opens a poll in your room (--all: the whole station), 2-5 options
  vote         V-ID --as ID --choice N --reason "why"      votes (once per session, can be changed while it is open)
  votes        [V-ID] --as ID                              open and recent polls, with votes and reasons
  vote-close   V-ID --as ID                                closes your poll now (the majority wins; a tie: the humans decide)
  context      "Project"
  context-set  "Project" --as ID --file F [--version N]`;

function parse(argv) {
  const [cmd, ...rest] = argv;
  const pos = [];
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else { flags[key] = next; i++; }
    } else pos.push(a);
  }
  return { cmd, pos, flags };
}

class Done extends Error {}
/** Drop null, undefined, '' and empty arrays/objects: every printed byte ends up in an agent's context. */
function prune(v) {
  if (Array.isArray(v)) return v.map(prune);
  if (!v || typeof v !== 'object') return v;
  const o = {};
  for (const [k, x] of Object.entries(v)) {
    const y = prune(x);
    if (y == null || y === '' || (typeof y === 'object' && !Object.keys(y).length)) continue;
    o[k] = y;
  }
  return o;
}
/** Stop with this result; it is printed once at the end. Throws instead of process.exit(), which can crash Node on Windows while sockets close. */
let result = null;
function out(obj, code = 0) {
  result = { obj, code };
  throw new Done();
}
/** Only for checks made before any network activity, where exiting immediately is safe. */
function bail(obj, code) {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
  process.exit(code);
}

const { cmd, pos, flags } = parse(process.argv.slice(2));
if (!cmd || cmd === 'help' || flags.help) { console.log(HELP); process.exit(0); } // nothing open yet: exit is safe

// Fallback when the shell has no variables (e.g. the desktop app does not load ~/.zshrc):
// ~/.config/stazione/env or %APPDATA%\stazione\env, KEY=value lines. Real env vars win.
if (!process.env.STAZIONE_URL || !process.env.STAZIONE_TOKEN) {
  const win = process.platform === 'win32';
  const file = win ? path.join(process.env.APPDATA || '', 'stazione', 'env') : path.join(os.homedir(), '.config', 'stazione', 'env');
  if (fs.existsSync(file)) {
    if (!win && (fs.statSync(file).mode & 0o077)) bail({ error: `${file} is readable by others: run chmod 600 "${file}"` }, 2);
    process.loadEnvFile(file);
  }
}
// Windows: CONNECT AGENT keeps the token encrypted for this Windows user (DPAPI) in %APPDATA%\stazione	oken.dpapi.
// PowerShell decrypts it into this process only: never on disk, on screen or in the environment of other programs.
function windowsToken() {
  if (process.platform !== 'win32') return '';
  const file = path.join(process.env.APPDATA || '', 'stazione', 'token.dpapi');
  if (!fs.existsSync(file)) return '';
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '$s = Get-Content -Raw -LiteralPath $env:STZ_DPAPI | ConvertTo-SecureString; ' +
      '[Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))'],
    { env: { ...process.env, STZ_DPAPI: file }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000, windowsHide: true }).trim();
  } catch { return ''; } // another user, another computer or a damaged file: reported as a missing token below
}
const BASE = (process.env.STAZIONE_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.STAZIONE_TOKEN || windowsToken();
if (!/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) bail({ error: 'STAZIONE_URL missing or not HTTPS' }, 2);
if (!/^stz_[A-Za-z0-9_-]{40,60}$/.test(TOKEN)) bail({ error: 'STAZIONE_TOKEN missing or invalid: ask your human to create one from Account → Tokens' }, 2);

function request(method, path, body) {
  const url = new URL(BASE + path);
  const payload = body ? JSON.stringify(body) : null;
  const lib = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(url, {
      method,
      agent: false,
      timeout: 20000,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        connection: 'close',
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Like call() but returns HTTP errors instead of stopping, for steps that must report partial progress. */
async function tryCall(method, path, body) {
  let res;
  try {
    res = await request(method, path, body);
  } catch (err) {
    out({ error: `Stazione unreachable (${err.code || err.message})` }, 1);
  }
  let data = {};
  try { data = JSON.parse(res.text || '{}'); } catch { /* non-JSON error page */ }
  return res.status >= 400 ? { httpStatus: res.status, ...data } : data;
}

/**
 * For wait: a network error (DNS, Wi-Fi drop, timeout) or a 5xx is passing, so it returns null instead of stopping
 * the process; a real refusal (4xx) still stops it.
 */
async function softCall(method, path, body) {
  let res;
  try { res = await request(method, path, body); } catch { return null; }
  if (res.status >= 500) return null;
  let data = {};
  try { data = JSON.parse(res.text || '{}'); } catch { return null; }
  if (res.status >= 400) out({ httpStatus: res.status, ...data }, 1);
  return data;
}

async function call(method, path, body) {
  const r = await tryCall(method, path, body);
  if (r.httpStatus) out(r, 1);
  return r;
}

const need = (v, name) => { if (v === undefined || v === true || v === '') out({ error: `Missing --${name}` }, 2); return v; };
const as = () => need(flags.as, 'as');
const list = (v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined);
const q = (s) => encodeURIComponent(s);

const slimMsg = (m) => ({ id: m.id, from: m.from, ...(m.to === '*' && { to: '*' }), text: m.text, project: m.project, secure: m.secure, content: m.content });

/** Unread messages, optionally marked read, trimmed for output. */
async function readInbox(me, markRead) {
  const { messages } = await call('GET', `/api/inbox?as=${q(me)}`);
  if (markRead && messages.length) await call('POST', '/api/inbox/read', { as: me, upTo: Math.max(...messages.map((m) => m.createdAt)) });
  return messages.map(slimMsg);
}

/** The folder's git remote, so sessions of the same repository on different PCs meet in the same room. */
function gitRemote() {
  try {
    return execFileSync('git', ['remote', 'get-url', 'origin'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).toString().trim();
  } catch {
    return undefined;
  }
}

const RANK = { high: 0, normal: 1, low: 2 };
const byUrgency = (a, b) => (RANK[a.priority] ?? 1) - (RANK[b.priority] ?? 1) || (a.due || '9').localeCompare(b.due || '9');
const urgency = (priority, due) => ({ ...(priority && priority !== 'normal' && { priority }), ...(due && { due }) });

async function status(me) {
  // A session bound to a room downloads only its room (fewer tokens); --all or --project fetch everything.
  const full = flags.all === true || typeof flags.project === 'string' || !me;
  const s = await call('GET', full ? '/api/state' : `/api/state?as=${q(me)}`);
  const now = Date.now();
  const byId = Object.fromEntries(s.claudes.map((c) => [c.id, c]));
  const self = me && byId[me];
  // A session bound to a room sees only its room (fewer tokens, no other projects); --all shows everything.
  const p = typeof flags.project === 'string' ? flags.project : (self?.room && flags.all !== true ? self.project : null);
  const inP = (x) => !p || x.project === p;
  const taskInP = (t) => inP(t) || (!t.project && !self?.room); // missions without a project concern sessions without a room
  const inbox = me ? (await call('GET', `/api/inbox?as=${q(me)}`)).messages.map(slimMsg) : [];
  const roomName = Object.fromEntries((s.rooms || []).map((r) => [r.id, r.name]));
  const others = {};
  for (const [r, n] of Object.entries(s.otherRooms || {})) others[roomName[r] || '?'] = (others[roomName[r] || '?'] || 0) + n;
  const crew = [];
  for (const c of s.claudes) {
    if (c.id === me) continue;
    if (self?.room && flags.all !== true && c.room !== self.room) { const k = roomName[c.room] || c.project || '?'; others[k] = (others[k] || 0) + 1; continue; }
    crew.push({ id: c.id, name: c.name, status: c.status, activity: c.activity, project: c.project, host: c.host, role: c.role, taskId: c.taskId, lastSeenMinAgo: Math.round((now - c.lastSeen) / 60e3), content: c.content });
  }
  return {
    me: self ? { id: self.id, name: self.name, status: self.status, activity: self.activity, taskId: self.taskId, project: self.project, room: roomName[self.room], role: self.role } : null,
    project: (() => { const r = (s.rooms || []).find((x) => x.id === self?.room); return r && (r.goal || r.milestones.length) ? { goal: r.goal, milestones: r.milestones.map((m, i) => `${i + 1}) ${m.done ? '[x]' : '[ ]'} ${m.text}`) } : undefined; })(),
    crew,
    otherRooms: others,
    // Most urgent first: high priority, then the nearest deadline; priority/deadline shown only when set.
    tasksOpen: s.tasks.filter((t) => t.status === 'open' && taskInP(t)).sort(byUrgency).map(({ id, title, project, resources, priority, due, content }) => ({ id, title, project, resources, content, ...urgency(priority, due) })),
    tasksActive: s.tasks.filter((t) => ['claimed', 'blocked'].includes(t.status) && taskInP(t)).map(({ id, title, project, owner, status: st, resources, note, checkpoint, priority, due, content }) => ({ id, title, project, owner, status: st, resources, note, checkpoint, content, ...urgency(priority, due) })),
    locks: s.locks.filter((l) => l.expiresAt > now && inP(l)).map((l) => ({ project: l.project, resource: l.resource, owner: l.owner, reason: l.reason, minutesLeft: Math.round((l.expiresAt - now) / 60e3) })),
    toVote: (s.polls || []).filter((p) => p.status === 'open' && !p.ballots.some((b) => b.voter === me)).map((p) => ({ id: p.id, question: p.question, options: p.options.map((o, i) => `${i + 1}) ${o}`), minutesLeft: Math.max(0, Math.round((p.expiresAt - now) / 60e3)), content: p.content })),
    inbox,
    contexts: s.contexts.map((c) => ({ project: c.project, version: c.version, updatedBy: c.updatedBy })),
  };
}

try {
switch (cmd) {
  case 'hello': {
    const join = flags.bridge === true || typeof flags.project === 'string'
      ? { bridge: flags.bridge === true, project: flags.project, key: typeof flags.key === 'string' ? flags.key : undefined, git: gitRemote() }
      : undefined;
    const r = await call('POST', '/api/claudes/heartbeat', {
      as: as(), new: flags.new === true, name: need(flags.name, 'name'), status: 'idle', host: os.hostname().slice(0, 60), join, role: flags.role,
    });
    out({
      registered: r.registered || undefined,
      session: r.id,
      room: r.room?.name,
      ...(r.id !== flags.as && { important: `Your id for this session is ${r.id}: use --as ${r.id} in ALL commands` }),
      ...(await status(r.id)),
    });
    break;
  }
  case 'status': out(await status(as())); break;
  case 'beat':
    out(await call('POST', '/api/claudes/heartbeat', {
      as: as(), status: flags.status, activity: flags.activity, project: flags.project, role: flags.role, color: typeof flags.color === 'string' ? flags.color : undefined,
      ...(flags.task !== undefined && { taskId: flags.task === 'none' ? null : flags.task }),
    }));
    break;
  case 'task-new':
    out(await call('POST', '/api/tasks', { as: as(), title: need(flags.title, 'title'), project: flags.project, resources: list(flags.resources), detail: flags.detail, to: flags.to, priority: flags.priority, due: flags.due }));
    break;
  case 'start': {
    const me = as();
    const inbox = await readInbox(me, true);
    let id = pos[0];
    if (!id) id = (await call('POST', '/api/tasks', { as: me, title: need(flags.title, 'title'), project: flags.project, resources: list(flags.lock) })).id;
    const claimed = await tryCall('POST', `/api/tasks/${q(id)}/claim`, { as: me });
    if (claimed.httpStatus) out({ ...claimed, inbox, next: 'someone else\'s mission: do not proceed, tell the user' }, 1);
    const t = claimed.task;
    const proj = typeof flags.project === 'string' ? flags.project : t.project;
    let locks;
    if (flags.lock) {
      if (!proj) out({ task: { id, title: t.title }, error: 'Locking needs --project (the mission has none)', inbox }, 2);
      locks = await tryCall('POST', '/api/locks', {
        as: me, project: proj, resources: list(flags.lock), reason: flags.reason ?? t.title.slice(0, 200),
        ttlMinutes: flags.ttl ? Number(flags.ttl) : undefined, taskId: id,
      });
      if (locks.httpStatus) out({ task: { id, title: t.title }, claimed: true, ...locks, inbox, next: 'do not touch the conflicting resources: write to the owner and ask the user' }, 1);
    }
    await call('POST', '/api/claudes/heartbeat', { as: me, status: 'working', activity: flags.activity ?? t.title.slice(0, 200), taskId: id, project: proj });
    out({ task: { id, title: t.title, project: t.project, checkpoint: t.checkpoint || undefined, content: t.content }, locked: locks && { resources: locks.resources, expiresAt: locks.expiresAt }, inbox });
    break;
  }
  case 'finish': {
    const me = as();
    const id = need(pos[0], 'id');
    const released = await call('POST', '/api/locks/release', { as: me, project: flags.project });
    const done = await call('PATCH', `/api/tasks/${q(id)}`, { as: me, status: flags.status ?? 'done', note: flags.note });
    await call('POST', '/api/claudes/heartbeat', { as: me, status: 'idle', activity: '', taskId: null });
    out({ task: { id, status: done.status }, released: released.released.map((l) => `${l.project}:${l.resource}`), inbox: await readInbox(me, true) });
    break;
  }
  case 'forget': out(await call('POST', `/api/claudes/${q(need(pos[0], 'id'))}/forget`, { as: as() })); break;
  case 'claim': out(await call('POST', `/api/tasks/${q(need(pos[0], 'id'))}/claim`, { as: as() })); break;
  case 'task': out(await call('PATCH', `/api/tasks/${q(need(pos[0], 'id'))}`, { as: as(), status: flags.status, note: flags.note, checkpoint: typeof flags.checkpoint === 'string' ? flags.checkpoint : undefined, priority: flags.priority, due: typeof flags.due === 'string' ? flags.due : undefined })); break;
  case 'lock':
    out(await call('POST', '/api/locks', {
      as: as(), project: need(flags.project, 'project'), resources: list(need(flags.resources, 'resources')),
      reason: flags.reason, ttlMinutes: flags.ttl ? Number(flags.ttl) : undefined, taskId: flags.task,
    }));
    break;
  case 'unlock': out(await call('POST', '/api/locks/release', { as: as(), project: flags.project, resources: list(flags.resources) })); break;
  case 'renew': out(await call('POST', '/api/locks/renew', { as: as(), ttlMinutes: flags.ttl ? Number(flags.ttl) : undefined })); break;
  case 'msg': {
    const text = flags['text-file'] ? fs.readFileSync(flags['text-file'], 'utf8') : need(flags.text, 'text');
    out(await call('POST', '/api/messages', { as: as(), to: need(flags.to, 'to'), text, project: flags.project, sensitive: flags.sensitive === true, reason: flags.reason, quiet: flags.quiet === true, urgent: flags.urgent === true }));
    break;
  }
  case 'inbox': {
    const me = as();
    if (flags.recent) { // the last N messages even if already read: after a stop, to see what may have been missed
      const n = Math.min(50, Math.max(1, Number(flags.recent) || 10));
      out({ messages: (await call('GET', `/api/inbox?as=${q(me)}&recent=${n}`)).messages.map(slimMsg) });
    }
    out({ messages: await readInbox(me, flags['mark-read'] === true), markedRead: flags['mark-read'] === true || undefined });
    break;
  }
  case 'wait': {
    // ponytail: client-side polling (1 GET every N s); server long-poll/push if the request count matters
    const me = as();
    // One wait per session: if one is already listening, this one leaves it alone and stops at once, so relaunching
    // wait is always safe (e.g. at every message from the user, or after a stop when the tokens ran out).
    const pidFile = path.join(os.tmpdir(), `stazione-wait-${me}.pid`);
    let old = 0;
    try { old = Number(fs.readFileSync(pidFile, 'utf8')); } catch { /* none */ }
    if (old && old !== process.pid) {
      let alive = false;
      try { process.kill(old, 0); alive = true; } catch { /* stale pid file */ }
      if (alive) out({ alreadyActive: true, next: 'a wait is already active for this session: do not relaunch it' });
    }
    try { fs.writeFileSync(pidFile, String(process.pid)); } catch { /* best effort */ }
    process.on('exit', () => { try { if (fs.readFileSync(pidFile, 'utf8') === String(process.pid)) fs.unlinkSync(pidFile); } catch { /* gone */ } });
    // Adaptive pace: right after (re)launch, i.e. right after some activity, look every 20 s so answers come fast;
    // then slow down by half each quiet round, up to 3 minutes. --every N fixes the interval instead.
    const fixed = flags.every ? Math.max(20, Number(flags.every)) * 1000 : 0;
    let every = fixed || 20e3;
    // No end by default: it stays on until a message arrives (or the app stops it). Every time it ended for nothing
    // the agent woke up only to relaunch it, and that costs tokens. --max N still sets a limit in minutes.
    const until = flags.max ? Date.now() + Math.max(1, Number(flags.max)) * 60e3 : Infinity;
    let renewAt = Date.now() + 10 * 60e3, fails = 0;
    for (;;) {
      const r = await softCall('GET', `/api/inbox?as=${q(me)}&wait=1`);
      if (!r) { // station unreachable for a moment: try again (10 s, 20 s, 40 s... up to 2 min) instead of going deaf
        fails++;
        if (Date.now() >= until) out({ error: 'Stazione unreachable for too long', next: 'relaunch wait in the background' }, 1);
        await new Promise((res) => setTimeout(res, Math.min(120e3, 10e3 * 2 ** (fails - 1))));
        continue;
      }
      fails = 0;
      // Keep this session's locks alive while it works (the server refuses if the agent has been idle for an hour).
      if (Date.now() >= renewAt) { renewAt = Date.now() + 10 * 60e3; await softCall('POST', '/api/locks/renew', { as: me, ttlMinutes: 45, auto: true }); }
      // Only a message that needs an answer ends the wait; quiet ones wait for the next command (or ride along here).
      if (r.messages.some((m) => !m.quiet)) {
        const markRead = flags['mark-read'] === true;
        if (markRead) await softCall('POST', '/api/inbox/read', { as: me, upTo: Math.max(...r.messages.map((m) => m.createdAt)) });
        out({ messages: r.messages.map(slimMsg), next: `${markRead ? '' : 'inbox --mark-read, '}handle them, then relaunch wait in the background` });
      }
      if (Date.now() >= until) out({ messages: [], timeout: true, next: 'relaunch wait in the background' });
      await new Promise((res) => setTimeout(res, every));
      if (!fixed) every = Math.min(180e3, every * 1.5);
    }
  }
  case 'secure': out(await call('GET', `/api/secure/${q(need(pos[0], 'id'))}?as=${q(as())}`)); break;
  case 'ask': out(await call('POST', '/api/asks', { as: as(), text: need(flags.text, 'text'), project: flags.project, kind: flags.opinion === true ? 'opinion' : undefined })); break;
  case 'recap': {
    const text = typeof flags.file === 'string' ? fs.readFileSync(flags.file, 'utf8') : need(flags.text, 'text');
    out(await call('POST', '/api/recaps', { as: as(), title: need(flags.title, 'title'), text, project: flags.project }));
    break;
  }
  case 'ask-status': as(); out(await call('GET', `/api/asks/${q(need(pos[0], 'id'))}`)); break;
  case 'secure-status': out(await call('GET', `/api/secure/${q(need(pos[0], 'id'))}/status?as=${q(as())}`)); break;
  case 'decide': out(await call('POST', '/api/decisions', { as: as(), project: flags.project, text: need(flags.text, 'text') })); break;
  case 'project': {
    const me = as();
    const s = await call('GET', `/api/state?as=${q(me)}`);
    const room = s.rooms.find((r) => r.id === (typeof flags.room === 'string' ? flags.room : s.room));
    if (!room) out({ error: 'Room not found: this session has no room, or --room is wrong' }, 2);
    const milestones = room.milestones.map((m) => ({ ...m }));
    if (typeof flags.milestone === 'string') milestones.push({ text: flags.milestone, done: false });
    if (flags.done) { const m = milestones[Number(flags.done) - 1]; if (!m) out({ error: `No milestone number ${flags.done}` }, 2); m.done = true; }
    const change = typeof flags.goal === 'string' || typeof flags.milestone === 'string' || flags.done;
    const r = change ? await call('PUT', `/api/rooms/${q(room.id)}/project`, { as: me, goal: typeof flags.goal === 'string' ? flags.goal : undefined, milestones }) : room;
    out({ room: room.name, goal: r.goal, milestones: r.milestones.map((m, i) => `${i + 1}) ${m.done ? '[x]' : '[ ]'} ${m.text}`) });
    break;
  }
  case 'room-new': out(await call('POST', '/api/rooms', { as: as(), name: need(flags.name, 'name'), goal: typeof flags.goal === 'string' ? flags.goal : undefined, git: typeof flags.git === 'string' ? flags.git : undefined, key: typeof flags.key === 'string' ? flags.key : undefined })); break;
  case 'room-merge': out(await call('POST', `/api/rooms/${q(need(pos[0], 'room'))}/merge`, { as: as(), into: need(flags.into, 'into') })); break;
  case 'vote-new':
    out(await call('POST', '/api/polls', {
      as: as(), text: need(flags.text, 'text'), options: String(need(flags.options, 'options')).split('|').map((s) => s.trim()).filter(Boolean),
      minutes: flags.minutes ? Number(flags.minutes) : undefined, all: flags.all === true, project: flags.project,
    }));
    break;
  case 'vote': out(await call('POST', `/api/polls/${q(need(pos[0], 'id'))}/vote`, { as: as(), choice: Number(need(flags.choice, 'choice')), reason: need(flags.reason, 'reason') })); break;
  case 'vote-close': out(await call('POST', `/api/polls/${q(need(pos[0], 'id'))}/close`, { as: as() })); break;
  case 'votes': {
    const me = as();
    const slim = (p) => ({ id: p.id, question: p.question, options: p.options.map((o, i) => `${i + 1}) ${o}: ${p.counts[i]}`), status: p.statusLabel, winner: p.winner, by: p.by, votes: p.ballots.map((b) => ({ voter: b.voter, choice: b.choice + 1, reason: b.reason, content: b.content })), content: p.content, ...(p.status === 'open' && { iVoted: p.ballots.some((b) => b.voter === me), minutesLeft: Math.max(0, Math.round((p.expiresAt - Date.now()) / 60e3)) }) });
    if (pos[0]) out(slim(await call('GET', `/api/polls/${q(pos[0])}`)));
    const room = (await call('GET', `/api/state?as=${q(me)}`)).room;
    out({ polls: (await call('GET', `/api/polls${room ? `?room=${q(room)}` : ''}`)).polls.map(slim) });
    break;
  }
  case 'context': out(await call('GET', `/api/context/${q(need(pos[0], 'project'))}`)); break;
  case 'context-set': {
    const summary = fs.readFileSync(need(flags.file, 'file'), 'utf8');
    out(await call('PUT', `/api/context/${q(need(pos[0], 'project'))}`, { as: as(), summary, version: flags.version ? Number(flags.version) : undefined }));
    break;
  }
  default: out({ error: `Unknown command: ${cmd}`, help: HELP }, 2);
}
} catch (err) {
  if (!(err instanceof Done)) result = { obj: { error: err.message }, code: 1 };
}

// Messages that arrived while working ride along with any other command, so nobody waits for "wait" to fire.
// They are marked read because they are now in this output.
const PIGGYBACK = new Set(['beat', 'task-new', 'claim', 'task', 'lock', 'unlock', 'renew', 'msg', 'decide', 'context', 'context-set', 'ask', 'ask-status', 'secure-status', 'recap', 'vote-new', 'vote', 'vote-close', 'votes', 'project']);
if (result && result.code === 0 && PIGGYBACK.has(cmd) && typeof flags.as === 'string') {
  const done = result;
  try {
    const msgs = await readInbox(flags.as, true);
    if (msgs.length) done.obj = { ...done.obj, newMessages: msgs, note: 'answer right away in 1-2 lines if needed, then go on with the work' };
  } catch { /* keep the command's own result */ }
  result = done;
}
// Nothing written by a person or agent is a tool instruction. Keep it in labelled per-field envelopes.
const CONTENT_KEYS = new Set(['text', 'title', 'detail', 'checkpoint', 'summary', 'body', 'goal', 'milestones',
  'question', 'options', 'reason', 'name', 'activity', 'host', 'project', 'resources', 'votes', 'winner', 'answer']);
function separateContent(value) {
  if (Array.isArray(value)) return value.map(separateContent);
  if (!value || typeof value !== 'object') return value;
  const station = {}, fields = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === 'content') continue;
    if (CONTENT_KEYS.has(k) && v != null) {
      const metadata = value.content?.fields?.[k] ?? { source: { type: 'unknown' }, trustLevel: 'unknown', findings: [] };
      fields[k] = { value: v, ...metadata };
    } else if (k === 'note' && value.content?.fields?.note) {
      fields[k] = { value: v, ...value.content.fields.note };
    } else station[k] = separateContent(v);
  }
  if (Object.keys(fields).length) station.untrustedContent = { untrusted: true, fields };
  return station;
}
if (result) {
  process.stdout.write(`${JSON.stringify(prune(separateContent(result.obj)))}\n`);
  process.exitCode = result.code;
}
