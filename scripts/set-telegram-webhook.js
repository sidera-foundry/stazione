// Points the Telegram bot at the deployed webhook, with the secret header Telegram will echo back.
// Usage: node scripts/set-telegram-webhook.js https://your-app.vercel.app
// Reads TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET from .env.production.local (or the environment).
import fs from 'node:fs';

const file = '.env.production.local';
if (fs.existsSync(file)) {
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.+)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}
const base = (process.argv[2] || '').replace(/\/+$/, '');
const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
if (!/^https:\/\//.test(base)) { console.error('Give the HTTPS URL of the app, e.g. https://your-station.vercel.app'); process.exit(1); }
if (!token || !secret) { console.error('TELEGRAM_BOT_TOKEN or TELEGRAM_WEBHOOK_SECRET is missing'); process.exit(1); }

const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    url: `${base}/api/telegram/webhook`,
    secret_token: secret,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true,
  }),
});
const data = await res.json();
console.log(data.ok ? 'Webhook set.' : `Telegram error: ${data.description}`);
