import { el, api, __, say } from './common.js';

// Shared human review UI; payloads are rendered as text, never HTML.
export async function renderHeld(target) {
  const { items } = await api('GET', '/api/held'); target.replaceChildren();
  const status = el('p', 'status-line'), boxes = new Map(), table = el('table');
  const head = el('tr');
  for (const label of ['Select','Agents','Sender','Content','Status','Reason','Preview']) head.append(el('th', null, __(label)));
  table.append(head);
  for (const item of items) {
    const row = el('tr'), checkbox = el('input'); checkbox.type = 'checkbox'; checkbox.disabled = !['pending','quarantined'].includes(item.status); boxes.set(item.id, checkbox);
    const sender = `${item.source.type === 'claude' ? 'agent' : item.source.type}:${item.source.id || '?'}`;
    const values = [checkbox, item.for_claude, sender, item.resource_key.replace(/^claude:/, 'agent:') + '/' + item.field, item.status, item.findings?.length ? item.findings.map(f => f.type).join(', ') : __('Manual review'), el('pre', null, typeof item.payload === 'string' ? item.payload : JSON.stringify(item.payload))];
    for (const value of values) { const cell = el('td'); cell.append(value); row.append(cell); } table.append(row);
  }
  const button = (label, action) => { const b = el('button', null, __(label)); b.type = 'button'; b.addEventListener('click', async () => { b.disabled = true; try { await action(); } catch (err) { say(status, err.message, 'err'); } finally { b.disabled = false; } }); return b; };
  const note = el('input'); note.maxLength = 500; const label = el('label', 'field', __('Delivery note')); label.append(note);
  const decide = decision => async () => { const ids = [...boxes].filter(([, b]) => b.checked).map(([id]) => id); if (!ids.length) return;
    // Keep each server batch bounded; the same decision is sent for every selected row.
    for (let offset = 0; offset < ids.length; offset += 50) await api('POST', '/api/held/decide', { ids: ids.slice(offset, offset + 50), decision, note: note.value });
    await renderHeld(target);
  };
  const wrap = el('div', 'table-wrap'); wrap.append(table);
  target.append(button('REFRESH', () => renderHeld(target)), label, button('DELIVER SELECTED', decide('approved')), button('QUARANTINE SELECTED', decide('quarantined')), button('DISCARD SELECTED', decide('discarded')), status, wrap);
}
