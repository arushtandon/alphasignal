/**
 * Minimal Telegram Bot API helper for IBKR bridge risk alerts.
 *
 * Env:
 *   TELEGRAM_BOT_TOKEN   from @BotFather
 *   TELEGRAM_CHAT_ID     your user/group chat id
 *   TELEGRAM_ALERTS      set 0 to disable even when token/chat are set
 */
'use strict';

const https = require('https');

function telegramConfigured() {
  if (process.env.TELEGRAM_ALERTS === '0') return false;
  return !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

function postTelegram(path, body) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${token}${path}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: 15000
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(data || '{}');
          if (!j.ok) reject(new Error(j.description || ('telegram HTTP ' + res.statusCode)));
          else resolve(j);
        } catch (e) {
          reject(new Error('telegram bad JSON: ' + e.message));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('telegram timeout')); });
    req.write(payload);
    req.end();
  });
}

/**
 * Send a plain-text alert (MarkdownV2 avoided — tickers have dots/underscores).
 * Long messages are split into ≤3500 char chunks.
 */
async function sendTelegramAlert(text, opts) {
  if (!telegramConfigured()) return { ok: false, skipped: true };
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const chunks = [];
  const s = String(text || '').trim();
  if (!s) return { ok: false, skipped: true };
  for (let i = 0; i < s.length; i += 3500) chunks.push(s.slice(i, i + 3500));
  const html = !!(opts && opts.html);
  for (const chunk of chunks) {
    const body = {
      chat_id: chatId,
      text: chunk,
      disable_web_page_preview: true
    };
    if (html) body.parse_mode = 'HTML';
    await postTelegram('/sendMessage', body);
  }
  return { ok: true, parts: chunks.length };
}

module.exports = { telegramConfigured, sendTelegramAlert };
