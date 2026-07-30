#!/usr/bin/env node
/*
 * Account admin for Daily Color Puzzle.
 *
 * There is no email on file, so a forgotten password cannot be reset by the
 * player. It is reset here, on the server, by whoever runs it.
 *
 *   node scripts/account.js list
 *   node scripts/account.js reset  "<nickname>" "<new password>"
 *   node scripts/account.js create "<nickname>" "<password>"
 *   node scripts/account.js delete "<nickname>"
 *
 * Hashing matches server/api.js exactly: scrypt, 16-byte random salt,
 * 64-byte key, both stored hex.
 */
'use strict';

const path = require('node:path');
const { randomBytes, randomUUID, scryptSync } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const DB_DIR = process.env.DCP_DB_DIR || '/var/lib/dailycolorpuzzle';
const db = new DatabaseSync(path.join(DB_DIR, 'scores.db'));

const hash = (password, saltHex) =>
  scryptSync(password, Buffer.from(saltHex, 'hex'), 64).toString('hex');

function findByName(name) {
  return db.prepare('SELECT * FROM players WHERE name_lower = ?').get(name.trim().toLowerCase());
}

function checkPassword(password) {
  if (typeof password !== 'string' || password.length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exit(1);
  }
}

const [, , cmd, name, password] = process.argv;

if (cmd === 'list') {
  const rows = db.prepare(
    `SELECT p.name, p.updated, COUNT(s.day) AS solves
       FROM players p LEFT JOIN scores s ON s.player = p.player
      GROUP BY p.player ORDER BY p.name`
  ).all();
  if (rows.length === 0) {
    console.log('No accounts.');
  } else {
    for (const r of rows) {
      console.log(
        String(r.name).padEnd(26),
        String(r.solves).padStart(3), 'solves  ',
        new Date(Number(r.updated)).toISOString().slice(0, 16).replace('T', ' ')
      );
    }
  }
  process.exit(0);
}

if (cmd === 'reset') {
  if (!name) { console.error('Usage: account.js reset "<nickname>" "<new password>"'); process.exit(1); }
  checkPassword(password);
  const row = findByName(name);
  if (!row) { console.error('No account called ' + JSON.stringify(name) + '. Use "create" instead.'); process.exit(1); }
  const salt = randomBytes(16).toString('hex');
  db.prepare('UPDATE players SET pass_hash = ?, pass_salt = ?, updated = ? WHERE player = ?')
    .run(hash(password, salt), salt, Date.now(), row.player);
  // Any session opened with the old password stops working.
  const gone = db.prepare('DELETE FROM sessions WHERE player = ?').run(row.player);
  console.log('Password reset for ' + row.name + '. Sessions closed: ' + gone.changes + '.');
  process.exit(0);
}

if (cmd === 'create') {
  if (!name) { console.error('Usage: account.js create "<nickname>" "<password>"'); process.exit(1); }
  checkPassword(password);
  if (findByName(name)) { console.error('That nickname already exists. Use "reset" instead.'); process.exit(1); }
  const clean = name.trim().replace(/\s+/g, ' ');
  if (clean.length < 1 || clean.length > 24) { console.error('Nickname must be 1 to 24 characters.'); process.exit(1); }
  const salt = randomBytes(16).toString('hex');
  db.prepare(
    'INSERT INTO players (player, name, name_lower, pass_hash, pass_salt, updated) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(randomUUID(), clean, clean.toLowerCase(), hash(password, salt), salt, Date.now());
  console.log('Created ' + clean + '.');
  process.exit(0);
}

if (cmd === 'delete') {
  if (!name) { console.error('Usage: account.js delete "<nickname>"'); process.exit(1); }
  const row = findByName(name);
  if (!row) { console.error('No account called ' + JSON.stringify(name) + '.'); process.exit(1); }
  db.prepare('DELETE FROM sessions WHERE player = ?').run(row.player);
  const scores = db.prepare('DELETE FROM scores WHERE player = ?').run(row.player);
  db.prepare('DELETE FROM players WHERE player = ?').run(row.player);
  console.log('Deleted ' + row.name + ' and ' + scores.changes + ' score(s).');
  process.exit(0);
}

console.error('Usage: account.js list | reset <nickname> <password> | create <nickname> <password> | delete <nickname>');
process.exit(1);
