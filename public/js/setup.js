// First start of a station: which required settings are still missing, and the random secrets made here, in the
// browser (crypto.getRandomValues), ready to paste into the host's environment variables. Nothing is sent anywhere:
// the only request asks the station whether it is set up (names of the missing settings, never values).
import { $, say, __ } from './common.js';

const bytes = (n) => crypto.getRandomValues(new Uint8Array(n));
const b64 = (n) => btoa(String.fromCharCode(...bytes(n)));
const b64url = (n) => b64(n).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function makeSecrets() {
  $('envBlock').value = [
    `PASSWORD_PEPPER=${b64(32)}`,
    `DATA_ENCRYPTION_KEY=${b64(32)}`,
    `INVITE_CODE=${b64url(18)}`,
    `CRON_SECRET=${b64url(32)}`,
  ].join('\n');
}

const WHAT = {
  DATABASE_URL: () => __('DATABASE_URL: the database. On Vercel: Storage, Create, Neon Postgres (it sets the variable by itself).'),
  PASSWORD_PEPPER: () => __('PASSWORD_PEPPER: from the block below.'),
  DATA_ENCRYPTION_KEY: () => __('DATA_ENCRYPTION_KEY: from the block below.'),
};

async function check() {
  let res, data = null;
  try {
    res = await fetch('/api/me', { credentials: 'same-origin', cache: 'no-store' });
    data = await res.json().catch(() => null);
  } catch { say($('state'), __('The station does not answer. Wait for the deployment to finish, then reload this page.'), 'err'); return; }
  if (data?.code !== 'setup_required') {
    say($('state'), __('This station is set up. If nobody has signed up yet, create the owner account with your INVITE_CODE.'), 'good');
    $('ready').hidden = false;
    return;
  }
  say($('state'), __('Almost there: the station still needs these settings.'));
  $('missing').replaceChildren(...data.missing.map((n) => { const li = document.createElement('li'); li.textContent = WHAT[n]?.() || n; return li; }));
  $('missing').hidden = false;
  if (data.missing.some((n) => n !== 'DATABASE_URL')) { makeSecrets(); $('secrets').hidden = false; }
  $('vercel').hidden = false;
}

$('again').addEventListener('click', makeSecrets);
$('copyEnv').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('envBlock').value); say($('state'), __('Copied. Now paste it on Vercel (step 2).'), 'good'); }
  catch { $('envBlock').select(); say($('state'), __('Copy not available: the block is selected, use Ctrl+C.')); }
});
check();
