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
/** Teams one account may own, and how long the change feed is kept. */
const MAX_TEAMS_PER_PLAYER = 20;
const MAX_MEMBERS_PER_TEAM = 50;
const EVENT_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
/** How much of the diary is handed over: a week behind, a quarter ahead. */
const AGENDA_PAST_MS = 7 * 24 * 60 * 60 * 1000;
const AGENDA_AHEAD_MS = 92 * 24 * 60 * 60 * 1000;
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

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

  /*
   * Teams: a notebook with more than one person in it.
   *
   * A team owns sections and pages the way an account does, and membership is
   * what decides who may open it. The rows are kept apart from personal ones by
   * a column rather than by another table, so a page is a page wherever it
   * lives and everything that already works on one keeps working.
   */
  db.exec(`
    CREATE TABLE IF NOT EXISTS teams (
      id      TEXT PRIMARY KEY,
      name    TEXT NOT NULL,
      owner   TEXT NOT NULL,
      created INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS team_members (
      team   TEXT NOT NULL,
      player TEXT NOT NULL,
      role   TEXT NOT NULL,
      added  INTEGER NOT NULL,
      PRIMARY KEY (team, player)
    );
    CREATE INDEX IF NOT EXISTS team_members_by_player ON team_members (player);
    -- What happened in a team, so the other members can be told about it.
    CREATE TABLE IF NOT EXISTS note_events (
      id    INTEGER PRIMARY KEY AUTOINCREMENT,
      team  TEXT NOT NULL,
      note  TEXT NOT NULL,
      title TEXT NOT NULL,
      actor TEXT NOT NULL,
      kind  TEXT NOT NULL,
      at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS note_events_by_team ON note_events (team, at);
    /*
     * The diary: something that is going to happen at a time.
     *
     * Kept beside the notes rather than anywhere cleverer because it is the
     * same question - what does this team need to know - asked about the
     * future. An entry with a team is the team's and everyone in it is told;
     * one without is the author's own.
     */
    CREATE TABLE IF NOT EXISTS schedule (
      id      TEXT PRIMARY KEY,
      owner   TEXT NOT NULL,
      team    TEXT,
      title   TEXT NOT NULL,
      detail  TEXT NOT NULL DEFAULT '',
      at      INTEGER NOT NULL,
      created INTEGER NOT NULL,
      updated INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS schedule_by_time ON schedule (at);
    CREATE INDEX IF NOT EXISTS schedule_by_team ON schedule (team, at);
  `);

  // Added after earlier releases. ALTER TABLE is the migration; SQLite has no
  // "add column if missing", so an existing column throws and is ignored.
  for (const sql of [
    'ALTER TABLE notes ADD COLUMN board INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE notes ADD COLUMN section TEXT',
    'ALTER TABLE notes ADD COLUMN html INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE notes ADD COLUMN position INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE notes ADD COLUMN team TEXT',
    'ALTER TABLE sections ADD COLUMN team TEXT',
  ]) {
    try { db.exec(sql); } catch { /* already there */ }
  }
  db.exec('CREATE INDEX IF NOT EXISTS notes_on_board ON notes (board, updated)');
  db.exec('CREATE INDEX IF NOT EXISTS notes_by_section ON notes (section, position)');

  const q = {
    // Personal pages only: a page filed in a team notebook belongs to the team,
    // not to whoever happened to type it, and must not appear in both.
    byOwner: db.prepare(`
      SELECT * FROM notes WHERE owner = ? AND (team IS NULL OR team = '')
      ORDER BY pinned DESC, updated DESC
    `),
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
      INSERT INTO notes (id, owner, kind, title, body, pinned, board, html, section, team, created, updated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    sections: db.prepare(`
      SELECT * FROM sections WHERE owner = ? AND (team IS NULL OR team = '')
      ORDER BY position, created
    `),
    sectionOne: db.prepare('SELECT * FROM sections WHERE id = ?'),
    sectionAdd: db.prepare(
      'INSERT INTO sections (id, owner, name, position, created, team) VALUES (?, ?, ?, ?, ?, ?)'
    ),
    sectionRename: db.prepare('UPDATE sections SET name = ? WHERE id = ?'),
    sectionMove: db.prepare('UPDATE sections SET position = ? WHERE id = ?'),
    sectionDrop: db.prepare('DELETE FROM sections WHERE id = ?'),
    sectionMax: db.prepare(
      "SELECT COALESCE(MAX(position), -1) AS p FROM sections WHERE owner = ? AND (team IS NULL OR team = '')"
    ),

    /* ---- teams ---- */
    teamAdd: db.prepare('INSERT INTO teams (id, name, owner, created) VALUES (?, ?, ?, ?)'),
    teamOne: db.prepare('SELECT * FROM teams WHERE id = ?'),
    teamRename: db.prepare('UPDATE teams SET name = ? WHERE id = ?'),
    teamDrop: db.prepare('DELETE FROM teams WHERE id = ?'),
    teamsOf: db.prepare(`
      SELECT t.*, m.role FROM teams t
      JOIN team_members m ON m.team = t.id
      WHERE m.player = ? ORDER BY t.created
    `),
    teamCountOf: db.prepare('SELECT COUNT(*) AS n FROM teams WHERE owner = ?'),
    memberAdd: db.prepare('INSERT OR REPLACE INTO team_members (team, player, role, added) VALUES (?, ?, ?, ?)'),
    memberDrop: db.prepare('DELETE FROM team_members WHERE team = ? AND player = ?'),
    memberDropAll: db.prepare('DELETE FROM team_members WHERE team = ?'),
    memberOne: db.prepare('SELECT * FROM team_members WHERE team = ? AND player = ?'),
    membersOf: db.prepare(`
      SELECT p.name, m.role, m.player FROM team_members m
      JOIN players p ON p.player = m.player
      WHERE m.team = ? ORDER BY (m.role = 'owner') DESC, p.name
    `),
    teamSections: db.prepare('SELECT * FROM sections WHERE team = ? ORDER BY position, created'),
    teamSectionMax: db.prepare('SELECT COALESCE(MAX(position), -1) AS p FROM sections WHERE team = ?'),
    teamNotes: db.prepare('SELECT * FROM notes WHERE team = ? ORDER BY pinned DESC, updated DESC'),
    setTeam: db.prepare('UPDATE notes SET team = ?, section = ? WHERE id = ?'),

    /* ---- what happened, for the people who were not looking ---- */
    eventAdd: db.prepare(
      'INSERT INTO note_events (team, note, title, actor, kind, at) VALUES (?, ?, ?, ?, ?, ?)'
    ),
    eventsSince: db.prepare(`
      SELECT e.*, t.name AS team_name, p.name AS actor_name FROM note_events e
      JOIN teams t ON t.id = e.team
      JOIN players p ON p.player = e.actor
      JOIN team_members m ON m.team = e.team AND m.player = ?
      WHERE e.at > ? AND e.actor <> ?
      ORDER BY e.at LIMIT 100
    `),
    eventsTrim: db.prepare('DELETE FROM note_events WHERE at < ?'),

    /* ---- the diary ---- */
    schedAdd: db.prepare(`
      INSERT INTO schedule (id, owner, team, title, detail, at, created, updated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `),
    schedUpdate: db.prepare('UPDATE schedule SET title = ?, detail = ?, at = ?, updated = ? WHERE id = ?'),
    schedOne: db.prepare('SELECT * FROM schedule WHERE id = ?'),
    schedDrop: db.prepare('DELETE FROM schedule WHERE id = ?'),
    // Mine, plus every team I am in. A window rather than everything: a diary
    // is about what is coming, and yesterday is only kept so a thing that has
    // just happened does not vanish off the page while people are still
    // talking about it.
    schedFor: db.prepare(`
      SELECT s.*, p.name AS owner_name, t.name AS team_name FROM schedule s
      JOIN players p ON p.player = s.owner
      LEFT JOIN teams t ON t.id = s.team
      WHERE s.at BETWEEN ? AND ?
        AND (s.owner = ? OR s.team IN (SELECT team FROM team_members WHERE player = ?))
      ORDER BY s.at LIMIT 300
    `),
    schedTrim: db.prepare('DELETE FROM schedule WHERE at < ?'),
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

/**
 * A team's sections, creating the first one if it has none.
 *
 * The same rule as a personal notebook: there is always somewhere to put a
 * page, so nothing has to handle the case where there is not.
 */
function sectionsOfTeam(q, team) {
  let rows = q.teamSections.all(team);
  if (!rows.length) {
    const t = q.teamOne.get(team);
    q.sectionAdd.run(randomUUID(), t ? t.owner : '', 'Board', 0, Date.now(), team);
    rows = q.teamSections.all(team);
  }
  return rows.map((r) => ({ id: r.id, name: r.name, position: Number(r.position) }));
}

/** The teams this player is in, with who else is in them. */
function teamsFor(q, player) {
  return q.teamsOf.all(player).map((t) => ({
    id: t.id,
    name: t.name,
    role: t.role,
    owner: (q.nameOf.get(t.owner) || {}).name || 'unknown',
    members: q.membersOf.all(t.id).map((m) => ({ name: m.name, role: m.role })),
    sections: sectionsOfTeam(q, t.id),
  }));
}

/** Membership is the whole permission model for a team notebook. */
function memberOf(q, team, player) {
  return !!q.memberOne.get(team, player);
}

/**
 * Record what happened to a team's page.
 *
 * Only team pages: a private page changing is nobody else's business, and the
 * feed exists so the other members can be told. Old entries are dropped on the
 * way past rather than by a job, because this is the only writer.
 */
function recordEvent(q, note, kind, actor) {
  if (!note.team) return;
  const now = Date.now();
  q.eventAdd.run(note.team, note.id, String(note.title || '').slice(0, 120), actor, kind, now);
  q.eventsTrim.run(now - EVENT_KEEP_MS);
}

/** The diary as the client sees it, nearest first. */
function agendaFor(q, player) {
  const now = Date.now();
  return q.schedFor.all(now - AGENDA_PAST_MS, now + AGENDA_AHEAD_MS, player, player).map((row) => ({
    id: row.id,
    title: row.title,
    detail: row.detail || '',
    at: Number(row.at),
    team: row.team || '',
    teamName: row.team_name || '',
    owner: row.owner_name,
    mine: row.owner === player,
  }));
}

/**
 * A diary entry changing is news, so it goes in the same feed page edits do.
 *
 * The team hears "someone put something in the calendar" straight away; the
 * reminders before the thing itself are the app's job, on each member's own
 * machine, because a server that has to wake up at the right minute for every
 * member is a server with a scheduler in it.
 */
function recordSchedule(q, row, kind, actor) {
  if (!row || !row.team) return;
  const now = Date.now();
  q.eventAdd.run(row.team, row.id, String(row.title || '').slice(0, 120), actor, kind, now);
  q.eventsTrim.run(now - EVENT_KEEP_MS);
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
    team: row.team || '',
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
    const teams = teamsFor(q, player);
    send(res, 200, {
      signedIn: true,
      name: me ? me.name : '',
      sections: sectionsFor(q, player),
      mine: q.byOwner.all(player).map((row) => shape(q, row, player)),
      shared: q.sharedWith.all(player).map((row) => shape(q, row, player)),
      // The board is everyone's, including this player's own postings, so it
      // reads the same for whoever is looking at it.
      board: q.board.all().map((row) => shape(q, row, player)),
      // A team notebook and its pages travel together: the client draws one
      // notebook per team and needs both to do it.
      teams,
      teamNotes: teams.flatMap((t) => q.teamNotes.all(t.id).map((row) => shape(q, row, player))),
      schedule: agendaFor(q, player),
    });
    return true;
  }

  /* ---- the diary on its own, for whatever is watching the clock ---- */
  if (req.method === 'GET' && url.pathname === '/api/notes/schedule') {
    send(res, 200, { now: Date.now(), schedule: agendaFor(q, player) });
    return true;
  }

  /* ---- the diary: what is going to happen, and when ---- */
  if (post && url.pathname === '/api/notes/schedule') {
    const id = typeof body.id === 'string' ? body.id : '';
    const existing = id ? q.schedOne.get(id) : null;
    if (id && !existing) { send(res, 404, { error: 'That entry is gone.' }); return true; }
    // An entry is the author's, or the team's - and a team's is any member's to
    // correct, the same as its pages.
    if (existing) {
      const allowed = existing.owner === player
        || (existing.team && memberOf(q, existing.team, player));
      if (!allowed) { send(res, 403, { error: 'That entry is not yours.' }); return true; }
    }

    if (body.remove && existing) {
      q.schedDrop.run(existing.id);
      recordSchedule(q, existing, 'unscheduled', player);
      send(res, 200, { deleted: existing.id, schedule: agendaFor(q, player) });
      return true;
    }

    const title = clean(body.title, MAX_TITLE);
    // clean() answers null for both "not a string" and "too long"; a missing
    // detail is neither an error nor a detail.
    const detail = body.detail === undefined ? '' : clean(body.detail, 2000);
    const at = Number(body.at);
    if (!title) { send(res, 400, { error: 'An entry needs a title.' }); return true; }
    if (detail === null) { send(res, 400, { error: 'That detail is too long.' }); return true; }
    if (!Number.isFinite(at) || at <= 0) { send(res, 400, { error: 'An entry needs a time.' }); return true; }
    // Far enough out to plan a quarter, not so far that a typo in a year files
    // something in the next century.
    const now = Date.now();
    if (at < now - YEAR_MS || at > now + YEAR_MS) {
      send(res, 400, { error: 'That time is not within a year of now.' });
      return true;
    }

    const team = existing ? (existing.team || '') : (typeof body.team === 'string' ? body.team : '');
    if (team && !memberOf(q, team, player)) { send(res, 404, { error: 'No such team.' }); return true; }

    if (existing) {
      q.schedUpdate.run(title, detail, at, now, existing.id);
      recordSchedule(q, q.schedOne.get(existing.id), 'rescheduled', player);
    } else {
      const made = randomUUID();
      q.schedAdd.run(made, player, team || null, title, detail, at, now, now);
      recordSchedule(q, q.schedOne.get(made), 'scheduled', player);
    }
    // Things that happened a fortnight ago are nobody's plan any more.
    q.schedTrim.run(now - AGENDA_PAST_MS * 2);
    send(res, 200, { schedule: agendaFor(q, player) });
    return true;
  }

  /* ---- what changed in my teams since I last looked ---- */
  if (req.method === 'GET' && url.pathname === '/api/notes/events') {
    const since = Number(url.searchParams.get('since')) || 0;
    const rows = q.eventsSince.all(player, since, player);
    send(res, 200, {
      now: Date.now(),
      events: rows.map((e) => ({
        id: Number(e.id),
        team: e.team,
        teamName: e.team_name,
        note: e.note,
        title: e.title,
        who: e.actor_name,
        kind: e.kind,
        at: Number(e.at),
      })),
    });
    return true;
  }

  /* ---- teams: a notebook with more than one person in it ---- */
  if (post && url.pathname === '/api/notes/team') {
    const id = typeof body.id === 'string' ? body.id : '';
    const team = id ? q.teamOne.get(id) : null;
    if (id && !team) { send(res, 404, { error: 'No such team.' }); return true; }
    // Everything but reading is the owner's: a shared notebook with shared
    // administration is a notebook anyone can dissolve.
    if (team && team.owner !== player) { send(res, 403, { error: 'That team is not yours.' }); return true; }

    if (body.remove && team) {
      // Its pages are not destroyed with it. Each goes back to the notebook of
      // whoever wrote it - not to the team's owner, who never wrote it and
      // would be inheriting other people's pages by deleting something.
      for (const row of q.teamNotes.all(team.id)) {
        const home = sectionsFor(q, row.owner)[0];
        q.setTeam.run(null, home.id, row.id);
      }
      for (const sec of q.teamSections.all(team.id)) q.sectionDrop.run(sec.id);
      q.memberDropAll.run(team.id);
      q.teamDrop.run(team.id);
      console.log(`[notes] ${player} deleted team ${team.id} (${JSON.stringify(team.name).slice(0, 40)})`);
      send(res, 200, { teams: teamsFor(q, player) });
      return true;
    }

    const name = clean(body.name, 60);
    if (!name) { send(res, 400, { error: 'A team needs a name.' }); return true; }

    if (team) {
      q.teamRename.run(name, team.id);
      send(res, 200, { teams: teamsFor(q, player) });
      return true;
    }
    if (Number(q.teamCountOf.get(player).n) >= MAX_TEAMS_PER_PLAYER) {
      send(res, 409, { error: `That is ${MAX_TEAMS_PER_PLAYER} teams already.` });
      return true;
    }
    const made = randomUUID();
    const now = Date.now();
    q.teamAdd.run(made, name, player, now);
    q.memberAdd.run(made, player, 'owner', now);
    sectionsOfTeam(q, made);
    send(res, 200, { team: made, teams: teamsFor(q, player) });
    return true;
  }

  /* ---- who is in a team ---- */
  if (post && url.pathname === '/api/notes/team/member') {
    const team = q.teamOne.get(String(body.id || ''));
    if (!team || !memberOf(q, team.id, player)) { send(res, 404, { error: 'No such team.' }); return true; }

    const name = clean(body.name, 24);
    const who = name ? q.playerByName.get(name.toLowerCase()) : null;
    if (!who) { send(res, 404, { error: 'No player by that name.' }); return true; }

    if (body.remove) {
      // The owner removes anyone; anyone may remove themselves, which is what
      // leaving a team is. Nobody removes the owner - the team would be left
      // with no one able to administer it.
      const self = who.player === player;
      if (!self && team.owner !== player) { send(res, 403, { error: 'Only the team owner does that.' }); return true; }
      if (who.player === team.owner) { send(res, 400, { error: 'The owner cannot be removed. Delete the team instead.' }); return true; }
      q.memberDrop.run(team.id, who.player);
      send(res, 200, { teams: teamsFor(q, player) });
      return true;
    }

    if (team.owner !== player) { send(res, 403, { error: 'Only the team owner invites.' }); return true; }
    if (q.membersOf.all(team.id).length >= MAX_MEMBERS_PER_TEAM) {
      send(res, 409, { error: `That is ${MAX_MEMBERS_PER_TEAM} members already.` });
      return true;
    }
    q.memberAdd.run(team.id, who.player, 'member', Date.now());
    send(res, 200, { teams: teamsFor(q, player) });
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
      // able to "manage" a shared note means. A page in a team notebook is the
      // team's, so any member may edit it - that is what the notebook is for.
      const allowed = row.owner === player
        || q.isSharedWith.get(row.id, player)
        || (row.team && memberOf(q, row.team, player));
      if (!allowed) { send(res, 403, { error: 'That note is not yours.' }); return true; }
      // Being able to read the board is not being able to edit it: only the
      // author moves a note on or off it.
      const onBoard = row.owner === player ? board : row.board;
      q.update.run(kind, title, text, pinned, onBoard, rich ? 1 : 0, now, row.id);
      if (typeof body.section === 'string' && body.section) {
        const target = q.sectionOne.get(body.section);
        // Into one of my own sections, or into a section of a team I am in.
        const canFile = target && (
          (row.owner === player && target.owner === player && !target.team)
          || (target.team && memberOf(q, target.team, player))
        );
        if (canFile) {
          if (target.team) q.setTeam.run(target.team, target.id, row.id);
          else q.setSection.run(target.id, row.id);
        }
      }
      const after = q.one.get(row.id);
      recordEvent(q, after, 'edited', player);
      send(res, 200, { note: shape(q, after, player) });
      return true;
    }

    if (Number(q.countFor.get(player).n) >= MAX_NOTES_PER_PLAYER) {
      send(res, 409, { error: `That is ${MAX_NOTES_PER_PLAYER} notes. Delete one first.` });
      return true;
    }
    const id = randomUUID();
    // A page belongs to a section, and the section says which notebook it is
    // in. A team's section is only offered to a member of that team; anything
    // else falls back to the account's own first section.
    let target = null;
    if (typeof body.section === 'string' && body.section) {
      const sec = q.sectionOne.get(body.section);
      if (sec && sec.team && memberOf(q, sec.team, player)) target = sec;
      else if (sec && !sec.team && sec.owner === player) target = sec;
    }
    if (!target && typeof body.team === 'string' && body.team && memberOf(q, body.team, player)) {
      const first = sectionsOfTeam(q, body.team)[0];
      target = q.sectionOne.get(first.id);
    }
    if (!target) target = q.sectionOne.get(sectionsFor(q, player)[0].id);

    q.insert.run(id, player, kind, title, text, pinned, board, rich ? 1 : 0,
      target.id, target.team || null, now, now);
    const made = q.one.get(id);
    recordEvent(q, made, 'added', player);
    send(res, 200, { note: shape(q, made, player) });
    return true;
  }

  /* ---- delete, or leave a note shared with you ---- */
  if (post && url.pathname === '/api/notes/delete') {
    const row = q.one.get(String(body.id || ''));
    if (!row) { send(res, 404, { error: 'That note is gone.' }); return true; }

    // In a team notebook the page belongs to the team: its author deletes it,
    // and so does the team's owner, who is the one answerable for the notebook.
    const teamOwner = row.team && (q.teamOne.get(row.team) || {}).owner === player;
    if (row.owner === player || teamOwner) {
      // Logged because a note going missing is not something to have to guess
      // about later; this is the only path that destroys one.
      console.log(`[notes] ${player} deleted ${row.id} (${JSON.stringify(row.title).slice(0, 60)})`);
      recordEvent(q, row, 'removed', player);
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
    // A section belongs either to an account or to a team, and the answer to
    // "may I touch this" is different for each.
    const team = existing ? (existing.team || '') : (typeof body.team === 'string' ? body.team : '');
    if (team && !memberOf(q, team, player)) { send(res, 404, { error: 'No such team.' }); return true; }
    if (id && (!existing || (!existing.team && existing.owner !== player))) {
      send(res, 404, { error: 'No such section.' });
      return true;
    }
    const listOf = () => (team ? sectionsOfTeam(q, team) : sectionsFor(q, player));

    if (body.remove && existing) {
      const sections = listOf();
      if (sections.length < 2) { send(res, 400, { error: 'A notebook keeps at least one section.' }); return true; }
      // Its pages move rather than disappear; deleting a tab should never be a
      // way to lose a page by accident.
      const fallback = sections.find((x) => x.id !== existing.id);
      for (const row of q.notesInSection.all(existing.id)) q.setSection.run(fallback.id, row.id);
      q.sectionDrop.run(existing.id);
      send(res, 200, { sections: listOf(), teams: teamsFor(q, player) });
      return true;
    }

    if (!name) { send(res, 400, { error: 'A section needs a name.' }); return true; }

    if (existing) {
      q.sectionRename.run(name, existing.id);
      if (Number.isInteger(body.position)) q.sectionMove.run(body.position, existing.id);
    } else {
      const next = Number((team ? q.teamSectionMax.get(team) : q.sectionMax.get(player)).p) + 1;
      q.sectionAdd.run(randomUUID(), player, name, next, Date.now(), team || null);
    }
    send(res, 200, { sections: listOf(), teams: teamsFor(q, player) });
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
