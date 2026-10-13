// Every browser module must parse: one syntax error in a module imported by board.js blanks the whole panel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

test('public/js modules parse', () => {
  for (const f of readdirSync(new URL('../public/js/', import.meta.url))) {
    if (!f.endsWith('.js')) continue;
    assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', `public/js/${f}`], { stdio: 'pipe' }), f);
  }
});
