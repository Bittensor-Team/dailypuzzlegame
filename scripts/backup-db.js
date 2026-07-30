#!/usr/bin/env node
/*
 * Write a consistent snapshot of the scoreboard database.
 *
 * VACUUM INTO is used rather than copying the file: the database runs in WAL
 * mode, so a plain cp during a write can capture a torn state.
 *
 *   node scripts/backup-db.js <source.db> <target.db>
 */
'use strict';

const { DatabaseSync } = require('node:sqlite');

const [, , source, target] = process.argv;
if (!source || !target) {
  console.error('Usage: backup-db.js <source.db> <target.db>');
  process.exit(1);
}

// VACUUM INTO takes a single-quoted SQL string literal, not a bound parameter.
// Embedded single quotes are doubled to escape them.
const quoted = "'" + String(target).replace(/'/g, "''") + "'";

const db = new DatabaseSync(source, { readOnly: true });
db.exec('VACUUM INTO ' + quoted);
db.close();
