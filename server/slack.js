/*
 * Slack bot — announcements and a slash command.
 *
 * Two halves, each optional and independently configured:
 *
 *   1. Announcements. A daily solve worth announcing, and a finished battle,
 *      are posted to a channel. Either an incoming webhook (SLACK_WEBHOOK_URL)
 *      or a bot token plus channel (SLACK_BOT_TOKEN + SLACK_CHANNEL) will do.
 *   2. /puzzle, the slash command. Needs SLACK_SIGNING_SECRET, because every
 *      request Slack sends is signed and an unsigned one must be refused —
 *      the endpoint is public, and without the check anybody could post to it.
 *
 * Secrets live in the same file as the Telegram token, outside the repo.
 * Announcements are fire-and-forget with a short timeout: a slow Slack must
 * never delay a player's score submission.
 */
'use strict';

const fs = require('node:fs');
const { createHmac, timingSafeEqual } = require('node:crypto');

const CONFIG_PATH = process.env.DCP_CONFIG || '/etc/dailycolorpuzzle.env';
const DEFAULT_SITE = 'https://puzzle.landready.site/';
const TIMEOUT_MS = 5000;
// Slack signs a timestamp; anything older is a replay of a captured request.
const MAX_SKEW_S = 60 * 5;

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
    // No config file: Slack is simply off.
  }
  return cfg;
}

let config = loadConfig();

function reload() { config = loadConfig(); return status(); }
function canAnnounce() { return !!(config.SLACK_WEBHOOK_URL || (config.SLACK_BOT_TOKEN && config.SLACK_CHANNEL)); }
function canCommand() { return !!config.SLACK_SIGNING_SECRET; }
function status() { return { announce: canAnnounce(), command: canCommand() }; }
function siteUrl() { return config.SITE_URL || DEFAULT_SITE; }

/* ------------------------------------------------------------------ */
/* Message building                                                    */
/* ------------------------------------------------------------------ */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function prettyDay(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day));
  if (!m) return String(day);
  return Number(m[3]) + ' ' + MONTHS[Number(m[2]) - 1] + ' ' + m[1];
}

/* Slack renders a subset of markdown in mrkdwn text, so a nickname containing
   &, < or > has to be escaped or it will be read as markup. */
function esc(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fit(text, width) {
  const s = String(text);
  return s.length <= width ? s.padEnd(width) : s.slice(0, width - 1) + '…';
}

function formatMs(ms) {
  if (ms === null || ms === undefined) return '—';
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? m + 'm ' + (s < 10 ? '0' : '') + s + 's' : s + 's';
}

const MEDALS = ['🥇', '🥈', '🥉'];

function section(text) {
  return { type: 'section', text: { type: 'mrkdwn', text } };
}

function context(text) {
  return { type: 'context', elements: [{ type: 'mrkdwn', text }] };
}

function link(label, path) {
  const base = siteUrl().replace(/\/+$/, '/');
  return {
    type: 'actions',
    elements: [{
      type: 'button',
      text: { type: 'plain_text', text: label || '🎮 Play today’s puzzle', emoji: true },
      url: path ? base + path : base,
      style: 'primary',
    }],
  };
}

/* A solve worth announcing: who, how well, and where that put them. */
function composeSolve({ name, moves, rank, total, day, previous, board }) {
  const heading = rank === 1 ? '👑 *New leader*'
    : rank === 2 ? '🥈 *Second place*'
    : rank === 3 ? '🥉 *Third place*'
    : '🎯 *Solved*';

  const blocks = [
    section(heading + '\n*' + esc(name) + '* solved it in *' + moves + ' moves* — rank ' +
      rank + ' of ' + total + '.'),
  ];

  blocks.push(context(previous === null || previous === undefined
    ? '✨ First solve of the day'
    : '📈 Improved from ' + previous + ' moves'));

  const top = Array.isArray(board) ? board.slice(0, 3) : [];
  if (top.length > 1) {
    // A code block, because Slack has no table and proportional text would
    // stagger the numbers across different name lengths.
    const rows = top.map((r, i) =>
      MEDALS[i] + '  ' + fit(r.name, 14) + '  ' + String(r.moves).padStart(3) + ' mv');
    blocks.push(section('*Today’s podium*\n```' + esc(rows.join('\n')) + '```'));
  }

  blocks.push(context('📅 ' + prettyDay(day) + '  ·  👥 ' + total +
    ' player' + (total === 1 ? '' : 's')));
  blocks.push(link());

  return { text: name + ' solved the ' + prettyDay(day) + ' puzzle in ' + moves + ' moves', blocks };
}

/* A finished battle: who won, and how everyone placed. */
function composeBattle({ code, winner, players }) {
  const rows = (players || []).slice(0, 8).map((p) =>
    (p.place <= 3 ? MEDALS[p.place - 1] : '  ') + ' ' + String(p.place).padStart(2) + '  ' +
    fit(p.name, 14) + '  ' +
    (p.solved ? String(p.moves).padStart(3) + ' mv  ' + formatMs(p.ms) : 'did not finish'));

  return {
    text: (winner || 'Nobody') + ' won battle ' + code,
    blocks: [
      section('⚔️ *Battle over* — *' + esc(winner || 'nobody') + '* took it.'),
      section('```' + esc(rows.join('\n')) + '```'),
      context('🏷️ Battle ' + code),
      link('⚔️ Start a battle', 'battle.html'),
    ],
  };
}

/* ------------------------------------------------------------------ */
/* Sending                                                             */
/* ------------------------------------------------------------------ */

function post(message) {
  if (!canAnnounce()) return Promise.resolve(false);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const webhook = !!config.SLACK_WEBHOOK_URL;
  const url = webhook ? config.SLACK_WEBHOOK_URL : 'https://slack.com/api/chat.postMessage';
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  if (!webhook) headers.Authorization = 'Bearer ' + config.SLACK_BOT_TOKEN;
  const body = webhook ? message : Object.assign({ channel: config.SLACK_CHANNEL }, message);

  return fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal })
    .then(async (r) => {
      // A webhook answers "ok" in plain text; the Web API answers JSON.
      const text = await r.text();
      if (webhook) {
        if (text.trim() !== 'ok') console.error('slack rejected:', text.slice(0, 200));
        return text.trim() === 'ok';
      }
      let res = {};
      try { res = JSON.parse(text); } catch { /* not our problem to fix */ }
      if (!res.ok) console.error('slack rejected:', res.error || text.slice(0, 200));
      return !!res.ok;
    })
    .catch((err) => {
      if (err.name !== 'AbortError') console.error('slack failed:', err.message);
      return false;
    })
    .finally(() => clearTimeout(timer));
}

/* A connection check that reads sensibly in the channel, so verifying the
   hookup does not leave a fake score behind. */
function ping() {
  return post({
    text: 'Daily Color Puzzle is connected',
    blocks: [
      section('✅ *Daily Color Puzzle is connected.*\nSolves and battle results will be posted here.'),
      context('Try `/puzzle` for the standings, `/puzzle top` for the battle leaderboard, ' +
        '`/puzzle live` for battles in progress.'),
      link(),
    ],
  });
}

function announceSolve(payload) { return post(composeSolve(payload)); }
function announceBattle(payload) { return post(composeBattle(payload)); }

/* ------------------------------------------------------------------ */
/* Slash command                                                       */
/* ------------------------------------------------------------------ */

/* Slack signs every request: v0=HMAC-SHA256 over "v0:timestamp:body", keyed
   with the signing secret. Unsigned or stale requests are refused — this
   endpoint is reachable by anyone who finds the URL. */
function verify(headers, rawBody) {
  if (!canCommand()) return 'slack command is not configured';

  const given = String(headers['x-slack-signature'] || '');
  const stamp = String(headers['x-slack-request-timestamp'] || '');
  if (!given || !/^\d+$/.test(stamp)) return 'missing signature';

  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(stamp));
  if (age > MAX_SKEW_S) return 'stale request';

  const mine = 'v0=' + createHmac('sha256', config.SLACK_SIGNING_SECRET)
    .update('v0:' + stamp + ':' + rawBody)
    .digest('hex');

  const a = Buffer.from(mine);
  const b = Buffer.from(given);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return 'bad signature';
  return null;
}

function formEncoded(raw) {
  const out = {};
  for (const pair of String(raw).split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const k = decodeURIComponent((eq < 0 ? pair : pair.slice(0, eq)).replace(/\+/g, ' '));
    const v = eq < 0 ? '' : decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, ' '));
    out[k] = v;
  }
  return out;
}

/* The reply to a slash command. Ephemeral by default — one person asking for
   the standings should not necessarily post them to the whole channel. */
function reply(blocks, text, inChannel) {
  return {
    response_type: inChannel ? 'in_channel' : 'ephemeral',
    text: text,
    blocks,
  };
}

function helpBlocks() {
  return [
    section('*Daily Color Puzzle*'),
    section([
      '`/puzzle` — today’s standings',
      '`/puzzle top` — battle leaderboard, by wins',
      '`/puzzle live` — battles being played right now',
      '`/puzzle share` — post today’s standings to the channel',
    ].join('\n')),
    link(),
  ];
}

module.exports = function createSlack({ distribution, today, battles }) {

  function todayBlocks() {
    const day = today();
    const dist = distribution(day, null);
    if (!dist.total) {
      return [section('*' + prettyDay(day) + '* — nobody has solved it yet. Be first.'), link()];
    }
    const rows = dist.board.slice(0, 10).map((r) =>
      (r.rank <= 3 ? MEDALS[r.rank - 1] : '  ') + ' ' + String(r.rank).padStart(2) + '  ' +
      fit(r.name, 14) + '  ' + String(r.moves).padStart(3) + ' mv  ' + formatMs(r.ms));
    return [
      section('🧩 *' + prettyDay(day) + '*\n```' + esc(rows.join('\n')) + '```'),
      context('👥 ' + dist.total + ' player' + (dist.total === 1 ? '' : 's') +
        '  ·  🔁 ' + dist.attempts + ' attempt' + (dist.attempts === 1 ? '' : 's') +
        '  ·  ⭐ best ' + (dist.dayBest === null ? '—' : dist.dayBest + ' moves')),
      link(),
    ];
  }

  function topBlocks() {
    const rows = battles.ranking();
    if (!rows.length) return [section('No battles finished yet.'), link('⚔️ Start a battle', 'battle.html')];
    const lines = rows.slice(0, 10).map((r, i) =>
      (i < 3 ? MEDALS[i] : '  ') + ' ' + String(i + 1).padStart(2) + '  ' +
      fit(r.name, 14) + '  ' + String(r.wins).padStart(3) + ' won  ' +
      String(r.played).padStart(3) + ' played');
    return [
      section('⚔️ *Battle leaderboard* — all-time wins\n```' + esc(lines.join('\n')) + '```'),
      link('⚔️ Start a battle', 'battle.html'),
    ];
  }

  function liveBlocks() {
    const live = battles.live();
    if (!live.length) return [section('Nothing being played right now.'), link('⚔️ Start a battle', 'battle.html')];
    const lines = live.slice(0, 10).map((b) =>
      fit(b.code, 6) + '  ' +
      b.players.map((p) => p.name + ' (' + p.moves + ')').join(' vs ').slice(0, 60));
    return [
      section('🔴 *Live now*\n```' + esc(lines.join('\n')) + '```'),
      link('👀 Watch', 'battle.html'),
    ];
  }

  function handle(req, res, url, rawBody, send) {
    if (url.pathname !== '/api/slack/command') return false;
    if (req.method !== 'POST') { send(res, 405, { error: 'use POST' }); return true; }

    const bad = verify(req.headers, rawBody);
    if (bad) {
      console.error('slack command refused:', bad);
      // Deliberately terse: a prober learns nothing about which check failed.
      send(res, 401, { error: 'unauthorized' });
      return true;
    }

    const form = formEncoded(rawBody);
    const arg = String(form.text || '').trim().toLowerCase().split(/\s+/)[0];

    let body;
    if (arg === 'top' || arg === 'wins') body = reply(topBlocks(), 'Battle leaderboard', false);
    else if (arg === 'live' || arg === 'now') body = reply(liveBlocks(), 'Live battles', false);
    else if (arg === 'share') body = reply(todayBlocks(), 'Today’s standings', true);
    else if (arg === 'help' || arg === '?') body = reply(helpBlocks(), 'Daily Color Puzzle', false);
    else body = reply(todayBlocks(), 'Today’s standings', false);

    send(res, 200, body);
    return true;
  }

  return {
    handle, announceSolve, announceBattle, ping, status, reload, siteUrl,
    composeSolve, composeBattle, verify, configPath: CONFIG_PATH,
  };
};
