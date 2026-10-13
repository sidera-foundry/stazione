// Minimal Telegram Bot API client. The bot token lives only in TELEGRAM_BOT_TOKEN and is never logged.

export const telegramConfigured = () => Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_WEBHOOK_SECRET);

export async function tg(method, payload) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
    const data = await res.json().catch(() => null);
    if (!data?.ok) {
      console.error(`telegram ${method} failed: ${data?.error_code ?? res.status}`);
      return null;
    }
    return data.result;
  } catch (err) {
    console.error(`telegram ${method} unreachable: ${err?.name || 'error'}`);
    return null;
  }
}

export const sendText = (chatId, text, extra = {}) => tg('sendMessage', { chat_id: chatId, text, ...extra });
