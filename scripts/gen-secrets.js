// Generates the production secrets without printing them.
//   npm run gen-secrets              → .env.production.local, to copy into your host's settings (e.g. Vercel), then delete
//   npm run gen-secrets -- --docker  → .env, read by docker-compose (it also holds the Postgres password)
// Both files are git-ignored.
import fs from 'node:fs';
import crypto from 'node:crypto';

const docker = process.argv.includes('--docker');
const file = docker ? '.env' : '.env.production.local';
if (fs.existsSync(file)) {
  console.error(`${file} already exists: not overwriting it. Delete it if you want to generate the secrets again.`);
  process.exit(1);
}
const b64 = (n) => crypto.randomBytes(n).toString('base64');
const url = (n) => crypto.randomBytes(n).toString('base64url');
const lines = [
  docker
    ? '# Settings of the Docker station (docker-compose reads this file). Never commit it and never paste it into a chat.'
    : '# Production secrets: copy them into your host\'s environment variables (e.g. Vercel), then delete this file.',
  ...(docker ? [] : ['# Never commit it and never paste it into a chat.']),
  ...(docker ? [`POSTGRES_PASSWORD=${crypto.randomBytes(24).toString('hex')}`] : []),
  `PASSWORD_PEPPER=${b64(32)}`,
  `DATA_ENCRYPTION_KEY=${b64(32)}`,
  `INVITE_CODE=${url(18)}`,
  `CRON_SECRET=${url(32)}`,
  `TELEGRAM_WEBHOOK_SECRET=${url(32)}`,
  'MAX_USERS=2',
  ...(docker ? ['# Behind a reverse proxy that sets X-Real-IP (recommended; 0 without a proxy):', 'TRUST_PROXY=1', '# APP_ORIGIN=https://station.example.com'] : []),
  '# To add by hand:',
  ...(docker ? [] : ['# DATABASE_URL=   (set by Vercel when you connect Neon, or your own Postgres)']),
  '# TELEGRAM_BOT_TOKEN=   (from @BotFather, optional)',
  '# TELEGRAM_BOT_USERNAME=   (e.g. MyStazioneBot, optional)',
  '# TIMEZONE=   (e.g. Europe/Rome, for the evening digest; default UTC)',
  '',
];
fs.writeFileSync(file, lines.join('\n'), { mode: 0o600 });
console.log(`Secrets written to ${file}. The file is not printed here on purpose.`);
