/*
 * Puzzle rules, solver and generator — server-side only.
 *
 * This file is deliberately NOT served to the browser. Shipping the generator
 * let anyone compute future boards; shipping the solver let anyone produce a
 * perfect run and post it as their own. The browser now receives only a dealt
 * board and the rules needed to play it.
 */
'use strict';

const CAPACITY = 4;      // blocks per tube
const COLOR_COUNT = 10;  // one full tube per color
const SPARE_TUBES = 2;   // empty tubes to work with
const TUBE_COUNT = COLOR_COUNT + SPARE_TUBES;

/* ---------------------------------------------------------------- */
/* Seeded randomness                                                 */
/* ---------------------------------------------------------------- */

function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

// mulberry32
function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------------------------------------------------------------- */
/* Core rules                                                        */
/* ---------------------------------------------------------------- */

function clone(tubes) {
  const out = new Array(tubes.length);
  for (let i = 0; i < tubes.length; i++) out[i] = tubes[i].slice();
  return out;
}

function topRun(tube) {
  if (tube.length === 0) return null;
  const color = tube[tube.length - 1];
  let count = 1;
  while (count < tube.length && tube[tube.length - 1 - count] === color) count++;
  return { color, count };
}

function isTubeDone(tube) {
  if (tube.length === 0) return true;
  if (tube.length !== CAPACITY) return false;
  for (let i = 1; i < tube.length; i++) if (tube[i] !== tube[0]) return false;
  return true;
}

function isSolved(tubes) {
  for (let i = 0; i < tubes.length; i++) if (!isTubeDone(tubes[i])) return false;
  return true;
}

function canPour(tubes, from, to) {
  if (from === to) return false;
  const src = tubes[from];
  const dst = tubes[to];
  if (src.length === 0) return false;
  if (dst.length >= CAPACITY) return false;
  if (dst.length > 0 && dst[dst.length - 1] !== src[src.length - 1]) return false;
  return true;
}

function pour(tubes, from, to) {
  if (!canPour(tubes, from, to)) return 0;
  const run = topRun(tubes[from]);
  const room = CAPACITY - tubes[to].length;
  const n = Math.min(run.count, room);
  for (let i = 0; i < n; i++) tubes[to].push(tubes[from].pop());
  return n;
}

/* ---------------------------------------------------------------- */
/* Solver — guarantees every generated board is solvable             */
/* ---------------------------------------------------------------- */

function stateKey(tubes) {
  const parts = new Array(tubes.length);
  for (let i = 0; i < tubes.length; i++) parts[i] = tubes[i].join(',');
  parts.sort();
  return parts.join('|');
}

function usefulMoves(tubes) {
  const moves = [];
  for (let from = 0; from < tubes.length; from++) {
    const src = tubes[from];
    if (src.length === 0) continue;
    const run = topRun(src);
    if (run.count === src.length && src.length === CAPACITY) continue;
    const wholeTube = run.count === src.length;
    for (let to = 0; to < tubes.length; to++) {
      if (!canPour(tubes, from, to)) continue;
      if (wholeTube && tubes[to].length === 0) continue;
      let score = (tubes[to].length > 0 ? 10 : 0) + run.count;
      if (tubes[to].length > 0 && run.count + tubes[to].length === CAPACITY) score += 20;
      moves.push({ from, to, score });
    }
  }
  moves.sort((a, b) => b.score - a.score);
  return moves;
}

function solve(tubes, budget) {
  budget = budget || 200000;
  const seen = Object.create(null);
  let nodes = 0;
  const path = [];

  function walk(state) {
    if (isSolved(state)) return true;
    if (++nodes > budget) return false;
    const key = stateKey(state);
    if (seen[key]) return false;
    seen[key] = 1;
    for (const m of usefulMoves(state)) {
      const next = clone(state);
      pour(next, m.from, m.to);
      path.push({ from: m.from, to: m.to });
      if (walk(next)) return true;
      path.pop();
    }
    return false;
  }

  return walk(clone(tubes)) ? path : null;
}

/* ---------------------------------------------------------------- */
/* Generation                                                        */
/* ---------------------------------------------------------------- */

function shuffleDeal(rng) {
  const deck = [];
  for (let c = 0; c < COLOR_COUNT; c++) {
    for (let k = 0; k < CAPACITY; k++) deck.push(c);
  }
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = deck[i]; deck[i] = deck[j]; deck[j] = tmp;
  }
  const tubes = [];
  for (let t = 0; t < COLOR_COUNT; t++) tubes.push(deck.slice(t * CAPACITY, (t + 1) * CAPACITY));
  for (let s = 0; s < SPARE_TUBES; s++) tubes.push([]);
  return tubes;
}

function isInteresting(tubes) {
  let finished = 0;
  for (const tube of tubes) if (tube.length === CAPACITY && isTubeDone(tube)) finished++;
  return finished === 0;
}

function generate(seedText) {
  const base = hashSeed(seedText);
  for (let attempt = 0; attempt < 400; attempt++) {
    const tubes = shuffleDeal(makeRng((base + attempt * 0x9e3779b9) >>> 0));
    if (!isInteresting(tubes)) continue;
    if (solve(tubes, 120000)) return tubes;
  }
  return shuffleDeal(makeRng(base));
}

module.exports = {
  CAPACITY, COLOR_COUNT, SPARE_TUBES, TUBE_COUNT,
  clone, topRun, isTubeDone, isSolved, canPour, pour,
  solve, generate,
};
