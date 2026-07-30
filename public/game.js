/* Daily Color Puzzle — a seeded, always-solvable color-sorting puzzle. */

(function () {
  'use strict';

  var CAPACITY = 4;      // blocks per tube
  var COLOR_COUNT = 10;  // one full tube per color
  var SPARE_TUBES = 2;   // empty tubes to work with
  var TUBE_COUNT = COLOR_COUNT + SPARE_TUBES;

  var COLOR_NAMES = ['Red', 'Orange', 'Yellow', 'Green', 'Cyan', 'Blue', 'Violet', 'Magenta', 'Purple', 'White'];
  var COLOR_TAGS = ['R', 'O', 'Y', 'G', 'C', 'B', 'V', 'M', 'P', 'W'];
  var TUBE_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '='];

  /* ------------------------------------------------------------------ */
  /* Core rules                                                          */
  /* ------------------------------------------------------------------ */

  function clone(tubes) {
    var out = new Array(tubes.length);
    for (var i = 0; i < tubes.length; i++) out[i] = tubes[i].slice();
    return out;
  }

  // The run of identical colors sitting on top of a tube.
  function topRun(tube) {
    if (tube.length === 0) return null;
    var color = tube[tube.length - 1];
    var count = 1;
    while (count < tube.length && tube[tube.length - 1 - count] === color) count++;
    return { color: color, count: count };
  }

  function isTubeDone(tube) {
    if (tube.length === 0) return true;
    if (tube.length !== CAPACITY) return false;
    for (var i = 1; i < tube.length; i++) if (tube[i] !== tube[0]) return false;
    return true;
  }

  function isSolved(tubes) {
    for (var i = 0; i < tubes.length; i++) if (!isTubeDone(tubes[i])) return false;
    return true;
  }

  function canPour(tubes, from, to) {
    if (from === to) return false;
    var src = tubes[from];
    var dst = tubes[to];
    if (src.length === 0) return false;
    if (dst.length >= CAPACITY) return false;
    if (dst.length > 0 && dst[dst.length - 1] !== src[src.length - 1]) return false;
    return true;
  }

  // Moves as many top-of-run blocks as fit. Returns how many moved.
  function pour(tubes, from, to) {
    if (!canPour(tubes, from, to)) return 0;
    var run = topRun(tubes[from]);
    var room = CAPACITY - tubes[to].length;
    var n = Math.min(run.count, room);
    for (var i = 0; i < n; i++) {
      tubes[to].push(tubes[from].pop());
    }
    return n;
  }

  /* ------------------------------------------------------------------ */
  /* Dates                                                               */
  /* ------------------------------------------------------------------ */

  /* The puzzle day is UTC for everyone. Deriving it from the local clock put
     players in different timezones on different boards at the same moment and
     split the leaderboard across two dates. */
  function isoDate(d) {
    return d.toISOString().slice(0, 10);
  }

  function utcToday() {
    return isoDate(new Date());
  }

  // Build a day key from calendar parts without going through a local Date,
  // which would shift the result by a day for some offsets.
  function ymd(y, m, d) {
    return y + '-' + String(m + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
  }

  function shiftDate(iso, days) {
    var d = new Date(iso + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + days);
    return isoDate(d);
  }

  // "Jul 30" — compact enough for the footer strip.
  function shortDate(iso) {
    var p = iso.split('-');
    var d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function prettyDate(iso) {
    var p = iso.split('-');
    var d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  }

  /* ------------------------------------------------------------------ */
  /* Storage                                                             */
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

  function loadStats() {
    return store.get('dcp:stats', { played: 0, streak: 0, best: 0, lastDate: null });
  }

  /**
   * Per-date results, keyed date -> fewest moves. Kept separate from the
   * aggregate stats so the leaderboard can rank individual days.
   */
  function loadResults() {
    var results = store.get('dcp:results', null);
    if (results && typeof results === 'object') return results;
    // First run since results were added: recover past solves from the saved
    // per-day progress, so an existing player's history is not lost.
    return backfillResults();
  }

  function backfillResults() {
    var results = {};
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var key = localStorage.key(i);
        if (!key || key.indexOf('dcp:progress:') !== 0) continue;
        var day = key.slice('dcp:progress:'.length);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
        var saved = store.get(key, null);
        if (!saved || !saved.won || typeof saved.moves !== 'number') continue;
        if (!(day in results) || saved.moves < results[day]) results[day] = saved.moves;
      }
    } catch (e) { /* storage unavailable */ }
    store.set('dcp:results', results);
    return results;
  }

  function saveResult(date, moves) {
    var results = loadResults();
    var previous = (date in results) ? results[date] : null;
    // A day keeps its best score, so replaying only ever improves it.
    var improved = previous === null || moves < previous;
    if (improved) {
      results[date] = moves;
      store.set('dcp:results', results);
    }
    return { improved: improved, previous: previous };
  }

  /* The account's best for a day, learned from the server. Without this the
     footer reads local storage only, so a player who solved on another browser
     (or cleared storage) is told they have not solved it. */
  function syncResultFromServer(day, best) {
    if (best === null || best === undefined) return false;
    var results = loadResults();
    if (day in results && results[day] <= best) return false;
    results[day] = best;
    store.set('dcp:results', results);
    return true;
  }

  /* Every solve, in order, so repeat attempts are visible even when they
     did not beat the day's best. */
  function loadHistory() {
    var history = store.get('dcp:history', []);
    return Array.isArray(history) ? history : [];
  }

  function addHistory(date, moves, improved, at) {
    var history = loadHistory();
    history.push({ date: date, moves: moves, best: !!improved, at: at });
    if (history.length > 250) history = history.slice(history.length - 250);
    store.set('dcp:history', history);
    return history;
  }

  // Ranked fewest moves first; ties broken by the earlier date.
  function rankedResults() {
    var results = loadResults();
    return Object.keys(results).map(function (day) {
      return { date: day, moves: results[day] };
    }).sort(function (a, b) {
      return a.moves - b.moves || (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
    });
  }

  function recordWin(date, moves, at) {
    var outcome = saveResult(date, moves);
    addHistory(date, moves, outcome.improved, at);

    var stats = loadStats();
    // Streak and play count advance once per day; the best score can improve
    // on any attempt.
    if (stats.lastDate !== date) {
      stats.streak = stats.lastDate === shiftDate(date, -1) ? stats.streak + 1 : 1;
      stats.played += 1;
      stats.lastDate = date;
    }
    stats.best = stats.best ? Math.min(stats.best, moves) : moves;
    store.set('dcp:stats', stats);

    return { stats: stats, improved: outcome.improved, previous: outcome.previous };
  }

  /* ------------------------------------------------------------------ */
  /* Theme                                                               */
  /* ------------------------------------------------------------------ */

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
        // The icon shows what you would switch TO, which is the convention
        // people expect from a toggle.
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
        return next;
      },
      current: current
    };
  })();

  /* ------------------------------------------------------------------ */
  /* Background world map                                                */
  /* ------------------------------------------------------------------ */

  /* A flat equirectangular map drawn from real coastline data (Natural Earth
     110m, sampled into land dots by scripts/gen-earth.js). Canvas rather than
     SVG: a couple of thousand dots with individually animated brightness is
     cheap to repaint and expensive to express as DOM. */
  var earth = (function () {
    var canvas, ctx, pts = null, dpr = 1, w = 0, h = 0, started = false;
    var stars = [], shots = [], prevT = 0;
    var ink = { land: '120 214 255', grid: '34 224 255', star: '190 232 255', streak: '225 250 255' };

    // The map is painted, not styled, so it has to read the theme itself.
    function readInk() {
      var root = getComputedStyle(document.documentElement);
      var pick = function (name, fallback) {
        var v = (root.getPropertyValue(name) || '').trim();
        return v || fallback;
      };
      ink.land = pick('--map-land', ink.land);
      ink.grid = pick('--map-grid', ink.grid);
      ink.star = pick('--map-star', ink.star);
      ink.streak = pick('--map-streak', ink.streak);
    }

    function reduced() {
      return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }

    /* Normalised map positions, plus a twinkle phase for a random minority of
       dots. Randomising once at load keeps the pattern stable rather than
       reshuffling every frame. */
    function prepare(flat) {
      var n = flat.length / 2;
      var out = {
        x: new Float32Array(n),
        y: new Float32Array(n),
        blink: new Float32Array(n),   // 0 = steady, otherwise the period in ms
        phase: new Float32Array(n)
      };
      for (var i = 0, k = 0; i < flat.length; i += 2, k++) {
        var lat = flat[i], lon = flat[i + 1];
        out.x[k] = (lon + 180) / 360;
        out.y[k] = (90 - lat) / 180;
        if (Math.random() < 0.09) {
          out.blink[k] = 1400 + Math.random() * 2800;
          out.phase[k] = Math.random() * Math.PI * 2;
        }
      }
      return out;
    }

    function size() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      seedStars();
    }

    /* Drifting starfield behind the map. Positions are normalised so a resize
       keeps the field rather than throwing it away. */
    function seedStars() {
      var count = Math.round(Math.min(140, Math.max(50, (w * h) / 9000)));
      stars = [];
      for (var i = 0; i < count; i++) {
        stars.push({
          x: Math.random(),
          y: Math.random(),
          r: 0.4 + Math.random() * 1.1,
          // px per second, rightward and slightly down, varying by depth
          vx: 4 + Math.random() * 14,
          vy: (Math.random() - 0.5) * 3,
          a: 0.12 + Math.random() * 0.4,
          tw: Math.random() * Math.PI * 2
        });
      }
    }

    function spawnShot() {
      // Enters from the left half of the top edge, travelling down-right.
      var angle = (18 + Math.random() * 22) * Math.PI / 180;
      shots.push({
        x: Math.random() * w * 0.7,
        y: Math.random() * h * 0.5,
        vx: Math.cos(angle) * (520 + Math.random() * 320),
        vy: Math.sin(angle) * (520 + Math.random() * 320),
        life: 1,
        len: 130 + Math.random() * 130
      });
    }

    function drawStars(dt, t) {
      for (var i = 0; i < stars.length; i++) {
        var st = stars[i];
        st.x += (st.vx * dt) / Math.max(w, 1);
        st.y += (st.vy * dt) / Math.max(h, 1);
        if (st.x > 1.02) { st.x = -0.02; st.y = Math.random(); }
        if (st.y > 1.02) st.y = -0.02;
        if (st.y < -0.02) st.y = 1.02;

        var flicker = 0.75 + 0.25 * Math.sin(t / 900 + st.tw);
        ctx.fillStyle = 'rgb(' + ink.star + ' / ' + (st.a * flicker).toFixed(3) + ')';
        ctx.beginPath();
        ctx.arc(st.x * w, st.y * h, st.r, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    function drawShots(dt) {
      if (shots.length < 3 && Math.random() < dt * 0.9) spawnShot();
      for (var i = shots.length - 1; i >= 0; i--) {
        var sh = shots[i];
        sh.x += sh.vx * dt;
        sh.y += sh.vy * dt;
        sh.life -= dt * 0.85;
        if (sh.life <= 0 || sh.x > w + 120 || sh.y > h + 120) { shots.splice(i, 1); continue; }

        var n = Math.sqrt(sh.vx * sh.vx + sh.vy * sh.vy);
        var tx = sh.x - (sh.vx / n) * sh.len;
        var ty = sh.y - (sh.vy / n) * sh.len;
        var grad = ctx.createLinearGradient(sh.x, sh.y, tx, ty);
        grad.addColorStop(0, 'rgb(' + ink.streak + ' / ' + Math.min(1, 1.1 * sh.life).toFixed(3) + ')');
        grad.addColorStop(0.35, 'rgb(' + ink.land + ' / ' + (0.55 * sh.life).toFixed(3) + ')');
        grad.addColorStop(1, 'rgb(' + ink.land + ' / 0)');
        ctx.strokeStyle = grad;
        ctx.lineWidth = 2.4;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(sh.x, sh.y);
        ctx.lineTo(tx, ty);
        ctx.stroke();

        // bright head, so the streak has a point of origin
        ctx.fillStyle = 'rgb(' + ink.streak + ' / ' + Math.min(1, sh.life).toFixed(3) + ')';
        ctx.beginPath();
        ctx.arc(sh.x, sh.y, 1.9, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    function draw(t, dt) {
      ctx.clearRect(0, 0, w, h);
      if (!w || !h) return;

      if (dt !== undefined) drawStars(dt, t);
      else drawStars(0, t);

      // Equirectangular is 2:1, so fit to whichever dimension binds.
      var mapW = Math.min(w * 0.98, h * 0.98 * 2);
      var mapH = mapW / 2;
      var ox = (w - mapW) / 2;
      var oy = (h - mapH) / 2;

      // graticule
      ctx.strokeStyle = 'rgb(' + ink.grid + ' / 0.12)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (var lon = -180; lon <= 180; lon += 30) {
        var gx = ox + ((lon + 180) / 360) * mapW;
        ctx.moveTo(gx, oy); ctx.lineTo(gx, oy + mapH);
      }
      for (var lat = -90; lat <= 90; lat += 30) {
        var gy = oy + ((90 - lat) / 180) * mapH;
        ctx.moveTo(ox, gy); ctx.lineTo(ox + mapW, gy);
      }
      ctx.stroke();

      // equator, marked a touch stronger
      ctx.strokeStyle = 'rgb(' + ink.grid + ' / 0.22)';
      ctx.beginPath();
      ctx.moveTo(ox, oy + mapH / 2); ctx.lineTo(ox + mapW, oy + mapH / 2);
      ctx.stroke();

      var d = 2.4;
      for (var i = 0; i < pts.x.length; i++) {
        var alpha = 0.55;
        var period = pts.blink[i];
        if (period) {
          // Mostly dim, briefly bright — a twinkle rather than a pulse.
          var wave = 0.5 + 0.5 * Math.sin((t / period) * Math.PI * 2 + pts.phase[i]);
          alpha = 0.18 + 0.82 * Math.pow(wave, 3);
        }
        var px = ox + pts.x[i] * mapW;
        var py = oy + pts.y[i] * mapH;
        ctx.fillStyle = 'rgb(' + ink.land + ' / ' + alpha.toFixed(3) + ')';
        ctx.fillRect(px - d / 2, py - d / 2, d, d);

        // the brightest moment of a twinkle gets a soft halo
        if (period && alpha > 0.9) {
          ctx.fillStyle = 'rgb(' + ink.land + ' / 0.28)';
          ctx.fillRect(px - d, py - d, d * 2, d * 2);
        }
      }
    }

    function loop(t) {
      var dt = prevT ? Math.min((t - prevT) / 1000, 0.05) : 0;
      prevT = t;
      draw(t, dt);
      drawShots(dt);
      requestAnimationFrame(loop);
    }

    return {
      refresh: readInk,
      start: function () {
        if (started) return;
        canvas = document.getElementById('earth');
        if (!canvas || !window.DCP_EARTH) return;
        ctx = canvas.getContext('2d');
        readInk();
        pts = prepare(window.DCP_EARTH);
        started = true;
        size();
        window.addEventListener('resize', function () { size(); if (reduced()) draw(0); });
        if (reduced()) draw(0);
        else requestAnimationFrame(loop);
      }
    };
  })();

  /* ------------------------------------------------------------------ */
  /* Celebration                                                         */
  /* ------------------------------------------------------------------ */

  /* Fireworks on a solve, and a full-screen burst for taking first place.
     One canvas, one rAF loop that stops itself when nothing is left to draw. */
  var fx = (function () {
    var SPARK_COLORS = ['#ff2d3c', '#ffa62b', '#f2ee4a', '#31ff5a', '#22e0ff',
                        '#3d6bff', '#7a3ff5', '#ff2be0', '#ffd24d', '#e6ecf5'];
    var canvas = null, ctx = null, parts = [], running = false, dpr = 1;

    function reduced() {
      return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }

    function size() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(window.innerWidth * dpr);
      canvas.height = Math.floor(window.innerHeight * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function ensure() {
      if (canvas) return true;
      canvas = document.getElementById('fx');
      if (!canvas) return false;
      ctx = canvas.getContext('2d');
      size();
      window.addEventListener('resize', function () { if (canvas) size(); });
      return true;
    }

    function burst(x, y, count, power) {
      var hue = SPARK_COLORS[Math.floor(Math.random() * SPARK_COLORS.length)];
      for (var i = 0; i < count; i++) {
        var angle = (Math.PI * 2 * i) / count + Math.random() * 0.3;
        var speed = power * (0.55 + Math.random() * 0.65);
        parts.push({
          x: x, y: y,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          life: 1,
          decay: 0.012 + Math.random() * 0.014,
          size: 1.6 + Math.random() * 2.2,
          color: Math.random() < 0.72 ? hue : SPARK_COLORS[Math.floor(Math.random() * SPARK_COLORS.length)]
        });
      }
    }

    function frame() {
      if (!parts.length) { running = false; ctx.clearRect(0, 0, canvas.width, canvas.height); return; }
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.globalCompositeOperation = 'lighter';
      for (var i = parts.length - 1; i >= 0; i--) {
        var p = parts[i];
        p.vy += 0.045;          // gravity
        p.vx *= 0.985;          // drag
        p.vy *= 0.985;
        p.x += p.vx;
        p.y += p.vy;
        p.life -= p.decay;
        if (p.life <= 0) { parts.splice(i, 1); continue; }
        ctx.globalAlpha = Math.max(0, p.life);
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      requestAnimationFrame(frame);
    }

    function run() {
      if (running) return;
      running = true;
      requestAnimationFrame(frame);
    }

    return {
      // A handful of bursts around the middle of the screen.
      solve: function () {
        if (!ensure() || reduced()) return;
        var w = window.innerWidth, h = window.innerHeight;
        for (var i = 0; i < 5; i++) {
          (function (n) {
            setTimeout(function () {
              burst(w * (0.28 + Math.random() * 0.44), h * (0.25 + Math.random() * 0.35), 34, 4.2);
              run();
            }, n * 230);
          })(i);
        }
      },
      // Bigger, longer, and spread across the whole viewport.
      champion: function () {
        if (!ensure() || reduced()) return;
        var w = window.innerWidth, h = window.innerHeight;
        for (var i = 0; i < 16; i++) {
          (function (n) {
            setTimeout(function () {
              burst(w * (0.08 + Math.random() * 0.84), h * (0.12 + Math.random() * 0.5), 52, 6.4);
              run();
            }, n * 190);
          })(i);
        }
      }
    };
  })();

  /* ------------------------------------------------------------------ */
  /* Session                                                             */
  /* ------------------------------------------------------------------ */

  /* The account lives on the server; the browser only holds a session token
     and the nickname to show while offline. */
  var session = {
    token: function () { return store.get('dcp:token', null); },
    name: function () { return store.get('dcp:name', null); },
    set: function (token, name) {
      store.set('dcp:token', token);
      store.set('dcp:name', name);
    },
    clear: function () {
      store.set('dcp:token', null);
      store.set('dcp:name', null);
    }
  };

  /* ------------------------------------------------------------------ */
  /* UI                                                                  */
  /* ------------------------------------------------------------------ */

  function boot() {
    var params = new URLSearchParams(location.search);
    var date = params.get('date') || utcToday();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) date = utcToday();

    // The board is dealt by the server. Generating it here would mean shipping
    // the generator — and with it, every future puzzle — to every visitor.
    fetch('/api/board?date=' + encodeURIComponent(date))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (b) {
        if (!b || !Array.isArray(b.tubes) || b.tubes.length !== TUBE_COUNT) {
          boardError('Could not load today\u2019s board.');
          return;
        }
        start(date, b.tubes);
      })
      .catch(function () { boardError('Could not reach the server.'); });
  }

  function boardError(message) {
    var board = document.getElementById('board');
    if (board) board.innerHTML = '<p class="lb-empty">' + message + ' Reload to try again.</p>';
  }

  function start(date, dealt) {
    var progressKey = 'dcp:progress:' + date;
    var initial = dealt;

    var el = {
      board: document.getElementById('board'),
      moveCount: document.getElementById('moveCount'),
      selectedLabel: document.getElementById('selectedLabel'),
      dateLabel: document.getElementById('dateLabel'),
      undoBtn: document.getElementById('undoBtn'),
      restartBtn: document.getElementById('restartBtn'),
      helpBtn: document.getElementById('helpBtn'),
      eyeBtn: document.getElementById('eyeBtn'),
      themeBtn: document.getElementById('themeBtn'),
      helpOverlay: document.getElementById('helpOverlay'),
      closeHelpBtn: document.getElementById('closeHelpBtn'),
      winOverlay: document.getElementById('winOverlay'),
      winLine: document.getElementById('winLine'),
      winStats: document.getElementById('winStats'),
      shareBtn: document.getElementById('shareBtn'),
      closeWinBtn: document.getElementById('closeWinBtn'),
      lbWrap: document.getElementById('lbWrap'),
      lbSummary: document.getElementById('lbSummary'),
      liveDot: document.getElementById('liveDot'),
      cdTime: document.getElementById('cdTime'),
      dayBtn: document.getElementById('dayBtn'),
      dayBtnText: document.getElementById('dayBtnText'),
      cal: document.getElementById('cal'),
      calGrid: document.getElementById('calGrid'),
      calMonth: document.getElementById('calMonth'),
      calPrev: document.getElementById('calPrev'),
      calNext: document.getElementById('calNext'),
      calToday: document.getElementById('calToday'),
      bestMeter: document.getElementById('bestMeter'),
      triesSegs: document.getElementById('triesSegs'),
      rankTitle: document.getElementById('rankTitle'),
      playersTitle: document.getElementById('playersTitle'),
      histStrip: document.getElementById('histStrip'),
      histSummary: document.getElementById('histSummary'),
      zone: document.getElementById('zone'),
      zoneTag: document.getElementById('zoneTag'),
      gaugeFill: document.getElementById('gaugeFill'),
      rankValue: document.getElementById('rankValue'),
      rankOf: document.getElementById('rankOf'),
      rankTag: document.getElementById('rankTag'),
      rankBest: document.getElementById('rankBest'),
      rankTries: document.getElementById('rankTries'),
      solvedChip: document.getElementById('solvedChip'),
      champ: document.getElementById('champ'),
      boardWrap: document.getElementById('boardWrap'),
      profileBtn: document.getElementById('profileBtn'),
      profileOverlay: document.getElementById('profileOverlay'),
      authOverlay: document.getElementById('authOverlay'),
      authForm: document.getElementById('authForm'),
      authName: document.getElementById('authName'),
      authPass: document.getElementById('authPass'),
      authNote: document.getElementById('authNote'),
      authTitle: document.getElementById('authTitle'),
      authBlurb: document.getElementById('authBlurb'),
      authSubmit: document.getElementById('authSubmit'),
      authSwap: document.getElementById('authSwap'),
      authSwapText: document.getElementById('authSwapText'),
      whoami: document.getElementById('whoami'),
      signOutBtn: document.getElementById('signOutBtn'),
      pwForm: document.getElementById('pwForm'),
      pwCurrent: document.getElementById('pwCurrent'),
      pwNext: document.getElementById('pwNext'),
      pwNote: document.getElementById('pwNote'),
      pwSave: document.getElementById('pwSave'),
      closeProfileBtn: document.getElementById('closeProfileBtn')
    };

    el.dateLabel.textContent = '(' + prettyDate(date) + ')';

    var state = {
      tubes: clone(initial),
      moves: 0,
      selected: null,
      history: [],
      won: false,
      // The sequence of pours, replayed by the server to verify a score.
      moveLog: [],
      submitted: false
    };

    var saved = store.get(progressKey, null);
    if (saved && Array.isArray(saved.tubes) && saved.tubes.length === TUBE_COUNT) {
      state.tubes = saved.tubes.map(function (t) { return t.slice(); });
      state.moves = saved.moves || 0;
      state.won = !!saved.won;
      state.moveLog = Array.isArray(saved.moveLog) ? saved.moveLog : [];
      state.submitted = !!saved.submitted;
    }

    if (store.get('dcp:labels', false)) {
      document.body.classList.add('labels');
      el.eyeBtn.setAttribute('aria-pressed', 'true');
    }

    /* The puzzle always plays today; the scoreboard can look back. */
    var viewDate = date;
    var OLDEST = shiftDate(date, -365);

    function paintDayNav() {
      var isToday = viewDate === date;
      el.dayBtnText.textContent = isToday ? 'Today' : shortDate(viewDate);
      el.dayBtn.title = prettyDate(viewDate);
      el.rankTitle.textContent = isToday ? 'Today\u2019s rank' : 'Rank \u00b7 ' + shortDate(viewDate);
      el.playersTitle.textContent = isToday
        ? 'Today\u2019s players'
        : shortDate(viewDate) + ' players';
    }

    /* A calendar drawn in the page, because a native date popup is browser
       chrome and cannot be themed. Rendered at page level so the leaderboard's
       overflow cannot clip it. */
    var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
                  'July', 'August', 'September', 'October', 'November', 'December'];
    var calCursor = null;   // {y, m} — the month on screen

    function monthStart(iso) {
      var p = iso.split('-');
      return { y: Number(p[0]), m: Number(p[1]) - 1 };
    }

    function renderCalendar() {
      var y = calCursor.y, m = calCursor.m;
      el.calMonth.textContent = MONTHS[m] + ' ' + y;

      // Monday-first: JS getDay() is Sunday-based, so rotate it.
      var lead = (new Date(y, m, 1).getDay() + 6) % 7;
      var days = new Date(y, m + 1, 0).getDate();

      var html = '';
      for (var b = 0; b < lead; b++) html += '<span class="cal-day blank"></span>';
      for (var d = 1; d <= days; d++) {
        var iso = ymd(y, m, d);
        var out = iso > date || iso < OLDEST;
        var cls = 'cal-day' + (iso === viewDate ? ' sel' : '') + (iso === date ? ' now' : '');
        html += '<button type="button" class="' + cls + '" data-day="' + iso + '"' +
          (out ? ' disabled' : '') + ' aria-label="' + prettyDate(iso) + '">' + d + '</button>';
      }
      el.calGrid.innerHTML = html;

      var firstIso = ymd(y, m, 1);
      var lastIso = ymd(y, m, days);
      el.calPrev.disabled = firstIso <= OLDEST;
      el.calNext.disabled = lastIso >= date;
    }

    function openCalendar() {
      calCursor = monthStart(viewDate);
      renderCalendar();
      el.cal.hidden = false;
      el.dayBtn.setAttribute('aria-expanded', 'true');

      // Anchored under the trigger, nudged back inside the viewport if needed.
      var r = el.dayBtn.getBoundingClientRect();
      var w = el.cal.offsetWidth, h = el.cal.offsetHeight;
      var left = Math.min(Math.max(8, r.left), window.innerWidth - w - 8);
      var top = r.bottom + 6;
      if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
      el.cal.style.left = left + 'px';
      el.cal.style.top = top + 'px';
    }

    function closeCalendar() {
      el.cal.hidden = true;
      el.dayBtn.setAttribute('aria-expanded', 'false');
    }

    function goToDay(next) {
      if (next > date || next < OLDEST) return;
      viewDate = next;
      paintDayNav();
      loadZone();
    }

    var playerName = session.name();
    var gated = false;
    // Signing in is the common case — most visits are returning players, and
    // a newcomer only has to follow the "Create one" link once.
    var authMode = 'login';

    function paintAuthMode() {
      var creating = authMode === 'register';
      el.authTitle.textContent = creating ? 'Create account' : 'Sign in';
      el.authSubmit.textContent = creating ? 'Create account' : 'Sign in';
      el.authBlurb.textContent = creating
        ? 'Pick a nickname and a password. The nickname is public; the password proves the score is yours.'
        : 'Your nickname and score are public. Your password keeps them yours.';
      el.authSwapText.textContent = creating ? 'Already have an account?' : 'No account yet?';
      el.authSwap.textContent = creating ? 'Sign in' : 'Create one';
      el.authPass.setAttribute('autocomplete', creating ? 'new-password' : 'current-password');
    }

    function setGate(on) {
      var wasGated = gated;
      gated = on;
      el.authOverlay.hidden = !on;
      // Focus only on the transition into the gate. The poll calls this every
      // tick, and refocusing each time would eat keystrokes mid-password.
      if (on && !wasGated) { paintAuthMode(); el.authName.focus(); }
    }

    function adoptSession(token, name) {
      if (token) session.set(token, name);
      playerName = name;
      el.whoami.textContent = name;
      setGate(false);
    }

    /* Solves recorded before signing in live only in this browser. Their move
       logs are still here, so they can be replayed to the server and verified
       exactly like a fresh solve. */
    function migrateLocalSolves(done) {
      var token = session.token();
      if (!token) { done(); return; }

      var pending = [];
      try {
        for (var i = 0; i < localStorage.length; i++) {
          var key = localStorage.key(i);
          if (!key || key.indexOf('dcp:progress:') !== 0) continue;
          var day = key.slice('dcp:progress:'.length);
          if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
          var rec = store.get(key, null);
          if (rec && rec.won && Array.isArray(rec.moveLog) && rec.moveLog.length > 0) {
            pending.push({ day: day, moves: rec.moveLog });
          }
        }
      } catch (e) { /* storage unavailable */ }

      if (pending.length === 0) { done(); return; }

      var i2 = 0;
      (function next() {
        if (i2 >= pending.length) { done(); return; }
        var item = pending[i2++];
        fetch('/api/scores', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: token, date: item.day, moves: item.moves })
        }).then(next, next);
      })();
    }

    function signOut() {
      var token = session.token();
      session.clear();
      playerName = null;
      authMode = 'login';
      el.profileOverlay.hidden = true;
      if (token) {
        fetch('/api/logout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: token })
        }).catch(function () { /* the local session is gone either way */ });
      }
      setGate(true);
      loadZone();
    }

    /* -- board construction (built once, then updated in place) -- */

    var tubeEls = [];
    for (var i = 0; i < TUBE_COUNT; i++) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tube';
      btn.dataset.index = String(i);
      // The flash is one-shot; drop the class so the DOM does not accumulate
      // finished animations.
      btn.addEventListener('animationend', function (e) {
        if (e.animationName === 'done-ring') this.classList.remove('just-done');
      });
      el.board.appendChild(btn);
      tubeEls.push(btn);
    }

    function describeTube(index) {
      var tube = state.tubes[index];
      if (tube.length === 0) return 'Tube ' + (index + 1) + ', empty';
      var names = tube.map(function (c) { return COLOR_NAMES[c]; });
      return 'Tube ' + (index + 1) + ', top to bottom: ' + names.join(', ') +
        '. Movable: ' + COLOR_NAMES[tube[tube.length - 1]] + ' at the bottom.';
    }

    // color-mix() needs a real colour, not a var pointing at another var, so
    // the palette is resolved once from the stylesheet.
    var COLOR_HEX = (function () {
      var root = getComputedStyle(document.documentElement);
      var out = [];
      for (var c = 0; c < COLOR_COUNT; c++) {
        out.push((root.getPropertyValue('--c' + c) || '').trim() || '#22e0ff');
      }
      return out;
    })();

    var wasDone = [];
    var primedDone = false;   // first paint records state without flashing

    function render() {
      for (var i = 0; i < TUBE_COUNT; i++) {
        var tube = state.tubes[i];
        var node = tubeEls[i];
        var run = topRun(tube);
        var liftCount = state.selected === i && run ? run.count : 0;

        // Tubes fill downward from the top, so the movable end of the stack
        // (the last array element) is the lowest filled block, with the empty
        // slots below it.
        var html = '';
        for (var b = 0; b < tube.length; b++) {
          var lifted = b >= tube.length - liftCount ? ' lifted' : '';
          html += '<div class="block c' + tube[b] + lifted + '">' +
            '<span class="tag">' + COLOR_TAGS[tube[b]] + '</span></div>';
        }
        for (var s = 0; s < CAPACITY - tube.length; s++) html += '<div class="slot"></div>';
        node.innerHTML = html;
        node.classList.toggle('selected', state.selected === i);

        var doneNow = tube.length === CAPACITY && isTubeDone(tube);
        node.classList.toggle('done', doneNow);
        if (doneNow) {
          node.style.setProperty('--done-c', COLOR_HEX[tube[0]]);
          if (!wasDone[i] && primedDone) {
            // Restart the animation even if the class is already present.
            node.classList.remove('just-done');
            void node.offsetWidth;
            node.classList.add('just-done');
          }
        } else {
          node.classList.remove('just-done');
          node.style.removeProperty('--done-c');
        }
        wasDone[i] = doneNow;
        node.setAttribute('aria-label', describeTube(i));
        node.setAttribute('aria-pressed', state.selected === i ? 'true' : 'false');
      }

      primedDone = true;
      el.moveCount.textContent = String(state.moves);
      el.selectedLabel.textContent = state.selected === null ? 'None' : 'Tube ' + (state.selected + 1);
      el.undoBtn.disabled = state.history.length === 0;
      el.solvedChip.hidden = !state.won;
    }

    function save() {
      store.set(progressKey, {
        tubes: state.tubes,
        moves: state.moves,
        won: state.won,
        moveLog: state.moveLog,
        submitted: state.submitted
      });
    }

    function reject(index) {
      var node = tubeEls[index];
      node.classList.remove('nudge');
      void node.offsetWidth; // restart the animation
      node.classList.add('nudge');
    }

    function select(index) {
      if (state.tubes[index].length === 0) { reject(index); return; }
      state.selected = index;
      render();
    }

    function tap(index) {
      if (gated) { el.authInput.focus(); return; }
      if (state.won) return;

      if (state.selected === null) { select(index); return; }
      if (state.selected === index) { state.selected = null; render(); return; }

      var from = state.selected;
      if (!canPour(state.tubes, from, index)) {
        reject(index);
        // Tapping a different non-empty tube re-targets instead of dead-ending.
        if (state.tubes[index].length > 0) select(index);
        return;
      }

      state.history.push({ tubes: clone(state.tubes) });
      if (state.history.length > 500) state.history.shift();

      pour(state.tubes, from, index);
      state.moveLog.push({ from: from, to: index });
      state.moves += 1;
      state.selected = null;
      render();
      save();

      if (isSolved(state.tubes)) win();
    }

    function win() {
      state.won = true;
      save();
      el.solvedChip.hidden = false;
      fx.solve();
      var outcome = recordWin(date, state.moves, Date.now());
      var stats = outcome.stats;
      renderLeaderboard();
      submitScore(true);

      el.winLine.textContent = 'You grouped all ' + COLOR_COUNT + ' colors in ' + state.moves +
        ' move' + (state.moves === 1 ? '' : 's') + '. ' +
        (outcome.previous === null ? 'First solve of the day.'
          : outcome.improved ? 'New best — you beat ' + outcome.previous + '.'
          : 'Your best today is still ' + outcome.previous + '.');

      el.winStats.innerHTML =
        '<div><dt>Solved</dt><dd>' + stats.played + '</dd></div>' +
        '<div><dt>Streak</dt><dd>' + stats.streak + '</dd></div>' +
        '<div><dt>Best</dt><dd>' + stats.best + '</dd></div>';
      el.winOverlay.hidden = false;
      el.shareBtn.textContent = 'Copy result';
      el.shareBtn.focus();
    }

    function undo() {
      var prev = state.history.pop();
      if (!prev) return;
      state.tubes = prev.tubes;
      // The move counter deliberately does not rewind: undo rescues a dead
      // end, it does not refund the moves already spent.
      state.moveLog.push({ u: 1 });
      state.selected = null;
      state.won = false;
      // Undoing past a win means the next solve must be sent again.
      state.submitted = false;
      el.winOverlay.hidden = true;
      render();
      save();
    }

    function restart() {
      state.tubes = clone(initial);
      state.moves = 0;
      state.selected = null;
      state.history = [];
      state.won = false;
      state.moveLog = [];
      state.submitted = false;
      wasDone = [];
      el.winOverlay.hidden = true;
      render();
      save();
    }

    function renderLeaderboard() {
      var rows = rankedResults();
      var stats = loadStats();

      el.lbSummary.innerHTML =
        '<div><dt>Days solved</dt><dd>' + rows.length + '</dd></div>' +
        '<div><dt>Streak</dt><dd>' + (stats.streak || 0) + '</dd></div>' +
        '<div><dt>Best</dt><dd>' + (rows.length ? rows[0].moves : '\u2014') + '</dd></div>';

      renderHistoryStrip();
    }

    /* Today in words, with earlier days as chips behind it. */
    function renderHistoryStrip() {
      var results = loadResults();
      var attempts = {};
      var log = loadHistory();
      for (var h = 0; h < log.length; h++) {
        attempts[log[h].date] = (attempts[log[h].date] || 0) + 1;
      }

      var todayBest = results[date];
      if (todayBest === undefined) {
        el.histSummary.className = 'hist-summary hist-unsolved';
        el.histSummary.textContent = 'Today: not solved yet';
        el.histSummary.removeAttribute('title');
      } else {
        var todayRuns = [];
        for (var k = 0; k < log.length; k++) if (log[k].date === date) todayRuns.push(log[k].moves);
        var tries = todayRuns.length || attempts[date] || 1;
        var latest = todayRuns.length ? todayRuns[todayRuns.length - 1] : todayBest;

        el.histSummary.className = 'hist-summary';
        el.histSummary.innerHTML = 'Your best today: <b>' + todayBest + '</b> moves' +
          // Attempts are only counted in this browser, so stay silent rather
          // than claiming "1 try" for a solve made somewhere else.
          (todayRuns.length ? ' in <b>' + tries + '</b> ' + (tries === 1 ? 'try' : 'tries') : '') +
          // Spelled out, so a best that is better than the latest run is not
          // mistaken for a wrong number.
          (latest !== todayBest ? ' <span class="hist-latest">latest ' + latest + '</span>' : '');
        el.histSummary.title = todayRuns.length
          ? 'Every solve today, in order: ' + todayRuns.join(', ') + ' moves'
          : 'Best recorded today: ' + todayBest + ' moves';
      }

      var days = Object.keys(results).sort().reverse().filter(function (d) { return d !== date; });
      if (days.length === 0) {
        el.histStrip.innerHTML = '';
        return;
      }

      var best = days.reduce(function (lo, d) {
        return results[d] < results[lo] ? d : lo;
      }, days[0]);

      var html = '<span class="hist-label">Earlier</span>';
      for (var i = 0; i < days.length; i++) {
        var day = days[i];
        var t = attempts[day] || 1;
        html += '<span class="chip' + (day === best ? ' chip-best' : '') + '" title="' +
          prettyDate(day) + ' \u00b7 best ' + results[day] + ' moves in ' + t +
          ' tr' + (t === 1 ? 'y' : 'ies') + '">' +
          '<b>' + shortDate(day) + '</b>' + results[day] + '</span>';
      }
      el.histStrip.innerHTML = html;
    }

    // Nicknames are player-supplied, so everything rendered goes through this.
    function esc(text) {
      return String(text)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    var BOARD_LIMIT = 100;

    var CROWN = 'M2 8.4l4.6 3.4L12 3.6l5.4 8.2L22 8.4 20.2 19H3.8L2 8.4z';
    var CUP = 'M6 3h12v3.2A6 6 0 0 1 13 12.9V16h3.2v2.2H7.8V16H11v-3.1A6 6 0 0 1 6 6.2V3z';

    // Crown for first, cup for second and third — gold, silver, bronze.
    function rankBadge(rank) {
      if (rank > 3) return '';
      var tone = rank === 1 ? 'gold' : rank === 2 ? 'silver' : 'bronze';
      var label = rank === 1 ? 'First place' : rank === 2 ? 'Second place' : 'Third place';
      return '<svg class="badge badge-' + tone + '" viewBox="0 0 24 24" role="img" aria-label="' +
        label + '"><title>' + label + '</title><path d="' + (rank === 1 ? CROWN : CUP) + '"/></svg>';
    }

    function renderPlayerBoard(data) {
      // The table is replaced wholesale, so keep the reader where they were.
      var keepScroll = el.boardWrap.scrollTop;
      var all = (data && data.board) || [];
      // Capped so this table never scrolls; the history block owns the only
      // scrollbar in the column.
      var rows = all.slice(0, BOARD_LIMIT);
      var mine = null;
      for (var m = 0; m < all.length; m++) if (all[m].you) mine = all[m];
      // Keep the player's own row visible even when they are outside the top.
      var appended = false;
      if (mine && mine.rank > BOARD_LIMIT) { rows = rows.concat([mine]); appended = true; }

      if (rows.length === 0) {
        el.boardWrap.innerHTML =
          '<p class="lb-empty">No finishers yet today.</p>';
        return;
      }
      var html = '<table class="lb"><thead><tr>' +
        '<th>#</th><th>Player</th><th class="moves">Moves</th>' +
        '</tr></thead><tbody>';
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        var cls = (r.you ? 'me' : '') + (r.rank <= 3 ? ' podium-' + r.rank : '');
        html += '<tr class="' + cls.trim() + '">' +
          '<td class="rank">' + rankBadge(r.rank) + r.rank + '</td>' +
          '<td class="date">' + (r.name ? esc(r.name) : '<span class="anon">anonymous</span>') +
          (r.you ? ' <span class="pb">you</span>' : '') + '</td>' +
          '<td class="moves">' + r.moves + '</td></tr>';
      }
      html += '</tbody></table>';
      if (all.length > BOARD_LIMIT) {
        html += '<p class="lb-foot">Top ' + BOARD_LIMIT + ' of ' + (data.total || all.length) +
          (appended ? ', plus your row.' : '.') + '</p>';
      }
      el.boardWrap.innerHTML = html;
      el.boardWrap.scrollTop = keepScroll;
    }

    function zoneMessage(text) {
      el.zone.innerHTML = '<p class="lb-empty">' + text + '</p>';
    }

    function clearRank(tag) {
      el.rankValue.textContent = '—';
      el.rankOf.textContent = 'no data';
      el.rankTag.textContent = tag;
      el.gaugeFill.style.strokeDasharray = '0 ' + (2 * Math.PI * 49);
      el.rankBest.textContent = '—';
      el.rankTries.textContent = '—';
      el.bestMeter.style.width = '0%';
      el.triesSegs.innerHTML = '';
    }

    // Circumference of the gauge ring (r=49), used to convert a percentage
    // into a stroke length.
    var GAUGE_C = 2 * Math.PI * 49;

    function renderRank(data) {
      var total = (data && data.total) || 0;
      var mine = data && data.best !== null && data.best !== undefined ? data.best : null;
      var pct = data && typeof data.betterThan === 'number' ? data.betterThan : null;

      if (mine === null) {
        el.rankValue.textContent = '—';
        el.rankOf.textContent = total ? 'of ' + total + ' players' : 'not solved yet';
        el.rankTag.textContent = total ? 'awaiting your solve' : 'standby';
        el.gaugeFill.style.strokeDasharray = '0 ' + GAUGE_C;
      } else {
        el.rankValue.textContent = '#' + data.rank;
        el.rankOf.textContent = 'of ' + total + ' player' + (total === 1 ? '' : 's');
        el.rankTag.textContent = 'locked in';
        // The ring reads as "share of the field you are ahead of".
        var frac = pct === null ? 0 : Math.max(0, Math.min(100, pct)) / 100;
        el.gaugeFill.style.strokeDasharray = (frac * GAUGE_C) + ' ' + GAUGE_C;
      }

      // Best move comes from the server; attempts are local, since the server
      // only ever stores a day's best.
      var tries = 0;
      var log = loadHistory();
      for (var i = 0; i < log.length; i++) if (log[i].date === viewDate) tries++;

      // A score on the server means at least one attempt, even when this
      // browser holds no log for that day. The number and the segments must
      // agree, so both read from the same value.
      var shownTries = tries || (mine === null ? 0 : 1);
      el.rankBest.textContent = mine === null ? '—' : mine;
      el.rankTries.textContent = shownTries || '—';

      // Best-move bar: where your score sits between the day's fewest and most
      // moves. Full bar means you hold the day's best.
      var frac = 0;
      if (mine !== null && data && data.counts && data.counts.length) {
        var lo = data.counts[0].moves;
        var hi = data.counts[data.counts.length - 1].moves;
        frac = hi === lo ? 1 : Math.max(0, Math.min(1, (hi - mine) / (hi - lo)));
      }
      el.bestMeter.style.width = Math.round(frac * 100) + '%';

      // Attempts: one lit segment per try, capped at the number of segments.
      var SEGMENTS = 6;
      var lit = Math.max(0, Math.min(SEGMENTS, shownTries));
      var segs = '';
      for (var k = 0; k < SEGMENTS; k++) segs += '<span class="seg' + (k < lit ? ' on' : '') + '"></span>';
      el.triesSegs.innerHTML = segs;
    }

    function renderZone(data) {
      lastSignature = signature(data);
      // Adopt the account's score for this day before anything reads storage.
      if (data && data.signedIn === true && syncResultFromServer(data.day, data.best)) {
        renderLeaderboard();
      }
      healUnsentScore(data);
      if (data && data.signedIn === true && data.name) adoptSession(null, data.name);
      else if (data && data.signedIn === false) { session.clear(); playerName = null; setGate(true); }
      renderRank(data);
      renderPlayerBoard(data);
      if (!data || !data.counts) { zoneMessage('Scoreboard unavailable.'); clearRank('offline'); return; }

      var counts = data.counts;
      var total = data.total || 0;
      el.zoneTag.textContent = 'players per move count';
      el.zoneTag.className = 'hud-tag';
      if (total === 0) {
        zoneMessage(viewDate === date
          ? 'Nobody has finished today\u2019s board yet. Solve it to be the first.'
          : 'Nobody finished the ' + shortDate(viewDate) + ' board.');
        return;
      }

      var mine = (data.best === null || data.best === undefined) ? null : data.best;
      var lo = counts[0].moves;
      var hi = counts[counts.length - 1].moves;
      if (mine !== null) { lo = Math.min(lo, mine); hi = Math.max(hi, mine); }

      // One bar per move count, widening the bin only if the spread is large.
      var span = hi - lo + 1;
      var binSize = span > 40 ? Math.ceil(span / 40) : 1;
      var binCount = Math.max(1, Math.ceil(span / binSize));
      var bins = [];
      for (var b = 0; b < binCount; b++) bins.push(0);
      for (var i = 0; i < counts.length; i++) {
        bins[Math.min(binCount - 1, Math.floor((counts[i].moves - lo) / binSize))] += counts[i].users;
      }
      var peak = Math.max.apply(null, bins);
      var mineBin = mine === null ? -1 : Math.min(binCount - 1, Math.floor((mine - lo) / binSize));

      // Header carries the headline percentage; the caption spells it out.
      var topPct = mine === null ? null : topPercent(data.rank, total);
      el.zoneTag.textContent = topPct === null ? 'players per move count' : 'you are top ' + topPct + '%';
      el.zoneTag.className = topPct === null ? 'hud-tag' : 'hud-tag zone-pct';

      el.zone.innerHTML =
        '<div class="zone-stats">' +
        '<div><dt>Players</dt><dd>' + total + '</dd></div>' +
        '<div><dt>Your moves</dt><dd>' + (mine === null ? '\u2014' : mine) + '</dd></div>' +
        '<div><dt>Fewest</dt><dd>' + counts[0].moves + '</dd></div>' +
        '<div><dt>Most</dt><dd>' + counts[counts.length - 1].moves + '</dd></div>' +
        '</div>' +
        '<div class="chart">' +
        '<div class="zbars">' + barsHtml(bins, lo, binSize, mineBin) + '</div>' +
        '<div class="zaxis"><span>' + lo + ' moves</span><span>fewer moves is better</span><span>' +
          (lo + binCount * binSize - 1) + ' moves</span></div>' +
        '</div>' +
        '<p class="zone-caption">' + captionFor(data, total, mine) + '</p>';

      // Heights go through the CSSOM: inline style attributes would require
      // 'unsafe-inline' in the page's Content-Security-Policy.
      var bars = el.zone.querySelectorAll('.zbar');
      for (var f = 0; f < bars.length; f++) {
        bars[f].querySelector('.zfill').style.height =
          (peak === 0 ? 0 : Math.round((100 * bins[f]) / peak)) + '%';
      }
      if (mineBin >= 0 && bars[mineBin]) bars[mineBin].setAttribute('data-you', String(mine));
    }

    function barsHtml(bins, lo, binSize, mineBin) {
      var html = '';
      for (var k = 0; k < bins.length; k++) {
        var from = lo + k * binSize;
        var to = from + binSize - 1;
        var range = binSize === 1 ? String(from) : from + '\u2013' + to;
        html += '<div class="zbar' + (k === mineBin ? ' mine' : '') + '" ' +
          'data-tip="' + range + ' moves \u00b7 ' + bins[k] + ' player' + (bins[k] === 1 ? '' : 's') + '">' +
          '<div class="zfill"></div></div>';
      }
      return html;
    }

    // Your standing as a percentage: what share of the field you are ahead of,
    // and the top slice you fall in. Rounded up so rank 1 never reads "top 0%".
    function topPercent(rank, total) {
      if (!rank || !total) return null;
      return Math.max(1, Math.ceil((rank / total) * 100));
    }

    function captionFor(data, total, mine) {
      var when = viewDate === date ? 'today\u2019s board' : 'the ' + shortDate(viewDate) + ' board';
      if (mine === null) {
        return total + ' player' + (total === 1 ? '' : 's') + ' finished ' + when +
          '. Solve it to place yourself on the chart.';
      }
      var top = topPercent(data.rank, total);
      return 'You: ' + mine + ' moves \u00b7 better than ' + data.betterThan + '% of ' +
        total + ' player' + (total === 1 ? '' : 's') + ' \u00b7 top ' + top + '%';
    }

    function loadZone() {
      zoneMessage('Loading scoreboard\u2026');
      fetch('/api/scores?date=' + encodeURIComponent(viewDate) +
            '&token=' + encodeURIComponent(session.token() || ''))
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(renderZone)
        .catch(function () {
          zoneMessage('Scoreboard unavailable \u2014 you are offline, or the server is down.');
          clearRank('offline');
        });
    }

    /* Reserved for actually topping the board: full-screen bursts plus a
       banner that clears itself. Skipped when the board has only one player,
       where being first is not an achievement. */
    var champTimer = null;
    function championCelebration() {
      fx.champion();
      if (champTimer) clearTimeout(champTimer);
      el.champ.classList.remove('out');
      el.champ.hidden = false;
      champTimer = setTimeout(function () {
        el.champ.classList.add('out');
        champTimer = setTimeout(function () { el.champ.hidden = true; }, 700);
      }, 2600);
    }

    /* Time left on today's board. The puzzle rolls over at local midnight,
       which is the same clock the date itself comes from. */
    function startCountdown() {
      function pad(n) { return n < 10 ? '0' + n : String(n); }

      function tick() {
        var now = new Date();
        var next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0);
        var left = Math.max(0, next - now.getTime());

        if (left === 0 || utcToday() !== date) {
          // A new board is live; reload rather than leave a stale one on screen.
          el.cdTime.textContent = 'new puzzle ready';
          setTimeout(function () { location.reload(); }, 1200);
          return;
        }

        var total = Math.floor(left / 1000);
        el.cdTime.innerHTML =
          pad(Math.floor(total / 3600)) + '<b>h</b> ' +
          pad(Math.floor((total % 3600) / 60)) + '<b>m</b> ' +
          pad(total % 60) + '<b>s</b>';
        setTimeout(tick, 1000 - (Date.now() % 1000));
      }

      tick();
    }

    /* If this browser holds a better score than the server has, the earlier
       submission never landed — an old build, a dropped request, an offline
       moment. The winning move log is still in storage, so replay it once. */
    var healAttempted = false;

    function healUnsentScore(data) {
      if (healAttempted) return;
      if (!data || data.signedIn !== true || viewDate !== date) return;

      var local = loadResults()[date];
      if (local === undefined) return;
      if (data.best !== null && data.best !== undefined && data.best <= local) return;

      var saved = store.get(progressKey, null);
      if (!saved || !saved.won || !Array.isArray(saved.moveLog) || saved.moveLog.length === 0) return;

      healAttempted = true;
      fetch('/api/scores', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: session.token(), date: date, moves: saved.moveLog })
      })
        .then(function (r) { return r.json(); })
        .then(function (res) { if (res && res.accepted) renderZone(res); })
        .catch(function () { /* next visit will try again */ });
    }

    /* Live updates by polling. A handful of players do not justify holding a
       server-sent-events connection open through nginx and the tunnel, and a
       poll survives both without extra proxy configuration. */
    var POLL_MS = 15000;
    var pollTimer = null;
    var lastSignature = null;

    function signature(data) {
      if (!data) return 'none';
      return JSON.stringify([data.total, data.best, data.rank, data.counts, data.board]);
    }

    function liveState(state) {
      el.liveDot.setAttribute('data-state', state);
      el.liveDot.title = state === 'offline' ? 'Cannot reach the server'
        : state === 'paused' ? 'Paused while this tab is in the background'
        : 'Updating automatically';
    }

    function poll() {
      if (document.hidden) return;
      fetch('/api/scores?date=' + encodeURIComponent(viewDate) +
            '&token=' + encodeURIComponent(session.token() || ''))
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (data) {
          if (!data) { liveState('offline'); return; }
          liveState('live');
          // Only touch the DOM when something actually changed, so the board
          // does not flicker every fifteen seconds.
          var sig = signature(data);
          if (sig === lastSignature) return;
          lastSignature = sig;
          renderZone(data);
        })
        .catch(function () { liveState('offline'); });
    }

    function startPolling() {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = setInterval(poll, POLL_MS);
      liveState(document.hidden ? 'paused' : 'live');
    }

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        liveState('paused');
      } else {
        liveState('live');
        poll();   // catch up immediately on return
      }
    });

    function submitScore(force) {
      if (state.moveLog.length === 0) { loadZone(); return; }
      if (!force && state.submitted) { loadZone(); return; }
      fetch('/api/scores', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: session.token(), date: date, moves: state.moveLog })
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data && data.accepted) {
            state.submitted = true;
            save();
            renderZone(data);
            if (data.rank === 1 && data.total > 1) championCelebration();
          } else {
            if (data && /sign in/i.test(data.error || '')) { session.clear(); playerName = null; setGate(true); }
            loadZone();
          }
        })
        .catch(function () {
          zoneMessage('Could not send your score \u2014 it will retry next time you open this page.');
        });
    }

    /* -- events -- */

    el.board.addEventListener('click', function (e) {
      var node = e.target.closest('.tube');
      if (node) tap(Number(node.dataset.index));
    });

    el.undoBtn.addEventListener('click', undo);
    el.restartBtn.addEventListener('click', restart);

    el.helpBtn.addEventListener('click', function () {
      el.helpOverlay.hidden = false;
      el.closeHelpBtn.focus();
    });
    el.closeHelpBtn.addEventListener('click', function () {
      el.helpOverlay.hidden = true;
      el.helpBtn.focus();
    });

    el.themeBtn.addEventListener('click', function () {
      theme.toggle();
      earth.refresh();   // the canvas cannot inherit CSS, so repoint its palette
    });

    el.eyeBtn.addEventListener('click', function () {
      var on = document.body.classList.toggle('labels');
      el.eyeBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
      store.set('dcp:labels', on);
    });

    el.closeWinBtn.addEventListener('click', function () { el.winOverlay.hidden = true; });

    el.authSwap.addEventListener('click', function () {
      authMode = authMode === 'register' ? 'login' : 'register';
      el.authNote.textContent = '';
      paintAuthMode();
      el.authName.focus();
    });

    el.authForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var name = el.authName.value.trim();
      var pass = el.authPass.value;
      if (!name) { el.authNote.textContent = 'Enter a nickname.'; return; }
      if (pass.length < 8) { el.authNote.textContent = 'Password must be at least 8 characters.'; return; }

      el.authNote.textContent = authMode === 'register' ? 'Creating…' : 'Signing in…';
      el.authSubmit.disabled = true;

      fetch('/api/' + (authMode === 'register' ? 'register' : 'login'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name, password: pass, date: date })
      })
        .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
        .then(function (res) {
          el.authSubmit.disabled = false;
          if (!res.ok) { el.authNote.textContent = res.body.error || 'Could not sign you in.'; return; }
          el.authNote.textContent = '';
          el.authPass.value = '';
          adoptSession(res.body.token, res.body.name);
          renderZone(res.body);
          // The submitted flag belonged to the previous identity.
          state.submitted = false;
          save();
          migrateLocalSolves(loadZone);
        })
        .catch(function () {
          el.authSubmit.disabled = false;
          el.authNote.textContent = 'Could not reach the server. Try again.';
        });
    });

    el.pwForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var current = el.pwCurrent.value;
      var next = el.pwNext.value;
      if (next.length < 8) { el.pwNote.textContent = 'New password must be at least 8 characters.'; return; }

      el.pwNote.textContent = 'Updating…';
      el.pwSave.disabled = true;
      fetch('/api/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: session.token(), current: current, next: next })
      })
        .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
        .then(function (res) {
          el.pwSave.disabled = false;
          if (!res.ok) { el.pwNote.textContent = res.body.error || 'Could not change the password.'; return; }
          el.pwCurrent.value = '';
          el.pwNext.value = '';
          el.pwNote.textContent = 'Password updated. Other browsers were signed out.';
        })
        .catch(function () {
          el.pwSave.disabled = false;
          el.pwNote.textContent = 'Could not reach the server.';
        });
    });

    el.dayBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (el.cal.hidden) openCalendar(); else closeCalendar();
    });

    el.calGrid.addEventListener('click', function (e) {
      var cell = e.target.closest('.cal-day');
      if (!cell || cell.disabled || !cell.dataset.day) return;
      closeCalendar();
      goToDay(cell.dataset.day);
    });

    el.calPrev.addEventListener('click', function () {
      calCursor = { y: calCursor.m === 0 ? calCursor.y - 1 : calCursor.y,
                    m: calCursor.m === 0 ? 11 : calCursor.m - 1 };
      renderCalendar();
    });
    el.calNext.addEventListener('click', function () {
      calCursor = { y: calCursor.m === 11 ? calCursor.y + 1 : calCursor.y,
                    m: calCursor.m === 11 ? 0 : calCursor.m + 1 };
      renderCalendar();
    });
    el.calToday.addEventListener('click', function () { closeCalendar(); goToDay(date); });

    el.cal.addEventListener('click', function (e) { e.stopPropagation(); });
    document.addEventListener('click', function () { if (!el.cal.hidden) closeCalendar(); });

    el.signOutBtn.addEventListener('click', signOut);

    el.profileBtn.addEventListener('click', function () {
      el.whoami.textContent = playerName || 'not signed in';
      el.pwNote.textContent = '';
      el.pwCurrent.value = '';
      el.pwNext.value = '';
      el.profileOverlay.hidden = false;
      el.closeProfileBtn.focus();
    });
    el.closeProfileBtn.addEventListener('click', function () {
      el.profileOverlay.hidden = true;
      el.profileBtn.focus();
    });

    document.addEventListener('keydown', function (e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (gated) return;

      if (e.key === 'Escape') {
        if (!el.cal.hidden) { closeCalendar(); el.dayBtn.focus(); return; }
        if (!el.helpOverlay.hidden) { el.helpOverlay.hidden = true; el.helpBtn.focus(); return; }
        if (!el.profileOverlay.hidden) { el.profileOverlay.hidden = true; el.profileBtn.focus(); return; }
        if (!el.winOverlay.hidden) { el.winOverlay.hidden = true; return; }
        state.selected = null;
        render();
        return;
      }
      if (!el.helpOverlay.hidden || !el.winOverlay.hidden || !el.profileOverlay.hidden) return;

      var slot = TUBE_KEYS.indexOf(e.key);
      if (slot !== -1) { e.preventDefault(); tap(slot); return; }
      if (e.key === 'u' || e.key === 'U') { e.preventDefault(); undo(); return; }
      if (e.key === 'r' || e.key === 'R') { e.preventDefault(); restart(); }
    });

    render();
    renderLeaderboard();
    paintDayNav();
    if (!session.token()) setGate(true);
    // A solve saved while offline is retried on the next visit.
    if (state.won && !state.submitted && state.moveLog.length > 0) submitScore();
    else loadZone();
    startPolling();
    theme.init();
    earth.start();
    startCountdown();

    var yearEl = document.getElementById('footYear');
    if (yearEl) yearEl.textContent = String(new Date().getFullYear());
    // Deliberately no win overlay on load. A solve already recorded is shown
    // by the Solved chip and the leaderboard, not by a modal on every reload.
  }

  /* ------------------------------------------------------------------ */

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot);
    } else {
      boot();
    }
  }

  if (typeof module !== 'undefined' && module.exports) {
    // Rules only. The generator and solver live in server/puzzle.js.
    module.exports = {
      CAPACITY: CAPACITY, COLOR_COUNT: COLOR_COUNT, TUBE_COUNT: TUBE_COUNT,
      isSolved: isSolved, canPour: canPour, pour: pour, clone: clone,
      isoDate: isoDate, topRun: topRun
    };
  }

})();
