// Protected data shared for a limited time is never readable after its deadline, even before the expiry sweep runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeCanRead, humanCanReveal } from '../lib/secure.js';

test('secure items: readable until available_until, never after', () => {
  const item = { ciphertext: 'v1.x.y.z', status: 'approved', policy: 'claude_24h', to_target: 'reader', from_claude: 'writer', owner_user: 'u1' };
  assert.equal(claudeCanRead({ ...item, available_until: Date.now() + 60e3 }, 'reader'), true);
  assert.equal(claudeCanRead({ ...item, available_until: Date.now() - 1 }, 'reader'), false);
  assert.equal(humanCanReveal({ ...item, available_until: Date.now() + 60e3 }, 'u1', 'u2'), true);
  assert.equal(humanCanReveal({ ...item, available_until: Date.now() - 1 }, 'u1', 'u2'), false);
  assert.equal(claudeCanRead({ ...item, policy: 'permanent', available_until: null }, 'anyone'), true, 'no deadline, no expiry');
});
