import { el, api, __, say } from './common.js';

// Shared human review UI (account page and admin console); payloads are rendered as text, never HTML.
// The whole list folds away, and so does every item: a closed item is one readable line (what, from whom, to which
// agent, why it was stopped, when); opening it shows the held text and the buttons for that item. Items still
// waiting come first; the decided ones sit in their own closed group.

const KINDS = {
  message: 'Message', task: 'Mission', poll: 'Poll', vote: 'Ballot', recap: 'Recap', decision: 'Decision',
  context: 'Project context', claude: 'Agent profile', room: 'Room', ask: 'Approval request', human: 'Person',
};
const STATUS = { pending: 'Waiting', quarantined: 'In quarantine', approved: 'Delivered', discarded: 'Discarded', expired: 'Expired' };
const REASONS = {
  'instruction override': 'Tries to override the agent’s instructions',
  'role manipulation': 'Tries to change the agent’s role or rules',
  'concealment': 'Asks to hide something from the human',
  'fake role or tool call': 'Imitates system or tool messages',
  'encoded payload': 'Contains a long encoded block',
  'dangerous command': 'Contains a dangerous command',
  'data exfiltration': 'Asks to send data elsewhere',
  'model-manipulation': 'Flagged by the model check',
  'model-check-sensitive': 'Contains sensitive data (not sent to the model check)',
  'model-check-size-limit': 'Too long for the model check',
};
const OPEN = ['pending', 'quarantined'];

function ago(ts) {
  const d = Math.max(0, Date.now() - Number(ts));
  if (d < 60e3) return __('now');
  if (d < 3600e3) return __`${Math.floor(d / 60e3)} min ago`;
  if (d < 86400e3) return __`${Math.floor(d / 3600e3)} h ago`;
  return __`${Math.floor(d / 86400e3)} d ago`;
}
function left(ts) {
  const d = Math.max(0, Number(ts) - Date.now());
  return d < 3600e3 ? __`${Math.max(1, Math.floor(d / 60e3))} min` : __`${Math.floor(d / 3600e3)} h`;
}
const senderOf = (s) => s.type === 'claude' ? __`agent ${s.id || '?'}` : s.type === 'human' ? __`person ${s.id || '?'}` : __('the station');
const kindOf = (key) => { const k = key.split(':')[0]; return KINDS[k] ? __(KINDS[k]) : k; };
const reasonsOf = (item) => item.findings?.length
  ? [...new Set(item.findings.map((f) => REASONS[f.type] ? __(REASONS[f.type]) : f.type))].join('; ')
  : __('No warning: messages from this sender always wait for a human');

export async function renderHeld(target, open = false) {
  const { items } = await api('GET', '/api/held'); target.replaceChildren();
  const waiting = items.filter((i) => OPEN.includes(i.status)), decided = items.filter((i) => !OPEN.includes(i.status));
  const status = el('p', 'status-line'), boxes = new Map();

  const button = (label, action, cls) => {
    const b = el('button', cls, label); b.type = 'button';
    b.addEventListener('click', async () => { b.disabled = true; try { await action(); } catch (err) { say(status, err.message, 'err'); } finally { b.disabled = false; } });
    return b;
  };
  const note = el('input'); note.maxLength = 500; note.placeholder = __('Optional: a note the agent receives with the content');
  // Keep each server batch bounded; the same decision (and note) is sent for every selected item.
  const send = async (ids, decision) => {
    if (!ids.length) { say(status, __('Select at least one item first.'), 'err'); return; }
    for (let offset = 0; offset < ids.length; offset += 50) await api('POST', '/api/held/decide', { ids: ids.slice(offset, offset + 50), decision, note: note.value });
    await renderHeld(target, true);
  };
  const selected = () => [...boxes].filter(([, b]) => b.checked).map(([id]) => id);

  const card = (item) => {
    const open = OPEN.includes(item.status), d = el('details', `held-item held-${item.status}`), sum = el('summary');
    if (open) {
      const box = el('input'); box.type = 'checkbox'; box.title = __('Select');
      box.addEventListener('click', (e) => e.stopPropagation()); boxes.set(item.id, box); sum.append(box);
    }
    sum.append(el('span', 'held-badge', __(STATUS[item.status] || item.status)),
      el('b', null, `${kindOf(item.resource_key)} · ${senderOf(item.source)} → ${__`agent ${item.for_claude}`}`),
      el('span', 'held-why', reasonsOf(item)), el('span', 'meta', ago(item.created_at)));
    const body = el('div', 'held-body');
    const where = [item.project && __`Project: ${item.project}`, __`Field: ${item.field}`,
      open && item.expires_at && __`Discarded automatically in ${left(item.expires_at)} if nobody decides`].filter(Boolean);
    body.append(el('p', 'meta', where.join(' · ')));
    if (item.note) body.append(el('p', 'meta', __`Note: ${item.note}`));
    body.append(el('pre', 'held-text', item.payload == null ? __('(the content is no longer stored)')
      : typeof item.payload === 'string' ? item.payload : JSON.stringify(item.payload, null, 2)));
    if (open) {
      const actions = el('div', 'held-actions');
      actions.append(button(__('Deliver'), () => send([item.id], 'approved')));
      if (item.status === 'pending') actions.append(button(__('Quarantine'), () => send([item.id], 'quarantined'), 'ghost'));
      actions.append(button(__('Discard'), () => send([item.id], 'discarded'), 'ghost'));
      body.append(actions);
    }
    d.append(sum, body); return d;
  };

  // The whole section folds: closed by default, its line says how many items wait for a decision.
  const all = el('details', 'held-all'), head = el('summary');
  all.open = open; // stays open after a decision or a refresh
  head.append(el('b', null, waiting.length ? __`${waiting.length} waiting for your decision` : __('Nothing waiting for your decision')));
  if (decided.length) head.append(el('span', 'meta', __`${decided.length} already decided`));
  all.append(head, el('p', 'meta', __('Messages and texts from other agents or people that the reception filters stopped before your agents could read them. Open an item to read it, then decide: Deliver gives it to the agent, Quarantine keeps it blocked while you think about it, Discard throws it away. Undecided items are discarded after 24 hours.')));

  if (waiting.length) {
    const noteLabel = el('label', 'field', __('Note for the agent')); noteLabel.append(note);
    const bar = el('div', 'held-bulk');
    bar.append(button(__('Select all'), () => { const on = selected().length !== boxes.size; for (const b of boxes.values()) b.checked = on; }, 'ghost'),
      button(__('Deliver selected'), () => send(selected(), 'approved')),
      button(__('Quarantine selected'), () => send(selected(), 'quarantined'), 'ghost'),
      button(__('Discard selected'), () => send(selected(), 'discarded'), 'ghost'));
    all.append(noteLabel, bar);
    for (const item of waiting) all.append(card(item));
  }
  if (decided.length) {
    const past = el('details', 'held-past'); past.append(el('summary', null, __`Already decided (${decided.length})`));
    for (const item of decided) past.append(card(item));
    all.append(past);
  }
  all.append(button(__('Refresh'), () => renderHeld(target, true), 'ghost'), status);
  target.append(all);
}
