import { $, api, say, busy, __ } from './common.js';
import { supported, ceremony } from './passkeys.js';

const msg = $('msg');
function enter(result) {
  if (result.next !== 'device') { location.replace('/'); return; }
  $('pwForm').hidden = $('totpForm').hidden = $('passkeyLogin').hidden = true;
  $('devicePending').hidden = false;
  say(msg, __('Waiting for device approval.'));
}
$('passkeyLogin').hidden = !supported();
$('passkeyLogin').addEventListener('click', async () => {
  $('passkeyLogin').disabled = true;
  try { enter(await ceremony(api, '/api/auth/passkey')); }
  catch (err) { say(msg, err.name === 'NotAllowedError' ? __('Passkey cancelled. Try again or use your password.') : err.message, 'err'); }
  finally { $('passkeyLogin').disabled = false; }
});
$('checkDevice').addEventListener('click', async () => {
  try { enter(await api('POST', '/api/auth/device/status', {})); }
  catch (err) { say(msg, err.message, 'err'); }
});
api('POST', '/api/auth/device/status', {}).then(enter).catch(() => {});

$('pwForm').addEventListener('submit', (e) => {
  e.preventDefault();
  busy(e.target, async () => {
    say(msg, '');
    try {
      await api('POST', '/api/auth/login', { username: $('username').value, password: $('password').value });
      $('password').value = '';
      $('pwForm').hidden = true;
      $('totpForm').hidden = false;
      $('code').focus();
    } catch (err) {
      say(msg, err.message, 'err');
    }
  });
});

$('totpForm').addEventListener('submit', (e) => {
  e.preventDefault();
  busy(e.target, async () => {
    try {
      enter(await api('POST', '/api/auth/login/totp', { code: $('code').value.trim() }));
    } catch (err) {
      $('code').value = '';
      if (err.status === 401 && /Session expired/.test(err.message)) {
        $('totpForm').hidden = true;
        $('pwForm').hidden = false;
      }
      say(msg, err.message, 'err');
    }
  });
});
