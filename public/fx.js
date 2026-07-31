/*
 * Fireworks — shared by the daily puzzle and the battle page.
 *
 * One canvas (#fx), one rAF loop that stops itself when nothing is left to
 * draw. Lives in its own file so both pages celebrate identically instead of
 * drifting apart as one of them gets tweaked.
 *
 * Exposes window.DCPFx: .solve() for finishing, .champion() for winning.
 */
'use strict';

var DCPFx = (function () {
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

window.DCPFx = DCPFx;
