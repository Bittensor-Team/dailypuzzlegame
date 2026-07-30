/*
 * Daily Color Puzzle — scoreboard API with password accounts.
 *
 * Two things are never trusted from the client:
 *   1. Identity. A score is accepted only with a valid session token, which
 *      is issued in exchange for a nickname and password.
 *   2. The score itself. The client sends its move sequence and the server
 *      replays it against the board it generates for that date, counting
 *      pours and replaying undos. A forged score costs a real solve.
 *
 * No dependencies: node:sqlite, node:http and node:crypto only.
 */
'use strict';

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const { randomBytes, randomUUID, scryptSync, timingSafeEqual } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

// Server-only: the browser never receives the generator or the solver.
const game = require('./puzzle.js');
const telegram = require('./telegram.js');

const PORT = Number(process.env.PORT || 8791);
const HOST = process.env.HOST || '127.0.0.1';
const DB_DIR = process.env.DCP_DB_DIR || '/var/lib/dailycolorpuzzle';
const MAX_BODY = 256 * 1024;
const SESSION_DAYS = 180;

fs.mkdirSync(DB_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DB_DIR, 'scores.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS scores (
    player  TEXT    NOT NULL,
    day     TEXT    NOT NULL,
    moves   INTEGER NOT NULL,
    updated INTEGER NOT NULL,
    PRIMARY KEY (player, day)
  );
  CREATE INDEX IF NOT EXISTS scores_by_day ON scores (day, moves);
  CREATE TABLE IF NOT EXISTS players (
    player     TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    name_lower TEXT NOT NULL,
    updated    INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS players_name ON players (name_lower);
  CREATE TABLE IF NOT EXISTS sessions (
    token   TEXT PRIMARY KEY,
    player  TEXT NOT NULL,
    created INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_by_player ON sessions (player);
`);

// Password columns are added in place so an existing players table survives.
const columns = db.prepare('PRAGMA table_info(players)').all().map((c) => c.name);
if (!columns.includes('pass_hash')) db.exec('ALTER TABLE players ADD COLUMN pass_hash TEXT');
if (!columns.includes('pass_salt')) db.exec('ALTER TABLE players ADD COLUMN pass_salt TEXT');

const insertScore = db.prepare(
  `INSERT INTO scores (player, day, moves, updated) VALUES (?, ?, ?, ?)
   ON CONFLICT (player, day) DO UPDATE SET
     moves = MIN(scores.moves, excluded.moves),
     updated = excluded.updated`
);
const selectBest = db.prepare('SELECT moves FROM scores WHERE player = ? AND day = ?');
const selectCounts = db.prepare(
  'SELECT moves, COUNT(*) AS users FROM scores WHERE day = ? GROUP BY moves ORDER BY moves'
);
const selectBoard = db.prepare(
  `SELECT s.player, s.moves, p.name
     FROM scores s JOIN players p ON p.player = s.player
    WHERE s.day = ?
    ORDER BY s.moves ASC, s.updated ASC
    LIMIT 100`
);
const selectByName = db.prepare('SELECT * FROM players WHERE name_lower = ?');
const selectPlayer = db.prepare('SELECT player, name FROM players WHERE player = ?');
const insertPlayer = db.prepare(
  'INSERT INTO players (player, name, name_lower, pass_hash, pass_salt, updated) VALUES (?, ?, ?, ?, ?, ?)'
);
const insertSession = db.prepare('INSERT INTO sessions (token, player, created) VALUES (?, ?, ?)');
const selectSession = db.prepare('SELECT player, created FROM sessions WHERE token = ?');
const deleteSession = db.prepare('DELETE FROM sessions WHERE token = ?');
const selectPlayerFull = db.prepare('SELECT * FROM players WHERE player = ?');
const updatePassword = db.prepare(
  'UPDATE players SET pass_hash = ?, pass_salt = ?, updated = ? WHERE player = ?'
);
const deleteOtherSessions = db.prepare('DELETE FROM sessions WHERE player = ? AND token <> ?');

/* ------------------------------------------------------------------ */
/* Credentials                                                         */
/* ------------------------------------------------------------------ */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TOKEN_RE = /^[a-f0-9]{64}$/;

function cleanName(raw) {
  if (typeof raw !== 'string') return null;
  const name = raw.trim().replace(/\s+/g, ' ');
  if (name.length < 1 || name.length > 24) return null;
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c < 0x20 || c === 0x7f || (c >= 0x80 && c <= 0x9f)) return null;
  }
  return name;
}

function hashPassword(password, saltHex) {
  return scryptSync(password, Buffer.from(saltHex, 'hex'), 64).toString('hex');
}

function passwordMatches(row, password) {
  if (!row.pass_hash || !row.pass_salt) return false;
  const want = Buffer.from(row.pass_hash, 'hex');
  const got = Buffer.from(hashPassword(password, row.pass_salt), 'hex');
  // Constant-time, so a wrong password cannot be found byte by byte.
  return want.length === got.length && timingSafeEqual(want, got);
}

function startSession(player) {
  const token = randomBytes(32).toString('hex');
  insertSession.run(token, player, Date.now());
  return token;
}

function playerForToken(token) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
  const row = selectSession.get(token);
  if (!row) return null;
  if (Date.now() - Number(row.created) > SESSION_DAYS * 24 * 3600e3) {
    deleteSession.run(token);
    return null;
  }
  return String(row.player);
}

/* ------------------------------------------------------------------ */
/* Board verification                                                  */
/* ------------------------------------------------------------------ */

const boardCache = new Map();
function boardFor(day) {
  if (!boardCache.has(day)) {
    if (boardCache.size > 400) boardCache.clear();
    boardCache.set(day, game.generate('dcp-' + day));
  }
  return boardCache.get(day);
}

function verify(day, actions) {
  if (!Array.isArray(actions)) return 'moves must be an array';
  if (actions.length < 1 || actions.length > 8000) return 'implausible move count';

  let tubes = game.clone(boardFor(day));
  const undoStack = [];
  let pours = 0;

  for (let i = 0; i < actions.length; i++) {
    const a = actions[i];
    if (!a || typeof a !== 'object') return 'malformed move ' + i;

    if (a.u === 1) {
      if (undoStack.length === 0) return 'undo with nothing to undo at ' + i;
      tubes = undoStack.pop();
      continue;
    }

    if (!Number.isInteger(a.from) || !Number.isInteger(a.to)) return 'malformed move ' + i;
    if (a.from < 0 || a.from >= tubes.length || a.to < 0 || a.to >= tubes.length) {
      return 'out-of-range move ' + i;
    }
    undoStack.push(game.clone(tubes));
    if (game.pour(tubes, a.from, a.to) === 0) return 'illegal move ' + i;
    pours += 1;
  }

  if (pours < 1) return 'implausible move count';
  if (!game.isSolved(tubes)) return 'move sequence does not solve the puzzle';
  return pours;
}

function isoUtcDay() {
  return new Date().toISOString().slice(0, 10);
}

/*
 * The puzzle day is UTC for every player, so the open board is simply today in
 * UTC. A small skew is allowed for clients whose clock runs slightly fast,
 * which would otherwise 403 them for a few seconds around midnight.
 */
const CLOCK_SKEW_MS = 2 * 60 * 1000;

function maxOpenDay() {
  return new Date(Date.now() + CLOCK_SKEW_MS).toISOString().slice(0, 10);
}

function plausibleDay(day) {
  if (!DATE_RE.test(day)) return false;
  const t = Date.parse(day + 'T00:00:00Z');
  if (Number.isNaN(t)) return false;
  const now = Date.now();
  return t <= now + CLOCK_SKEW_MS && t >= now - 365 * 24 * 3600e3;
}

/* ------------------------------------------------------------------ */
/* Rate limiting                                                       */
/* ------------------------------------------------------------------ */

const hits = new Map();
function rateLimited(key, limit) {
  const win = Math.floor(Date.now() / 60000);
  const rec = hits.get(key);
  if (!rec || rec.win !== win) {
    if (hits.size > 5000) hits.clear();
    hits.set(key, { win, n: 1 });
    return false;
  }
  rec.n += 1;
  return rec.n > limit;
}

/* ------------------------------------------------------------------ */
/* Responses                                                           */
/* ------------------------------------------------------------------ */

function distribution(day, player) {
  const counts = selectCounts.all(day).map((r) => ({ moves: Number(r.moves), users: Number(r.users) }));
  const total = counts.reduce((n, c) => n + c.users, 0);

  let best = null;
  if (player) {
    const row = selectBest.get(player, day);
    if (row) best = Number(row.moves);
  }

  let rank = null;
  let betterThan = null;
  if (best !== null && total > 0) {
    rank = counts.reduce((n, c) => n + (c.moves < best ? c.users : 0), 0) + 1;
    const worse = counts.reduce((n, c) => n + (c.moves > best ? c.users : 0), 0);
    betterThan = Math.round((100 * worse) / total);
  }

  // Competition ranking: equal scores share the better rank, and the next
  // distinct score skips ahead (1, 1, 3). This has to match the rank shown on
  // the dial, which is computed the same way — otherwise a tied leader sees
  // "#1" beside a silver badge.
  let lastMoves = null;
  let lastRank = 0;
  const board = selectBoard.all(day).map((r, i) => {
    const moves = Number(r.moves);
    if (moves !== lastMoves) { lastRank = i + 1; lastMoves = moves; }
    return {
      rank: lastRank,
      name: r.name,
      moves,
      you: player ? r.player === player : false,
    };
  });

  const me = player ? selectPlayer.get(player) : null;

  return { day, total, counts, best, rank, betterThan, board, name: me ? me.name : null };
}

function send(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket.remoteAddress || 'unknown';
  if (rateLimited('req:' + ip, 120)) return send(res, 429, { error: 'slow down' });

  let url;
  try { url = new URL(req.url, 'http://localhost'); }
  catch { return send(res, 400, { error: 'bad request' }); }

  const post = req.method === 'POST';
  let body = {};
  if (post) {
    try { body = JSON.parse((await readBody(req)) || '{}'); }
    catch { return send(res, 400, { error: 'bad json' }); }
  }

  if (req.method === 'GET' && url.pathname === '/api/health') {
    return send(res, 200, { ok: true });
  }

  /* -- accounts -- */

  if (post && url.pathname === '/api/register') {
    if (rateLimited('auth:' + ip, 10)) return send(res, 429, { error: 'Too many attempts. Wait a minute.' });

    const name = cleanName(body.name);
    if (name === null) return send(res, 400, { error: 'Pick a nickname of 1 to 24 characters.' });
    const password = typeof body.password === 'string' ? body.password : '';
    if (password.length < 8) return send(res, 400, { error: 'Password must be at least 8 characters.' });
    if (password.length > 200) return send(res, 400, { error: 'Password is too long.' });

    if (selectByName.get(name.toLowerCase())) {
      return send(res, 409, { error: 'That nickname is taken. Sign in, or pick another.' });
    }

    const player = randomUUID();
    const salt = randomBytes(16).toString('hex');
    try {
      insertPlayer.run(player, name, name.toLowerCase(), hashPassword(password, salt), salt, Date.now());
    } catch {
      return send(res, 409, { error: 'That nickname is taken. Sign in, or pick another.' });
    }

    const token = startSession(player);
    const day = plausibleDay(String(body.date || '')) ? String(body.date) : isoUtcDay();
    return send(res, 200, Object.assign({ token, name }, distribution(day, player)));
  }

  if (post && url.pathname === '/api/login') {
    if (rateLimited('auth:' + ip, 10)) return send(res, 429, { error: 'Too many attempts. Wait a minute.' });

    const name = cleanName(body.name);
    const password = typeof body.password === 'string' ? body.password : '';
    const row = name === null ? null : selectByName.get(name.toLowerCase());

    // One message for both cases, so this cannot be used to discover which
    // nicknames exist.
    if (!row || !passwordMatches(row, password)) {
      return send(res, 401, { error: 'Wrong nickname or password.' });
    }

    const token = startSession(String(row.player));
    const day = plausibleDay(String(body.date || '')) ? String(body.date) : isoUtcDay();
    return send(res, 200, Object.assign({ token, name: row.name }, distribution(day, String(row.player))));
  }

  if (post && url.pathname === '/api/password') {
    if (rateLimited('auth:' + ip, 10)) return send(res, 429, { error: 'Too many attempts. Wait a minute.' });

    const player = playerForToken(body.token);
    if (!player) return send(res, 401, { error: 'Sign in first.' });

    const row = selectPlayerFull.get(player);
    const current = typeof body.current === 'string' ? body.current : '';
    if (!row || !passwordMatches(row, current)) {
      return send(res, 401, { error: 'Current password is wrong.' });
    }

    const next = typeof body.next === 'string' ? body.next : '';
    if (next.length < 8) return send(res, 400, { error: 'New password must be at least 8 characters.' });
    if (next.length > 200) return send(res, 400, { error: 'New password is too long.' });

    const salt = randomBytes(16).toString('hex');
    updatePassword.run(hashPassword(next, salt), salt, Date.now(), player);
    // Every other session is dropped, so a leaked password stops working
    // everywhere except here.
    deleteOtherSessions.run(player, body.token);
    return send(res, 200, { ok: true });
  }

  if (post && url.pathname === '/api/logout') {
    if (typeof body.token === 'string' && TOKEN_RE.test(body.token)) deleteSession.run(body.token);
    return send(res, 200, { ok: true });
  }

  /* -- scores -- */

  /* The dealt board for a date. Today or earlier only, so tomorrow's puzzle
     cannot be fetched ahead of time. */
  if (req.method === 'GET' && url.pathname === '/api/board') {
    const day = url.searchParams.get('date') || '';
    if (!plausibleDay(day)) return send(res, 400, { error: 'bad date' });
    if (day > maxOpenDay()) return send(res, 403, { error: 'that board is not open yet' });
    return send(res, 200, { day, tubes: boardFor(day) });
  }

  if (req.method === 'GET' && url.pathname === '/api/scores') {
    const day = url.searchParams.get('date') || '';
    if (!plausibleDay(day)) return send(res, 400, { error: 'bad date' });
    const player = playerForToken(url.searchParams.get('token') || '');
    return send(res, 200, Object.assign({ signedIn: !!player }, distribution(day, player)));
  }

  if (post && url.pathname === '/api/scores') {
    const player = playerForToken(body.token);
    if (!player) return send(res, 401, { error: 'Sign in before submitting a score.' });

    const day = String(body.date || '');
    if (!plausibleDay(day)) return send(res, 400, { error: 'bad date' });

    const verified = verify(day, body.moves);
    if (typeof verified === 'string') return send(res, 400, { error: verified });

    // What the player held before this run, so the announcement can say
    // whether they improved on themselves.
    const previousRow = selectBest.get(player, day);
    const previous = previousRow ? Number(previousRow.moves) : null;

    insertScore.run(player, day, verified, Date.now());
    const dist = distribution(day, player);

    // Announce only genuine improvements — a repeat submission of a worse run
    // would otherwise spam the channel.
    if (previous === null || verified < previous) {
      const me = selectPlayer.get(player);
      telegram.send({
        name: me ? me.name : 'A player',
        moves: verified,
        rank: dist.rank,
        total: dist.total,
        day,
        previous,
        board: dist.board,
      });
    }

    return send(res, 200, Object.assign({ accepted: verified, signedIn: true }, dist));
  }

  send(res, 404, { error: 'not found' });
});

server.listen(PORT, HOST, () => {
  console.log('scoreboard api on http://' + HOST + ':' + PORT);
});
