// Exercise the renderers across role changes: cached cards must drop forbidden controls immediately.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initPolls } from '../public/js/polls.js';
import { initProject } from '../public/js/project.js';
import { __ } from '../public/js/common.js';

class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.children = []; this.hidden = false;
    this.style = { setProperty() {} }; this.classList = { toggle() {} }; this.events = {};
  }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  addEventListener(event, fn) { this.events[event] = fn; }
  setAttribute() {}
  contains() { return false; }
}
const descendants = (node) => [node, ...node.children.filter((c) => c instanceof Element).flatMap(descendants)];
const visible = (node) => node.hidden ? [] : [node, ...node.children.filter((c) => c instanceof Element).flatMap(visible)];
const buttons = (node) => visible(node).filter((n) => n.tagName === 'BUTTON').map((n) => n.textContent);

test('panel: poll and project controls follow permissions, including a cached role downgrade', () => {
  const oldDocument = globalThis.document, oldOption = globalThis.Option;
  const nodes = new Map();
  globalThis.document = {
    getElementById(id) { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); },
    createElement(tag) { return new Element(tag); }, activeElement: null,
  };
  globalThis.Option = class extends Element {};
  try {
    const state = { me: { username: 'viewer', permissions: ['station.view'] }, filter: 'Shop', tasks: [],
      rooms: [{ id: 'shop', project: 'Shop', name: 'Shop', goal: 'Release', milestones: [{ text: 'Docs', done: false }] }],
      polls: [{ id: 'V-TEST', room: 'shop', project: 'Shop', by: 'bot', question: 'Ship today?',
        status: 'open', options: ['Yes', 'No'], counts: [0, 0], ballots: [], expiresAt: 1 }],
    };
    const h = { state, inFilter: () => true, roomByProject: () => state.rooms[0], roomTint: () => '#ffffff',
      roomName: () => 'Shop', nameOf: (x) => x, left: () => '1 min', ago: () => 'now', poll() {}, goRoom() {} };
    const renderPolls = initPolls(h), renderProject = initProject(h);
    const node = (id) => nodes.get(id);
    const render = () => { renderPolls(); renderProject(); };
    render();
    assert.equal(node('newVote').hidden, true);
    assert.deepEqual(buttons(node('pollsList')), []);
    assert.deepEqual(buttons(node('projectBody')), []);
    assert.ok(descendants(node('projectBody')).find((n) => n.type === 'checkbox').disabled);

    state.me.permissions = ['station.view', 'polls.open', 'polls.vote', 'rooms.project'];
    render();
    assert.equal(node('newVote').hidden, false);
    assert.deepEqual(buttons(node('pollsList')), [__('VOTE'), __('VOTE')]);
    assert.ok(buttons(node('projectBody')).includes(__('SAVE')));
    state.polls[0].status = 'tie'; render();
    assert.deepEqual(buttons(node('pollsList')), [], 'a member cannot settle a tie');

    state.me.permissions.push('polls.decide'); render();
    assert.deepEqual(buttons(node('pollsList')), [__('CHOOSE'), __('CHOOSE')]);
    state.polls[0].status = 'open'; render();
    assert.ok(buttons(node('pollsList')).includes(__('CLOSE NOW')));

    state.me.permissions = ['station.view']; render();
    assert.deepEqual(buttons(node('pollsList')), [], 'cached polls lose their buttons');
    assert.deepEqual(buttons(node('projectBody')), [], 'cached project loses its edit buttons');
    assert.equal(node('newVote').hidden, true);
  } finally { globalThis.document = oldDocument; globalThis.Option = oldOption; }
});
