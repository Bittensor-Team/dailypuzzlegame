/*
 * Telegram announcements.
 *
 * The bot token stays on the server. It is never sent to a browser and never
 * committed: it is read from a config file outside the repo (see
 * DCP_CONFIG, default /etc/dailycolorpuzzle.env).
 *
 * Every call is fire-and-forget with a short timeout. A slow or broken
 * Telegram must never delay or fail a player's score submission.
 */
'use strict';

const fs = require('node:fs');

const CONFIG_PATH = process.env.DCP_CONFIG || '/etc/dailycolorpuzzle.env';
const DEFAULT_SITE = 'http://65.109.81.250:8080/';

function loadConfig() {
  const cfg = {};
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 1) continue;
      cfg[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
  } catch {
    // No config file: announcements are simply off.
  }
  return cfg;
}

let config = loadConfig();
function reload() { config = loadConfig(); return enabled(); }
function enabled() { return !!(config.TELEGRAM_TOKEN && config.TELEGRAM_CHAT_ID); }
function siteUrl() { return config.SITE_URL || DEFAULT_SITE; }

// Nicknames are player-supplied, so they are escaped before going into HTML.
function esc(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function prettyDay(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day));
  if (!m) return String(day);
  return Number(m[3]) + ' ' + MONTHS[Number(m[2]) - 1] + ' ' + m[1];
}

// Trim a nickname so the podium table cannot be knocked out of alignment.
function fit(text, width) {
  const s = String(text);
  return s.length <= width ? s.padEnd(width) : s.slice(0, width - 1) + '…';
}

const HEADINGS = {
  1: { icon: '👑', title: 'NEW LEADER', medal: '🥇' },
  2: { icon: '🥈', title: 'SECOND PLACE', medal: '🥈' },
  3: { icon: '🥉', title: 'THIRD PLACE', medal: '🥉' },
};

/*
 * A structured card rather than a sentence: a banner, the player's own result
 * as an aligned block, the podium, and a footer. Monospace blocks are used for
 * anything columnar — Telegram has no tables, and <pre> is the only way to keep
 * numbers lined up across different name lengths.
 */
function compose({ name, moves, rank, total, day, previous, board }) {
  const head = HEADINGS[rank] || { icon: '🎯', title: 'SOLVED', medal: '▫️' };
  const rule = '━━━━━━━━━━━━━━━━━━━━';

  const lines = [];
  lines.push(head.icon + ' <b>' + head.title + '</b> ' + head.icon);
  lines.push(rule);

  // The player's result
  lines.push(head.medal + ' <b>' + esc(name) + '</b>');
  lines.push('<pre>' + [
    'Moves   ' + String(moves),
    'Rank    ' + rank + ' of ' + total,
  ].join('\n') + '</pre>');

  if (previous !== null && previous !== undefined) {
    lines.push('📈 <i>Improved from ' + previous + ' moves</i>');
  } else {
    lines.push('✨ <i>First solve of the day</i>');
  }

  // Podium, when there is a field worth showing
  const top = Array.isArray(board) ? board.slice(0, 3) : [];
  if (top.length > 1) {
    lines.push(rule);
    lines.push('<b>Today&#39;s podium</b>');
    const medals = ['🥇', '🥈', '🥉'];
    const rows = top.map((r, i) =>
      medals[i] + '  ' + fit(r.name, 14) + '  ' + String(r.moves).padStart(3) + ' mv');
    lines.push('<pre>' + esc(rows.join('\n')) + '</pre>');
  }

  lines.push(rule);
  lines.push('📅 ' + esc(prettyDay(day)) + '  ·  👥 ' + total + ' player' + (total === 1 ? '' : 's'));

  return lines.join('\n');
}

function keyboard() {
  return {
    inline_keyboard: [[
      { text: '🎮 Play today’s puzzle', url: siteUrl() },
    ]],
  };
}

function send(payload) {
  if (!enabled()) return;

  const body = JSON.stringify({
    chat_id: config.TELEGRAM_CHAT_ID,
    text: compose(payload),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: keyboard(),
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);

  fetch('https://api.telegram.org/bot' + config.TELEGRAM_TOKEN + '/sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: controller.signal,
  })
    .then((r) => r.json())
    .then((res) => { if (!res.ok) console.error('telegram rejected:', res.description); })
    .catch((err) => { if (err.name !== 'AbortError') console.error('telegram failed:', err.message); })
    .finally(() => clearTimeout(timer));
}

module.exports = { send, enabled, reload, compose, keyboard, siteUrl, configPath: CONFIG_PATH };
