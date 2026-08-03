#!/usr/bin/env node
/*
 * Post a connection check to Slack, and report what is configured.
 *
 *   node scripts/slack-test.js
 *
 * Reads the same config the server does (/etc/dailycolorpuzzle.env, or
 * DCP_CONFIG). Nothing here needs the database or a running API.
 */
'use strict';

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const DB_DIR = process.env.DCP_DB_DIR || '/var/lib/dailycolorpuzzle';

const slack = require('../server/slack.js')({
  db: new DatabaseSync(path.join(DB_DIR, 'scores.db')),
  distribution: () => ({}),
  today: () => new Date().toISOString().slice(0, 10),
  battles: { ranking: () => [], live: () => [] },
});

const state = slack.status();
console.log('config:      ' + slack.configPath);
console.log('site url:    ' + slack.siteUrl());
console.log('announce:    ' + (state.announce ? 'on' : 'off — set SLACK_WEBHOOK_URL'));
console.log('/puzzle:     ' + (state.command ? 'on' : 'off — set SLACK_SIGNING_SECRET'));
console.log('installs:    ' + (state.install
  ? 'on — ' + slack.installUrl()
  : 'off — set SLACK_CLIENT_ID and SLACK_CLIENT_SECRET'));
console.log('workspaces:  ' + state.workspaces);

if (!state.announce && !state.workspaces) process.exit(1);

slack.ping().then((ok) => {
  console.log(ok ? 'sent: check the channel' : 'failed: Slack refused the message');
  process.exit(ok ? 0 : 1);
});
