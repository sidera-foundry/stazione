// Polls on the panel: what the Claudes are deciding together, who voted what and why. The humans can vote too,
// close a vote early, or settle it themselves (always when it ended in a tie).
import { $, el, api, say, busy, __, can, contentWarning } from './common.js';

/** h: helpers from the board — state, nameOf, roomName, roomTint, inFilter, roomByProject, ago, left, poll. Returns render(). */
export function initPolls(h) {
  let key = '';
  const act = async (li, path, body) => {
    li.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    try { await api('POST', path, body); key = ''; h.poll(); } catch (err) {
      li.querySelectorAll('button').forEach((b) => { b.disabled = false; });
      li.append(el('div', 'status-line err', err.message));
    }
  };

  // New vote, opened by a human: for one room or for the whole station.
  let roomsKey = '';
  const form = $('voteForm'), msg = $('voteMsg'), sel = $('vRoom');
  $('newVote').hidden = true;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!can(h.state.me, 'polls.open')) return;
    const options = $('vOpts').value.split('\n').map((x) => x.trim()).filter(Boolean);
    if (options.length < 2 || options.length > 5) { say(msg, __('From 2 to 5 options are needed, one per line.'), 'err'); return; }
    busy(form, async () => {
      try {
        await api('POST', '/api/polls', { text: $('vText').value.trim(), options, room: sel.value || undefined, minutes: Number($('vMin').value) });
        form.reset(); $('newVote').open = false; say(msg, ''); key = ''; h.poll();
      } catch (err) { say(msg, err.message, 'err'); }
    });
  });
  const renderRooms = () => {
    const rooms = h.state.rooms || [];
    const k = JSON.stringify([rooms.map((r) => [r.id, r.name]), h.state.filter]);
    if (k === roomsKey) return;
    roomsKey = k;
    sel.replaceChildren(new Option(__('The whole station'), ''), ...rooms.map((r) => new Option(__`Only ${r.name}`, r.id)));
    sel.value = h.roomByProject(h.state.filter)?.id ?? ''; // the room on screen is the natural choice
  };

  return function render() {
    renderRooms();
    const s = h.state, panel = $('pollsPanel');
    $('newVote').hidden = !can(s.me, 'polls.open');
    const polls = (s.polls || []).filter((p) => !p.room || h.inFilter(p.project));
    const live = polls.filter((p) => p.status !== 'closed');
    panel.classList.toggle('alert', live.some((p) => p.status === 'tie'));
    $('pollsCount').textContent = live.length ? String(live.length) : '';
    const k = JSON.stringify([s.me?.permissions, polls.map((p) => [p.id, p.status, p.ballots, p.status === 'open' ? h.left(p.expiresAt) : h.ago(p.closedAt)])]);
    if (k === key) return; // rebuilt only on change, so a click is never lost to the poll
    key = k;
    const list = $('pollsList'); list.replaceChildren();
    if (!polls.length) list.append(el('li', 'empty', __('No polls in progress.')));
    const mine = `human:${s.me?.username}`;
    for (const p of polls) {
      const li = el('li', `card poll ${p.status}`); li.id = `poll-${p.id}`;
      li.style.setProperty('--rc', h.roomTint(p.project));
      const where = p.room ? h.roomName(p.project) : __('The whole station');
      const when = p.status === 'open' ? __`closes in ${h.left(p.expiresAt)}` : p.status === 'tie' ? __('TIE: you choose') : __`closed ${h.ago(p.closedAt)}`;
      li.append(el('div', 'meta', __`${where} · opened by ${h.nameOf(p.by)} · ${when}`), el('div', 't', p.question));
      const warning = contentWarning(p); if (warning) li.append(warning);
      const total = Math.max(1, p.ballots.length);
      p.options.forEach((o, i) => {
        const row = el('div', `opt${p.result === i ? ' win' : ''}`);
        const bar = el('div', 'ttl'); const fill = el('i'); fill.style.width = `${(p.counts[i] / total) * 100}%`; bar.append(fill);
        const head = el('div', 'opt-head');
        head.append(el('b', null, `${p.result === i ? '★ ' : ''}${o}`), el('span', 'meta', (p.counts[i] === 1 ? __('1 vote') : __`${p.counts[i]} votes`)));
        if (p.status === 'tie' ? can(s.me, 'polls.decide') : p.status === 'open' && can(s.me, 'polls.vote')) {
          const b = el('button', 'ghost', p.status === 'tie' ? __('CHOOSE') : p.ballots.some((x) => x.voter === mine && x.choice === i) ? __('VOTED') : __('VOTE')); b.type = 'button';
          b.addEventListener('click', () => (p.status === 'tie'
            ? act(li, `/api/polls/${encodeURIComponent(p.id)}/close`, { choice: i + 1 })
            : act(li, `/api/polls/${encodeURIComponent(p.id)}/vote`, { choice: i + 1 })));
          head.append(b);
        }
        row.append(head, bar);
        for (const x of p.ballots.filter((y) => y.choice === i)) row.append(el('div', 'why', `${h.nameOf(x.voter)}${x.reason ? `: ${x.reason}` : ''}`));
        li.append(row);
      });
      if (p.status === 'open' && can(s.me, 'polls.decide')) {
        const b = el('button', 'ghost', __('CLOSE NOW')); b.type = 'button'; b.title = __('Closes at once: the majority of the votes so far wins');
        b.addEventListener('click', () => act(li, `/api/polls/${encodeURIComponent(p.id)}/close`, {}));
        li.append(b);
      } else if (p.status === 'closed' && p.closedBy?.startsWith('human:')) li.append(el('div', 'meta', __`Decided by ${h.nameOf(p.closedBy)}`));
      list.append(li);
    }
  };
}
