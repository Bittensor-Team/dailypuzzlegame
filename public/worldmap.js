/*
 * The dotted world map — shared by the daily puzzle and the battle page.
 *
 * Drawn from real coastline data (Natural Earth 110m, sampled by
 * scripts/gen-earth.js) onto every <canvas class="worldmap"> on the page.
 * Each canvas keeps its own size, starfield and shooting stars; the land dots
 * are prepared once and shared.
 *
 * Exposes window.DCPMap: .start() to begin, .refresh() to re-read the theme.
 */
'use strict';

  /* A flat equirectangular map drawn from real coastline data (Natural Earth
   110m, sampled into land dots by scripts/gen-earth.js). Canvas rather than
   SVG: a couple of thousand dots with individually animated brightness is
   cheap to repaint and expensive to express as DOM. */
var DCPMap = (function () {
  /* One scene per canvas: each has its own size, starfield and streaks. The
     land dots are prepared once and shared, since they are the same map. */
  var scenes = [], pts = null, started = false, prevT = 0;
  var canvas, ctx, dpr = 1, w = 0, h = 0, stars = [], shots = [];
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

  /* The draw code below reads module-level canvas/ctx/w/h/stars/shots, so a
     scene is swapped in before anything touches them. */
  function use(scene) {
    canvas = scene.canvas;
    ctx = scene.ctx;
    w = scene.w; h = scene.h;
    stars = scene.stars; shots = scene.shots;
  }

  function stash(scene) {
    scene.w = w; scene.h = h;
    scene.stars = stars; scene.shots = shots;
  }

  function size(scene) {
    use(scene);
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = canvas.clientWidth;
    h = canvas.clientHeight;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    seedStars();
    stash(scene);
  }

  function sizeAll() { for (var i = 0; i < scenes.length; i++) size(scenes[i]); }

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
    for (var i = 0; i < scenes.length; i++) {
      var scene = scenes[i];
      // A hidden panel has no size; drawing into it wastes a frame.
      if (!scene.canvas.clientWidth || !scene.canvas.clientHeight) continue;
      if (scene.canvas.clientWidth !== scene.w || scene.canvas.clientHeight !== scene.h) size(scene);
      use(scene);
      draw(t, dt);
      drawShots(dt);
      stash(scene);
    }
    requestAnimationFrame(loop);
  }

  // Reduced motion gets one still frame per canvas instead of a loop.
  function drawAllStill() {
    for (var i = 0; i < scenes.length; i++) {
      if (!scenes[i].canvas.clientWidth) continue;
      use(scenes[i]);
      draw(0);
      stash(scenes[i]);
    }
  }

  return {
    refresh: function () { readInk(); if (reduced()) drawAllStill(); },
    start: function () {
      if (started) return;
      var canvases = document.querySelectorAll('canvas.worldmap');
      if (!canvases.length || !window.DCP_EARTH) return;
      readInk();
      pts = prepare(window.DCP_EARTH);
      for (var i = 0; i < canvases.length; i++) {
        scenes.push({
          canvas: canvases[i], ctx: canvases[i].getContext('2d'),
          w: 0, h: 0, stars: [], shots: []
        });
      }
      started = true;
      sizeAll();
      window.addEventListener('resize', function () {
        sizeAll();
        if (reduced()) drawAllStill();
      });
      if (reduced()) drawAllStill();
      else requestAnimationFrame(loop);
    }
  };
})();

window.DCPMap = DCPMap;
