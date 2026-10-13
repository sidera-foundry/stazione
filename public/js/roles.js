// Roles: what an astronaut wears. Only these fixed keys exist (no free text reaches the drawing): each role sets the
// suit colour, a hat drawn over the helmet (front and back view) and a tool held when the hand is free.
// Pixel maps are 14 columns wide like the sprites, drawn facing right and mirrored when facing left.

const HATS = {
  // rows start one pixel above the helmet top (sprite row 1 in front view)
  server: { rows: ['.....YYYY.....', '....YYYYYY....', '..yyyyyyyyyy..'], pal: { Y: '#ffd23f', y: '#c9a020' } },
  design: { rows: ['.......r......', '....RRRRRR....', '...RRRRRRRR...', '...rrrrrrr....'], pal: { R: '#d64550', r: '#8e2a36' }, dy: -1 },
  bridge: { rows: ['....wwwwww....', '...wwwwgwww...', '....kkkkkkkkk.'], pal: { w: '#ece6d2', g: '#ffb547', k: '#1a1d2e' } },
  research: { rows: ['', '', '', '', '.....xx.xx....'], pal: { x: '#ffd27a' }, dy: 1 }, // glasses on the visor
};
const BACK_HATS = {
  server: ['....YYYYYY....', '..yyyyyyyyyy..'],
  design: ['....RRRRRR....', '...RRRRRRRR...'],
  bridge: ['....wwwwww....', '...wwwwwwww...'],
};

export const ROLES = {
  server: { label: 'server', suit: '#f2c230', shade: '#b8901f' },
  design: { label: 'design', suit: '#9b5de5', shade: '#6a3aa8' },
  bridge: { label: 'bridge', suit: '#3553b0', shade: '#22397a' },
  test: { label: 'test', suit: '#e3e7f5', shade: '#9aa3c7' },
  research: { label: 'research', suit: '#e3e7f5', shade: '#9aa3c7' },
};
export const roleOf = (c) => (c && ROLES[c.role] ? c.role : null);

/** Suit colours for the sprite palette (W suit, s suit shade); the defaults when the role has none. */
export function suit(role) {
  const r = ROLES[role];
  return r ? { W: r.suit, s: r.shade } : { W: '#e3e7f5', s: '#9aa3c7' };
}

/** Hat over the helmet, front view. side(c) maps a sprite column to screen x (mirroring included). */
export function hat(R, role, side, top) {
  const h = HATS[role];
  if (!h) return;
  h.rows.forEach((row, r) => { for (let c = 0; c < 14; c++) { const ch = row[c]; if (ch && ch !== '.') R(side(c), top + 1 + r + (h.dy || 0), 1, 1, h.pal[ch]); } });
}

/** Hat seen from behind (sofa), over the back sprite's head. */
export function hatFromBehind(R, role, lft, top) {
  const rows = BACK_HATS[role];
  const h = HATS[role];
  if (!rows) return;
  rows.forEach((row, r) => { for (let c = 0; c < 14; c++) { const ch = row[c]; if (ch !== '.') R(lft + c, top - 1 + r, 1, 1, h.pal[ch]); } });
}

/** Tool in the free hand at (hx, hy), dir = 1 facing right, -1 left; t animates the brush tip. */
export function tool(R, role, hx, hy, dir, t) {
  if (role === 'server') { // wrench
    R(hx, hy - 3, 1, 3, '#9aa3c7'); R(hx - 1, hy - 5, 1, 2, '#9aa3c7'); R(hx + 1, hy - 5, 1, 2, '#9aa3c7');
  } else if (role === 'design') { // brush with a changing colour, and a palette in the other hand
    const tips = ['#ff5fa2', '#3ee6c9', '#ffd23f', '#8fa8ff'];
    R(hx, hy - 3, 1, 3, '#8a5a3c'); R(hx, hy - 5, 1, 2, tips[Math.floor(t / 700) % tips.length]);
  } else if (role === 'test') { // magnifying glass
    R(hx, hy - 2, 1, 2, '#5d6590'); R(hx - 1 + dir, hy - 5, 3, 1, '#c9cfe6'); R(hx - 1 + dir, hy - 3, 3, 1, '#c9cfe6'); R(hx - 1 + dir, hy - 4, 1, 1, '#c9cfe6'); R(hx + 1 + dir, hy - 4, 1, 1, '#c9cfe6'); R(hx + dir, hy - 4, 1, 1, '#8fe9ff88');
  } else if (role === 'research') { // book
    R(hx - (dir < 0 ? 2 : 0), hy - 3, 3, 3, '#8e2a36'); R(hx - (dir < 0 ? 2 : 0), hy - 3, 3, 1, '#ece6d2');
  } else if (role === 'bridge') { // tablet
    R(hx - (dir < 0 ? 1 : 0), hy - 3, 2, 3, '#1b2a66'); R(hx - (dir < 0 ? 1 : 0), hy - 2, 2, 1, '#3ee6c9');
  }
}
