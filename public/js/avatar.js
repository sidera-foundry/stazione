// Account avatars: small animated pixel-art portraits drawn on a canvas (32x32 cells), from a fixed list of keys, so no
// uploaded images or free text ever reach the page. Used in the header (click = account page) and in the picker.

import { __ } from './i18n.js';

export const AVATARS = [
  { key: 'cat', label: __('Retro cat') },
  { key: 'astronaut', label: __('Astronaut') },
  { key: 'robot', label: 'Robot' },
  { key: 'fox', label: __('Space fox') },
];
export const avatarKey = (k) => (AVATARS.some((a) => a.key === k) ? k : 'astronaut');

const N = 32;
const inEllipse = (x, y, cx, cy, rx, ry) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
function inTri(x, y, [ax, ay], [bx, by], [cx, cy]) {
  const s = (px, py, qx, qy, rx, ry) => (px - rx) * (qy - ry) - (qx - rx) * (py - ry);
  const d1 = s(x, y, ax, ay, bx, by), d2 = s(x, y, bx, by, cx, cy), d3 = s(x, y, cx, cy, ax, ay);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

/** Round neon badge behind every portrait: dark space, a faint grid, a ring in the given colour. */
function badge(P, ring) {
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const d = Math.hypot(x - 15.5, y - 15.5);
    if (d <= 15.5) P(x, y, d > 14.6 ? ring : (y > 22 && (x % 4 === 0 || y % 3 === 0)) ? '#1a1f4f' : '#0b0f2e');
  }
}
const DRAW = {
  cat(P, t) {
    badge(P, '#ff5fa2');
    const FUR = '#3a3550', HI = '#57507a', OUT = '#07081a';
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const earL = inTri(x, y, [6, 13], [8, 4], [13, 10]), earR = inTri(x, y, [16, 10], [21, 4], [23, 13]);
      const head = inEllipse(x, y, 14.5, 17, 9.5, 8);
      if (earL || earR || head) P(x, y, FUR);
      if (inTri(x, y, [8, 11], [8.6, 6.5], [11, 10]) || inTri(x, y, [18, 10], [20.4, 6.5], [21, 11])) P(x, y, '#ff5fa2');
      if (head && y < 14 && x > 9 && x < 20 && (x + y) % 5 === 0) P(x, y, HI);                   // stripes on the forehead
      if (y >= 25 && y <= 27 && x >= 8 && x <= 21) P(x, y, y === 25 ? '#3ee6c9' : '#1b2a66');     // neon collar
    }
    // retro-futuristic visor across the eyes
    for (let x = 6; x <= 23; x++) { P(x, 13, OUT); P(x, 17, OUT); for (let y = 14; y <= 16; y++) P(x, y, x === 6 || x === 23 ? OUT : '#1fb6a0'); }
    const scan = 8 + (Math.floor(t / 120) % 14); P(scan, 15, '#b8fff2'); P(scan + 1, 15, '#b8fff2'); // light sweeping the visor
    P(8, 14, '#b8fff2'); P(9, 14, '#b8fff2');
    // eyes glowing behind the visor (they blink)
    if (t % 3600 > 140) for (const ex of [10, 18]) { P(ex, 15, '#e8fffb'); P(ex + 1, 15, '#e8fffb'); P(ex, 16, '#7ff0dc'); P(ex + 1, 16, '#7ff0dc'); }
    // muzzle, nose, mouth, whiskers
    for (let y = 18; y <= 23; y++) for (let x = 9; x <= 20; x++) if (inEllipse(x, y, 14.5, 21, 3.6, 2.3)) P(x, y, '#9d96b8');
    P(14, 19, '#ff8ac0'); P(15, 19, '#ff8ac0'); P(14, 20, '#07081a'); P(15, 21, '#07081a'); P(13, 21, '#07081a');
    for (const [x0, y0, dx] of [[9, 20, -1], [9, 22, -1], [20, 20, 1], [20, 22, 1]]) for (let i = 1; i <= 4; i++) P(x0 + dx * i, y0 + (i > 2 ? (y0 === 20 ? -1 : 1) : 0), '#8a8fb0');
  },
  astronaut(P, t) {
    badge(P, '#3ee6c9');
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      if (inEllipse(x, y, 15.5, 15, 10, 10)) P(x, y, '#e3e7f5');
      if (inEllipse(x, y, 15.5, 16, 7, 5.5)) P(x, y, '#1b2a66');
      if (y >= 25 && x >= 7 && x <= 24) P(x, y, y === 25 ? '#3ee6c9' : '#c9cfe6');
    }
    P(11, 13, '#8fe9ff'); P(12, 12, '#8fe9ff'); P(12, 13, '#8fe9ff');
    P(15, 4, (t % 1000 < 500) ? '#ff5fa2' : '#5a2040'); P(15, 5, '#9aa3c7');
  },
  robot(P, t) {
    badge(P, '#ffb547');
    for (let y = 8; y <= 24; y++) for (let x = 7; x <= 24; x++) P(x, y, x === 7 || x === 24 || y === 8 || y === 24 ? '#5d6590' : '#9aa3c7');
    for (let y = 12; y <= 16; y++) for (let x = 9; x <= 22; x++) P(x, y, '#141a45');
    const blink = t % 3000 < 150;
    for (const ex of [11, 18]) for (let dx = 0; dx < 3; dx++) P(ex + dx, 14, blink ? '#141a45' : '#ffb547');
    for (let x = 11; x <= 20; x++) P(x, 20, x % 2 ? '#39447f' : '#c9cfe6');
    P(15, 5, (t % 800 < 400) ? '#3ee6c9' : '#1c7a70'); P(15, 6, '#5d6590'); P(15, 7, '#5d6590');
  },
  fox(P, t) {
    badge(P, '#b6f24a');
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      if (inTri(x, y, [6, 14], [8, 4], [13, 10]) || inTri(x, y, [18, 10], [23, 4], [25, 14]) || inEllipse(x, y, 15.5, 17, 9.5, 7.5)) P(x, y, '#e8762e');
      if (inTri(x, y, [8, 17], [15.5, 25], [23, 17]) && y > 17) P(x, y, '#f4e8d8');
    }
    for (const ex of [11, 19]) { P(ex, 16, '#07081a'); P(ex + 1, 16, '#07081a'); P(ex, 15, '#b6f24a'); }
    P(15, 23, '#07081a'); P(16, 23, '#07081a');
    if (t % 2400 < 200) { P(11, 16, '#e8762e'); P(12, 16, '#e8762e'); P(19, 16, '#e8762e'); P(20, 16, '#e8762e'); } // blink
  },
};

/** Draws one frame of an avatar on a canvas sized a multiple of 32 px. */
export function drawAvatar(canvas, key, t) {
  const g = canvas.getContext('2d');
  const s = canvas.width / N;
  g.clearRect(0, 0, canvas.width, canvas.height);
  DRAW[avatarKey(key)]((x, y, c) => { g.fillStyle = c; g.fillRect(x * s, y * s, s, s); }, t);
}

/** Keeps a canvas animated with the avatar that get() returns (it can change after a poll or a choice). */
export function animateAvatar(canvas, get) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const tick = (t) => { drawAvatar(canvas, get(), reduced ? 0 : t); if (!reduced) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
}
