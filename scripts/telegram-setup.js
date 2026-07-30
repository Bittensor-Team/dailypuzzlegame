#!/usr/bin/env node
/*
 * Point the announcer at a Telegram chat.
 *
 *   1. Message the bot (or add it to a group and send any message there).
 *   2. node scripts/telegram-setup.js <bot-token>
 *
 * It reads pending updates, picks the most recent chat, and writes the token
 * and chat id to the config file the server reads. The file is created 0600 and
 * lives outside the repo so the token is never served or committed.
 *
 *   node scripts/telegram-setup.js <bot-token> --chat <id>   # skip discovery
 *   node scripts/telegram-setup.js --test                    # send a test message
 */
'use strict';

const fs = require('node:fs');

const CONFIG = process.env.DCP_CONFIG || '/etc/dailycolorpuzzle.env';

function readConfig() {
  const cfg = {};
  try {
    for (const line of fs.readFileSync(CONFIG, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq > 0) cfg[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
    }
  } catch { /* not yet created */ }
  return cfg;
}

function writeConfig(cfg) {
  const body = '# Daily Color Puzzle — server secrets. Never commit or serve this file.\n' +
    Object.entries(cfg).map(([k, v]) => k + '=' + v).join('\n') + '\n';
  fs.writeFileSync(CONFIG, body, { mode: 0o600 });
  fs.chmodSync(CONFIG, 0o600);
}

async function api(token, method, body) {
  const res = await fetch('https://api.telegram.org/bot' + token + '/' + method, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

(async () => {
  const args = process.argv.slice(2);

  if (args[0] === '--test') {
    const cfg = readConfig();
    if (!cfg.TELEGRAM_TOKEN || !cfg.TELEGRAM_CHAT_ID) {
      console.error('Not configured yet. Run: telegram-setup.js <bot-token>');
      process.exit(1);
    }
    const out = await api(cfg.TELEGRAM_TOKEN, 'sendMessage', {
      chat_id: cfg.TELEGRAM_CHAT_ID,
      text: '✅ <b>Daily Color Puzzle</b> is connected. Scores will appear here.',
      parse_mode: 'HTML',
    });
    console.log(out.ok ? 'Test message sent.' : 'Failed: ' + out.description);
    process.exit(out.ok ? 0 : 1);
  }

  const token = args[0];
  if (!token) {
    console.error('Usage: telegram-setup.js <bot-token> [--chat <id>]');
    process.exit(1);
  }

  const me = await api(token, 'getMe');
  if (!me.ok) { console.error('Bad token: ' + me.description); process.exit(1); }
  console.log('Bot: @' + me.result.username);

  let chatId = null;
  const flag = args.indexOf('--chat');
  if (flag !== -1 && args[flag + 1]) {
    chatId = args[flag + 1];
  } else {
    const updates = await api(token, 'getUpdates');
    if (!updates.ok) { console.error('getUpdates failed: ' + updates.description); process.exit(1); }
    const chats = [];
    for (const u of updates.result) {
      const m = u.message || u.channel_post || u.my_chat_member;
      if (m && m.chat) chats.push(m.chat);
    }
    if (chats.length === 0) {
      console.error('\nNo chats found. Send the bot a message first:');
      console.error('  - open https://t.me/' + me.result.username + ' and send /start');
      console.error('  - or add it to a group and post any message there');
      console.error('then run this again.');
      process.exit(2);
    }
    const chat = chats[chats.length - 1];
    chatId = String(chat.id);
    console.log('Chat: ' + chatId + ' (' + chat.type + ') ' + (chat.title || chat.username || chat.first_name || ''));
  }

  const cfg = readConfig();
  cfg.TELEGRAM_TOKEN = token;
  cfg.TELEGRAM_CHAT_ID = chatId;
  writeConfig(cfg);
  console.log('Wrote ' + CONFIG + ' (0600). Restart the API: pm2 restart dcp-api');
})();
