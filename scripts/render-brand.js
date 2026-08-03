#!/usr/bin/env node
/*
 * Render brand/*.svg to the PNG set.
 *
 *   node scripts/render-brand.js
 *
 * Uses the Playwright chromium already available for the browser tests: the
 * SVGs rely on CSS drop-shadow filters, so a real rendering engine gives the
 * same result the site shows rather than an approximation.
 */
'use strict';

const fs = require('fs');
const base = process.env.HOME + '/.npm/_npx';
const { chromium } = require(base + '/' + fs.readdirSync(base).find(d => fs.existsSync(base + '/' + d + '/node_modules/playwright')) + '/node_modules/playwright');
const OUT = require('path').join(__dirname, '..', 'brand');

// What each file is for, so the set is not a pile of guesses.
const JOBS = [
  { svg: 'icon.svg', size: 512,  name: 'icon-512.png',  why: 'Slack app icon, GitHub org avatar' },
  { svg: 'icon.svg', size: 1024, name: 'icon-1024.png', why: 'high-resolution master' },
  { svg: 'icon.svg', size: 192,  name: 'icon-192.png',  why: 'PWA / Android home screen' },
  { svg: 'icon.svg', size: 180,  name: 'apple-touch-icon.png', why: 'iOS home screen' },
  { svg: 'logo.svg', size: 512,  name: 'logo-512.png',  why: 'the mark alone, transparent' },
  { svg: 'logo.svg', size: 64,   name: 'logo-64.png',   why: 'small transparent mark' },
  { svg: 'logo.svg', size: 32,   name: 'favicon-32.png', why: 'browser tab' },
];

(async () => {
  const browser = await chromium.launch();
  const results = [];
  for (const job of JOBS) {
    const svg = fs.readFileSync(OUT + '/' + job.svg, 'utf8');
    const page = await browser.newPage({
      viewport: { width: job.size, height: job.size },
      deviceScaleFactor: 1,
    });
    // omitBackground keeps the mark transparent; the icon paints its own ground.
    await page.setContent(
      '<style>html,body{margin:0;padding:0;background:transparent}' +
      'svg{display:block;width:' + job.size + 'px;height:' + job.size + 'px}</style>' + svg,
      { waitUntil: 'load' });
    await page.screenshot({ path: OUT + '/' + job.name, omitBackground: true });
    await page.close();
    const bytes = fs.statSync(OUT + '/' + job.name).size;
    results.push({ file: job.name, px: job.size + '×' + job.size, kb: (bytes / 1024).toFixed(1), for: job.why });
  }
  await browser.close();
  console.log(results.map(r => `${r.file.padEnd(22)} ${r.px.padEnd(11)} ${(r.kb + ' KB').padStart(9)}  ${r.for}`).join('\n'));
})();
