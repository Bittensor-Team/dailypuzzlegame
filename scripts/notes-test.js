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

  const gone = await call('notes/delete', { token: at, id });
  ok('the owner deletes', gone.status === 200 && gone.body.deleted === id, gone);
  ok('and it is gone for the owner too',
    !(await call(`notes?token=${at}`)).body.mine.some((n) => n.id === id));

  console.log(failed ? `\n${failed} FAILED` : '\nall notes assertions passed');
  process.exit(failed ? 1 : 0);
})();
