import { $, api, say, busy, renderPhrase, showQr, __ } from './common.js';

const msg = $('msg');
const inviteFromLink = new URL(location.href).searchParams.get('invite');
if (inviteFromLink) {
  $('invite').value = inviteFromLink;
  history.replaceState(null, '', location.pathname); // keep the one-use secret out of the address bar and later referrers
}

api('GET', '/api/auth/status').then((s) => {
  if (!s.registrationOpen) {
    $('closed').hidden = false;
    $('regForm').hidden = true;
  }
}).catch(() => {});

$('regForm').addEventListener('submit', (e) => {
  e.preventDefault();
  if ($('password').value !== $('password2').value) return say(msg, __('The two passwords do not match'), 'err');
  busy(e.target, async () => {
    say(msg, __('Checking…'));
    try {
      const data = await api('POST', '/api/auth/register/start', {
        invite: $('invite').value.trim(), username: $('username').value.trim().toLowerCase(), password: $('password').value,
      });
      $('password').value = '';
      $('password2').value = '';
      showQr($('qr'), $('secret'), data);
      $('step1').hidden = true;
      $('step2').hidden = false;
      say(msg, '');
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
      const data = await api('POST', '/api/auth/register/confirm', { code: $('code').value.trim() });
      renderPhrase($('phrase'), data.recoveryPhrase);
      $('qr').removeAttribute('src');
      $('secret').textContent = '';
      $('step2').hidden = true;
      $('step3').hidden = false;
      say(msg, '');
    } catch (err) {
      $('code').value = '';
      say(msg, err.message, 'err');
    }
  });
});

$('saved').addEventListener('change', (e) => { $('done').disabled = !e.target.checked; });
$('done').addEventListener('click', () => {
  $('phrase').replaceChildren();
  location.replace('/');
});
