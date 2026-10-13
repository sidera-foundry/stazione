// Every setting of the station comes from environment variables: this is the one list of them, with what each is for,
// and the check run at start-up by the self-hosted server (server.js). On Vercel the same variables are set in the
// project settings; lib/app.js still refuses every request while the required secrets are missing.

const b64Bytes = (v) => { try { return Buffer.from(v, 'base64').length; } catch { return 0; } };

/** name → { required, secret, help, check(value) → error text or null } */
export const CONFIG = {
  RECEPTION_DEFAULT: { required: false, help: 'initial reception default for new installations: manual (default), automatic or unrestricted; later changed in the console', check: v => ['manual','automatic','unrestricted'].includes(v) ? null : 'must be manual, automatic or unrestricted' },
  DATABASE_URL: { required: true, secret: true, help: 'Postgres connection string (e.g. Neon, or the db service of docker-compose)', check: (v) => (/^postgres(ql)?:\/\//.test(v) ? null : 'must start with postgres:// or postgresql://') },
  PASSWORD_PEPPER: { required: true, secret: true, help: 'at least 32 random bytes, base64 (npm run gen-secrets)', check: (v) => (b64Bytes(v) >= 32 ? null : 'needs at least 32 bytes, base64') },
  DATA_ENCRYPTION_KEY: { required: true, secret: true, help: 'at least 32 random bytes, base64 (npm run gen-secrets)', check: (v) => (b64Bytes(v) >= 32 ? null : 'needs at least 32 bytes, base64') },
  INVITE_CODE: { required: false, secret: true, help: 'bootstrap code for the first owner only; later people use single-use invites', check: (v) => (v.length >= 16 ? null : 'needs at least 16 characters') },
  MAX_USERS: { required: false, help: 'initial organization user limit (default 2); subsequent changes are stored in the database', check: (v) => (/^[1-9]\d{0,4}$/.test(v) ? null : 'must be a positive integer') },
  MESSAGE_MAX_CHARS: { required: false, help: 'message character limit (default 2000)', check: (v) => (/^[1-9]\d{0,4}$/.test(v) && Number(v) <= 20000 ? null : 'must be between 1 and 20000') },
  CONTEXT_MAX_CHARS: { required: false, help: 'context character limit (default 8000)', check: (v) => (/^[1-9]\d{0,4}$/.test(v) && Number(v) <= 20000 ? null : 'must be between 1 and 20000') },
  MESSAGE_RATE_LIMIT: { required: false, help: 'messages per Claude per 10 minutes (default 20)', check: (v) => (/^[1-9]\d{0,4}$/.test(v) && Number(v) <= 20000 ? null : 'must be between 1 and 20000') },
  APP_ORIGIN: { required: false, help: 'public address, e.g. https://station.example.com (default: taken from each request)', check: (v) => (/^https?:\/\/[^/\s]+$/.test(v) ? null : 'must be scheme://host[:port], without a path') },
  TIMEZONE: { required: false, help: 'IANA time zone of the evening digest, e.g. Europe/Rome (default UTC)', check: (v) => { try { new Intl.DateTimeFormat('en', { timeZone: v }); return null; } catch { return 'unknown time zone'; } } },
  CRON_SECRET: { required: false, secret: true, help: 'protects /api/cron/cleanup (Vercel sends it); the self-hosted server runs the cleanup by itself' },
  TELEGRAM_BOT_TOKEN: { required: false, secret: true, help: 'Telegram bot token from @BotFather (optional)' },
  TELEGRAM_BOT_USERNAME: { required: false, help: 'username of the Telegram bot, shown on the Account page' },
  TELEGRAM_WEBHOOK_SECRET: { required: false, secret: true, help: 'secret header Telegram sends to the webhook (npm run gen-secrets)' },
  HIBP_DISABLED: { required: false, help: 'set to 1 to skip the Have I Been Pwned password check (e.g. offline installs)', check: (v) => (v === '1' || v === '0' ? null : 'must be 1 or 0') },
  // self-hosted server only (server.js)
  HOST: { required: false, help: 'address the server listens on (default 0.0.0.0)' },
  PORT: { required: false, help: 'port the server listens on (default 3000)', check: (v) => (/^\d{1,5}$/.test(v) && Number(v) <= 65535 ? null : 'must be a port number') },
  TRUST_PROXY: { required: false, help: 'set to 1 only behind a reverse proxy that overwrites X-Real-IP or X-Forwarded-For with the real client address (a proxy that appends to a header sent by the visitor lets anyone fake their address and slip past rate limits and IP rules)', check: (v) => (v === '1' || v === '0' ? null : 'must be 1 or 0') },
};

/** Checks the environment: errors stop the start-up, warnings are printed. Values are never included in the output. */
export function checkConfig(env = process.env) {
  const errors = [], warnings = [];
  for (const [name, c] of Object.entries(CONFIG)) {
    const v = env[name];
    if (v == null || v === '') { if (c.required) errors.push(`${name} is missing: ${c.help}`); continue; }
    const problem = c.check?.(v);
    if (problem) errors.push(`${name} ${problem}`);
  }
  if (env.TRUST_PROXY === '1' && !env.APP_ORIGIN) warnings.push('APP_ORIGIN is not set: behind a proxy set it to the public address (e.g. https://station.example.com), or make sure the proxy sends X-Forwarded-Proto, otherwise sign-in fails with "Request origin not allowed"');
  if (!env.INVITE_CODE) warnings.push('INVITE_CODE is not set: a new installation cannot bootstrap its first owner; existing stations use single-use invites');
  const tg = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET'].filter((n) => env[n]);
  if (tg.length === 1) warnings.push('Telegram needs both TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET: it stays off');
  return { errors, warnings };
}
