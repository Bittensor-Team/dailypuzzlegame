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
  ok('and the note survives', (await call(`notes?token=${at}`)).body.mine.length === 1);

  ok('a title has a limit',
    (await call('notes', { token: at, title: 'x'.repeat(200), body: 'y' })).status === 400);
  ok('an empty note is refused',
    (await call('notes', { token: at, title: '   ', body: '\n\n' })).status === 400);

  const ctrl = await call('notes', { token: at, title: 'clean', body: 'keep\tthis\nand thisnot that' });
  ok('control characters are stripped', ctrl.body.note.body === 'keep\tthis\nand thisnot that', ctrl.body.note);

  const gone = await call('notes/delete', { token: at, id });
  ok('the owner deletes', gone.status === 200 && gone.body.deleted === id, gone);
  ok('and it is gone for the owner too', (await call(`notes?token=${at}`)).body.mine.length === 1);

  console.log(failed ? `\n${failed} FAILED` : '\nall notes assertions passed');
  process.exit(failed ? 1 : 0);
})();
