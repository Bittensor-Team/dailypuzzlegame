/*
 * Notes — short texts an account keeps, and can hand to other accounts.
 *
 * The identity is the one the scoreboard already uses: a session token issued
 * by /api/login, exchanged here for a player id. Nothing new is stored about
 * who anyone is.
 *
 * Sharing is by nickname, resolved to a player id at the moment of sharing, so
 * a later rename cannot silently move a note to somebody else. A recipient may
 * read and edit what they were given - that is what "share" means here - but
 * only the owner can delete the note or change who else can see it. A
 * recipient who is finished with one removes their own share and leaves the
 * note alone.
 *
 * Kept in its own file rather than in the router: it owns a schema, and the
 * scoreboard has no business knowing about it.
 */
'use strict';

const { randomUUID } = require('node:crypto');

/** Bounds, so one account cannot fill the disk or a list. */
const MAX_TITLE = 120;
const MAX_BODY = 16 * 1024;
const MAX_NOTES_PER_PLAYER = 500;
const MAX_SHARES_PER_NOTE = 50;
const KINDS = new Set(['note', 'command']);

function install(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS notes (
      id      TEXT PRIMARY KEY,
      owner   TEXT NOT NULL,
      kind    TEXT NOT NULL,
      title   TEXT NOT NULL,
      body    TEXT NOT NULL,
      pinned  INTEGER NOT NULL DEFAULT 0,
      created INTEGER NOT NULL,
      updated INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS notes_by_owner ON notes (owner, updated);
    CREATE TABLE IF NOT EXISTS note_shares (
      note   TEXT NOT NULL,
      player TEXT NOT NULL,
      shared INTEGER NOT NULL,
      PRIMARY KEY (note, player)
    );
    CREATE INDEX IF NOT EXISTS note_shares_by_player ON note_shares (player, shared);
  `);

  const q = {
    byOwner: db.prepare('SELECT * FROM notes WHERE owner = ? ORDER BY pinned DESC, updated DESC'),
    sharedWith: db.prepare(`
      SELECT n.* FROM notes n
      JOIN note_shares s ON s.note = n.id
      WHERE s.player = ?
      ORDER BY n.pinned DESC, n.updated DESC
    `),
    one: db.prepare('SELECT * FROM notes WHERE id = ?'),
    countFor: db.prepare('SELECT COUNT(*) AS n FROM notes WHERE owner = ?'),
    insert: db.prepare(`
      INSERT INTO notes (id, owner, kind, title, body, pinned, created, updated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `),
    update: db.prepare('UPDATE notes SET kind = ?, title = ?, body = ?, pinned = ?, updated = ? WHERE id = ?'),
    remove: db.prepare('DELETE FROM notes WHERE id = ?'),
    removeShares: db.prepare('DELETE FROM note_shares WHERE note = ?'),
    share: db.prepare('INSERT OR REPLACE INTO note_shares (note, player, shared) VALUES (?, ?, ?)'),
    unshare: db.prepare('DELETE FROM note_shares WHERE note = ? AND player = ?'),
    sharesOf: db.prepare(`
      SELECT p.name FROM note_shares s
      JOIN players p ON p.player = s.player
      WHERE s.note = ? ORDER BY p.name
    `),
    shareCount: db.prepare('SELECT COUNT(*) AS n FROM note_shares WHERE note = ?'),
    isSharedWith: db.prepare('SELECT 1 AS ok FROM note_shares WHERE note = ? AND player = ?'),
    playerByName: db.prepare('SELECT player, name FROM players WHERE name_lower = ?'),
    nameOf: db.prepare('SELECT name FROM players WHERE player = ?'),
  };

  return q;
}

/** A note as the client sees it: never a player id, always a nickname. */
function shape(q, row, viewer) {
  const owner = q.nameOf.get(row.owner);
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    pinned: !!row.pinned,
    created: Number(row.created),
    updated: Number(row.updated),
    owner: owner ? owner.name : 'unknown',
    mine: row.owner === viewer,
    sharedWith: row.owner === viewer ? q.sharesOf.all(row.id).map((r) => r.name) : [],
  };
}

function clean(value, max) {
  if (typeof value !== 'string') return null;
  // Tab, newline and carriage return survive; every other control character is
  // dropped. Pasted terminal output is a normal thing to keep in a note, and
  // escape sequences in it are not.
  let out = '';
  for (const ch of value) {
    const c = ch.codePointAt(0);
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c !== 127)) out += ch;
  }
  out = out.trim();
  return out.length > max ? null : out;
}

/**
 * Routes /api/notes*. Returns true when it handled the request.
 *
 * Deliberately shaped like the rest of the router: the caller has already
 * parsed the body and knows the method.
 */
function route({ q, req, res, url, body, post, send, playerForToken }) {
  if (!url.pathname.startsWith('/api/notes')) return false;

  const token = post ? body.token : url.searchParams.get('token');
  const player = playerForToken(typeof token === 'string' ? token : '');
  if (!player) {
    send(res, 401, { error: 'Sign in to use notes.' });
    return true;
  }

  /* ---- list ---- */
  if (req.method === 'GET' && url.pathname === '/api/notes') {
    const me = q.nameOf.get(player);
    send(res, 200, {
      signedIn: true,
      name: me ? me.name : '',
      mine: q.byOwner.all(player).map((row) => shape(q, row, player)),
      shared: q.sharedWith.all(player).map((row) => shape(q, row, player)),
    });
    return true;
  }

  /* ---- create or edit ---- */
  if (post && url.pathname === '/api/notes') {
    const title = clean(body.title, MAX_TITLE);
    const text = clean(body.body, MAX_BODY);
    const kind = KINDS.has(body.kind) ? body.kind : 'note';
    const pinned = body.pinned ? 1 : 0;

    if (title === null) { send(res, 400, { error: `A title is at most ${MAX_TITLE} characters.` }); return true; }
    if (text === null) { send(res, 400, { error: 'That note is too long.' }); return true; }
    if (!title && !text) { send(res, 400, { error: 'A note needs a title or something in it.' }); return true; }

    const now = Date.now();

    if (body.id) {
      const row = q.one.get(String(body.id));
      if (!row) { send(res, 404, { error: 'That note is gone.' }); return true; }
      // The owner and anyone it was shared with may edit; that is what being
      // able to "manage" a shared note means.
      const allowed = row.owner === player || q.isSharedWith.get(row.id, player);
      if (!allowed) { send(res, 403, { error: 'That note is not yours.' }); return true; }
      q.update.run(kind, title, text, pinned, now, row.id);
      send(res, 200, { note: shape(q, q.one.get(row.id), player) });
      return true;
    }

    if (Number(q.countFor.get(player).n) >= MAX_NOTES_PER_PLAYER) {
      send(res, 409, { error: `That is ${MAX_NOTES_PER_PLAYER} notes. Delete one first.` });
      return true;
    }
    const id = randomUUID();
    q.insert.run(id, player, kind, title, text, pinned, now, now);
    send(res, 200, { note: shape(q, q.one.get(id), player) });
    return true;
  }

  /* ---- delete, or leave a note shared with you ---- */
  if (post && url.pathname === '/api/notes/delete') {
    const row = q.one.get(String(body.id || ''));
    if (!row) { send(res, 404, { error: 'That note is gone.' }); return true; }

    if (row.owner === player) {
      q.removeShares.run(row.id);
      q.remove.run(row.id);
      send(res, 200, { deleted: row.id });
      return true;
    }
    if (q.isSharedWith.get(row.id, player)) {
      q.unshare.run(row.id, player);
      send(res, 200, { left: row.id });
      return true;
    }
    send(res, 403, { error: 'That note is not yours.' });
    return true;
  }

  /* ---- share with, or stop sharing with, another account ---- */
  if (post && url.pathname === '/api/notes/share') {
    const row = q.one.get(String(body.id || ''));
    if (!row) { send(res, 404, { error: 'That note is gone.' }); return true; }
    if (row.owner !== player) { send(res, 403, { error: 'Only the owner can share a note.' }); return true; }

    const wanted = typeof body.name === 'string' ? body.name.trim() : '';
    if (!wanted) { send(res, 400, { error: 'Who should it go to?' }); return true; }

    const target = q.playerByName.get(wanted.toLowerCase());
    if (!target) { send(res, 404, { error: `No player called ${wanted}.` }); return true; }
    if (target.player === player) { send(res, 400, { error: 'It is already yours.' }); return true; }

    if (body.remove) {
      q.unshare.run(row.id, target.player);
    } else {
      if (Number(q.shareCount.get(row.id).n) >= MAX_SHARES_PER_NOTE) {
        send(res, 409, { error: `A note can be shared with ${MAX_SHARES_PER_NOTE} people.` });
        return true;
      }
      q.share.run(row.id, target.player, Date.now());
    }
    send(res, 200, { note: shape(q, q.one.get(row.id), player) });
    return true;
  }

  send(res, 404, { error: 'not found' });
  return true;
}

module.exports = { install, route, MAX_TITLE, MAX_BODY };
