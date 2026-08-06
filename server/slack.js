/*
 * Slack bot — announcements and a slash command.
 *
 * Three halves, each optional and independently configured:
 *
 *   1. Announcements. A daily solve worth announcing, and a finished battle,
 *      are posted to every workspace that installed the app, plus a single
 *      hard-configured channel if SLACK_WEBHOOK_URL is set.
 *   2. /puzzle, the slash command. Needs SLACK_SIGNING_SECRET, because every
 *      request Slack sends is signed and an unsigned one must be refused —
 *      the endpoint is public, and without the check anybody could post to it.
 *   3. OAuth install, which is what public distribution requires: a workspace
 *      clicks Add to Slack, Slack sends a code, and we trade it for that
 *      workspace's own webhook and bot token. One signing secret covers every
 *      install, because it belongs to the app rather than the installation.
 *
 * Secrets live in the same file as the Telegram token, outside the repo.
 * Announcements are fire-and-forget with a short timeout: a slow Slack must
 * never delay a player's score submission.
 */
'use strict';

const fs = require('node:fs');
const { createHmac, randomBytes, timingSafeEqual } = require('node:crypto');

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

function reload() { config = loadConfig(); return canAnnounce(); }
function canAnnounce() { return !!(config.SLACK_WEBHOOK_URL || (config.SLACK_BOT_TOKEN && config.SLACK_CHANNEL)); }
function canCommand() { return !!config.SLACK_SIGNING_SECRET; }
function canInstall() { return !!(config.SLACK_CLIENT_ID && config.SLACK_CLIENT_SECRET); }
// commands is what the slash command needs; incoming-webhook gives each
// install its own channel to post into without asking for chat:write.
function scopes() { return config.SLACK_SCOPES || 'commands,incoming-webhook'; }
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
  // Fewest moves wins, so the headline says what actually won it.
  const best = (players || []).find((p) => p.place === 1 && p.solved);
  const rows = (players || []).slice(0, 8).map((p) =>
    (p.place <= 3 ? MEDALS[p.place - 1] : '  ') + ' ' + String(p.place).padStart(2) + '  ' +
    fit(p.name, 14) + '  ' +
    (p.solved ? String(p.moves).padStart(3) + ' mv  ' + formatMs(p.ms) : 'did not finish'));

  return {
    text: (winner || 'Nobody') + ' won battle ' + code,
    blocks: [
      section('⚔️ *Battle over* — *' + esc(winner || 'nobody') + '* took it' +
        (best ? ' with ' + best.moves + ' moves' : '') + '.'),
      section('```' + esc(rows.join('\n')) + '```'),
      context('🏷️ Battle ' + code),
      link('⚔️ Start a battle', 'battle.html'),
    ],
  };
}

/* ------------------------------------------------------------------ */
/* Sending                                                             */
/* ------------------------------------------------------------------ */

/* One destination: either a webhook URL, or a bot token plus a channel. Every
   caller goes through here so a workspace-specific target and the configured
   one behave identically. */
function postTo(target, message, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const webhook = !!target.webhook;
  const url = webhook ? target.url : 'https://slack.com/api/chat.postMessage';
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  if (!webhook) headers.Authorization = 'Bearer ' + target.token;
  const body = webhook ? message : Object.assign({ channel: target.channel }, message);
  const who = label ? ' [' + label + ']' : '';

  return fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal })
    .then(async (r) => {
      // A webhook answers "ok" in plain text; the Web API answers JSON.
      const text = await r.text();
      if (webhook) {
        if (text.trim() !== 'ok') console.error('slack rejected' + who + ':', text.slice(0, 200));
        return text.trim() === 'ok';
      }
      let res = {};
      try { res = JSON.parse(text); } catch { /* not our problem to fix */ }
      if (!res.ok) console.error('slack rejected' + who + ':', res.error || text.slice(0, 200));
      return !!res.ok;
    })
    .catch((err) => {
      if (err.name !== 'AbortError') console.error('slack failed' + who + ':', err.message);
      return false;
    })
    .finally(() => clearTimeout(timer));
}

function post(message) {
  if (!canAnnounce()) return Promise.resolve(false);
  return config.SLACK_WEBHOOK_URL
    ? postTo({ url: config.SLACK_WEBHOOK_URL, webhook: true }, message)
    : postTo({ token: config.SLACK_BOT_TOKEN, channel: config.SLACK_CHANNEL }, message);
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

module.exports = function createSlack({ db, distribution, today, battles }) {

  /* One row per workspace that installed the app. Slack hands over a webhook
     and a bot token at install time; both are that workspace's, so they are
     stored rather than configured. */
  if (db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS slack_installs (
        team      TEXT PRIMARY KEY,
        team_name TEXT,
        bot_token TEXT,
        bot_user  TEXT,
        webhook   TEXT,
        channel   TEXT,
        installed INTEGER NOT NULL
      );
    `);
  }

  const q = db ? {
    save: db.prepare(
      `INSERT INTO slack_installs (team, team_name, bot_token, bot_user, webhook, channel, installed)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (team) DO UPDATE SET
         team_name = excluded.team_name, bot_token = excluded.bot_token,
         bot_user = excluded.bot_user, webhook = excluded.webhook,
         channel = excluded.channel, installed = excluded.installed`),
    all: db.prepare('SELECT * FROM slack_installs'),
    drop: db.prepare('DELETE FROM slack_installs WHERE team = ?'),
    count: db.prepare('SELECT COUNT(*) AS n FROM slack_installs'),
  } : null;

  function status() {
    return {
      announce: canAnnounce(), command: canCommand(), install: canInstall(),
      workspaces: installCount(),
    };
  }

  function installs() { return q ? q.all.all() : []; }
  function installCount() { return q ? Number(q.count.get().n) : 0; }

  /* Announce to every install, and to the single configured channel if there
     is one. Failures are per-workspace: one dead webhook must not stop the
     others, and none of it may delay the player who triggered it. */
  function fanOut(message) {
    const jobs = [];
    if (canAnnounce()) jobs.push(post(message));
    for (const row of installs()) {
      if (row.webhook) jobs.push(postTo({ url: row.webhook, webhook: true }, message, row.team));
      else if (row.bot_token && row.channel) {
        jobs.push(postTo({ token: row.bot_token, channel: row.channel }, message, row.team));
      }
    }
    return Promise.all(jobs).then((r) => r.filter(Boolean).length);
  }


  function announceSolve(payload) { return fanOut(composeSolve(payload)); }
  function announceBattle(payload) { return fanOut(composeBattle(payload)); }

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

  /* ---------------------------------------------------------------- */
  /* OAuth install                                                     */
  /* ---------------------------------------------------------------- */

  /* Short-lived one-time values, so a callback can be tied to an install we
     actually started. Slack returns state untouched; without checking it, a
     stranger could hand us a code of their choosing. */
  const pending = new Map();

  function newState() {
    const value = randomBytes(16).toString('hex');
    pending.set(value, Date.now() + 10 * 60e3);
    // Cheap sweep: this map only ever holds installs started in the last while.
    for (const [k, expiry] of pending) if (expiry < Date.now()) pending.delete(k);
    return value;
  }

  function takeState(value) {
    if (!value || !pending.has(value)) return false;
    const ok = pending.get(value) >= Date.now();
    pending.delete(value);
    return ok;
  }

  function redirectUri() {
    return config.SLACK_REDIRECT_URI ||
      siteUrl().replace(/\/+$/, '') + '/api/slack/callback';
  }

  function page(res, code, title, body) {
    const html = '<!doctype html><meta charset="utf-8"><title>' + title +
      '</title><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<style>body{margin:0;min-height:100vh;display:grid;place-items:center;' +
      'background:#030711;color:#d6f2ff;font:16px/1.6 system-ui,sans-serif;text-align:center;padding:24px}' +
      'main{max-width:34rem}h1{color:#22e0ff;font-size:20px;letter-spacing:.08em;text-transform:uppercase}' +
      'a{color:#22e0ff}</style><main><h1>' + title + '</h1>' + body + '</main>';
    res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
  }

  function handleInstall(req, res, url, send) {
    if (!canInstall()) { send(res, 503, { error: 'installs are not configured' }); return; }
    const target = new URL('https://slack.com/oauth/v2/authorize');
    target.searchParams.set('client_id', config.SLACK_CLIENT_ID);
    target.searchParams.set('scope', scopes());
    target.searchParams.set('redirect_uri', redirectUri());
    target.searchParams.set('state', newState());
    res.writeHead(302, { Location: target.toString(), 'Cache-Control': 'no-store' });
    res.end();
  }

  async function handleCallback(req, res, url, send) {
    if (!canInstall()) { send(res, 503, { error: 'installs are not configured' }); return; }

    const err = url.searchParams.get('error');
    if (err) { page(res, 400, 'Install cancelled', '<p>Slack said: ' + esc(err) + '</p>'); return; }
    if (!takeState(url.searchParams.get('state'))) {
      page(res, 400, 'Install failed', '<p>That install link has expired. Start again from the top.</p>');
      return;
    }
    const code = url.searchParams.get('code');
    if (!code) { page(res, 400, 'Install failed', '<p>Slack sent no code.</p>'); return; }

    const form = new URLSearchParams({
      code,
      client_id: config.SLACK_CLIENT_ID,
      client_secret: config.SLACK_CLIENT_SECRET,
      redirect_uri: redirectUri(),
    });

    let data = {};
    try {
      const r = await fetch('https://slack.com/api/oauth.v2.access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      });
      data = await r.json();
    } catch (e) {
      console.error('slack oauth failed:', e.message);
      page(res, 502, 'Install failed', '<p>Could not reach Slack. Try again in a moment.</p>');
      return;
    }

    if (!data.ok) {
      console.error('slack oauth rejected:', data.error);
      page(res, 400, 'Install failed', '<p>Slack refused the install: ' + esc(data.error || 'unknown') + '</p>');
      return;
    }

    const team = (data.team && data.team.id) || data.team_id;
    const hook = data.incoming_webhook || {};
    if (q) {
      q.save.run(
        team,
        (data.team && data.team.name) || null,
        data.access_token || null,
        data.bot_user_id || null,
        hook.url || null,
        hook.channel || null,
        Date.now()
      );
    }
    console.log('slack installed for team', team, (data.team && data.team.name) || '');

    page(res, 200, 'Installed',
      '<p><b>Daily Color Puzzle</b> is connected to ' +
      esc((data.team && data.team.name) || 'your workspace') +
      (hook.channel ? ' in ' + esc(hook.channel) : '') + '.</p>' +
      '<p>Solves and battle results will be posted there. Type <code>/puzzle</code> for the standings.</p>' +
      '<p><a href="' + esc(siteUrl()) + '">Play the puzzle</a></p>');
  }

  /* Slack tells us when a workspace removes the app. Without this the install
     row lingers and every announcement keeps posting into the void. */
  function handleEvents(req, res, rawBody, send) {
    const bad = verify(req.headers, rawBody);
    if (bad) { console.error('slack event refused:', bad); send(res, 401, { error: 'unauthorized' }); return; }

    let body = {};
    try { body = JSON.parse(rawBody || '{}'); } catch { send(res, 400, { error: 'bad json' }); return; }

    // Slack proves it owns the endpoint by asking us to echo a challenge.
    if (body.type === 'url_verification') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(String(body.challenge || ''));
      return;
    }

    const kind = body.event && body.event.type;
    if ((kind === 'app_uninstalled' || kind === 'tokens_revoked') && body.team_id && q) {
      const gone = q.drop.run(body.team_id);
      if (gone.changes) console.log('slack uninstalled for team', body.team_id);
    }
    send(res, 200, { ok: true });
  }

  function handle(req, res, url, rawBody, send) {
    if (url.pathname === '/api/slack/install' && req.method === 'GET') {
      handleInstall(req, res, url, send); return true;
    }
    if (url.pathname === '/api/slack/callback' && req.method === 'GET') {
      handleCallback(req, res, url, send); return true;
    }
    if (url.pathname === '/api/slack/events' && req.method === 'POST') {
      handleEvents(req, res, rawBody, send); return true;
    }
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
    installs, installCount, installUrl: () => siteUrl().replace(/\/+$/, '') + '/api/slack/install',
    composeSolve, composeBattle, verify, configPath: CONFIG_PATH,
  };
};
