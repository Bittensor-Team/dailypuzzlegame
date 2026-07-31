/*
 * Live battles — duels and multiplayer races on a freshly dealt board.
 *
 * Unlike the daily puzzle, a battle board is generated the moment the battle
 * starts and never repeats. Every board, every player and every single move is
 * written to the database, so a finished battle can be replayed move by move
 * long after the room is gone.
 *
 * Authority lives here. The browser sends "pour tube 3 into tube 7" and this
 * file decides whether that is legal, applies it to the state it holds, and
 * broadcasts the result. A client cannot invent a solved board, because the
 * server never reads a board from a client.
 *
 * Live state is kept in memory for speed and mirrored to SQLite for durability.
 * If the process restarts mid-battle, rooms are rebuilt by replaying the stored
 * moves, so an in-flight duel survives a deploy.
 */
'use strict';

const { randomUUID, randomInt } = require('node:crypto');

/* Ambiguous glyphs are left out: no O/0, no I/1. Codes get read aloud and
   typed by hand, so 0 and O being distinct on screen is not enough. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 5;

const MIN_SIZE = 2;
const MAX_SIZE = 8;
const COUNTDOWN_MS = 3000;      // the "3, 2, 1" before anyone may move
const OPEN_TTL_MS = 30 * 60e3;  // an unstarted room is swept after this
const GONE_MS = 45e3;           // no socket for this long counts as departed
const HEARTBEAT_MS = 20e3;      // keeps proxies from closing an idle stream

module.exports = function createBattles({ db, game, playerForToken, nameOf }) {

  db.exec(`
    CREATE TABLE IF NOT EXISTS battles (
      battle  TEXT PRIMARY KEY,
      code    TEXT NOT NULL,
      tubes   TEXT NOT NULL,
      par     INTEGER,
      host    TEXT NOT NULL,
      size    INTEGER NOT NULL,
      mode    TEXT NOT NULL,
      status  TEXT NOT NULL,
      created INTEGER NOT NULL,
      started INTEGER,
      ended   INTEGER,
      winner  TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS battles_code ON battles (code);
    CREATE INDEX IF NOT EXISTS battles_status ON battles (status, created);

    CREATE TABLE IF NOT EXISTS battle_players (
      battle TEXT    NOT NULL,
      player TEXT    NOT NULL,
      joined INTEGER NOT NULL,
      moves  INTEGER NOT NULL DEFAULT 0,
      ms     INTEGER,
      place  INTEGER,
      PRIMARY KEY (battle, player)
    );
    CREATE INDEX IF NOT EXISTS battle_players_by_player ON battle_players (player);

    /* One row per pour. An undo is stored as its own row with src = -1 so the
       history stays append-only and a replay can show the mistake too. */
    CREATE TABLE IF NOT EXISTS battle_moves (
      id     INTEGER PRIMARY KEY AUTOINCREMENT,
      battle TEXT    NOT NULL,
      player TEXT    NOT NULL,
      n      INTEGER NOT NULL,
      src    INTEGER NOT NULL,
      dst    INTEGER NOT NULL,
      at     INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS battle_moves_by_battle ON battle_moves (battle, id);
  `);

  const q = {
    insertBattle: db.prepare(
      `INSERT INTO battles (battle, code, tubes, par, host, size, mode, status, created)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    byCode: db.prepare(`SELECT * FROM battles WHERE code = ?`),
    byId: db.prepare(`SELECT * FROM battles WHERE battle = ?`),
    setStatus: db.prepare(`UPDATE battles SET status = ?, started = ? WHERE battle = ?`),
    finish: db.prepare(`UPDATE battles SET status = 'done', ended = ?, winner = ? WHERE battle = ?`),
    kill: db.prepare(`UPDATE battles SET status = 'dead', ended = ? WHERE battle = ?`),
    openQuick: db.prepare(
      `SELECT * FROM battles WHERE mode = 'quick' AND status = 'open' ORDER BY created ASC`),
    staleOpen: db.prepare(`SELECT battle FROM battles WHERE status = 'open' AND created < ?`),

    addPlayer: db.prepare(
      `INSERT INTO battle_players (battle, player, joined) VALUES (?, ?, ?)
       ON CONFLICT (battle, player) DO NOTHING`),
    dropPlayer: db.prepare(`DELETE FROM battle_players WHERE battle = ? AND player = ?`),
    playersOf: db.prepare(
      `SELECT bp.player, bp.joined, bp.moves, bp.ms, bp.place, p.name
         FROM battle_players bp LEFT JOIN players p ON p.player = bp.player
        WHERE bp.battle = ? ORDER BY bp.joined ASC`),
    scorePlayer: db.prepare(
      `UPDATE battle_players SET moves = ?, ms = ?, place = ? WHERE battle = ? AND player = ?`),

    addMove: db.prepare(
      `INSERT INTO battle_moves (battle, player, n, src, dst, at) VALUES (?, ?, ?, ?, ?, ?)`),
    movesOf: db.prepare(
      `SELECT player, src, dst, at FROM battle_moves WHERE battle = ? ORDER BY id ASC`),

    liveBattles: db.prepare(`SELECT * FROM battles WHERE status IN ('open', 'live')`),

    /* Rooms anyone may walk into. Read from the database rather than the
       in-memory rooms so a room that outlived a restart is still listed. */
    openRooms: db.prepare(
      `SELECT b.battle, b.code, b.mode, b.size, b.created, b.host, p.name AS hostname,
              (SELECT COUNT(*) FROM battle_players bp WHERE bp.battle = b.battle) AS players
         FROM battles b LEFT JOIN players p ON p.player = b.host
        WHERE b.status = 'open'
        ORDER BY b.created ASC
        LIMIT 40`),
    recentFor: db.prepare(
      `SELECT b.battle, b.code, b.mode, b.status, b.started, b.ended, b.winner, b.par,
              bp.moves, bp.ms, bp.place
         FROM battles b JOIN battle_players bp ON bp.battle = b.battle
        WHERE bp.player = ? AND b.status = 'done'
        ORDER BY b.ended DESC LIMIT ?`),
  };

  /* ---------------------------------------------------------------- */
  /* Rooms                                                             */
  /* ---------------------------------------------------------------- */

  /** battleId -> room. A room is the authoritative live copy of a battle. */
  const rooms = new Map();

  function freshCode() {
    for (let tries = 0; tries < 40; tries++) {
      let code = '';
      for (let i = 0; i < CODE_LENGTH; i++) {
        code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      }
      if (!q.byCode.get(code)) return code;
    }
    // 32^5 is 33 million; forty collisions means something is very wrong.
    return randomUUID().slice(0, 8).toUpperCase();
  }

  function newSeat(player, name) {
    return {
      player,
      name: name || 'anonymous',
      tubes: null,      // dealt when the battle starts
      history: [],      // {from, to, count} per pour, for undo
      moves: 0,
      done: false,
      ms: null,
      place: null,
      left: false,
      seenAt: Date.now(),
      sockets: new Set(),
    };
  }

  function createRoom({ host, hostName, size, mode }) {
    const id = randomUUID();
    const code = freshCode();
    const now = Date.now();
    // Dealt now so a rematch of the same room is still a brand new puzzle.
    const tubes = game.generate('battle:' + id);
    const par = game.solve(game.clone(tubes), 120000);

    q.insertBattle.run(id, code, JSON.stringify(tubes), par ? par.length : null,
                       host, size, mode, 'open', now);
    q.addPlayer.run(id, host, now);

    const room = {
      id, code, mode, size,
      host,
      status: 'open',
      tubes,                       // the deal every player starts from
      par: par ? par.length : null,
      created: now,
      startAt: null,
      ended: null,
      winner: null,
      seats: new Map([[host, newSeat(host, hostName)]]),
      watchers: new Set(),
    };
    rooms.set(id, room);
    return room;
  }

  function roomFor(id) {
    if (rooms.has(id)) return rooms.get(id);
    const row = q.byId.get(id);
    if (!row) return null;
    if (row.status === 'done' || row.status === 'dead') return null;
    return rebuild(row);
  }

  /* A restart wipes the in-memory rooms. Everything needed to reconstruct one
     is on disk: the deal, the roster and every move in order. */
  function rebuild(row) {
    const room = {
      id: row.battle,
      code: row.code,
      mode: row.mode,
      size: Number(row.size),
      host: row.host,
      status: row.status,
      tubes: JSON.parse(row.tubes),
      par: row.par === null ? null : Number(row.par),
      created: Number(row.created),
      startAt: row.started === null ? null : Number(row.started),
      ended: null,
      winner: null,
      seats: new Map(),
      watchers: new Set(),
    };
    for (const p of q.playersOf.all(row.battle)) {
      const seat = newSeat(p.player, p.name);
      if (room.status === 'live') seat.tubes = game.clone(room.tubes);
      room.seats.set(p.player, seat);
    }
    if (room.status === 'live') {
      for (const m of q.movesOf.all(row.battle)) {
        const seat = room.seats.get(m.player);
        if (!seat) continue;
        if (Number(m.src) < 0) undoOn(seat);
        else applyPour(seat, Number(m.src), Number(m.dst));
      }
    }
    rooms.set(room.id, room);
    return room;
  }

  /* ---------------------------------------------------------------- */
  /* Play                                                              */
  /* ---------------------------------------------------------------- */

  function applyPour(seat, from, to) {
    if (!seat.tubes) return false;
    if (!game.canPour(seat.tubes, from, to)) return false;
    const count = game.pour(seat.tubes, from, to);
    if (count === 0) return false;
    seat.history.push({ from, to, count });
    seat.moves += 1;
    return true;
  }

  function undoOn(seat) {
    if (!seat.tubes) return false;
    const last = seat.history.pop();
    if (!last) return false;
    for (let i = 0; i < last.count; i++) seat.tubes[last.from].push(seat.tubes[last.to].pop());
    // Undo costs a move here exactly as it does in the daily puzzle: it buys
    // back the position, never the move count.
    seat.moves += 1;
    return true;
  }

  function tubesDone(tubes) {
    let n = 0;
    for (const t of tubes) if (t.length === game.CAPACITY && game.isTubeDone(t)) n++;
    return n;
  }

  function startBattle(room) {
    if (room.status !== 'open') return;
    room.status = 'live';
    room.startAt = Date.now() + COUNTDOWN_MS;
    for (const seat of room.seats.values()) {
      seat.tubes = game.clone(room.tubes);
      seat.history = [];
      seat.moves = 0;
    }
    q.setStatus.run('live', room.startAt, room.id);
    broadcast(room);
    broadcastLobby();   // a started room is no longer joinable
  }

  /* Everyone still in it: not finished, not walked away. The battle runs until
     at most one of these is left. */
  function contenders(room) {
    return [...room.seats.values()].filter((s) => !s.done && !s.left);
  }

  /* A finish is recorded the moment it happens — place, moves and time — and
     the battle carries on. Only the last player standing is denied a finish,
     because there is nobody left to race. */
  function recordFinish(room, seat, at) {
    seat.done = true;
    seat.ms = at - room.startAt;
    seat.place = [...room.seats.values()].filter((s) => s.done).length;   // finish order
    if (!room.winner) room.winner = seat.player;
    q.scorePlayer.run(seat.moves, seat.ms, seat.place, room.id, seat.player);
  }

  /* Placings: everyone who finished, in the order they finished, then everyone
     who did not — the ones still playing ahead of the ones who left. */
  function endBattle(room, fallbackWinner) {
    if (room.status === 'done') return;
    room.status = 'done';
    room.ended = Date.now();

    const seats = [...room.seats.values()];
    const finished = seats.filter((s) => s.done).sort((a, b) => a.place - b.place);
    const rest = seats.filter((s) => !s.done).sort((a, b) => {
      if (a.left !== b.left) return a.left ? 1 : -1;
      const da = a.tubes ? tubesDone(a.tubes) : 0;
      const dbb = b.tubes ? tubesDone(b.tubes) : 0;
      if (da !== dbb) return dbb - da;
      return a.moves - b.moves;
    });

    if (!room.winner) {
      // Nobody finished: a walkover, so whoever was left standing takes it.
      room.winner = fallbackWinner || (rest[0] ? rest[0].player : null);
    }

    [...finished, ...rest].forEach((seat, i) => {
      seat.place = i + 1;
      q.scorePlayer.run(seat.moves, seat.ms, seat.place, room.id, seat.player);
    });
    q.finish.run(room.ended, room.winner, room.id);
    broadcast(room);
    broadcastLobby();
    // Leave the room up briefly so late frames and the result screen land.
    setTimeout(() => rooms.delete(room.id), 60e3).unref?.();
  }

  /* ---------------------------------------------------------------- */
  /* Wire format                                                       */
  /* ---------------------------------------------------------------- */

  function seatView(room, seat, forPlayer) {
    const you = seat.player === forPlayer;
    const total = game.COLOR_COUNT;
    const done = seat.tubes ? tubesDone(seat.tubes) : 0;
    return {
      player: seat.player,
      name: seat.name,
      you,
      // Only your own colours are ever sent. An opponent is described by shape
      // alone — how full each tube is and whether it is finished. Everyone is
      // racing the identical deal, so sending their colours would hand a stuck
      // player the leader's solution, and hiding it in CSS would not: it would
      // still be sitting in the page for anyone who opened devtools.
      tubes: you && seat.tubes ? seat.tubes.map((t) => t.slice()) : null,
      shape: you || !seat.tubes ? null : seat.tubes.map((t) => ({
        n: t.length,
        done: t.length === game.CAPACITY && game.isTubeDone(t),
      })),
      moves: seat.moves,
      done,
      percent: Math.round((100 * done) / total),
      solved: seat.done,
      ms: seat.ms,
      place: seat.place,
      here: seat.sockets.size > 0 && !seat.left,
      left: seat.left,
    };
  }

  function view(room, forPlayer) {
    return {
      battle: room.id,
      code: room.code,
      mode: room.mode,
      size: room.size,
      status: room.status,
      host: room.host,
      youAreHost: room.host === forPlayer,
      par: room.par,
      startAt: room.startAt,
      now: Date.now(),
      winner: room.winner,
      players: [...room.seats.values()].map((s) => seatView(room, s, forPlayer)),
    };
  }

  /* Everyone sitting on the lobby screen, waiting to be told a room appeared.
     Kept separate from a room's watchers: these people are not in a battle. */
  const lobbyWatchers = new Set();

  function openList(forPlayer) {
    return q.openRooms.all()
      .map((r) => ({
        code: r.code,
        mode: r.mode,
        host: r.hostname || 'someone',
        players: Number(r.players),
        size: Number(r.size),
        waiting: Number(r.size) - Number(r.players),
        created: Number(r.created),
        yours: r.host === forPlayer,
      }))
      .filter((r) => r.waiting > 0);
  }

  function broadcastLobby() {
    for (const w of lobbyWatchers) {
      writeEvent(w.res, 'open', { rooms: openList(w.player), now: Date.now() });
    }
  }

  function broadcast(room) {
    for (const w of room.watchers) {
      writeEvent(w.res, 'state', view(room, w.player));
    }
  }

  function writeEvent(res, name, payload) {
    try {
      res.write('event: ' + name + '\ndata: ' + JSON.stringify(payload) + '\n\n');
    } catch { /* the socket is gone; the close handler will clean it up */ }
  }

  /* ---------------------------------------------------------------- */
  /* Presence                                                          */
  /* ---------------------------------------------------------------- */

  function attach(room, player, res) {
    const seat = room.seats.get(player);
    if (seat) { seat.sockets.add(res); seat.left = false; seat.seenAt = Date.now(); }
    const watcher = { res, player };
    room.watchers.add(watcher);

    res.on('close', () => {
      room.watchers.delete(watcher);
      if (seat) {
        seat.sockets.delete(res);
        seat.seenAt = Date.now();
      }
      broadcast(room);
    });
    writeEvent(res, 'state', view(room, player));
  }

  // A room with nobody in it is swept; a live battle whose last opponent walked
  // away is awarded to whoever stayed rather than hanging forever.
  const sweeper = setInterval(() => {
    const now = Date.now();
    let listChanged = false;
    for (const room of [...rooms.values()]) {
      let changed = false;
      for (const seat of room.seats.values()) {
        if (!seat.left && seat.sockets.size === 0 && now - seat.seenAt > GONE_MS) {
          seat.left = true;
          changed = true;
        }
      }
      const present = [...room.seats.values()].filter((s) => !s.left);
      if (room.status === 'live' && room.seats.size > 1 && contenders(room).length <= 1) {
        endBattle(room, present[0] ? present[0].player : null);
        continue;
      }
      if (present.length === 0 && now - room.created > GONE_MS) {
        if (room.status !== 'done') q.kill.run(now, room.id);
        rooms.delete(room.id);
        listChanged = true;
        continue;
      }
      if (room.status === 'open' && now - room.created > OPEN_TTL_MS) {
        q.kill.run(now, room.id);
        rooms.delete(room.id);
        listChanged = true;
        continue;
      }
      if (changed) broadcast(room);
    }
    for (const row of q.staleOpen.all(now - OPEN_TTL_MS)) {
      if (!rooms.has(row.battle)) { q.kill.run(now, row.battle); listChanged = true; }
    }
    // An abandoned room that just got swept must leave the list, or people
    // keep clicking a battle that is no longer there.
    if (listChanged) broadcastLobby();
  }, 10e3);
  sweeper.unref?.();

  const heart = setInterval(() => {
    for (const room of rooms.values()) {
      for (const w of room.watchers) {
        try { w.res.write(': ping\n\n'); } catch { /* closed */ }
      }
    }
    // Lobby sockets sit idle whenever nobody opens a room, which is exactly
    // when a proxy decides they are dead.
    for (const w of lobbyWatchers) {
      try { w.res.write(': ping\n\n'); } catch { /* closed */ }
    }
  }, HEARTBEAT_MS);
  heart.unref?.();

  // Anything left 'live' from a previous process is stale on boot: its players
  // are long gone. Rooms are rebuilt lazily on demand instead.
  for (const row of q.liveBattles.all()) {
    if (Number(row.created) < Date.now() - OPEN_TTL_MS) q.kill.run(Date.now(), row.battle);
  }

  /* ---------------------------------------------------------------- */
  /* Routes                                                            */
  /* ---------------------------------------------------------------- */

  function handle(req, res, url, body, send) {
    const post = req.method === 'POST';
    const p = url.pathname;
    if (p.indexOf('/api/battle') !== 0) return false;

    /* -- live list of rooms anyone can walk into -- */
    if (req.method === 'GET' && p === '/api/battle/lobby') {
      const player = playerForToken(url.searchParams.get('token') || '');
      if (!player) { send(res, 401, { error: 'Sign in to see open battles.' }); return true; }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 3000\n\n');
      const watcher = { res, player };
      lobbyWatchers.add(watcher);
      res.on('close', () => lobbyWatchers.delete(watcher));
      writeEvent(res, 'open', { rooms: openList(player), now: Date.now() });
      return true;
    }

    /* -- the same list, for a client whose stream is down -- */
    if (req.method === 'GET' && p === '/api/battle/open') {
      const player = playerForToken(url.searchParams.get('token') || '');
      if (!player) { send(res, 401, { error: 'Sign in to see open battles.' }); return true; }
      send(res, 200, { rooms: openList(player), now: Date.now() });
      return true;
    }

    /* -- live stream -- */
    if (req.method === 'GET' && p === '/api/battle/stream') {
      const player = playerForToken(url.searchParams.get('token') || '');
      if (!player) { send(res, 401, { error: 'Sign in to watch a battle.' }); return true; }
      const room = roomFor(url.searchParams.get('battle') || '');
      if (!room) { send(res, 404, { error: 'That battle is over.' }); return true; }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store, no-transform',
        Connection: 'keep-alive',
        // nginx buffers proxied responses by default, which would hold every
        // frame back until the battle ended.
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 2000\n\n');
      attach(room, player, res);
      return true;
    }

    const player = post ? playerForToken(body.token) : playerForToken(url.searchParams.get('token') || '');
    if (!player) { send(res, 401, { error: 'Sign in to battle.' }); return true; }
    const myName = nameOf(player);

    /* -- create a private room -- */
    if (post && p === '/api/battle/create') {
      let size = Number(body.size);
      if (!Number.isFinite(size)) size = 2;
      size = Math.max(MIN_SIZE, Math.min(MAX_SIZE, Math.round(size)));
      leaveEverything(player);
      const room = createRoom({ host: player, hostName: myName, size, mode: 'room' });
      broadcastLobby();
      send(res, 200, view(room, player));
      return true;
    }

    /* -- join by code -- */
    if (post && p === '/api/battle/join') {
      const code = String(body.code || '').trim().toUpperCase();
      const row = q.byCode.get(code);
      if (!row) { send(res, 404, { error: 'No battle with that code.' }); return true; }
      const room = roomFor(row.battle);
      if (!room) { send(res, 410, { error: 'That battle has finished.' }); return true; }
      const joined = seatIn(room, player, myName);
      if (joined.error) { send(res, 409, { error: joined.error }); return true; }
      send(res, 200, view(room, player));
      return true;
    }

    /* -- quick match: take the oldest room with a free seat, else open one -- */
    if (post && p === '/api/battle/quick') {
      leaveEverything(player);
      for (const row of q.openQuick.all()) {
        const room = roomFor(row.battle);
        if (!room || room.status !== 'open') continue;
        if (room.seats.size >= room.size) continue;
        if (room.seats.has(player)) continue;
        seatIn(room, player, myName);
        send(res, 200, view(room, player));
        return true;
      }
      const room = createRoom({ host: player, hostName: myName, size: 2, mode: 'quick' });
      broadcastLobby();
      send(res, 200, view(room, player));
      return true;
    }

    /* -- host presses start -- */
    if (post && p === '/api/battle/start') {
      const room = roomFor(String(body.battle || ''));
      if (!room) { send(res, 404, { error: 'That battle is over.' }); return true; }
      if (room.host !== player) { send(res, 403, { error: 'Only the host can start.' }); return true; }
      if (room.seats.size < MIN_SIZE) { send(res, 409, { error: 'Needs at least two players.' }); return true; }
      startBattle(room);
      send(res, 200, view(room, player));
      return true;
    }

    /* -- a pour, or an undo -- */
    if (post && p === '/api/battle/move') {
      const room = roomFor(String(body.battle || ''));
      if (!room) { send(res, 404, { error: 'That battle is over.' }); return true; }
      const seat = room.seats.get(player);
      if (!seat) { send(res, 403, { error: 'You are not in this battle.' }); return true; }
      if (room.status !== 'live') { send(res, 409, { error: 'The battle is not running.' }); return true; }
      if (Date.now() < room.startAt) { send(res, 409, { error: 'Not started yet.' }); return true; }
      if (seat.done) { send(res, 409, { error: 'You already finished.' }); return true; }

      const undo = body.undo === true;
      const from = Number(body.from);
      const to = Number(body.to);
      const ok = undo ? undoOn(seat)
        : (Number.isInteger(from) && Number.isInteger(to) &&
           from >= 0 && to >= 0 && from < game.TUBE_COUNT && to < game.TUBE_COUNT &&
           applyPour(seat, from, to));
      if (!ok) { send(res, 400, { error: 'Illegal move.', state: view(room, player) }); return true; }

      const at = Date.now();
      q.addMove.run(room.id, player, seat.moves, undo ? -1 : from, undo ? -1 : to, at);

      if (!undo && game.isSolved(seat.tubes)) {
        recordFinish(room, seat, at);
        // The race is over only when a single player is left with nobody to
        // race against; until then the others keep playing for their place.
        if (contenders(room).length <= 1) endBattle(room);
        else { broadcast(room); broadcastLobby(); }
      } else {
        broadcast(room);
      }
      send(res, 200, view(room, player));
      return true;
    }

    /* -- state, for a client whose stream dropped -- */
    if (req.method === 'GET' && p === '/api/battle/state') {
      const room = roomFor(url.searchParams.get('battle') || '');
      if (!room) { send(res, 404, { error: 'That battle is over.' }); return true; }
      send(res, 200, view(room, player));
      return true;
    }

    /* -- leave -- */
    if (post && p === '/api/battle/leave') {
      const room = roomFor(String(body.battle || ''));
      if (room) {
        const seat = room.seats.get(player);
        if (seat && room.status === 'open') {
          room.seats.delete(player);
          q.dropPlayer.run(room.id, player);
          if (room.seats.size === 0) { q.kill.run(Date.now(), room.id); rooms.delete(room.id); }
          else broadcast(room);
          broadcastLobby();
        } else if (seat) {
          seat.left = true;
          // Walking out of a live battle can leave a lone contender, and there
          // is no race with one runner.
          if (room.status === 'live' && room.seats.size > 1 && contenders(room).length <= 1) {
            const present = [...room.seats.values()].filter((p2) => !p2.left);
            endBattle(room, present[0] ? present[0].player : null);
          } else {
            broadcast(room);
          }
        }
      }
      send(res, 200, { ok: true });
      return true;
    }

    /* -- a player's finished battles -- */
    if (req.method === 'GET' && p === '/api/battle/history') {
      const rows = q.recentFor.all(player, 20).map((r) => ({
        battle: r.battle, code: r.code, mode: r.mode,
        ended: Number(r.ended), moves: Number(r.moves),
        ms: r.ms === null ? null : Number(r.ms),
        place: r.place === null ? null : Number(r.place),
        won: r.winner === player,
        par: r.par === null ? null : Number(r.par),
      }));
      send(res, 200, { history: rows });
      return true;
    }

    send(res, 404, { error: 'not found' });
    return true;
  }

  function seatIn(room, player, name) {
    if (room.seats.has(player)) return { ok: true };
    if (room.status !== 'open') return { error: 'That battle has already started.' };
    if (room.seats.size >= room.size) return { error: 'That battle is full.' };
    room.seats.set(player, newSeat(player, name));
    q.addPlayer.run(room.id, player, Date.now());
    // A full room starts itself; nobody should have to press a button.
    if (room.seats.size >= room.size) startBattle(room);
    else { broadcast(room); broadcastLobby(); }
    return { ok: true };
  }

  // One battle at a time: joining a second would leave a ghost in the first.
  function leaveEverything(player) {
    for (const room of [...rooms.values()]) {
      if (!room.seats.has(player)) continue;
      if (room.status === 'open') {
        room.seats.delete(player);
        q.dropPlayer.run(room.id, player);
        if (room.seats.size === 0) { q.kill.run(Date.now(), room.id); rooms.delete(room.id); }
        else broadcast(room);
        broadcastLobby();
      }
    }
  }

  return { handle };
};
