// Sounds of the panel: small chiptune formulas rendered into Web Audio buffers.
// No sample files (the CSP allows none, and there are no rights to worry about). Both off by default; the
// browser only lets audio start after a click, which the toggles provide.
const SR = 22050; // plenty for square waves and noise, half the work of 44.1 kHz
let seed = 1; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const noise = () => rnd() * 2 - 1;
const hz = (m) => 440 * 2 ** ((m - 69) / 12);
const sq = (f, s, duty = 0.5) => ((s * f) % 1 < duty ? 1 : -1);
const tri = (f, s) => 4 * Math.abs(((s * f) % 1) - 0.5) - 1;

/** A buffer of len seconds, filled by draw(add) where add(t, dur, f) mixes f(s) in from t */
function render(len, draw) {
  const buf = new Float32Array(Math.ceil(len * SR));
  const add = (t, dur, f) => { const i0 = Math.floor(t * SR); for (let i = 0; i < dur * SR && i0 + i < buf.length; i++) if (i0 + i >= 0) buf[i0 + i] += f(i / SR, i); };
  draw(add);
  return buf;
}

// ---------- effects (t = 0 is the moment they play) ----------
function key(add, t, heavy) {
  const f = heavy ? 110 : 150 + rnd() * 110, g = heavy ? 1.6 : 0.8 + rnd() * 0.4;
  let prev = 0;
  add(t, 0.006, (s) => { const n = noise(), d = n - prev; prev = n; return d * 0.25 * g * Math.exp(-s / 0.0012); });
  add(t + 0.002, 0.05, (s) => Math.sin(2 * Math.PI * f * s) * 0.22 * g * Math.exp(-s / 0.009));
}
function sweep(add, t, dur, amp) {
  let y = 0;
  add(t, dur, (s) => { const k = Math.sin(Math.PI * s / dur); y += (0.02 + 0.25 * k * k) * (noise() - y); return y * amp * k; });
}
const arp = (add, t, notes, step, amp, dur = step) => notes.forEach((m, k) => add(t + k * step, dur, (s) => sq(hz(m), s, 0.25) * amp * (1 - s / dur)));
const FX = {
  key: [0.06, (a) => key(a, 0)],
  enter: [0.06, (a) => key(a, 0, true)],
  whoosh: [0.8, (a) => sweep(a, 0, 0.8, 0.35)],
  swish: [0.45, (a) => sweep(a, 0, 0.45, 0.18)],
  blip: [0.17, (a) => { a(0, 0.06, (s) => sq(880, s, 0.25) * 0.08); a(0.07, 0.09, (s) => sq(1320, s, 0.25) * 0.08 * (1 - s / 0.09)); }],
  can: [0.5, (a) => { key(a, 0, true); let prev = 0; a(0.05, 0.45, (s) => { const n = noise(), d = n - prev; prev = n; return d * 0.18 * Math.min(1, s / 0.01) * Math.exp(-s / 0.15); }); }],
  foos: [0.45, (a) => { for (const [dt, f] of [[0, 620], [0.13, 540], [0.21, 700], [0.38, 580]]) a(dt, 0.04, (s) => (Math.sin(2 * Math.PI * f * s) + noise() * 0.3) * 0.2 * Math.exp(-s / 0.008)); }],
  game: [0.5, (a) => arp(a, 0, [72, 76, 79, 84, 79, 84], 0.07, 0.07)],
  sting: [3, (a) => { arp(a, 0, [60, 64, 67, 72, 76], 0.06, 0.08); [60, 64, 67, 72].forEach((m) => a(0.3, 2.6, (s) => tri(hz(m), s) * 0.05 * Math.exp(-s / 1.1))); }],
};

// ---------- music: Am F C G at 112 bpm, 32 beats that loop seamlessly ----------
const BEAT = 60 / 112, CHORDS = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]];
const music = (add) => {
  for (let b = 0; b < 32; b++) {
    const t = b * BEAT, ch = CHORDS[Math.floor(b / 8)];
    add(t, BEAT * 0.9, (s) => sq(hz(ch[0] - 24), s) * 0.07 * Math.exp(-s / 0.35));
    for (let k = 0; k < 2; k++) { const m = ch[(b * 2 + k) % 3] + 12; add(t + k * BEAT / 2, BEAT / 2 * 0.8, (s) => sq(hz(m), s, 0.125) * 0.035 * Math.exp(-s / 0.12)); }
    if (b % 2) add(t, 0.03, (s) => noise() * 0.035 * Math.exp(-s / 0.008));
  }
};

// ---------- playback ----------
const PREF = 'stazione.sounds';
const prefs = (() => { try { return { fx: false, music: false, ...JSON.parse(localStorage.getItem(PREF)) }; } catch { return { fx: false, music: false }; } })();
const save = () => { try { localStorage.setItem(PREF, JSON.stringify(prefs)); } catch { /* not remembered */ } };
let ctx = null, master = null, musicNode = null, musicBuf = null;
const cache = {};
const audioBuf = (data) => { const b = ctx.createBuffer(1, data.length, SR); b.getChannelData(0).set(data); return b; };

function ensureCtx() {
  if (!ctx) { ctx = new AudioContext(); master = ctx.createGain(); master.gain.value = 1.5; master.connect(ctx.destination); } // raw formulas peak at 0.1-0.3
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

/** Plays an effect by name if effects are on (a few are throttled so a burst of events stays pleasant). */
const lastAt = {};
export function play(name, minGapMs = 60) {
  if (!prefs.fx || !FX[name] || document.hidden) return;
  // A remembered "on" still needs one click on the page before the browser lets audio start.
  if (!ctx && !navigator.userActivation?.hasBeenActive) return;
  const now = performance.now(); if (now - (lastAt[name] || 0) < minGapMs) return; lastAt[name] = now;
  ensureCtx();
  cache[name] ??= audioBuf(render(FX[name][0], FX[name][1]));
  const src = ctx.createBufferSource(); src.buffer = cache[name]; src.connect(master); src.start();
}

function setMusic(on) {
  if (!on) { musicNode?.stop(); musicNode = null; return; }
  if (musicNode) return;
  ensureCtx();
  musicBuf ??= audioBuf(render(32 * BEAT, music));
  const g = ctx.createGain(); g.gain.setValueAtTime(0, ctx.currentTime); g.gain.linearRampToValueAtTime(1, ctx.currentTime + 1.5); g.connect(master);
  musicNode = ctx.createBufferSource(); musicNode.buffer = musicBuf; musicNode.loop = true; musicNode.connect(g); musicNode.start();
}

/** Wires the two header toggles (#sndFx, #sndMusic) and the typing clicks on every field of the page. */
export function initSounds() {
  const fxB = document.getElementById('sndFx'), muB = document.getElementById('sndMusic');
  const paint = () => { fxB.setAttribute('aria-pressed', String(prefs.fx)); muB.setAttribute('aria-pressed', String(prefs.music)); };
  fxB.addEventListener('click', () => { prefs.fx = !prefs.fx; save(); paint(); if (prefs.fx) { ensureCtx(); play('sting'); } });
  muB.addEventListener('click', () => { prefs.music = !prefs.music; save(); paint(); setMusic(prefs.music); });
  paint();
  // Remembered music starts at the first click anywhere (browsers block audio before a gesture).
  if (prefs.music) document.addEventListener('pointerdown', () => { if (prefs.music) setMusic(true); }, { once: true });
  document.addEventListener('keydown', (e) => {
    if (!e.target.matches?.('input, textarea')) return;
    if (e.key === 'Enter') play('enter'); else if (e.key.length === 1 || e.key === 'Backspace') play('key', 25);
  });
  document.addEventListener('visibilitychange', () => { if (ctx) (document.hidden ? ctx.suspend() : ctx.resume()); });
}
