// Settings: every variable is checked at start-up by the self-hosted server, without ever printing a value.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { checkConfig } from '../lib/config.js';

const key = () => crypto.randomBytes(32).toString('base64');
const good = { DATABASE_URL: 'postgres://u:p@db:5432/s', PASSWORD_PEPPER: key(), DATA_ENCRYPTION_KEY: key(), INVITE_CODE: 'an-invite-code-0123' };

test('config: required settings, formats, and no values in the messages', () => {
  assert.deepEqual(checkConfig(good), { errors: [], warnings: [] });
  const missing = checkConfig({});
  assert.equal(missing.errors.length, 3, 'database and the two keys are required');
  assert.ok(missing.warnings.some((w) => /INVITE_CODE/.test(w)));
  const bad = checkConfig({ ...good, PASSWORD_PEPPER: 'short', TIMEZONE: 'Mars/Base', PORT: '99999', APP_ORIGIN: 'https://x.example/path', MAX_USERS: '0' });
  assert.deepEqual(bad.errors.map((e) => e.split(' ')[0]).sort(), ['APP_ORIGIN', 'MAX_USERS', 'PASSWORD_PEPPER', 'PORT', 'TIMEZONE']);
  assert.ok(!bad.errors.join(' ').includes('short'), 'values are never echoed');
  assert.deepEqual(checkConfig({ ...good, TIMEZONE: 'Europe/Rome', APP_ORIGIN: 'https://station.example.com', TRUST_PROXY: '1' }).errors, []);
  assert.ok(checkConfig({ ...good, TELEGRAM_BOT_TOKEN: 'x' }).warnings.some((w) => /Telegram/.test(w)));
});
