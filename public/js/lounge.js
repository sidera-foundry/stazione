// Game room: the room below the main deck where idle Claudes sit on the sofa and play on the console.
// Pure drawing helpers in scene pixels; board.js owns the canvas, the layout and the animation loop.
import { suit, hatFromBehind } from './roles.js';
import { __ } from './i18n.js';
export const LOUNGE = { y0: 180, h: 76 };                 // strip under the main room, full width
const Y0 = LOUNGE.y0, Y1 = Y0 + LOUNGE.h, WALL = 14;     // the dividing wall is the lounge's back wall
const TV = { x: 196, y: Y0 + 1, w: 46, h: 26 };           // frame; the screen is inset by 3 px
const SCR = { x: TV.x + 3, y: TV.y + 3, w: TV.w - 6, h: TV.h - 7 };
const SOFA = { x: 188, y: Y0 + 46, w: 62 };               // back of the sofa, seen from behind
const BEAN = { x: 271, y: Y0 + 60 };
/** Where idle Claudes go: three sofa seats and a beanbag, then standing spots. */
export const SEATS = [{ x: 200, y: SOFA.y + 3 }, { x: 219, y: SOFA.y + 3 }, { x: 238, y: SOFA.y + 3 }, { x: BEAN.x, y: BEAN.y }];
const FOOS = { x: 30, y: Y0 + 50, w: 48, h: 12 };        // hockey da tavolo, played standing from the short sides
/** After the seats: the two air hockey players (face: towards the table), then spots where the rest watch. */
export const STAND = [{ x: FOOS.x - 8, y: FOOS.y + 8, face: 1, foos: true }, { x: FOOS.x + FOOS.w + 8, y: FOOS.y + 8, face: -1, foos: true },
  { x: 172, y: Y0 + 66 }, { x: 292, y: Y0 + 58 }, { x: 110, y: Y0 + 66 }, { x: 296, y: Y0 + 70 }];
export const FOOS_Y = FOOS.y + 6;
export const FRIDGE_SPOT = { x: 120, y: Y0 + 34 };       // bottom-centre of the mini fridge
/** Doorway in the dividing wall, between the two middle desks of the bottom row; wide enough for lanes. */
export const DOOR = { x: 160, y: Y0, w: 24 };
export const SOFA_Y = SOFA.y + 3.5;                      // draw order: just after the players on the sofa
export const BEAN_Y = BEAN.y + 0.5;

/** Static part, painted once on the background canvas with P(x, y, w, h, colour). */
export function paintLounge(P) {
  // carpet with a subtle diamond weave, warm against the cold metal of the deck
  P(0, Y0, 320, LOUNGE.h, '#1e1233');
  for (let y = Y0 + WALL; y < Y1; y++) for (let x = 0; x < 320; x++) if ((x + y) % 6 === 0 || (x - y + 900) % 6 === 0) P(x, y, 1, 1, '#241640');
  // back wall: padded panels, with the doorway cut through it
  P(0, Y0, 320, WALL, '#241a4d');
  for (let x = 0; x < 320; x += 16) { P(x, Y0 + 2, 1, WALL - 3, '#1a1238'); P(x + 1, Y0 + 2, 1, WALL - 3, '#2e2360'); }
  P(0, Y0, 320, 2, '#2b3574'); P(0, Y0 + WALL - 1, 320, 1, '#130c28');
  const dl = DOOR.x - DOOR.w / 2;
  P(dl, Y0, DOOR.w, WALL, '#151d4d'); P(dl, Y0, DOOR.w, 1, '#202a63');
  for (let x = dl + 2; x < dl + DOOR.w - 2; x += 4) P(x, Y0 + 6, 2, 1, '#2a6f7a');                     // guide lights on the threshold
  P(dl - 3, Y0, 3, WALL, '#ffb547'); P(dl + DOOR.w, Y0, 3, WALL, '#ffb547');
  for (let y = Y0 + 1; y < Y0 + WALL; y += 4) { P(dl - 3, y, 3, 2, '#2a2352'); P(dl + DOOR.w, y + 2, 3, 2, '#2a2352'); } // hazard stripes
  // wall decor on the left: dartboard and a poster
  for (let y = -5; y <= 5; y++) for (let x = -5; x <= 5; x++) { const d = x * x + y * y; if (d <= 25) P(28 + x, Y0 + 7 + y, 1, 1, d <= 2 ? '#ff5f5f' : d <= 9 ? '#1a1d2e' : d <= 16 ? '#e8dcb5' : '#1a1d2e'); }
  P(29, Y0 + 5, 3, 1, '#c9cfe6'); P(26, Y0 + 9, 1, 3, '#c9cfe6');                                            // two darts stuck in it
  P(126, Y0 + 2, 14, 11, '#070a1f'); P(127, Y0 + 3, 12, 9, '#1b3a66'); P(129, Y0 + 5, 8, 4, '#ffb547'); P(131, Y0 + 4, 4, 1, '#ff5fa2'); // poster
  // buffet: long table with a checked cloth, pizza, donuts, chips, drinks and a coffee machine
  const BX = 10, BY = Y0 + 22;
  P(BX, BY, 62, 4, '#070a1f'); P(BX + 1, BY, 60, 3, '#8a5a3c'); P(BX + 1, BY, 60, 1, '#a8704a');
  for (let x = 0; x < 60; x++) for (let y = 0; y < 7; y++) P(BX + 1 + x, BY + 3 + y, 1, 1, ((x >> 1) + (y >> 1)) % 2 ? '#e3e7f5' : '#d0605a');
  P(BX + 1, BY + 10, 60, 1, '#070a1f');
  P(BX + 3, BY - 3, 12, 4, '#8a6a3c'); P(BX + 4, BY - 3, 10, 3, '#f0b050');                                  // pizza box
  for (const [dx, dy] of [[5, -2], [8, -3], [11, -2], [7, -1], [10, -1]]) P(BX + dx, BY + dy, 1, 1, '#b5422f');
  P(BX + 17, BY - 1, 10, 1, '#c9cfe6');                                                                       // plate of donuts
  for (const dx of [18, 21, 24]) { P(BX + dx, BY - 3, 3, 2, '#ff8ac0'); P(BX + dx + 1, BY - 3, 1, 1, '#8a5a3c'); }
  P(BX + 30, BY - 2, 8, 2, '#3e9a8a'); P(BX + 31, BY - 3, 6, 1, '#ffcf7a');                                   // bowl of chips
  for (const [dx, c] of [[40, '#2f8f5a'], [43, '#ff8a3d'], [46, '#3aa0ff']]) { P(BX + dx, BY - 6, 2, 6, c); P(BX + dx, BY - 7, 2, 1, '#e3e7f5'); } // bottles
  P(BX + 50, BY - 10, 9, 10, '#070a1f'); P(BX + 51, BY - 9, 7, 8, '#39447f'); P(BX + 52, BY - 8, 5, 2, '#141a45'); P(BX + 53, BY - 4, 3, 3, '#1a1d2e'); P(BX + 55, BY - 8, 1, 1, '#ff6b5f'); // coffee machine
  // arcade cabinet against the wall
  P(84, Y0 + 5, 16, 29, '#070a1f'); P(85, Y0 + 6, 14, 27, '#4a2a7a'); P(85, Y0 + 6, 2, 27, '#6a3aa0'); P(97, Y0 + 6, 2, 27, '#3a1e5a');
  P(86, Y0 + 7, 12, 3, '#ffb547'); P(87, Y0 + 11, 10, 8, '#070a1f');
  P(86, Y0 + 20, 12, 3, '#2c3048'); P(89, Y0 + 20, 1, 2, '#ff5f5f'); P(92, Y0 + 21, 1, 1, '#3aa0ff'); P(94, Y0 + 21, 1, 1, '#b6f24a');
  // rug in front of the sofa
  P(180, Y0 + 52, 110, 22, '#3a1e4d'); P(181, Y0 + 53, 108, 20, '#4a2660');
  for (let x = 183; x < 288; x += 4) { P(x, Y0 + 53, 2, 1, '#6a3a7a'); P(x + 2, Y0 + 72, 2, 1, '#6a3a7a'); }
  // TV cabinet with the console on it
  P(TV.x + 2, TV.y + TV.h, 42, 7, '#070a1f'); P(TV.x + 3, TV.y + TV.h + 1, 40, 5, '#3a2a55'); P(TV.x + 3, TV.y + TV.h + 1, 40, 1, '#54407a'); P(TV.x + 3, TV.y + TV.h + 6, 40, 1, '#1c1330');
  P(TV.x + 8, TV.y + TV.h - 3, 12, 4, '#070a1f'); P(TV.x + 9, TV.y + TV.h - 3, 10, 3, '#1a1d2e'); P(TV.x + 9, TV.y + TV.h - 3, 10, 1, '#2c3048');
  // floor lamp next to the sofa, plants in the corners
  P(262, Y0 + 16, 1, 30, '#8a93b8'); P(259, Y0 + 12, 7, 5, '#ffcf7a'); P(260, Y0 + 17, 5, 1, '#b5822f'); P(260, Y0 + 46, 5, 2, '#3b4270');
  for (const px of [8, 306]) {
    P(px - 4, Y0 + 66, 8, 8, '#5d3a28'); P(px - 3, Y0 + 67, 6, 1, '#7a4e36');
    for (const [dx, dy] of [[-4, -6], [-1, -9], [2, -6], [-3, -3], [1, -3], [-1, -5]]) P(px + dx, Y0 + 66 + dy, 2, 3, '#2f8f5a');
  }
}

// Seated astronaut seen from behind: helmet, crew-colour collar, backpack. c crew colour, C its shade.
const BACK = [
  '....oooooo....',
  '..ooWWWWWWoo..',
  '.oWWWWWWWWWWo.',
  '.oWWWWWWWWWso.',
  '.oWWWWWWWWWso.',
  '..oWWWWWWWso..',
  '...oooooooo...',
  '.oocccccccCoo.',
  'oWWpppppppppWo',
  'oWWpPPPPPPPpWo',
  'oWWpppppppppWo',
];
/** Neon sign and the TV with the game. players: [{ color }] in seat order, t: ms, still: reduced motion. */
export function drawLounge({ R, T }, t, players, still) {
  const neon = still || Math.floor(t / 700) % 7 !== 0 ? '#ff5fa2' : '#6a2a50';
  R(40, Y0 + 1, 27, 12, '#12091f'); R(40, Y0 + 1, 27, 1, neon); R(40, Y0 + 12, 27, 1, neon);
  T(__('GAMES'), 53.5, Y0 + 10, neon, 13);
  R(TV.x, TV.y, TV.w, TV.h, '#070a1f'); R(TV.x + 1, TV.y + 1, TV.w - 2, TV.h - 2, '#1a1d2e');
  R(SCR.x, SCR.y, SCR.w, SCR.h, '#03061a');
  R(TV.x + TV.w / 2 - 1, TV.y + TV.h - 3, 2, 1, players.length ? '#3ee6c9' : '#ff6b5f');
  R(TV.x + 16, TV.y + TV.h - 2, 2, 1, (t % 1600 < 800 || still) ? '#3aa0ff' : '#1a4a88'); // console power light
  drawCorner(R, t, still);
  if (players.length) { drawPong(R, t, players, still); R(TV.x + 6, TV.y + TV.h + 8, 34, 1, '#3ee6c91a'); }
  else if (Math.floor(t / 900) % 2) R(SCR.x + SCR.w / 2 - 1, SCR.y + SCR.h / 2 - 2, 2, 4, '#39447f');
}

/** Animated bits of the left corner: coffee steam, the arcade attract screen. */
function drawCorner(R, t, still) {
  const k = still ? 0 : t / 1000;
  if (!still) for (let i = 0; i < 3; i++) { const f = (k * 0.8 + i / 3) % 1; R(64 + Math.round(Math.sin(f * 7 + i)), Y0 + 11 - Math.round(f * 8), 1, 1, `rgba(220,225,240,${(0.5 * (1 - f)).toFixed(2)})`); }
  const sx = 88, sy = Y0 + 12;                                               // arcade screen 8x6: marching invaders and a ship
  for (let r = 0; r < 2; r++) for (let c = 0; c < 3; c++) R(sx + (Math.floor(k * 2) % 2) + c * 3, sy + r * 2, 2, 1, r ? '#3ee6c9' : '#ff5fa2');
  R(sx + 1 + Math.round((Math.sin(k * 1.7) + 1) * 3), sy + 5, 2, 1, '#b6f24a');
  if (Math.floor(k * 3) % 2) R(sx + 2 + Math.round((Math.sin(k * 1.7) + 1) * 3), sy + 3, 1, 1, '#ffffff');
}

/** Air hockey seen from above (it replaced the foosball): the puck glides and bounces, each player's mallet follows it. */
export function drawFoosball({ R }, t, still, busy) {
  const { x, y, w, h } = FOOS, k = still || !busy ? 0 : t / 1000;
  R(x - 1, y - 1, w + 2, h + 4, '#070a1f'); R(x, y, w, h, '#2a3a8a'); R(x, y + h, w, 2, '#151d4a'); // rim and legs' shadow
  R(x + 1, y + 1, w - 2, h - 2, '#d8ecff'); // the ice-white playing surface
  for (let i = 3; i < w - 2; i += 4) R(x + i, y + 2 + (i % 3), 1, 1, '#b8d4f2'); // air holes
  R(x + w / 2, y + 1, 1, h - 2, '#ff5f5f'); // centre line and face-off circle
  R(x + w / 2 - 2, y + h / 2 - 2, 5, 1, '#ff5f5f'); R(x + w / 2 - 2, y + h / 2 + 2, 5, 1, '#ff5f5f');
  R(x + w / 2 - 3, y + h / 2 - 1, 1, 3, '#ff5f5f'); R(x + w / 2 + 3, y + h / 2 - 1, 1, 3, '#ff5f5f');
  R(x, y + 4, 1, h - 8, '#070a1f'); R(x + w - 1, y + 4, 1, h - 8, '#070a1f'); // goal slots
  R(x - 1, y - 1, w + 2, 1, '#3ee6c9'); // neon edge
  const tri = (v) => 1 - Math.abs(((v % 2) + 2) % 2 - 1);
  const px = x + 3 + Math.round(tri(k * 0.9) * (w - 7)), py = y + 2 + Math.round(tri(k * 2.3) * (h - 5));
  const mallet = (mx, my, c) => { R(mx - 1, my, 3, 2, c); R(mx, my - 1, 1, 1, c); R(mx, my + 2, 1, 1, '#070a1f'); };
  const clamp = (v) => Math.max(y + 2, Math.min(y + h - 4, v));
  mallet(x + 4 + (px < x + w / 2 ? Math.round(tri(k * 0.9) * 4) : 0), clamp(py), '#ff4040');           // red, left half
  mallet(x + w - 5 - (px >= x + w / 2 ? Math.round((1 - tri(k * 0.9)) * 4) : 0), clamp(py), '#3a8cff'); // blue, right half
  R(px, py, 2, 2, '#111522'); // puck
}

/** Sofa back: drawn after the seated players, since they are seen from behind. */
export function drawSofa({ R }) {
  R(SOFA.x, SOFA.y, SOFA.w, 14, '#070a1f'); R(SOFA.x + 1, SOFA.y + 1, SOFA.w - 2, 12, '#b0413e');
  R(SOFA.x + 1, SOFA.y + 1, SOFA.w - 2, 2, '#d0605a'); R(SOFA.x + 1, SOFA.y + 11, SOFA.w - 2, 2, '#7a2a2a');
  for (const sx of [SOFA.x + 21, SOFA.x + 40]) R(sx, SOFA.y + 3, 1, 8, '#8a3232');
  R(SOFA.x - 3, SOFA.y + 2, 4, 13, '#8a3232'); R(SOFA.x + SOFA.w - 1, SOFA.y + 2, 4, 13, '#8a3232');
}
export function drawBean({ R }) {
  R(BEAN.x - 9, BEAN.y - 4, 18, 8, '#070a1f'); R(BEAN.x - 8, BEAN.y - 4, 16, 7, '#3e9a8a'); R(BEAN.x - 7, BEAN.y - 4, 14, 2, '#5cc0ae');
}

/** Pong between the first two players (the second is the console if alone). Positions are pure functions of t. */
function drawPong(R, t, players, still) {
  const tt = still ? 0 : t / 1000;
  const tri = (v) => 1 - Math.abs(((v % 2) + 2) % 2 - 1);            // 0..1..0 triangle wave
  const bx = SCR.x + 3 + Math.round(tri(tt * 0.9) * (SCR.w - 7)), by = SCR.y + 1 + Math.round(tri(tt * 1.37 + 0.3) * (SCR.h - 3));
  const pad = (side) => Math.max(SCR.y, Math.min(SCR.y + SCR.h - 6, by - 2 + Math.round(Math.sin(tt * 2.3 + side) * 2)));
  const c1 = players[0].color, c2 = players[1] ? players[1].color : '#8a94c6';
  R(SCR.x + SCR.w / 2, SCR.y, 1, SCR.h, '#1b245a');
  R(SCR.x + 1, pad(0), 1, 6, c1); R(SCR.x + SCR.w - 2, pad(1.7), 1, 6, c2);
  R(bx, by, 1, 1, '#ffffff');
  const score = Math.floor(tt / 2);                                    // a point every couple of seconds, alternating
  for (let i = 0; i < Math.min(5, Math.ceil(score / 2) % 6); i++) R(SCR.x + 6 + i * 2, SCR.y + 1, 1, 1, c1);
  for (let i = 0; i < Math.min(5, Math.floor(score / 2) % 6); i++) R(SCR.x + SCR.w - 7 - i * 2, SCR.y + 1, 1, 1, c2);
  for (let y = SCR.y; y < SCR.y + SCR.h; y += 2) R(SCR.x, y, SCR.w, 1, '#00000033'); // scanlines
}

/** One Claude seated, seen from behind: holds a controller that jiggles while playing, or just watches. */
export function drawSeated({ R, shade }, x, y, color, t, still, playing, role) {
  const lft = Math.round(x - 7), top = Math.round(y - 14);
  const pal = { o: '#070a1f', ...suit(role), c: color, C: shade(color, 0.62), p: '#5d6590', P: '#4a5280' };
  const lean = still ? 0 : (Math.floor(t / 1300) % 5 === 0 ? 1 : 0);   // leans into the game now and then
  for (let r = 0; r < BACK.length; r++) for (let c = 0; c < 14; c++) { const ch = BACK[r][c]; if (ch !== '.') R(lft + c + (r < 7 ? lean : 0), top + r, 1, 1, pal[ch]); }
  hatFromBehind(R, role, lft + lean, top);
  if (!playing) return;
  const j = still ? 0 : Math.floor(t / 140) % 2;
  R(lft - 2, top + 6 + j, 3, 2, '#2c3048'); R(lft - 2, top + 6 + j, 1, 1, color);            // controller, left hand
  R(lft + 13, top + 7 - j, 3, 2, '#2c3048'); R(lft + 15, top + 7 - j, 1, 1, '#3aa0ff');       // right hand
}
