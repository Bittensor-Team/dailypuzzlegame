/*
 * Live battles — the browser half.
 *
 * The server owns the game. This file sends "pour tube A into tube B" and
 * paints whatever comes back over the event stream; it never decides that a
 * move was legal or that a board is solved. Local rules exist only to grey out
 * a tap that obviously cannot work, saving a round trip.
 *
 * Every player's board arrives on the same stream, so the opponent's tubes are
 * painted from the server's copy, not from anything the opponent's browser
 * claims.
 */
(function () {
  'use strict';

  var CAPACITY = 4;
  var COLOR_COUNT = 10;
  var TUBE_COUNT = COLOR_COUNT + 2;
  var COLOR_TAGS = ['R', 'O', 'Y', 'G', 'C', 'B', 'V', 'M', 'P', 'W'];
  var COLOR_NAMES = ['Red', 'Orange', 'Yellow', 'Green', 'Cyan', 'Blue', 'Violet', 'Magenta', 'Purple', 'White'];

  /* ------------------------------------------------------------------ */
  /* Small shared helpers, matching the daily puzzle's storage keys       */
  /* ------------------------------------------------------------------ */

  var store = {
    get: function (key, fallback) {
      try {
        var raw = localStorage.getItem(key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch (e) { return fallback; }
    },
    set: function (key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* private mode */ }
    }
  };

  var session = {
    token: function () { return store.get('dcp:token', null); },
    name: function () { return store.get('dcp:name', null); },
    save: function (token, name) { store.set('dcp:token', token); store.set('dcp:name', name); },
    clear: function () { store.set('dcp:token', null); store.set('dcp:name', null); }
  };

  var theme = (function () {
    var KEY = 'dcp:theme';
    function systemPref() {
      return (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches)
        ? 'light' : 'dark';
    }
    function current() {
      var saved = store.get(KEY, null);
      return saved === 'light' || saved === 'dark' ? saved : systemPref();
    }
    function apply(next) {
      document.documentElement.setAttribute('data-theme', next);
      var btn = document.getElementById('themeBtn');
      if (btn) {
        btn.innerHTML = next === 'dark' ? '&#9788;' : '&#9789;';
        btn.title = next === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
      }
      return next;
    }
    return {
      init: function () { apply(current()); },
      toggle: function () {
        var next = current() === 'dark' ? 'light' : 'dark';
        store.set(KEY, next);
        apply(next);
      }
    };
  })();

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function formatMs(ms) {
    if (ms === null || ms === undefined) return '—';
    var total = Math.round(ms / 1000);
    var m = Math.floor(total / 60);
    var sec = total % 60;
    return m > 0 ? m + 'm ' + (sec < 10 ? '0' : '') + sec + 's' : sec + 's';
  }

  function post(path, payload) {
    return fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (r) {
      return r.json().then(function (data) { return { ok: r.ok, status: r.status, data: data }; });
    });
  }

  /* Local mirror of the pour rule. Used only to reject a tap before it costs a
     round trip — the server checks the same thing and has the last word. */
  function topRun(tube) {
    if (tube.length === 0) return null;
    var color = tube[tube.length - 1];
    var count = 1;
    while (count < tube.length && tube[tube.length - 1 - count] === color) count++;
    return { color: color, count: count };
  }

  function canPour(tubes, from, to) {
    if (from === to) return false;
    var src = tubes[from], dst = tubes[to];
    if (src.length === 0) return false;
    if (dst.length >= CAPACITY) return false;
    if (dst.length > 0 && dst[dst.length - 1] !== src[src.length - 1]) return false;
    return true;
  }

  function isTubeDone(tube) {
    if (tube.length === 0) return true;
    if (tube.length !== CAPACITY) return false;
    for (var i = 1; i < tube.length; i++) if (tube[i] !== tube[0]) return false;
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* Elements                                                            */
  /* ------------------------------------------------------------------ */

  var el = {};
  ['themeBtn', 'whoamiChip', 'lobby', 'lobbyNote', 'quickBtn', 'createBtn', 'sizeSel',
   'joinForm', 'joinCode', 'room', 'roomCode', 'roomTag', 'roster', 'roomNote', 'startBtn',
   'leaveBtn', 'copyLinkBtn', 'arena', 'arenaCode', 'myMoves', 'mySelected', 'myBoard',
   'myProgress', 'solvedChip', 'rivals', 'veil', 'veilNum', 'undoBtn2', 'quitBtn',
   'resultOverlay', 'resultTitle', 'resultLine', 'resultTable', 'againBtn', 'authOverlay',
   'authForm', 'authName', 'authPass', 'authNote', 'authSubmit', 'authTitle', 'authBlurb',
   'authSwap', 'authSwapText', 'histBlock', 'battleHistory', 'parStat', 'parVal',
   'arenaLive', 'modeLabel', 'footYear'].forEach(function (id) {
    el[id] = document.getElementById(id);
  });

  /* ------------------------------------------------------------------ */
  /* State                                                               */
  /* ------------------------------------------------------------------ */

  var view = null;        // last state pushed by the server
  var selected = null;    // tube index picked up locally
  var stream = null;      // EventSource
  var myTubes = null;     // my board, from the server
  var countdownTimer = null;
  var skew = 0;           // server clock minus this browser's, in ms
  var boardBuilt = false;
  var tubeEls = [];

  function serverNow() { return Date.now() + skew; }

  function me() {
    if (!view) return null;
    for (var i = 0; i < view.players.length; i++) if (view.players[i].you) return view.players[i];
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* Screens                                                             */
  /* ------------------------------------------------------------------ */

  function show(which) {
    el.lobby.hidden = which !== 'lobby';
    el.room.hidden = which !== 'room';
    el.arena.hidden = which !== 'arena';
  }

  function note(node, message, bad) {
    node.textContent = message || '';
    node.classList.toggle('bad', !!bad);
  }

  /* ------------------------------------------------------------------ */
  /* Boards                                                              */
  /* ------------------------------------------------------------------ */

  function tubeHTML(tube, liftCount) {
    var html = '';
    for (var b = 0; b < tube.length; b++) {
      var lifted = liftCount && b >= tube.length - liftCount ? ' lifted' : '';
      html += '<div class="block c' + tube[b] + lifted + '">' +
        '<span class="tag">' + COLOR_TAGS[tube[b]] + '</span></div>';
    }
    // Blocks fill from the top; the empty slots sit below, so the movable
    // block is the lowest one. Same as the daily puzzle.
    for (var s = 0; s < CAPACITY - tube.length; s++) html += '<div class="slot"></div>';
    return html;
  }

  function describeTube(tubes, index) {
    var tube = tubes[index];
    if (tube.length === 0) return 'Tube ' + (index + 1) + ', empty';
    var names = tube.map(function (c) { return COLOR_NAMES[c]; });
    return 'Tube ' + (index + 1) + ', top to bottom: ' + names.join(', ') +
      '. Movable: ' + COLOR_NAMES[tube[tube.length - 1]] + ' at the bottom.';
  }

  function buildMyBoard() {
    if (boardBuilt) return;
    el.myBoard.innerHTML = '';
    tubeEls = [];
    for (var i = 0; i < TUBE_COUNT; i++) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tube';
      btn.dataset.index = String(i);
      el.myBoard.appendChild(btn);
      tubeEls.push(btn);
    }
    boardBuilt = true;
  }

  function renderMyBoard() {
    if (!myTubes) return;
    buildMyBoard();
    for (var i = 0; i < TUBE_COUNT; i++) {
      var tube = myTubes[i];
      var node = tubeEls[i];
      var run = topRun(tube);
      var lift = selected === i && run ? run.count : 0;
      node.innerHTML = tubeHTML(tube, lift);
      node.classList.toggle('selected', selected === i);
      node.classList.toggle('done', tube.length === CAPACITY && isTubeDone(tube));
      node.setAttribute('aria-label', describeTube(myTubes, i));
      node.setAttribute('aria-pressed', selected === i ? 'true' : 'false');
    }
    el.mySelected.textContent = selected === null ? 'None' : 'Tube ' + (selected + 1);
  }

  /* A rival is drawn from shape alone — the server sends how full each tube is
     and whether it is finished, never which colours are in it. Read-only, so
     plain markup rather than buttons. */
  function rivalHTML(p) {
    var shape = p.shape || [];
    var cells = '';
    for (var i = 0; i < shape.length; i++) {
      var blocks = '';
      for (var b = 0; b < shape[i].n; b++) blocks += '<div class="block block-mute"></div>';
      for (var e = 0; e < CAPACITY - shape[i].n; e++) blocks += '<div class="slot"></div>';
      cells += '<div class="tube tube-mini' + (shape[i].done ? ' tube-sealed' : '') + '">' +
        blocks + '</div>';
    }
    var status = p.solved ? '<span class="pill pill-win">solved</span>'
      : p.left ? '<span class="pill pill-gone">left</span>'
      : p.here ? '<span class="pill pill-live">playing</span>'
      : '<span class="pill pill-gone">away</span>';
    return '<article class="side side-rival' + (p.solved ? ' is-solved' : '') + '">' +
      '<header class="side-head"><span class="side-name">' + esc(p.name) + '</span>' + status +
      '</header>' +
      '<p class="side-meta"><b>' + p.moves + '</b> moves &middot; <b>' + p.done + '</b>/10 done</p>' +
      '<div class="board board-mini">' + cells + '</div>' +
      '<div class="side-bar"><span class="side-fill" data-pct="' + p.percent + '"></span></div>' +
      '</article>';
  }

  // A style attribute would be refused by the page's CSP, so the bar width is
  // applied through the CSSOM instead.
  function paintRivalStyles() {
    el.rivals.querySelectorAll('.side-fill[data-pct]').forEach(function (bar) {
      bar.style.width = bar.getAttribute('data-pct') + '%';
    });
  }

  function renderArena() {
    var mine = me();
    if (!mine) return;
    el.myMoves.textContent = String(mine.moves);
    el.arenaCode.textContent = view.code;
    el.solvedChip.hidden = !mine.solved;
    el.myProgress.innerHTML = '<b>' + mine.done + '</b>/10 tubes done';
    if (view.par) { el.parStat.hidden = false; el.parVal.textContent = String(view.par); }

    var rivals = view.players.filter(function (p) { return !p.you; });
    el.rivals.innerHTML = rivals.map(rivalHTML).join('');
    paintRivalStyles();
    el.rivals.classList.toggle('rivals-many', rivals.length > 1);
    renderMyBoard();
  }

  /* ------------------------------------------------------------------ */
  /* Countdown                                                           */
  /* ------------------------------------------------------------------ */

  function runCountdown() {
    if (countdownTimer) clearInterval(countdownTimer);
    function tick() {
      var left = view.startAt - serverNow();
      if (left <= 0) {
        el.veil.hidden = true;
        clearInterval(countdownTimer);
        countdownTimer = null;
        return;
      }
      el.veil.hidden = false;
      el.veilNum.textContent = String(Math.ceil(left / 1000));
    }
    tick();
    countdownTimer = setInterval(tick, 100);
  }

  function started() {
    return !!view && view.status === 'live' && serverNow() >= view.startAt;
  }

  /* ------------------------------------------------------------------ */
  /* Applying server state                                               */
  /* ------------------------------------------------------------------ */

  function apply(next) {
    var wasStatus = view ? view.status : null;
    view = next;
    // A browser clock can sit minutes away from the server's. The offset is
    // measured once per frame, at the instant it lands, and every later
    // comparison goes through serverNow() — recomputing it on each call would
    // fold the elapsed time back in and the countdown would never expire.
    skew = view.now - Date.now();
    var mine = me();
    if (mine && mine.tubes) myTubes = mine.tubes;

    if (view.status === 'open') {
      show('room');
      renderRoom();
    } else if (view.status === 'live') {
      if (wasStatus !== 'live') { boardBuilt = false; selected = null; }
      show('arena');
      renderArena();
      if (view.startAt > serverNow()) runCountdown();
      else el.veil.hidden = true;
    } else if (view.status === 'done') {
      show('arena');
      renderArena();
      el.veil.hidden = true;
      showResult();
    }
    history.replaceState(null, '', 'battle.html?b=' + view.code);
  }

  function renderRoom() {
    el.roomCode.textContent = view.code;
    el.roomTag.textContent = view.mode === 'quick' ? 'quick match' : 'private room';
    el.roster.innerHTML = view.players.map(function (p) {
      return '<li class="roster-row' + (p.you ? ' me' : '') + '">' +
        '<span class="roster-name">' + esc(p.name) + (p.you ? ' <span class="pb">you</span>' : '') + '</span>' +
        (p.player === view.host ? '<span class="pill">host</span>' : '') +
        '</li>';
    }).join('') + Array(Math.max(0, view.size - view.players.length)).fill(
      '<li class="roster-row empty"><span class="roster-name">waiting&hellip;</span></li>').join('');

    var missing = view.size - view.players.length;
    note(el.roomNote, missing > 0
      ? 'Waiting for ' + missing + ' more player' + (missing === 1 ? '' : 's') +
        '. The battle starts by itself when the room fills.'
      : 'Starting…');
    // Below a full room the host may start early; a solo room cannot.
    el.startBtn.hidden = !(view.youAreHost && view.players.length >= 2 && missing > 0);
  }

  function showResult() {
    var mine = me();
    var winner = null;
    for (var i = 0; i < view.players.length; i++) {
      if (view.players[i].player === view.winner) winner = view.players[i];
    }
    var iWon = mine && view.winner === mine.player;
    el.resultTitle.textContent = iWon ? 'You win' : 'Battle over';
    // textContent escapes on its own; running esc() here would show &amp;.
    el.resultLine.textContent = winner
      ? (iWon ? 'Solved in ' + mine.moves + ' moves, ' + formatMs(mine.ms) + '.'
              : winner.name + ' solved it first in ' + winner.moves + ' moves, ' + formatMs(winner.ms) + '.')
      : 'Nobody finished.';

    var rows = view.players.slice().sort(function (a, b) {
      return (a.place || 99) - (b.place || 99);
    });
    el.resultTable.innerHTML = '<table class="lb"><thead><tr>' +
      '<th>#</th><th>Player</th><th class="moves">Moves</th><th class="tries">Time</th>' +
      '</tr></thead><tbody>' + rows.map(function (p) {
        return '<tr class="' + (p.you ? 'me' : '') + '">' +
          '<td class="rank">' + (p.place || '—') + '</td>' +
          '<td class="date">' + esc(p.name) + (p.you ? ' <span class="pb">you</span>' : '') + '</td>' +
          '<td class="moves">' + p.moves + '</td>' +
          '<td class="tries">' + (p.solved ? formatMs(p.ms) : 'did not finish') + '</td></tr>';
      }).join('') + '</tbody></table>';
    el.resultOverlay.hidden = false;
  }

  /* ------------------------------------------------------------------ */
  /* Stream                                                              */
  /* ------------------------------------------------------------------ */

  function connect(battleId) {
    if (stream) { stream.close(); stream = null; }
    var url = '/api/battle/stream?battle=' + encodeURIComponent(battleId) +
      '&token=' + encodeURIComponent(session.token() || '');
    stream = new EventSource(url);
    stream.addEventListener('state', function (e) {
      el.arenaLive.classList.remove('off');
      try { apply(JSON.parse(e.data)); } catch (err) { /* ignore a torn frame */ }
    });
    stream.onerror = function () {
      // EventSource reconnects on its own; just say so while it is down.
      el.arenaLive.classList.add('off');
    };
  }

  /* ------------------------------------------------------------------ */
  /* Moves                                                               */
  /* ------------------------------------------------------------------ */

  function sendMove(payload) {
    payload.token = session.token();
    payload.battle = view.battle;
    return post('/api/battle/move', payload).then(function (r) {
      if (r.ok) { apply(r.data); return; }
      // A rejected move means this client's picture drifted; the reply carries
      // the authoritative one when it can.
      if (r.data && r.data.state) apply(r.data.state);
      if (r.status === 400) nudge();
    });
  }

  function nudge() {
    el.myBoard.classList.remove('shake');
    void el.myBoard.offsetWidth;
    el.myBoard.classList.add('shake');
  }

  function tap(index) {
    if (!started() || !myTubes) return;
    var mine = me();
    if (mine && mine.solved) return;

    if (selected === null) {
      if (myTubes[index].length === 0) return;
      selected = index;
      renderMyBoard();
      return;
    }
    if (selected === index) { selected = null; renderMyBoard(); return; }
    if (!canPour(myTubes, selected, index)) { nudge(); return; }

    var from = selected;
    selected = null;
    sendMove({ from: from, to: index });
  }

  el.myBoard.addEventListener('click', function (e) {
    var node = e.target.closest('.tube');
    if (node) tap(Number(node.dataset.index));
  });

  el.undoBtn2.addEventListener('click', function () {
    if (started()) sendMove({ undo: true });
  });

  document.addEventListener('keydown', function (e) {
    if (el.arena.hidden) return;
    if (e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
    var keys = '1234567890-=';
    var i = keys.indexOf(e.key);
    if (i >= 0 && i < TUBE_COUNT) { tap(i); return; }
    if (e.key === 'Escape') { selected = null; renderMyBoard(); }
    if (e.key === 'u' || e.key === 'U') el.undoBtn2.click();
  });

  /* ------------------------------------------------------------------ */
  /* HUD dropdown                                                        */
  /* ------------------------------------------------------------------ */

  /* Replaces a native <select>, whose popup the browser paints in its own
     colours — white on white against this theme. Owning the list means owning
     the keyboard too, so everything a select gave for free is rebuilt here. */
  function hudSelect(root) {
    var button = root.querySelector('.hudsel-btn');
    var label = root.querySelector('.hudsel-btn span:first-child');
    var list = root.querySelector('.hudsel-list');
    var opts = [].slice.call(root.querySelectorAll('.hudsel-opt'));
    var value = null;
    var active = 0;

    function paint() {
      opts.forEach(function (o, i) {
        var chosen = o.getAttribute('data-value') === value;
        o.setAttribute('aria-selected', chosen ? 'true' : 'false');
        o.classList.toggle('active', i === active);
        if (chosen) label.innerHTML = o.innerHTML;
      });
    }

    /* The list lives at the end of <body> while open. Inside the card it was
       cut off by the card's clip-path, which clips descendants as well. */
    function place() {
      var r = button.getBoundingClientRect();
      list.style.left = r.left + 'px';
      list.style.width = r.width + 'px';
      var room = window.innerHeight - r.bottom;
      var wanted = Math.min(list.scrollHeight, 244);
      if (room < wanted + 12 && r.top > wanted + 12) {
        list.style.top = (r.top - wanted - 5) + 'px';   // flip up near the fold
      } else {
        list.style.top = (r.bottom + 5) + 'px';
      }
    }

    function open() {
      document.body.appendChild(list);
      list.hidden = false;
      root.classList.add('open');
      button.setAttribute('aria-expanded', 'true');
      active = Math.max(0, opts.findIndex(function (o) { return o.getAttribute('data-value') === value; }));
      paint();
      place();
      opts[active].scrollIntoView({ block: 'nearest' });
    }

    function close(refocus) {
      list.hidden = true;
      root.classList.remove('open');
      button.setAttribute('aria-expanded', 'false');
      if (refocus) button.focus();
    }

    // A fixed layer does not follow its button, so it closes rather than
    // hovering somewhere wrong.
    window.addEventListener('resize', function () { if (!list.hidden) close(false); });
    window.addEventListener('scroll', function () { if (!list.hidden) close(false); }, true);

    function choose(i) {
      value = opts[i].getAttribute('data-value');
      active = i;
      paint();
      close(true);
    }

    button.addEventListener('click', function () {
      if (list.hidden) open(); else close(false);
    });

    opts.forEach(function (o, i) {
      o.addEventListener('click', function () { choose(i); });
      o.addEventListener('mousemove', function () { active = i; paint(); });
    });

    root.addEventListener('keydown', function (e) {
      var openNow = !list.hidden;
      if (e.key === 'Escape' && openNow) { close(true); e.preventDefault(); return; }
      if ((e.key === 'Enter' || e.key === ' ') && openNow) { choose(active); e.preventDefault(); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!openNow) { open(); return; }
        active = (active + (e.key === 'ArrowDown' ? 1 : opts.length - 1)) % opts.length;
        paint();
        opts[active].scrollIntoView({ block: 'nearest' });
        return;
      }
      if (e.key === 'Home' && openNow) { active = 0; paint(); e.preventDefault(); }
      if (e.key === 'End' && openNow) { active = opts.length - 1; paint(); e.preventDefault(); }
    });

    // Clicking anywhere else closes it, the way a real select behaves.
    document.addEventListener('click', function (e) {
      if (!list.hidden && !root.contains(e.target)) close(false);
    });

    value = (opts.find(function (o) { return o.getAttribute('aria-selected') === 'true'; }) || opts[0])
      .getAttribute('data-value');
    paint();

    return { value: function () { return value; } };
  }

  var sizePick = hudSelect(el.sizeSel);

  /* ------------------------------------------------------------------ */
  /* Lobby actions                                                       */
  /* ------------------------------------------------------------------ */

  function enter(result) {
    if (!result.ok) {
      note(el.lobbyNote, (result.data && result.data.error) || 'Could not start that battle.', true);
      if (result.status === 401) gate(true);
      return;
    }
    note(el.lobbyNote, '');
    apply(result.data);
    connect(result.data.battle);
  }

  el.quickBtn.addEventListener('click', function () {
    note(el.lobbyNote, 'Looking for an opponent…');
    post('/api/battle/quick', { token: session.token() }).then(enter);
  });

  el.createBtn.addEventListener('click', function () {
    post('/api/battle/create', { token: session.token(), size: Number(sizePick.value()) }).then(enter);
  });

  el.joinForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var code = el.joinCode.value.trim().toUpperCase();
    if (code.length < 4) { note(el.lobbyNote, 'That code looks too short.', true); return; }
    post('/api/battle/join', { token: session.token(), code: code }).then(enter);
  });

  el.startBtn.addEventListener('click', function () {
    post('/api/battle/start', { token: session.token(), battle: view.battle }).then(function (r) {
      if (!r.ok) note(el.roomNote, r.data.error || 'Could not start.', true);
    });
  });

  function leave() {
    if (view) post('/api/battle/leave', { token: session.token(), battle: view.battle });
    if (stream) { stream.close(); stream = null; }
    view = null; myTubes = null; selected = null; boardBuilt = false;
    el.resultOverlay.hidden = true;
    history.replaceState(null, '', 'battle.html');
    show('lobby');
    loadHistory();
  }

  el.leaveBtn.addEventListener('click', leave);
  el.quitBtn.addEventListener('click', function () {
    if (view && view.status === 'live' && !confirm('Forfeit this battle?')) return;
    leave();
  });
  el.againBtn.addEventListener('click', leave);

  el.copyLinkBtn.addEventListener('click', function () {
    var link = location.origin + '/battle.html?b=' + view.code;
    var done = function () {
      el.copyLinkBtn.textContent = 'Copied';
      setTimeout(function () { el.copyLinkBtn.textContent = 'Copy invite link'; }, 1400);
    };
    if (navigator.clipboard) navigator.clipboard.writeText(link).then(done, function () { prompt('Copy this link', link); });
    else prompt('Copy this link', link);
  });

  el.themeBtn.addEventListener('click', function () { theme.toggle(); });

  /* Leaving the tab open in a dead battle helps nobody; tell the server so the
     opponent is not left staring at a frozen board. */
  window.addEventListener('pagehide', function () {
    if (view && navigator.sendBeacon) {
      navigator.sendBeacon('/api/battle/leave', new Blob(
        [JSON.stringify({ token: session.token(), battle: view.battle })],
        { type: 'application/json' }));
    }
  });

  /* ------------------------------------------------------------------ */
  /* History                                                             */
  /* ------------------------------------------------------------------ */

  function loadHistory() {
    if (!session.token()) return;
    fetch('/api/battle/history?token=' + encodeURIComponent(session.token()))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || !d.history.length) { el.histBlock.hidden = true; return; }
        el.histBlock.hidden = false;
        el.battleHistory.innerHTML = '<table class="lb"><thead><tr>' +
          '<th>Result</th><th>Code</th><th class="moves">Moves</th><th class="tries">Time</th>' +
          '</tr></thead><tbody>' + d.history.map(function (h) {
            return '<tr class="' + (h.won ? 'me' : '') + '">' +
              '<td class="date">' + (h.won ? 'Won' : '#' + (h.place || '—')) + '</td>' +
              '<td class="date">' + esc(h.code) + '</td>' +
              '<td class="moves">' + h.moves + '</td>' +
              '<td class="tries">' + formatMs(h.ms) + '</td></tr>';
          }).join('') + '</tbody></table>';
      })
      .catch(function () { /* history is a nicety */ });
  }

  /* ------------------------------------------------------------------ */
  /* Auth gate                                                           */
  /* ------------------------------------------------------------------ */

  var registering = false;

  function gate(on) {
    el.authOverlay.hidden = !on;
    if (on) setTimeout(function () { el.authName.focus(); }, 50);
  }

  function paintAuth() {
    el.authTitle.textContent = registering ? 'Create an account' : 'Sign in to battle';
    el.authSubmit.textContent = registering ? 'Create account' : 'Sign in';
    el.authSwapText.textContent = registering ? 'Already have one?' : 'No account yet?';
    el.authSwap.textContent = registering ? 'Sign in' : 'Create one';
    el.authPass.setAttribute('autocomplete', registering ? 'new-password' : 'current-password');
  }

  el.authSwap.addEventListener('click', function () {
    registering = !registering;
    note(el.authNote, '');
    paintAuth();
  });

  el.authForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var name = el.authName.value.trim();
    var pass = el.authPass.value;
    if (!name) { note(el.authNote, 'Pick a nickname.', true); return; }
    if (pass.length < 8) { note(el.authNote, 'Passwords are at least 8 characters.', true); return; }
    el.authSubmit.disabled = true;
    post(registering ? '/api/register' : '/api/login', { name: name, password: pass })
      .then(function (r) {
        el.authSubmit.disabled = false;
        if (!r.ok) { note(el.authNote, r.data.error || 'That did not work.', true); return; }
        session.save(r.data.token, r.data.name);
        gate(false);
        ready();
      })
      .catch(function () {
        el.authSubmit.disabled = false;
        note(el.authNote, 'Could not reach the server.', true);
      });
  });

  /* ------------------------------------------------------------------ */
  /* Boot                                                                */
  /* ------------------------------------------------------------------ */

  function ready() {
    el.whoamiChip.hidden = false;
    el.whoamiChip.textContent = session.name() || 'signed in';
    loadHistory();

    // An invite link drops you straight into the room it names.
    var code = new URLSearchParams(location.search).get('b');
    if (code) {
      el.joinCode.value = code.toUpperCase();
      post('/api/battle/join', { token: session.token(), code: code.toUpperCase() }).then(function (r) {
        if (r.ok) enter(r);
        else note(el.lobbyNote, r.data.error || 'That battle is no longer open.', true);
      });
    }
  }

  theme.init();
  el.footYear.textContent = String(new Date().getUTCFullYear());
  show('lobby');
  paintAuth();

  if (!session.token()) gate(true);
  else ready();
})();
