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
 * A note can also be put on the team board, which every signed-in account can
 * read. The board is a noticeboard rather than a wiki: anyone may read what is
 * pinned to it, only the author may change or remove it.
 *
 * Notes live in sections, the way a notebook has tabs: a section belongs to one
 * account and holds its pages in an order the owner chooses. Every account gets
 * one called Notes the first time it is seen, so nothing has to be set up
 * before writing anything down.
 *
 * A body is rich text, stored as a small subset of HTML. What arrives is
 * filtered here to a fixed list of tags and attributes rather than trusted:
 * this text is rendered inside somebody else's window.
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

  db.exec(`
    CREATE TABLE IF NOT EXISTS sections (
      id       TEXT PRIMARY KEY,
      owner    TEXT NOT NULL,
      name     TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      created  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sections_by_owner ON sections (owner, position);
  `);

  // Added after earlier releases. ALTER TABLE is the migration; SQLite has no
  // "add column if missing", so an existing column throws and is ignored.
  for (const sql of [
    'ALTER TABLE notes ADD COLUMN board INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE notes ADD COLUMN section TEXT',
    'ALTER TABLE notes ADD COLUMN html INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE notes ADD COLUMN position INTEGER NOT NULL DEFAULT 0',
  ]) {
    try { db.exec(sql); } catch { /* already there */ }
  }
  db.exec('CREATE INDEX IF NOT EXISTS notes_on_board ON notes (board, updated)');
  db.exec('CREATE INDEX IF NOT EXISTS notes_by_section ON notes (section, position)');

  const q = {
    byOwner: db.prepare('SELECT * FROM notes WHERE owner = ? ORDER BY pinned DESC, updated DESC'),
    sharedWith: db.prepare(`
      SELECT n.* FROM notes n
      JOIN note_shares s ON s.note = n.id
      WHERE s.player = ?
      ORDER BY n.pinned DESC, n.updated DESC
    `),
    one: db.prepare('SELECT * FROM notes WHERE id = ?'),
    board: db.prepare('SELECT * FROM notes WHERE board = 1 ORDER BY pinned DESC, updated DESC LIMIT 200'),
    countFor: db.prepare('SELECT COUNT(*) AS n FROM notes WHERE owner = ?'),
    insert: db.prepare(`
      INSERT INTO notes (id, owner, kind, title, body, pinned, board, html, section, created, updated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    update: db.prepare(
      'UPDATE notes SET kind = ?, title = ?, body = ?, pinned = ?, board = ?, html = ?, updated = ? WHERE id = ?'
    ),
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
    sections: db.prepare('SELECT * FROM sections WHERE owner = ? ORDER BY position, created'),
    sectionOne: db.prepare('SELECT * FROM sections WHERE id = ?'),
    sectionAdd: db.prepare('INSERT INTO sections (id, owner, name, position, created) VALUES (?, ?, ?, ?, ?)'),
    sectionRename: db.prepare('UPDATE sections SET name = ? WHERE id = ?'),
    sectionMove: db.prepare('UPDATE sections SET position = ? WHERE id = ?'),
    sectionDrop: db.prepare('DELETE FROM sections WHERE id = ?'),
    sectionMax: db.prepare('SELECT COALESCE(MAX(position), -1) AS p FROM sections WHERE owner = ?'),
    notesInSection: db.prepare('SELECT id FROM notes WHERE section = ?'),
    adopt: db.prepare("UPDATE notes SET section = ? WHERE owner = ? AND (section IS NULL OR section = '')"),
    setSection: db.prepare('UPDATE notes SET section = ? WHERE id = ?'),
    playerByName: db.prepare('SELECT player, name FROM players WHERE name_lower = ?'),
    nameOf: db.prepare('SELECT name FROM players WHERE player = ?'),
  };

  return q;
}

/**
 * The account's sections, creating the first one if it has none.
 *
 * Doing it here rather than at registration means accounts that existed before
 * sections did get one the first time they open the page, and their loose
 * notes are adopted into it.
 */
function sectionsFor(q, player) {
  let rows = q.sections.all(player);
  if (!rows.length) {
    const id = randomUUID();
    q.sectionAdd.run(id, player, 'Notes', 0, Date.now());
    q.adopt.run(id, player);
    rows = q.sections.all(player);
  }
  return rows.map((r) => ({ id: r.id, name: r.name, position: Number(r.position) }));
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
    board: !!row.board,
    html: !!row.html,
    section: row.section || '',
    created: Number(row.created),
    updated: Number(row.updated),
    owner: owner ? owner.name : 'unknown',
    mine: row.owner === viewer,
    sharedWith: row.owner === viewer ? q.sharesOf.all(row.id).map((r) => r.name) : [],
  };
}

/*
 * The only markup a body may contain.
 *
 * Rich text is edited in one window and rendered in another, so what arrives
 * is filtered rather than trusted. This is an allowlist: an unknown tag loses
 * its angle brackets and keeps its text, and every attribute is dropped except
 * the handful named here. Nothing that can fetch, execute or embed survives -
 * no script, style, iframe, object, img src, or on* handler - and the client
 * filters again through a DOM parser before it renders any of it.
 */
const ALLOWED_TAGS = new Set([
  'p', 'br', 'div', 'span', 'b', 'strong', 'i', 'em', 'u', 's', 'mark',
  'h1', 'h2', 'h3', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'hr',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
]);
/** tag -> attributes it may keep. Everything else is stripped. */
const ALLOWED_ATTRS = {
  li: new Set(['data-checked']),
  ul: new Set(['class']),
  span: new Set(['class']),
  td: new Set(['colspan', 'rowspan']),
  th: new Set(['colspan', 'rowspan']),
};
/** class names a span or list may carry; anything else is dropped. */
const ALLOWED_CLASSES = new Set(['checklist', 'hl']);

function sanitiseHtml(raw) {
  if (typeof raw !== 'string') return '';
  let out = '';
  let i = 0;

  while (i < raw.length) {
    const lt = raw.indexOf('<', i);
    if (lt < 0) { out += escapeText(raw.slice(i)); break; }
    out += escapeText(raw.slice(i, lt));

    const gt = raw.indexOf('>', lt);
    if (gt < 0) { out += escapeText(raw.slice(lt)); break; }

    const inner = raw.slice(lt + 1, gt).trim();
    i = gt + 1;

    // Comments, doctypes and closing brackets of things we never allowed.
    if (inner.startsWith('!') || inner.startsWith('?')) continue;

    const closing = inner.startsWith('/');
    const nameMatch = /^\/?\s*([a-zA-Z][a-zA-Z0-9]*)/.exec(inner);
    if (!nameMatch) continue;
    const tag = nameMatch[1].toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) continue;

    if (closing) { out += `</${tag}>`; continue; }
    out += `<${tag}${keptAttrs(tag, inner)}>`;
  }
  return out;
}

/**
 * Escape a run of text, once.
 *
 * What arrives is already markup: the editor hands over `a &amp;&amp; b` for a
 * page that says `a && b`. Escaping every ampersand would turn that into
 * `&amp;amp;` and the page would say `a &amp;&amp; b` the next time it was
 * read - and again on the save after that, escaping itself a level deeper every
 * time. So an ampersand that is already the start of an entity is left alone;
 * a bare one is still escaped, which is what makes the rest of this safe.
 */
function escapeText(text) {
  return text
    .replace(/&(?!#\d+;|#[xX][0-9a-fA-F]+;|[a-zA-Z][a-zA-Z0-9]{1,31};)/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function keptAttrs(tag, inner) {
  const allowed = ALLOWED_ATTRS[tag];
  if (!allowed) return '';
  let out = '';
  const re = /([a-zA-Z-]+)\s*=\s*"([^"]*)"/g;
  let m = re.exec(inner);
  while (m) {
    const name = m[1].toLowerCase();
    let value = m[2];
    if (allowed.has(name)) {
      if (name === 'class') {
        value = value.split(/\s+/).filter((c) => ALLOWED_CLASSES.has(c)).join(' ');
      } else {
        value = value.replace(/[^a-zA-Z0-9 _-]/g, '');
      }
      if (value) out += ` ${name}="${value}"`;
    }
    m = re.exec(inner);
  }
  return out;
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
      sections: sectionsFor(q, player),
      mine: q.byOwner.all(player).map((row) => shape(q, row, player)),
      shared: q.sharedWith.all(player).map((row) => shape(q, row, player)),
      // The board is everyone's, including this player's own postings, so it
      // reads the same for whoever is looking at it.
      board: q.board.all().map((row) => shape(q, row, player)),
    });
    return true;
  }

  /* ---- create or edit ---- */
  if (post && url.pathname === '/api/notes') {
    const title = clean(body.title, MAX_TITLE);
    // Rich text arrives as markup and is filtered to the allowlist; plain text
    // is cleaned as before. Which one it is travels with the note.
    const rich = !!body.html;
    const text = rich
      ? (String(body.body || '').length > MAX_BODY ? null : sanitiseHtml(body.body))
      : clean(body.body, MAX_BODY);
    const kind = KINDS.has(body.kind) ? body.kind : 'note';
    const pinned = body.pinned ? 1 : 0;
    const board = body.board ? 1 : 0;

    if (title === null) { send(res, 400, { error: `A title is at most ${MAX_TITLE} characters.` }); return true; }
    if (text === null) { send(res, 400, { error: 'That note is too long.' }); return true; }
    const empty = !title && !String(text).replace(/<[^>]*>/g, '').trim();
    if (empty) { send(res, 400, { error: 'A note needs a title or something in it.' }); return true; }

    const now = Date.now();

    if (body.id) {
      const row = q.one.get(String(body.id));
      if (!row) { send(res, 404, { error: 'That note is gone.' }); return true; }
      // The owner and anyone it was shared with may edit; that is what being
      // able to "manage" a shared note means.
      const allowed = row.owner === player || q.isSharedWith.get(row.id, player);
      if (!allowed) { send(res, 403, { error: 'That note is not yours.' }); return true; }
      // Being able to read the board is not being able to edit it: only the
      // author moves a note on or off it.
      const onBoard = row.owner === player ? board : row.board;
      q.update.run(kind, title, text, pinned, onBoard, rich ? 1 : 0, now, row.id);
      if (row.owner === player && typeof body.section === 'string' && body.section) {
        const target = q.sectionOne.get(body.section);
        if (target && target.owner === player) q.setSection.run(target.id, row.id);
      }
      send(res, 200, { note: shape(q, q.one.get(row.id), player) });
      return true;
    }

    if (Number(q.countFor.get(player).n) >= MAX_NOTES_PER_PLAYER) {
      send(res, 409, { error: `That is ${MAX_NOTES_PER_PLAYER} notes. Delete one first.` });
      return true;
    }
    const id = randomUUID();
    // A note belongs to a section; an unknown one falls back to the first.
    const sections = sectionsFor(q, player);
    const wanted = sections.find((x) => x.id === body.section) || sections[0];
    q.insert.run(id, player, kind, title, text, pinned, board, rich ? 1 : 0, wanted.id, now, now);
    send(res, 200, { note: shape(q, q.one.get(id), player) });
    return true;
  }

  /* ---- delete, or leave a note shared with you ---- */
  if (post && url.pathname === '/api/notes/delete') {
    const row = q.one.get(String(body.id || ''));
    if (!row) { send(res, 404, { error: 'That note is gone.' }); return true; }

    if (row.owner === player) {
      // Logged because a note going missing is not something to have to guess
      // about later; this is the only path that destroys one.
      console.log(`[notes] ${player} deleted ${row.id} (${JSON.stringify(row.title).slice(0, 60)})`);
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

  /* ---- sections: the tabs down the side of a notebook ---- */
  if (post && url.pathname === '/api/notes/section') {
    const name = clean(body.name, 60);
    const id = typeof body.id === 'string' ? body.id : '';
    const existing = id ? q.sectionOne.get(id) : null;
    if (id && (!existing || existing.owner !== player)) {
      send(res, 404, { error: 'No such section.' });
      return true;
    }

    if (body.remove && existing) {
      const sections = sectionsFor(q, player);
      if (sections.length < 2) { send(res, 400, { error: 'A notebook keeps at least one section.' }); return true; }
      // Its pages move rather than disappear; deleting a tab should never be a
      // way to lose a page by accident.
      const fallback = sections.find((x) => x.id !== existing.id);
      for (const row of q.notesInSection.all(existing.id)) q.setSection.run(fallback.id, row.id);
      q.sectionDrop.run(existing.id);
      send(res, 200, { sections: sectionsFor(q, player) });
      return true;
    }

    if (!name) { send(res, 400, { error: 'A section needs a name.' }); return true; }

    if (existing) {
      q.sectionRename.run(name, existing.id);
      if (Number.isInteger(body.position)) q.sectionMove.run(body.position, existing.id);
    } else {
      const next = Number(q.sectionMax.get(player).p) + 1;
      q.sectionAdd.run(randomUUID(), player, name, next, Date.now());
    }
    send(res, 200, { sections: sectionsFor(q, player) });
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
