// Stazione · restyling, the behaviour half of restyle.css. Two selectable themes: "new" (the dark cockpit)
// and "classic" (the original panel). A classic script, loaded in <head> right after
// <link rel="stylesheet" href="/css/restyle.css" data-restyle> and before board.js: it picks the theme before the
// first paint (no flash) and before the scene draws its first frame. In the new theme:
// 1. the sky follows the viewer's clock (day 7-19 is the light variant → data-sky on <html>), or a fixed choice;
// 2. a clock in the header;
// 3. the pixel scene repainted with the new palette: canvas colours are remapped when they are set, so board.js,
//    rooms.js and the game room module need no edit.
// Both choices live in this browser only (localStorage).
(() => {
  const store = {
    get: (k, d) => { try { return localStorage.getItem(k) || d; } catch { return d; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode: the choice lasts for this page */ } },
  };
  let theme = store.get('stazione-theme', 'new') === 'classic' ? 'classic' : 'new';
  const isNew = () => theme === 'new';
  // Texts through i18n.js (a module, loaded by every page; ready before DOMContentLoaded, when the buttons appear).
  const tr = (s, ...v) => (globalThis.__ ? globalThis.__(s, ...v) : s.replace(/\{(\d+)\}/g, (_, i) => v[i]));

  // ---------- 3. palette for the canvases (old hex → new hex; alpha kept) ----------
  const PALETTE = {
    '#05071a': '#0b0812', '#05081c': '#0d0912', '#070a1f': '#0b0812', '#0a0f2c': '#120c18', '#0b0f2e': '#140e1c',
    '#0b1030': '#1a1322', '#10163a': '#1b1424', '#141a45': '#221b2b', '#161e4b': '#231a2d', '#1a2366': '#2a1d36',
    '#1a1d2e': '#1d1626', '#2b3574': '#4b4458', '#2b3775': '#4b4458', '#2c3048': '#3a3046', '#39447f': '#5a536a',
    '#3a3f66': '#4a4058', '#4a5494': '#7a7290', '#5a66a8': '#7f7596', '#5c6699': '#7a6e8a', '#5d6590': '#6d6580',
    '#6f78a6': '#8a809a', '#8a93b8': '#a497b3', '#8a94c6': '#a497b3', '#9aa3c7': '#b4a8bd', '#c9cfe6': '#ddd2c4',
    '#ece6d2': '#f5ecdd', '#3ee6c9': '#7fe8c1', '#ff5fa2': '#ff8fc0', '#b6f24a': '#9be07a', '#07282a': '#0f2a22',
    '#06092d': '#0b0812', '#232b5e': '#2a2236', '#10173f': '#1a1322', '#151d4d': '#221b2b', '#222a5e': '#2a2236',
    '#050a1c': '#0b0812', '#101a33': '#140f1f', '#0e1440': '#1a1322', '#1b2560': '#2a2236',
  };
  const MAP = new Map(Object.entries(PALETTE));
  const hex2 = (n) => Number(n).toString(16).padStart(2, '0');
  /** '#rrggbb[aa]' or 'rgb[a](r, g, b[, a])' → the same colour from the new palette, alpha kept; anything else as is. */
  function remap(v) {
    if (!isNew() || typeof v !== 'string') return v;
    if (v[0] === '#' && v.length >= 7) { const m = MAP.get(v.slice(0, 7).toLowerCase()); return m ? m + v.slice(7) : v; }
    const c = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(v);
    if (!c) return v;
    const m = MAP.get(`#${hex2(c[1])}${hex2(c[2])}${hex2(c[3])}`);
    if (!m) return v;
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(m.slice(i, i + 2), 16));
    return c[4] == null ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${c[4]})`;
  }
  for (const prop of ['fillStyle', 'strokeStyle', 'shadowColor']) {
    const d = Object.getOwnPropertyDescriptor(CanvasRenderingContext2D.prototype, prop);
    Object.defineProperty(CanvasRenderingContext2D.prototype, prop, { ...d, set(v) { d.set.call(this, remap(v)); } });
  }
  const addStop = CanvasGradient.prototype.addColorStop;
  CanvasGradient.prototype.addColorStop = function (offset, color) { return addStop.call(this, offset, remap(color)); };

  // ---------- 1. the sky ----------
  const SKIES = ['auto', 'day', 'night'], SKY_KEY = { auto: 'auto', day: 'day', night: 'night' }, SKY_LABEL = { auto: 'follows your time', day: 'always day', night: 'always night' };
  const PHASE_NAME = { day: 'day', night: 'night' };
  const phase = (h) => (h >= 7 && h < 19 ? 'day' : 'night');
  let skyChoice = SKIES.includes(store.get('stazione-sky', 'auto')) ? store.get('stazione-sky', 'auto') : 'auto';
  const sky = () => (skyChoice === 'auto' ? phase(new Date().getHours()) : skyChoice);

  // ---------- applying a theme ----------
  let clock, skyBtn, themeBtn;
  function apply() {
    const root = document.documentElement;
    root.dataset.theme = theme;
    if (isNew()) root.dataset.sky = sky(); else delete root.dataset.sky;
    const link = document.querySelector('link[data-restyle]') || document.querySelector('link[href*="restyle.css"]');
    if (link) link.disabled = !isNew();
    if (clock) clock.hidden = !isNew();
    if (skyBtn) skyBtn.hidden = !isNew();
    if (themeBtn) { themeBtn.innerHTML = tr('Theme <b>{0}</b>', tr(theme)); themeBtn.title = tr('Switch to the {0} theme', tr(isNew() ? 'classic' : 'new')); }
  }
  apply();

  // ---------- 2. the header: clock, sky button, theme button ----------
  function mount() {
    const bar = document.querySelector('.bar');
    if (!bar || bar.querySelector('.clock')) return;
    clock = document.createElement('span');
    clock.className = 'clock'; clock.setAttribute('aria-hidden', 'true');
    clock.innerHTML = '<b></b><small></small>';
    bar.querySelector('h1')?.after(clock);
    const anchor = bar.querySelector('.snd') || bar.querySelector('#conn');
    skyBtn = document.createElement('button');
    skyBtn.type = 'button'; skyBtn.className = 'ghost sky-btn';
    const skyLabel = () => { skyBtn.innerHTML = tr('Sky <b>{0}</b>', tr(SKY_KEY[skyChoice])); skyBtn.title = tr('Sky: {0} (click to change)', tr(SKY_LABEL[skyChoice])); };
    const tick = () => {
      const d = new Date();
      clock.querySelector('b').textContent = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      clock.querySelector('small').textContent = tr(PHASE_NAME[sky()]);
    };
    skyBtn.addEventListener('click', () => { skyChoice = SKIES[(SKIES.indexOf(skyChoice) + 1) % SKIES.length]; store.set('stazione-sky', skyChoice); skyLabel(); apply(); tick(); });
    skyLabel();
    themeBtn = document.createElement('button');
    themeBtn.type = 'button'; themeBtn.className = 'ghost theme-btn';
    themeBtn.addEventListener('click', () => { theme = isNew() ? 'classic' : 'new'; store.set('stazione-theme', theme); apply(); tick(); });
    if (anchor) anchor.before(themeBtn, skyBtn);
    else (bar.querySelector('#who') || bar.querySelector('.avatar-btn') || bar.querySelector('a.btn') || bar.querySelector('button'))?.before(themeBtn, skyBtn);
    tick();
    setInterval(() => { if (isNew()) document.documentElement.dataset.sky = sky(); tick(); }, 30000);
    apply();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
})();
