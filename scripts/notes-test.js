'use strict';
// Exercises the notes endpoints against a locally running api.js with a
// throwaway database: two accounts, a note, a share, an edit from the other
// side, and the permission boundaries.
const BASE = process.env.BASE || 'http://127.0.0.1:8791/api';

let failed = 0;
function ok(name, cond, extra) {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : '  ' + JSON.stringify(extra)}`);
  if (!cond) failed++;
}

async function call(path, body) {
  const res = await fetch(`${BASE}/${path}`, body
    ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    : undefined);
  return { status: res.status, body: await res.json().catch(() => null) };
}

(async () => {
  const stamp = Date.now().toString(36);
  const alice = `alice_${stamp}`;
  const bob = `bob_${stamp}`;

  const a = await call('register', { name: alice, password: 'correct horse battery' });
  const b = await call('register', { name: bob, password: 'correct horse battery' });
  // A third account that is in nothing, for the "can a stranger" half of every
  // permission question.
  const c = await call('register', { name: `carol_${stamp}`, password: 'correct horse battery' });
  const ct = c.body.token;
  ok('two accounts register', a.status === 200 && b.status === 200, [a, b]);
  const at = a.body.token;
  const bt = b.body.token;

  ok('notes need a session', (await call('notes')).status === 401);

  const made = await call('notes', {
    token: at, kind: 'command', title: 'restart the poller',
    body: 'pm2 restart scoreboard\npm2 logs --lines 50', pinned: true,
  });
  ok('a note is created', made.status === 200 && made.body.note.id, made);
  const id = made.body.note && made.body.note.id;
  ok('pinned and kind survive', made.body.note.pinned === true && made.body.note.kind === 'command', made.body.note);

  const mine = await call(`notes?token=${at}`);
  ok('it comes back in mine', mine.body.mine.length === 1 && mine.body.mine[0].id === id, mine.body);
  ok('nothing is shared with me yet', mine.body.shared.length === 0, mine.body);

  const strangers = await call(`notes?token=${bt}`);
  ok('another account cannot see it', strangers.body.mine.length === 0 && strangers.body.shared.length === 0);

  ok('a stranger cannot edit it',
    (await call('notes', { token: bt, id, title: 'hijacked', body: 'x' })).status === 403);
  ok('a stranger cannot delete it',
    (await call('notes/delete', { token: bt, id })).status === 403);
  ok('sharing with nobody fails',
    (await call('notes/share', { token: at, id, name: 'nobody_at_all' })).status === 404);

  const shared = await call('notes/share', { token: at, id, name: bob });
  ok('it shares by nickname', shared.status === 200 && shared.body.note.sharedWith.includes(bob), shared.body);

  const bobSees = await call(`notes?token=${bt}`);
  ok('the other account sees it', bobSees.body.shared.length === 1 && bobSees.body.shared[0].id === id);
  ok('and knows it is not theirs', bobSees.body.shared[0].mine === false);
  ok('and is told whose it is', bobSees.body.shared[0].owner === alice, bobSees.body.shared[0]);
  ok('but not who else has it', bobSees.body.shared[0].sharedWith.length === 0);

  const edited = await call('notes', { token: bt, id, kind: 'command', title: 'restart the poller', body: 'pm2 restart scoreboard' });
  ok('a recipient may edit', edited.status === 200 && edited.body.note.body === 'pm2 restart scoreboard', edited);

  ok('only the owner may share',
    (await call('notes/share', { token: bt, id, name: alice })).status === 403);

  const left = await call('notes/delete', { token: bt, id });
  ok('a recipient leaves rather than deletes', left.status === 200 && left.body.left === id, left);
  ok('and the note survives', (await call(`notes?token=${at}`)).body.mine.some((n) => n.id === id));

  ok('a title has a limit',
    (await call('notes', { token: at, title: 'x'.repeat(200), body: 'y' })).status === 400);
  ok('an empty note is refused',
    (await call('notes', { token: at, title: '   ', body: '\n\n' })).status === 400);

  const ctrl = await call('notes', { token: at, title: 'clean', body: 'keep\tthis\nand thisnot that' });
  ok('control characters are stripped', ctrl.body.note.body === 'keep\tthis\nand thisnot that', ctrl.body.note);

  /* ---- the team board ---- */
  const posted = await call('notes', { token: at, title: 'deploy window', body: 'Friday 18:00 UTC', board: true });
  ok('a note can be put on the board', posted.status === 200 && posted.body.note.board === true, posted.body);
  const boardId = posted.body.note.id;

  const bobBoard = await call(`notes?token=${bt}`);
  ok('everyone signed in sees the board',
    bobBoard.body.board.some((n) => n.id === boardId), bobBoard.body.board);
  ok('and knows who posted it',
    bobBoard.body.board.find((n) => n.id === boardId).owner === alice);
  ok('a private note stays off the board',
    !bobBoard.body.board.some((n) => n.title === 'clean'), bobBoard.body.board.map((n) => n.title));

  const hijack = await call('notes', { token: bt, id: boardId, title: 'deploy window', body: 'cancelled' });
  ok('reading the board is not editing it', hijack.status === 403, hijack);
  ok('nor deleting from it',
    (await call('notes/delete', { token: bt, id: boardId })).status === 403);

  const pulled = await call('notes', { token: at, id: boardId, title: 'deploy window', body: 'Friday 18:00 UTC', board: false });
  ok('the author can take it down', pulled.status === 200 && pulled.body.note.board === false, pulled.body);
  ok('and then nobody else sees it',
    !(await call(`notes?token=${bt}`)).body.board.some((n) => n.id === boardId));

  /* ---- sections ---- */
  const listed = await call(`notes?token=${at}`);
  ok('every account gets a section', listed.body.sections.length >= 1, listed.body.sections);
  ok('and its notes are in it', listed.body.mine.every((n) => n.section), listed.body.mine.map((n) => n.section));
  const first = listed.body.sections[0].id;

  const added = await call('notes/section', { token: at, name: 'Runbooks' });
  ok('a section is created', added.status === 200 && added.body.sections.length === 2, added.body);
  const runbooks = added.body.sections.find((x) => x.name === 'Runbooks').id;

  const filed = await call('notes', { token: at, title: 'in runbooks', body: 'x', section: runbooks });
  ok('a note can be filed in one', filed.body.note.section === runbooks, filed.body.note);

  ok('a stranger cannot rename it',
    (await call('notes/section', { token: bt, id: runbooks, name: 'theirs' })).status === 404);

  const renamed = await call('notes/section', { token: at, id: runbooks, name: 'Runbook' });
  ok('the owner renames it',
    renamed.body.sections.some((x) => x.name === 'Runbook'), renamed.body.sections);

  const dropped = await call('notes/section', { token: at, id: runbooks, remove: true });
  ok('deleting one keeps a section', dropped.status === 200 && dropped.body.sections.length === 1, dropped.body);
  const after = await call(`notes?token=${at}`);
  ok('and moves its pages rather than losing them',
    after.body.mine.some((n) => n.title === 'in runbooks' && n.section === first), after.body.mine.length);
  ok('the last section cannot be deleted',
    (await call('notes/section', { token: at, id: first, remove: true })).status === 400);

  /* ---- teams: a notebook with more than one person in it ---- */
  const team = await call('notes/team', { token: at, name: 'Validators' });
  ok('a team is created', team.status === 200 && team.body.team, team.body);
  const tid = team.body.team;
  ok('with its creator as owner and a section to write in',
    team.body.teams[0].role === 'owner' && team.body.teams[0].sections.length === 1, team.body.teams[0]);

  ok('a stranger cannot see it', !(await call(`notes?token=${bt}`)).body.teams.length);
  ok('nor add a page to it',
    (await call('notes', { token: bt, title: 'sneaky', body: 'x', team: tid })).body.note.team === '');

  const invited = await call('notes/team/member', { token: at, id: tid, name: bob });
  ok('the owner invites', invited.status === 200 && invited.body.teams[0].members.length === 2, invited.body.teams[0]);
  ok('and now the member sees the notebook',
    (await call(`notes?token=${bt}`)).body.teams.some((t) => t.id === tid));

  const tsec = team.body.teams[0].sections[0].id;
  const tpage = await call('notes', { token: bt, title: 'runbook', body: 'restart it', section: tsec });
  ok('a member adds a page to the team', tpage.body.note.team === tid, tpage.body.note);
  ok('and it is not in their own notebook',
    !(await call(`notes?token=${bt}`)).body.mine.some((n) => n.id === tpage.body.note.id));
  ok('but it is in the team notebook for both',
    (await call(`notes?token=${at}`)).body.teamNotes.some((n) => n.id === tpage.body.note.id));

  const teamEdit = await call('notes', { token: at, id: tpage.body.note.id, title: 'runbook', body: 'restart it twice' });
  ok('the other member edits it', teamEdit.status === 200 && teamEdit.body.note.body.includes('twice'), teamEdit.body);

  const tsec2 = await call('notes/section', { token: bt, team: tid, name: 'Incidents' });
  ok('a member adds a section to the team',
    tsec2.body.teams.find((t) => t.id === tid).sections.length === 2, tsec2.body.teams);

  const feed = await call(`notes/events?token=${bt}&since=0`);
  ok('the feed carries what the others did', feed.body.events.length >= 1, feed.body.events);
  ok('but never what I did myself',
    feed.body.events.every((e) => e.who !== bob), feed.body.events.map((e) => e.who));
  ok('and it says which team, page and person', feed.body.events.every(
    (e) => e.team === tid && e.title && e.who && e.kind), feed.body.events);

  ok('a member cannot invite', (await call('notes/team/member', { token: bt, id: tid, name: alice })).status === 403);
  ok('nor rename the team', (await call('notes/team', { token: bt, id: tid, name: 'theirs' })).status === 403);
  ok('but can leave it',
    (await call('notes/team/member', { token: bt, id: tid, name: bob, remove: true })).status === 200);
  ok('and then it is gone from their list', !(await call(`notes?token=${bt}`)).body.teams.length);
  ok('the owner cannot be removed',
    (await call('notes/team/member', { token: at, id: tid, name: alice, remove: true })).status === 400);

  const dissolved = await call('notes/team', { token: at, id: tid, remove: true });
  ok('the owner deletes the team', dissolved.status === 200 && !dissolved.body.teams.length, dissolved.body);
  // The page was bob's writing, so it goes back to bob - deleting a team must
  // not be a way to inherit other people's pages.
  const afterTeam = await call(`notes?token=${bt}`);
  ok('and its pages go back to whoever wrote them',
    afterTeam.body.mine.some((n) => n.id === tpage.body.note.id && !n.team), afterTeam.body.mine.map((n) => n.title));
  ok('not to the person who deleted the team',
    !(await call(`notes?token=${at}`)).body.mine.some((n) => n.id === tpage.body.note.id));

  /* ---- the diary ---- */
  const team2 = await call('notes/team', { token: at, name: 'Ops' });
  const t2 = team2.body.team;
  await call('notes/team/member', { token: at, id: t2, name: bob });

  const when = Date.now() + 45 * 60 * 1000;
  const booked = await call('notes/schedule', {
    token: at, team: t2, title: 'SN3 feature launch', detail: 'new weights go live', at: when,
  });
  ok('an entry is scheduled', booked.status === 200
    && booked.body.schedule.some((s) => s.title === 'SN3 feature launch'), booked.body);
  const entry = booked.body.schedule.find((s) => s.title === 'SN3 feature launch');
  ok('and it carries its time, team and author',
    entry.at === when && entry.team === t2 && entry.owner === alice, entry);

  const theirs = await call(`notes?token=${bt}`);
  ok('every member of the team sees it',
    theirs.body.schedule.some((s) => s.id === entry.id), theirs.body.schedule);

  const schedFeed = await call(`notes/events?token=${bt}&since=0`);
  ok('and is told it was put there',
    schedFeed.body.events.some((e) => e.kind === 'scheduled' && e.note === entry.id), schedFeed.body.events);

  const moved = await call('notes/schedule', { token: bt, id: entry.id, title: 'SN3 feature launch', at: when + 3600000 });
  ok('a member can move it', moved.status === 200
    && moved.body.schedule.find((s) => s.id === entry.id).at === when + 3600000, moved.body);

  ok('a stranger cannot', (await call('notes/schedule', {
    token: ct, id: entry.id, title: 'nope', at: when,
  })).status === 403);
  ok('nor even see it', !(await call(`notes?token=${ct}`)).body.schedule.length);

  ok('an entry needs a time', (await call('notes/schedule', { token: at, title: 'when?' })).status === 400);
  ok('and a title', (await call('notes/schedule', { token: at, at: when })).status === 400);
  ok('and a time this side of a century',
    (await call('notes/schedule', { token: at, title: 'typo', at: when + 40 * 365 * 86400000 })).status === 400);

  const mineOnly = await call('notes/schedule', { token: at, title: 'dentist', at: when });
  const personal = mineOnly.body.schedule.find((s) => s.title === 'dentist');
  ok('an entry with no team is private',
    personal && !personal.team && !(await call(`notes?token=${bt}`)).body.schedule.some((s) => s.id === personal.id),
    personal);

  const onlyDiary = await call(`notes/schedule?token=${bt}`);
  ok('the diary can be read on its own', onlyDiary.status === 200
    && onlyDiary.body.schedule.some((s) => s.id === entry.id) && onlyDiary.body.now > 0, onlyDiary.body);

  const unbooked = await call('notes/schedule', { token: at, id: entry.id, remove: true });
  ok('and it can be taken out of the diary',
    unbooked.status === 200 && !unbooked.body.schedule.some((s) => s.id === entry.id), unbooked.body);

  /* ---- rich text ---- */
  const rich = await call('notes', {
    token: at, title: 'formatted', html: true,
    body: '<p>keep <b>this</b> and <ul class="checklist"><li data-checked="true">done</li></ul></p>',
  });
  ok('markup on the allowlist survives',
    rich.body.note.body.includes('<b>this</b>') && rich.body.note.body.includes('data-checked="true"'), rich.body.note.body);
  ok('and it is marked as rich text', rich.body.note.html === true);

  const nasty = await call('notes', {
    token: at, title: 'nasty', html: true,
    body: '<p onclick="steal()">hi<script>fetch("//evil")</script><img src=x onerror=y><iframe src="//evil"></iframe></p>',
  });
  const kept = nasty.body.note.body;
  ok('scripts do not survive', !/<script/i.test(kept), kept);
  ok('nor iframes or images', !/<iframe|<img/i.test(kept), kept);
  ok('nor event handlers', !/onclick|onerror/i.test(kept), kept);
  ok('but the words do', kept.includes('hi'), kept);

  // A page that says `a && b` arrives as markup that already has the ampersand
  // escaped. Escaping it again would say `a &amp;&amp; b` on the way back, and
  // one level deeper on every save after that.
  const amp = await call('notes', {
    token: at, title: 'ampersands', html: true,
    body: '<pre>btcli s list &amp;&amp; echo &lt;done&gt;</pre>',
  });
  const once = amp.body.note.body;
  ok('an escaped ampersand is not escaped again',
    once === '<pre>btcli s list &amp;&amp; echo &lt;done&gt;</pre>', once);

  const again = await call('notes', { token: at, id: amp.body.note.id, html: true, title: 'ampersands', body: once });
  ok('and saving it back leaves it alone', again.body.note.body === once, again.body.note.body);

  const bare = await call('notes', {
    token: at, title: 'bare ampersand', html: true, body: '<p>tom & jerry</p>',
  });
  ok('a bare ampersand still gets escaped',
    bare.body.note.body === '<p>tom &amp; jerry</p>', bare.body.note.body);

  const gone = await call('notes/delete', { token: at, id });
  ok('the owner deletes', gone.status === 200 && gone.body.deleted === id, gone);
  ok('and it is gone for the owner too',
    !(await call(`notes?token=${at}`)).body.mine.some((n) => n.id === id));

  console.log(failed ? `\n${failed} FAILED` : '\nall notes assertions passed');
  process.exit(failed ? 1 : 0);
})();
