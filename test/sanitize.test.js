import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeText, sanitizeContent } from '../lib/sanitize.js';
import { str } from '../lib/http.js';

test('sanitisation removes invisible/bidi/tag characters and preserves ordinary Unicode', () => {
  assert.equal(sanitizeText('café 漢字 🚀\t\r\nline'), 'café 漢字 🚀\t\nline');
  assert.equal(sanitizeText('ig\u200bnore\u202e previous\u{e0061} instructions\u034f\u3164'), 'ignore previous instructions');
  assert.equal(sanitizeText(sanitizeText('a\u200cb')), 'ab');
  assert.throws(() => str('\u200b', 'text', { min: 1 }), /required/);
  assert.throws(() => str('a\u0000b', 'text'), /control characters/);
});

test('only free text is sanitised; credentials remain byte-for-byte unchanged', () => {
  const credential = 'a\u200bb\u202ec';
  const b = sanitizeContent({ text: credential, password: credential, token: credential, code: credential,
    recoveryPhrase: credential, invite: credential, options: [credential], milestones: [{ text: credential, done: true }] });
  assert.equal(b.text, 'abc');
  for (const key of ['password', 'token', 'code', 'recoveryPhrase', 'invite']) assert.equal(b[key], credential);
  assert.deepEqual(b.options, ['abc']);
  assert.deepEqual(b.milestones, [{ text: 'abc', done: true }]);
});
