import { el, __ } from './common.js';

export function restrictionEditor(rooms, value = {}) {
  const element = el('div', 'stack'), checks = new Map();
  const field = (text, input) => { const label = el('label', 'field', text); label.append(input); element.append(label); };
  for (const [key, text] of [['readOnly', 'Read only'], ['noPolls', 'Disable voting and poll changes'], ['noContext', 'Disable context changes']]) {
    const input = el('input'); input.type = 'checkbox'; input.checked = Boolean(value[key]); checks.set(key, input); field(__(text), input);
  }
  const inherit = el('input'); inherit.type = 'checkbox'; inherit.checked = value.rooms == null;
  field(__('All rooms available to the owner'), inherit);
  const choices = el('select'); choices.multiple = true; choices.size = Math.min(6, Math.max(2, rooms.length));
  const available = [...rooms];
  for (const id of value.rooms || []) if (!available.some(r => r.id === id)) available.push({ id, name: __('Unavailable room') });
  for (const room of available) { const option = el('option', null, room.name); option.value = room.id; option.selected = (value.rooms || []).includes(room.id); choices.append(option); }
  const refresh = () => { choices.disabled = inherit.checked; }; inherit.addEventListener('change', refresh); refresh();
  field(__('Allowed rooms'), choices);
  element.append(el('p', 'meta', __('When all rooms is off, an empty selection permits no rooms.')));
  const ips = el('textarea'); ips.rows = 3; ips.value = (value.ips || []).join('\n'); field(__('Allowed networks for this token'), ips);
  element.append(el('p', 'meta', __('One IPv4 or IPv6 range per line. Leave empty to allow every network.')));
  return { element, value: () => ({ ...Object.fromEntries([...checks].map(([key, c]) => [key, c.checked])), rooms: inherit.checked ? null : [...choices.selectedOptions].map(o => o.value), ips: ips.value.split('\n').map(v => v.trim()).filter(Boolean) }) };
}
