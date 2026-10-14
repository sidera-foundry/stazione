// Physical rooms: the station map (a space station seen from above, click a pod to enter) and the Bridge, the
// management room (meeting table and a big wall screen instead of the window and the hub). Pure drawing helpers in
// scene pixels; board.js owns the canvas, the state and the animation loop, and hands in SH = { R, T, shade }.

import { __ } from './i18n.js';

const ROOM_PALETTE = ['#3ee6c9', '#ff5fa2', '#8fa8ff', '#b6f24a', '#ff7a45', '#c792ff', '#5fd0ff'];
function hash(s) { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) | 0; return Math.abs(h); }
/** Each room keeps its colour everywhere (map, signs, light strip); the Bridge is amber. */
export const roomColor = (r) => (!r ? '#8a94c6' : r.kind === 'bridge' ? '#ffb547' : ROOM_PALETTE[hash(r.id) % ROOM_PALETTE.length]);

const clip = (s, n) => { s = String(s || ''); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

// ---------- the station map: a space station seen from above ----------
// The Bridge is the command module in the middle; every room is a pod around it, joined by pressurised tubes where
// lights run and astronauts walk when they change place. Pods have a metal hull with rivets, portholes, beacons and
// a neon name plate; the space behind has a nebula and a ringed planet.
const MAP_W = 320;
const POD = { w: 86, h: 64 };
const cell = (cx, cy, w = POD.w, h = POD.h) => ({ x: cx - w / 2, y: cy - h / 2, w, h, cx, cy });
const BRIDGE_BOX = cell(160, 128, 100, 70);
const LOUNGE_BOX = cell(160, 214);                                       // the common game room, below the Bridge
// Room pods, in order of arrival: the four corners, then left, right, top of the Bridge.
const SLOTS = [cell(52, 42), cell(268, 42), cell(52, 214), cell(268, 214), cell(52, 128), cell(268, 128), cell(160, 42)];
const mapStars = Array.from({ length: 90 }, (_, i) => ({ x: hash(`mx${i}`) % MAP_W, y: hash(`my${i}`) % 256, b: hash(`mb${i}`) % 3 }));

const space = document.createElement('canvas');
function paintSpace(H, S) {
  space.width = MAP_W * S; space.height = H * S;
  const b = space.getContext('2d'); const P = (x, y, w, h, c) => { b.fillStyle = c; b.fillRect(x * S, y * S, w * S, h * S); };
  const sky = ['#02030f', '#03041a', '#050722', '#070a29', '#090c31'];
  for (let y = 0; y < H; y++) P(0, y, MAP_W, 1, sky[Math.min(sky.length - 1, Math.floor((y / H) * sky.length))]);
  // nebula: two dithered clouds, magenta and teal
  for (let i = 0; i < 900; i++) {
    const x = hash(`nbx${i}`) % MAP_W, y = hash(`nby${i}`) % H;
    const a = ((x - 70) / 90) ** 2 + ((y - 80) / 50) ** 2, c = ((x - 250) / 80) ** 2 + ((y - 190) / 45) ** 2;
    if (a < 1 && i % 3) P(x, y, 1, 1, a < 0.4 ? '#2a1850' : '#1a1240');
    else if (c < 1 && i % 2) P(x, y, 1, 1, c < 0.4 ? '#0f3340' : '#0b2230');
  }
  // a ringed planet in the space above the Bridge (a seventh room would hide it)
  const PX = 160, PY = 34, PR = 22;
  for (let y = -PR; y <= PR; y++) for (let x = -PR; x <= PR; x++) {
    const d = x * x + y * y; if (d > PR * PR) continue;
    const light = (x - y) / PR * 0.6 + (1 - Math.sqrt(d) / PR) * 0.7, band = Math.floor((y + 60) / 6) % 2;
    P(PX + x, PY + y, 1, 1, light > 0.9 ? '#ffb08a' : light > 0.45 ? (band ? '#e46f64' : '#d4605a') : light > 0 ? '#8e3a55' : '#3a1534');
  }
  for (let x = -38; x <= 38; x++) { const y = Math.round(x * -0.22 + Math.sqrt(Math.max(0, 1 - (x / 38) ** 2)) * 3); if (x * x + (y + 2) ** 2 > PR * PR || y > -1) P(PX + x, PY - 2 + y, 1, 1, Math.abs(x) > 32 ? '#8a6a4a' : '#ffd9a0'); }
  // a far moon in the gap on the right
  for (let y = -4; y <= 4; y++) for (let x = -4; x <= 4; x++) if (x * x + y * y <= 16) P(300 + x, 92 + y, 1, 1, x + y < -2 ? '#eef2ff' : x + y < 2 ? '#b9c1e0' : '#6f78a6');
}

/** A pressurised tube from (x0, y0) to (x1, y1): dark body, lit edges, lights running towards the second end. */
function tube(R, t, x0, y0, x1, y1, color) {
  const len = Math.hypot(x1 - x0, y1 - y0), nx = (x1 - x0) / len, ny = (y1 - y0) / len;
  for (let d = 0; d <= len; d += 1) { const x = Math.round(x0 + nx * d), y = Math.round(y0 + ny * d); R(x - 4, y - 4, 9, 9, '#232b5e'); }
  for (let d = 0; d <= len; d += 1) { const x = Math.round(x0 + nx * d), y = Math.round(y0 + ny * d); R(x - 3, y - 3, 7, 7, '#141a45'); }
  for (let d = 4; d < len; d += 10) { const x = Math.round(x0 + nx * d), y = Math.round(y0 + ny * d); R(x - 4, y - 4, 9, 1, '#39447f'); } // rings
  const p = (t / 25) % 18;
  for (let d = p; d < len; d += 18) { const x = Math.round(x0 + nx * d), y = Math.round(y0 + ny * d); R(x, y, 1, 1, color); }
}

/** Metal hull of a pod, with rivets, corner beacons, two portholes and the neon name plate. */
function hull(SH, b, color, name, t, hot, antenna) {
  const { R, T } = SH;
  const { x, y, w, h } = b;
  R(x + 3, y + 4, w, h, '#00000066');                                         // shadow on space
  R(x + 2, y, w - 4, h, '#070a1f'); R(x, y + 2, w, h - 4, '#070a1f');        // outline with cut corners
  R(x + 3, y + 1, w - 6, h - 2, '#4a5494'); R(x + 1, y + 3, w - 2, h - 6, '#4a5494');
  R(x + 3, y + 1, w - 6, 1, '#8a93b8'); R(x + 1, y + 3, 1, h - 6, '#6f78a6'); // light from the top left
  R(x + 3, y + h - 2, w - 6, 1, '#2b3574'); R(x + w - 2, y + 3, 1, h - 6, '#2b3574');
  for (let rx = x + 6; rx < x + w - 4; rx += 8) { R(rx, y + 2, 1, 1, '#9aa3c7'); R(rx, y + h - 3, 1, 1, '#2b3574'); }
  const blink = Math.floor(t / 600 + x) % 2;
  R(x + 2, y + 2, 2, 2, blink ? color : '#2b3574'); R(x + w - 4, y + h - 4, 2, 2, blink ? '#2b3574' : color);
  if (antenna) { R(x + w - 12, y - 6, 1, 6, '#8a93b8'); R(x + w - 13, y - 7, 3, 1, '#c9cfe6'); R(x + w - 12, y - 8, 1, 1, Math.floor(t / 400) % 2 ? '#ff5fa2' : '#5a2040'); }
  // name plate on the top hull
  const label = clip(name, 14), pw = Math.min(w - 16, label.length * 5 + 12);
  R(x + w / 2 - pw / 2, y - 3, pw, 9, '#070a1f'); R(x + w / 2 - pw / 2 + 1, y - 2, pw - 2, 7, '#0b0f2e'); R(x + w / 2 - pw / 2 + 1, y + 5, pw - 2, 1, color);
  T(label, x + w / 2, y + 4, hot ? '#ffffff' : color, 12);
  if (hot) { R(x, y, w, 1, color); R(x, y + h - 1, w, 1, color); R(x, y, 1, h, color); R(x + w - 1, y, 1, h, color); }
}

/** Inside of a pod: floor by kind, a little furniture, the crew standing in a row. */
function interior(SH, b, kind, color, crew, t, astro) {
  const { R } = SH;
  const x = b.x + 5, y = b.y + 7, w = b.w - 10, h = b.h - 14;
  const FLOOR = { bridge: ['#2a1f2c', '#33262f'], lounge: ['#1e1233', '#241640'], project: ['#10173f', '#151d4d'] }[kind];
  R(x, y, w, h, FLOOR[0]);
  for (let yy = y + 2; yy < y + h; yy += 5) for (let xx = x + ((yy - y) % 10 ? 0 : 4); xx < x + w; xx += 8) R(xx, yy, Math.min(7, x + w - xx), 1, FLOOR[1]);
  R(x, y, w, 1, '#00000055'); R(x, y, 1, h, '#00000055');
  if (kind === 'bridge') { // meeting table with a hologram, and the big screen
    R(x + w / 2 - 22, y + 3, 44, 6, '#050a1c'); R(x + w / 2 - 20, y + 4, 12, 1, '#ffb547'); R(x + w / 2 - 20, y + 6, 22, 1, '#3ee6c9');
    R(x + w / 2 - 18, y + 14, 36, 7, '#6a4a32'); R(x + w / 2 - 18, y + 14, 36, 1, '#8a6444');
    const a = t / 1500; R(x + w / 2 + Math.round(Math.cos(a) * 5) - 1, y + 11, 2, 2, '#ffb547');
  } else if (kind === 'lounge') { // TV with the game, sofa, arcade
    R(x + w - 30, y + 3, 24, 12, '#070a1f'); R(x + w - 29, y + 4, 22, 10, '#101a33');
    R(x + w - 27 + Math.round((Math.sin(t / 400) + 1) * 8), y + 8 + Math.round(Math.cos(t / 300) * 2), 2, 2, '#ece6d2');
    R(x + w - 34, y + 17, 30, 4, '#8a2a3a'); R(x + w - 34, y + 16, 30, 1, '#b2404f');
    R(x + 3, y + 3, 8, 14, '#3a1f5c'); R(x + 4, y + 4, 6, 5, (Math.floor(t / 300) % 2) ? '#ff5fa2' : '#3ee6c9');
  } else { // desks along the wall: screens light up for whoever is working
    const busy = crew.filter((c) => c.status === 'working').length, n = 4;
    for (let i = 0; i < n; i++) {
      const dx = x + 3 + i * ((w - 6) / n);
      R(dx, y + 9, 14, 3, '#5a66a8'); R(dx, y + 12, 14, 3, '#222a5e');
      R(dx + 8, y + 3, 6, 5, '#39447f'); R(dx + 9, y + 4, 4, 3, i < busy ? '#07282a' : '#0a0f2c');
      if (i < busy) R(dx + 9, y + 5, 3, 1, color);
    }
  }
  const per = Math.max(1, Math.floor((w - 4) / 15));
  crew.slice(0, per).forEach((c, k) => astro(x + 8 + k * 15, y + h - 2, c, k));
  if (crew.length > per) SH.T(`+${crew.length - per}`, x + w - 2, y + h - 18, '#ece6d2', 12, 'right');
}

/** One pod: hull, interior, and the caption on the bottom hull. */
function pod(SH, b, room, kind, color, crew, info, t, hot, astro) {
  hull(SH, b, color, kind === 'bridge' ? __('◆ BRIDGE') : kind === 'lounge' ? __('GAME ROOM') : room.name.toUpperCase(), t, hot, kind === 'project');
  interior(SH, b, kind, color, crew, t, astro);
  const bits = kind === 'lounge' ? [__`${crew.length} on a break`] : [__`${crew.filter((c) => c.status !== 'offline').length} on board`, info.tasks ? (info.tasks === 1 ? __('1 mission') : __`${info.tasks} missions`) : '', info.milestones ? __`milestones ${info.milestones[0]}/${info.milestones[1]}` : ''];
  if (info.milestones) { // progress of the room's project, along the bottom hull
    const bw = b.w - 12; SH.R(b.x + 6, b.y + b.h - 2, bw, 1, '#0a0f2c'); SH.R(b.x + 6, b.y + b.h - 2, Math.round(bw * info.milestones[0] / info.milestones[1]), 1, '#b6f24a');
  }
  if (info.vote && Math.floor(t / 500) % 2) SH.T(info.vote.status === 'tie' ? __('TIE') : __('VOTE'), b.x + b.w - 3, b.y + 8, '#ff5fa2', 11, 'right');
  SH.T(bits.filter(Boolean).join(' · '), b.x + b.w / 2, b.y + b.h + 8, hot ? '#ece6d2' : '#8a94c6', 11);
}

// Who is where on the map, and who is walking between two places right now (e.g. from a room to the game room).
const where = new Map();
const trips = new Map();
const WALK = 60; // map pixels per second

/** Walks from the first pod to the Bridge and on to the second, along the tubes. */
function tripPoint(trip, now) {
  const a = { x: trip.from.cx, y: trip.from.cy }, hub = { x: BRIDGE_BOX.cx, y: BRIDGE_BOX.cy }, b = { x: trip.to.cx, y: trip.to.cy };
  const legs = trip.from === BRIDGE_BOX || trip.to === BRIDGE_BOX ? [[a, b]] : [[a, hub], [hub, b]];
  let d = ((now - trip.start) / 1000) * WALK;
  for (const [p, q] of legs) {
    const len = Math.hypot(q.x - p.x, q.y - p.y);
    if (d <= len) { const k = len ? d / len : 1; return { x: p.x + (q.x - p.x) * k, y: p.y + (q.y - p.y) * k + 10, face: q.x < p.x ? -1 : q.x > p.x ? 1 : trip.face }; }
    d -= len;
  }
  return null; // arrived
}

/**
 * Draws the whole station seen from above. rooms: [{ room, crew: [{ color, status, ... }], tasks }].
 * astro(x, y, crewMember, k, walk) draws one astronaut standing (or walking) at (x, y).
 * Returns the clickable boxes: [{ project, x, y, w, h }].
 */
/** lounge: the agents on a break in the game room, or null when the game room module is off (no pod, no tube). */
export function drawMap(SH, t, rooms, H, hover, astro, lounge = []) {
  const { R, T } = SH;
  const ctx = document.getElementById('scene').getContext('2d');           // the scene canvas (S = canvas px / scene px)
  const S = ctx.canvas.width / MAP_W;
  if (space.height !== H * S) paintSpace(H, S);
  ctx.drawImage(space, 0, 0);
  for (const s of mapStars) { const tw = (Math.floor(t / 500) + s.b) % 7 === 0; R(s.x, s.y % H, 1, 1, tw ? '#ffffff' : s.b ? '#4a5494' : '#2b3574'); }
  const bridge = rooms.find((r) => r.room.kind === 'bridge');
  const others = rooms.filter((r) => r !== bridge);
  const place = [];
  if (bridge) place.push({ ...bridge, box: BRIDGE_BOX, kind: 'bridge' });
  others.slice(0, SLOTS.length).forEach((r, i) => place.push({ ...r, box: SLOTS[i], kind: 'project' }));

  // tubes first: from the Bridge to every pod (and the game room)
  for (const p of [...place.filter((q) => q.box !== BRIDGE_BOX), ...(lounge ? [{ box: LOUNGE_BOX, room: { kind: 'lounge' } }] : [])]) {
    tube(R, t, BRIDGE_BOX.cx, BRIDGE_BOX.cy, p.box.cx, p.box.cy, p.room.kind === 'lounge' ? '#c792ff' : roomColor(p.room));
  }

  // places changed since the last frame start a walk through the tubes; walkers are not drawn inside pods
  const boxOf = new Map(place.map((p) => [p.room.project, p.box]));
  if (lounge) boxOf.set('lounge', LOUNGE_BOX);
  const seen = new Set();
  const note = (c, key) => {
    if (!c.id) return;
    seen.add(c.id);
    const prev = where.get(c.id);
    if (prev && prev !== key && boxOf.has(prev) && boxOf.has(key) && !trips.has(c.id)) trips.set(c.id, { c, from: boxOf.get(prev), to: boxOf.get(key), start: t, face: 1 });
    where.set(c.id, key);
  };
  for (const p of place) for (const c of p.crew) note(c, p.room.project);
  for (const c of lounge || []) note(c, 'lounge');
  for (const id of [...where.keys()]) if (!seen.has(id)) where.delete(id);
  const walkers = [];
  for (const [id, trip] of trips) { const at = tripPoint(trip, t); if (!at || !seen.has(id)) trips.delete(id); else walkers.push({ trip, at }); }
  const home = (crew) => crew.filter((c) => !trips.has(c.id));

  if (lounge) pod(SH, LOUNGE_BOX, { kind: 'lounge' }, 'lounge', '#c792ff', home(lounge), {}, t, false, astro);
  const boxes = [];
  for (const p of place) {
    pod(SH, p.box, p.room, p.kind, roomColor(p.room), home(p.crew), p, t, hover === p.room.project, astro);
    boxes.push({ project: p.room.project, x: p.box.x, y: p.box.y, w: p.box.w, h: p.box.h });
  }
  for (const { trip, at } of walkers) { trip.face = at.face; astro(Math.round(at.x), Math.round(at.y), trip.c, 0, { face: at.face }); }
  if (others.length > SLOTS.length) T(__`+${others.length - SLOTS.length} rooms in the tabs above`, MAP_W / 2, H - 2, '#8a94c6', 12);
  if (!bridge && !others.length) T(__('NO ROOMS'), MAP_W / 2, 60, '#8a94c6', 16);
  return boxes;
}

// ---------- the Bridge ----------
/** Painted over the main room of the background: parquet, wood-panelled wall, carpet, big screen frame. */
export function paintBridge(P, W, H, table) {
  P(0, 34, W, H - 34, '#2a1f2c');
  for (let y = 35; y < H; y += 6) {
    for (let x = (y % 12 ? 0 : 10); x < W; x += 20) {
      P(x, y, 19, Math.min(5, H - y), (x + y) % 40 ? '#33262f' : '#2e2230'); // boards stop at the game room's wall
      if (y + 5 < H) P(x, y + 5, 20, 1, '#1e1620');
    }
  }
  P(0, 0, W, 34, '#241c33');
  for (let x = 0; x < W; x += 20) { P(x, 4, 1, 28, '#1a1426'); P(x + 1, 4, 1, 28, '#30264a'); }
  P(0, 0, W, 4, '#3a2d52'); P(0, 3, W, 1, '#140f1e'); P(0, 30, W, 4, '#4a3526'); P(0, 30, W, 1, '#6a4a32');
  // carpet under the meeting table
  P(table.x - table.rx - 22, table.y - table.ry - 12, (table.rx + 22) * 2, (table.ry + 12) * 2, '#3a1c2c');
  P(table.x - table.rx - 20, table.y - table.ry - 10, (table.rx + 20) * 2, (table.ry + 10) * 2, '#4a2438');
  for (let x = table.x - table.rx - 18; x < table.x + table.rx + 18; x += 6) { P(x, table.y - table.ry - 9, 3, 1, '#ffb54744'); P(x + 3, table.y + table.ry + 8, 3, 1, '#ffb54744'); }
  // wall screen frame (where the office has its window)
  P(96, 3, 128, 29, '#070a1f'); P(97, 4, 126, 27, '#39447f'); P(99, 5, 122, 24, '#050a1c');
  // deck signs, same places as in the project rooms
  for (const x of [12, 238]) { P(x, 8, 70, 12, '#140f1e'); P(x, 8, 70, 1, '#6a4a32'); P(x, 19, 70, 1, '#0a0710'); }
}

/** The big screen: live numbers of the whole station. info = { open, active, locks, rooms, deploy, deployAgo }. */
export function drawBridgeScreen(SH, t, info) {
  const { R, T } = SH;
  R(99, 5, 122, 24, '#050a1c');
  for (let y = 5; y < 29; y += 2) R(99, y, 122, 1, '#0a1230');
  // One turn in three the screen is for the vote: the one going on, or the result of the last one.
  if (info.vote && (info.vote.open || info.vote.tie ? Math.floor(t / 4000) % 2 : Math.floor(t / 4000) % 3 === 2)) {
    T(info.vote.open ? __('POLL IN PROGRESS') : info.vote.tie ? __('TIED POLL') : __('LAST POLL'), 103, 11, '#ff5fa2', 12, 'left');
    T(clip(info.vote.question, 34), 103, 18, '#ece6d2', 12, 'left');
    T(clip(info.vote.line, 34), 103, 25, info.vote.open ? '#3ee6c9' : '#b6f24a', 12, 'left');
    if (Math.floor(t / 500) % 2) R(216, 25, 3, 1, '#ff5fa2');
    return;
  }
  // Every few seconds the title gives way to the most urgent mission (high priority or close to its deadline).
  if (info.urgent && Math.floor(t / 3000) % 2) T(clip(`! ${info.urgent.due ? `${info.urgent.due.toUpperCase()}: ` : ''}${info.urgent.title}`, 30), 103, 11, '#ff6b5f', 12, 'left');
  else T(__('STATION STATUS'), 103, 11, '#ffb547', 12, 'left');
  T(__`OPEN MISSIONS ${info.open}`, 103, 18, '#3ee6c9', 12, 'left');
  T(__`IN PROGRESS ${info.active}`, 103, 25, '#b6f24a', 12, 'left');
  T(`LOCK ${info.locks}`, 166, 18, '#ff5fa2', 12, 'left');
  T(info.deploy ? `DEPLOY ${info.deploy}` : 'DEPLOY —', 166, 25, '#8fa8ff', 12, 'left');
  // who is working, room by room: one bar each
  info.rooms.slice(0, 6).forEach((r, i) => { const h = Math.min(8, r.busy * 3 + 1); R(206 + i * 2.5, 12 - h + 8, 2, h, r.color); });
  if (Math.floor(t / 500) % 2) R(216, 25, 3, 1, '#ffb547');
}

/** Meeting table with laptops and papers; a small hologram of the station in the middle. */
/** The ballot box next to the hub: grey when nothing is being decided, lit with a paper dropping in while a vote is open. */
export function drawBallotBox(SH, t, x, y, vote, reduced) {
  const { R, T } = SH;
  const on = !!vote, tie = vote?.status === 'tie';
  R(x - 1, y + 9, 12, 2, '#0a0f2c');                                   // shadow
  R(x, y, 10, 10, on ? '#3a2a6a' : '#2b3574'); R(x, y, 10, 2, on ? '#5a44a8' : '#39447f');
  R(x + 3, y, 4, 1, '#050a1c');                                        // slot
  R(x + 3, y + 4, 4, 3, on ? (tie ? '#ff5fa2' : '#3ee6c9') : '#4a5494'); // seal
  if (!on) return;
  if (!reduced) { const k = Math.floor(t / 180) % 8; if (k < 5) R(x + 4, y - 6 + k, 2, 3, '#ece6d2'); } // a ballot dropping in
  if (Math.floor(t / 600) % 2) T(tie ? __('TIE') : __('VOTE'), x + 5, y - 9, '#ff5fa2', 11);
}

export function drawBridgeTable(SH, t, table, reduced) {
  const { R } = SH;
  const { x, y, rx, ry } = table;
  for (let yy = -ry; yy <= ry; yy++) {
    const w = Math.round(rx * Math.sqrt(1 - (yy * yy) / (ry * ry)));
    R(x - w, y + yy, w * 2, 1, yy < -ry + 2 ? '#8a6444' : '#6a4a32');
  }
  for (let yy = 0; yy < 3; yy++) { const w = Math.round(rx * 0.98); R(x - w, y + ry + yy, w * 2, 1, yy ? '#2a1c14' : '#4a3222'); }
  // laptops and papers around the edge
  for (const [dx, dy] of [[-18, -4], [14, -5], [-6, 4], [20, 3]]) { R(x + dx, y + dy, 6, 3, '#39447f'); R(x + dx + 1, y + dy - 3, 4, 3, '#1b2a66'); R(x + dx + 2, y + dy - 2, 2, 1, '#3ee6c9'); }
  for (const [dx, dy] of [[-26, 0], [4, -2]]) R(x + dx, y + dy, 4, 3, '#ece6d2');
  // hologram of the station: a slowly turning ring of modules
  const spin = reduced ? 0.5 : t / 1800;
  for (let k = 0; k < 6; k++) {
    const a = spin + (k / 6) * Math.PI * 2;
    R(x + Math.round(Math.cos(a) * 7), y - 12 + Math.round(Math.sin(a) * 2.5), 2, 2, Math.sin(a) > 0 ? '#ffb547' : '#ffb54766');
  }
  R(x - 1, y - 13, 2, 3, '#ffd27a'); R(x - 4, y - 3, 8, 2, '#39447f');
  for (let i = 0; i < 8; i++) R(x - 2 - i * 0.4, y - 4 - i, 4 + i * 0.8, 1, '#ffb54718');
}

// ---------- furnishing of the project rooms, by type ----------
// Free floor on both sides of the hub, above and below the walkway (y 101-107); drawn before the astronauts.
function whiteboard(R, T, x, y, t, lines) {
  R(x, y, 42, 24, '#070a1f'); R(x + 1, y + 1, 40, 21, '#dfe4f5'); R(x + 2, y + 22, 38, 1, '#9aa3c7');
  R(x + 4, y + 24, 1, 8, '#5d6590'); R(x + 37, y + 24, 1, 8, '#5d6590');
  lines(x, y);
}


/** room.type: 'code' (a git repository), anything else: a generic office. */
export function drawFurniture(SH, t, room, reduced) {
  const { R, T } = SH;
  const type = room.type || 'general';
  if (type === 'code') {
    whiteboard(R, T, 22, 70, t, (x, y) => {
      R(x + 4, y + 4, 10, 6, '#3a7bd5'); R(x + 26, y + 4, 10, 6, '#46b04a'); R(x + 15, y + 13, 10, 6, '#e2453c');
      R(x + 14, y + 7, 12, 1, '#10163a'); R(x + 20, y + 10, 1, 3, '#10163a');
    });
    // git graph in neon: two branches, commits pulsing along them
    const gx = 232, gy = 78;
    R(gx, gy + 6, 64, 1, '#3ee6c9'); R(gx + 16, gy, 32, 1, '#ff5fa2'); R(gx + 16, gy, 1, 6, '#ff5fa2'); R(gx + 48, gy, 1, 6, '#ff5fa2');
    for (let i = 0; i < 5; i++) R(gx + 4 + i * 14, gy + 5, 3, 3, '#3ee6c9');
    const p = reduced ? 0 : (t / 30) % 64; R(gx + p, gy + 5, 2, 3, '#ece6d2');
    // server cabinet below the walkway
    R(244, 110, 16, 30, '#070a1f'); R(245, 111, 14, 28, '#262e66');
    for (let i = 0; i < 5; i++) { R(247, 114 + i * 5, 10, 3, '#141a45'); R(248, 115 + i * 5, 1, 1, (Math.floor(t / 300) + i) % 3 ? '#2a4020' : '#b6f24a'); }
    T('main', 264, 76, '#3ee6c9', 12, 'left');
  } else {
    // generic office: bookcase and a noticeboard
    R(24, 72, 30, 26, '#4a3526'); for (let r = 0; r < 3; r++) { R(26, 76 + r * 8, 26, 1, '#2a1c14'); for (let b = 0; b < 6; b++) R(27 + b * 4, 71 + r * 8, 3, 5, ['#8e2a36', '#3a7bd5', '#46b04a', '#f2c230', '#9b5de5'][(b + r) % 5]); }
    R(240, 72, 44, 22, '#6a4a32'); R(241, 73, 42, 20, '#b08a5a');
    for (const [nx, ny, c] of [[244, 76, '#ffd27a'], [256, 78, '#8fe9ff'], [268, 75, '#ff9bb8'], [250, 85, '#b6f24a']]) R(nx, ny, 8, 6, c);
  }
}

// ---------- office corner ----------
/** Paper bin: a few crumpled sheets sticking out when someone has been working. */
export function drawBin(R, x, y, cans) {
  R(x, y - 7, 7, 7, '#070a1f'); R(x + 1, y - 6, 5, 6, '#4a5494'); R(x + 1, y - 6, 5, 1, '#6f78a6'); R(x + 2, y - 4, 1, 3, '#39447f'); R(x + 4, y - 4, 1, 3, '#39447f');
  for (let i = 0; i < cans; i++) { const cx = x + 1 + (i * 2) % 5, cy = y - 8 - (i > 2 ? 1 : 0); R(cx, cy + 1, 2, 2, '#dfe4f5'); R(cx, cy + 2, 1, 1, '#9aa3c7'); }
}
// ---------- party on a new deploy, and the light of the real time of day ----------
export const PARTY_MS = 9000;
const BURST_COLORS = ['#ff5fa2', '#3ee6c9', '#ffd23f', '#b6f24a', '#8fa8ff', '#ff7a45'];
/** Fireworks inside a box (the window, the Bridge screen, the map sky) for PARTY_MS after `since`. */
export function drawFireworks({ R }, t, since, box) {
  const age = t - since;
  if (age < 0 || age > PARTY_MS) return;
  for (let k = 0; k < 12; k++) {
    const start = k * 650, a = age - start;
    if (a < 0 || a > 1600) continue;
    const cx = box.x + 8 + ((k * 37 + 11) % Math.max(1, box.w - 16)), cy = box.y + 6 + ((k * 23 + 5) % Math.max(1, box.h - 12));
    const color = BURST_COLORS[k % BURST_COLORS.length];
    if (a < 300) { R(cx, cy + Math.round((300 - a) / 40), 1, 2, '#ece6d2'); continue; } // the rocket going up
    const r = Math.min(11, (a - 300) / 60), fade = a > 1200;
    for (const [ring, n] of [[1, 18], [0.55, 10]]) { // two rings of sparks, falling slowly
      for (let i = 0; i < n; i++) {
        const ang = (i / n) * Math.PI * 2 + ring, x = Math.round(cx + Math.cos(ang) * r * ring), y = Math.round(cy + Math.sin(ang) * r * ring * 0.8 + (a - 300) / 240);
        if (x >= box.x && x < box.x + box.w - 1 && y >= box.y && y < box.y + box.h - 1) R(x, y, fade ? 1 : 2, fade ? 1 : 2, fade && i % 2 ? '#ece6d2' : ring < 1 ? '#ffffff' : color);
      }
    }
  }
}

/** 0 by day, 1 at night, in between at dawn and dusk: how much artificial light the station needs. */
export function nightLevel(date = new Date()) {
  const h = date.getHours() + date.getMinutes() / 60;
  if (h >= 21 || h < 5.5) return 1;
  if (h < 7.5) return (7.5 - h) / 2;           // dawn: lights going off
  if (h >= 18.5) return (h - 18.5) / 2.5;      // dusk: lights coming on
  return 0;
}

/** Light of the scene from the local hour: deep blue night (dark enough for the lamps to show), warm dawn and dusk. */
export function dayTint(date = new Date()) {
  const h = date.getHours() + date.getMinutes() / 60;
  if (h >= 21 || h < 5.5) return 'rgba(6, 9, 45, 0.5)';
  if (h < 7.5) return 'rgba(255, 140, 90, 0.14)';
  if (h >= 18.5) return 'rgba(60, 40, 110, 0.28)';
  return null;
}

/**
 * Artificial lights, drawn over the night tint with additive blending so they really glow: cold ceiling lights and
 * monitors over the desks, the hub, and in the game room the floor lamp, the TV, the arcade and the neon sign; in the
 * Bridge the light over the meeting table and the big screen. lights: [{ x, y, r, color, a }] in scene pixels.
 */
export function drawLights(lights, level, t) {
  if (level <= 0) return;
  const ctx = document.getElementById('scene').getContext('2d');
  const S = ctx.canvas.width / MAP_W;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const l of lights) {
    const flick = l.flicker ? 0.85 + 0.15 * Math.sin(t / 90 + l.x) : 1;
    const g = ctx.createRadialGradient(l.x * S, l.y * S, 0, l.x * S, l.y * S, l.r * S);
    g.addColorStop(0, l.color.replace('A', String((l.a * level * flick).toFixed(3))));
    g.addColorStop(1, l.color.replace('A', '0'));
    ctx.fillStyle = g;
    ctx.fillRect((l.x - l.r) * S, (l.y - l.r) * S, l.r * 2 * S, l.r * 2 * S);
  }
  ctx.restore();
}
