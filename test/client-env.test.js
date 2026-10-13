// N1: the client falls back to ~/.config/stazione/env when the variables are missing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('client reads ~/.config/stazione/env and refuses it when not 600', { skip: process.platform === 'win32' }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stz-'));
  const file = path.join(home, '.config', 'stazione', 'env');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'STAZIONE_URL=http://127.0.0.1:9\nSTAZIONE_TOKEN=stz_' + 'A'.repeat(43) + '\n', { mode: 0o644 });
  const env = { PATH: process.env.PATH, HOME: home };
  const run = () => { try { return execFileSync(process.execPath, ['client/stazione.mjs', 'inbox', '--as', 'x'], { env, encoding: 'utf8' }); } catch (e) { return e.stdout; } };
  assert.match(run(), /chmod 600/);
  fs.chmodSync(file, 0o600);
  const out = run();
  assert.doesNotMatch(out, /missing|chmod/, 'variables loaded from the file');
  assert.doesNotMatch(out, /A{43}/, 'token never printed');
});
