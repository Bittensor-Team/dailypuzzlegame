/*
 * Solving a board optimally takes anywhere from a tenth of a second to a few
 * seconds. Node runs one thread, so doing that on the request path would stall
 * every other player for the duration. It runs here instead, off to one side.
 */
'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const game = require('./puzzle.js');
const optimal = require('./optimal.js');

const day = String(workerData && workerData.day || '');
const result = optimal.best(game.generate('dcp-' + day), { maxMs: 25000 });
parentPort.postMessage({ day, moves: result.moves, proved: result.proved, ms: result.ms });
