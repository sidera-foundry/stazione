// Sections of the panel: Station (with the comms channel), Missions, Logbook, Tech. Only one is shown at a time; each has
// its own address (/#missions...) and the last one is remembered. The panels keep their ids, so board.js and the other
// modules fill them exactly as before; this module only moves the view around and keeps two small summaries:
// the "Your turn" box (approvals, permissions, opinions waiting for you) and, if present, the latest recaps.
import { __ } from './i18n.js';

const $ = (id) => document.getElementById(id);
const VIEWS = ['station', 'missions', 'journal', 'tech'];
const KEY = 'stazione.view';

/** Shows one section (also used by the bell to jump to a panel that lives in another section). */
export function show(view) {
  if (!VIEWS.includes(view)) view = 'station';
  for (const v of document.querySelectorAll('[data-view]')) v.hidden = v.dataset.view !== view;
  for (const b of document.querySelectorAll('#viewTabs [data-go]')) {
    const on = b.dataset.go === view;
    b.classList.toggle('on', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  }
  try { localStorage.setItem(KEY, view); } catch { /* not remembered */ }
  if (location.hash !== `#${view}`) history.replaceState(null, '', `#${view}`);
}

function start() {
  for (const b of document.querySelectorAll('#viewTabs [data-go]')) b.addEventListener('click', () => show(b.dataset.go));
  addEventListener('hashchange', () => show(location.hash.slice(1)));
  let first = location.hash.slice(1);
  if (!VIEWS.includes(first)) { try { first = localStorage.getItem(KEY) || 'station'; } catch { first = 'station'; } }
  show(first);

  // "Your turn": the three waiting-for-you panels live in one box, shown only when one of them has something;
  // the count also goes on the Station tab, so nothing is missed from another section.
  const waiting = ['approvalsPanel', 'asksPanel', 'opinionsPanel'].map($).filter(Boolean);
  const box = $('yourTurn'), badge = $('yourTurnBadge');
  const refresh = () => {
    const open = waiting.filter((p) => !p.hidden);
    const n = open.reduce((sum, p) => sum + (Number(p.querySelector('.count')?.textContent) || p.querySelectorAll('li').length || 1), 0);
    if (box) box.hidden = !open.length;
    if (badge) { badge.hidden = !n; badge.textContent = String(n); }
  };
  for (const p of waiting) new MutationObserver(refresh).observe(p, { attributes: true, attributeFilter: ['hidden'], childList: true, subtree: true });
  refresh();

  // Latest recaps on the home view: a copy of the first three from the Logbook section.
  const full = $('recapList'), mini = $('recapMini');
  if (full && mini) {
    const copy = () => {
      const items = [...full.children].slice(0, 3).map((n) => n.cloneNode(true));
      mini.replaceChildren(...(items.length ? items : [Object.assign(document.createElement('p'), { className: 'empty', textContent: __('No recaps yet.') })]));
    };
    new MutationObserver(copy).observe(full, { childList: true, subtree: true, characterData: true });
    copy();
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
