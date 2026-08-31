/*
 * The fewest moves a board can possibly be solved in — proved, not guessed.
 *
 * puzzle.js's solve() returns the first solution it stumbles on, which is why
 * a battle calls that number "par". This is IDA*: iterative deepening on
 * f = g + h, so the first solution it reaches is the shortest one, and if the
 * search finishes without one at a given bound, no solution of that length
 * exists.
 *
 * The heuristic is admissible, which is what makes the answer a proof rather
 * than an estimate: every colour must end up in a single tube, and one pour can
 * retire at most one surplus tube for one colour, so the number of surplus
 * tubes summed over colours can never exceed the moves still required.
 *
 * Server-side only. It is the answer key.
 */
'use strict';

const { clone, isSolved, canPour, pour, topRun, CAPACITY } = require('./puzzle.js');

function heuristic(tubes) {
  const holding = new Map();
  for (const tube of tubes) {
    for (const colour of new Set(tube)) holding.set(colour, (holding.get(colour) || 0) + 1);
  }
  let h = 0;
  for (const n of holding.values()) h += n - 1;
  return h;
}

/* Tubes are interchangeable, so two states differing only in which tube holds
   what are the same position. Sorting the contents collapses them. */
function stateKey(tubes) {
  const parts = new Array(tubes.length);
  for (let i = 0; i < tubes.length; i++) parts[i] = tubes[i].join(',');
  parts.sort();
  return parts.join('|');
}

function candidates(tubes) {
  const out = [];
  for (let from = 0; from < tubes.length; from++) {
    const src = tubes[from];
    if (src.length === 0) continue;
    const run = topRun(src);
    // A finished tube is never worth disturbing.
    if (run.count === src.length && src.length === CAPACITY) continue;
    const wholeTube = run.count === src.length;
    for (let to = 0; to < tubes.length; to++) {
      if (!canPour(tubes, from, to)) continue;
      // Moving an entire tube into an empty one changes nothing but the
      // labels, and cannot shorten a solution.
      if (wholeTube && tubes[to].length === 0) continue;
      out.push({ from, to });
    }
  }
  return out;
}

/**
 * @returns {{moves: number|null, proved: boolean, nodes: number, ms: number}}
 *   moves is the proved optimum when proved is true. proved false means the
 *   budget ran out first — the number, if any, is then only an upper bound.
 */
function best(start, options) {
  const opts = options || {};
  const maxMs = opts.maxMs || 30000;
  const maxNodes = opts.maxNodes || 40e6;
  const began = Date.now();

  let bound = heuristic(start);
  let nodes = 0;
  let found = null;
  let ranOut = false;

  function walk(tubes, g, seen) {
    const f = g + heuristic(tubes);
    if (f > bound) return f;
    if (isSolved(tubes)) { found = g; return -1; }
    if (++nodes > maxNodes || (nodes % 4096 === 0 && Date.now() - began > maxMs)) {
      ranOut = true;
      return -1;
    }

    let next = Infinity;
    for (const move of candidates(tubes)) {
      const child = clone(tubes);
      pour(child, move.from, move.to);
      const key = stateKey(child);
      const seenAt = seen.get(key);
      // Reaching the same position again no sooner is a detour.
      if (seenAt !== undefined && seenAt <= g + 1) continue;
      seen.set(key, g + 1);
      const r = walk(child, g + 1, seen);
      if (r === -1) return -1;
      if (r < next) next = r;
    }
    return next;
  }

  for (;;) {
    const r = walk(clone(start), 0, new Map([[stateKey(start), 0]]));
    if (found !== null) return { moves: found, proved: !ranOut, nodes, ms: Date.now() - began };
    if (ranOut) return { moves: null, proved: false, nodes, ms: Date.now() - began };
    if (r === Infinity) return { moves: null, proved: true, nodes, ms: Date.now() - began };
    bound = r;
  }
}

module.exports = { best, heuristic };
