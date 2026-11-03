'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(root,name),'utf8');

test('phone navigation has an accessible menu and responsive layout', () => {
  const nav=read('assets/js/site-tabs.js');
  const css=read('assets/css/site-tabs.css');
  assert.match(nav,/aria-expanded/);
  assert.match(nav,/aria-controls/);
  assert.match(nav,/Escape/);
  assert.match(css,/\.empire-global-nav__links\.is-open/);
  assert.match(css,/max-width:700px/);
});
test('Genesis pipeline reads only public filtered APIs', () => {
  const brain=read('assets/js/genesis-brain.js');
  const dashboard=read('dashboard.html');
  assert.match(dashboard,/GENESIS VERIFIED OPERATIONS PIPELINE/);
  assert.match(brain,/getJSON\('\/api\/health'\)/);
  assert.match(brain,/getJSON\('\/api\/genesis\/status'\)/);
  assert.doesNotMatch(brain,/\/api\/genesis-thoughts|\/api\/genesis-weights/);
  assert.doesNotMatch(dashboard,/fetch\('\/api\/genesis-thoughts|fetch\('\/api\/genesis-weights/);
  assert.match(brain,/fresh\(health.served_at\)/);
  assert.match(dashboard,/Individual decisions remain private/);
});
test('community is not simulated or falsely represented as synchronized', () => {
  const community=read('community.html');
  assert.doesNotMatch(community,/function sendMessage|Simulated reply|FULLNAMES/);
  assert.match(community,/There is no synchronized website chat/);
});
test('results and research clearly distinguish fresh from archived', () => {
  assert.doesNotMatch(read('results.html'),/raw\.githubusercontent\.com\/5pillars5\/tkempire\/main\/stats\.json/);
  assert.match(read('research.html'),/ARCHIVED \/ STALE/);
  assert.doesNotMatch(read('app.html'),/fetch\('\/api\/portfolio/);
});
test('browser JavaScript files parse', () => {
  for (const f of [
    'assets/js/genesis-brain.js',
    'assets/js/genesis-connection.js',
    'assets/js/genesis-live.js',
    'assets/js/site-tabs.js',
    'empire.js'
  ]) assert.doesNotThrow(() => new vm.Script(read(f),{filename:f}));
});
test('inline scripts parse on key changed pages', () => {
  for (const file of ['dashboard.html','results.html','research.html','community.html','app.html']) {
    const html=read(file);
    const scripts=[...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
      .filter(m=>!/\bsrc\s*=/.test(m[1]) && !/type\s*=\s*["']application\//i.test(m[1]))
      .map(m=>m[2].trim()).filter(Boolean);
    for (const script of scripts) assert.doesNotThrow(() => new vm.Script(script,{filename:file}));
  }
});
test('mobile Results distinguishes current paper aggregates from archived signals', () => {
  const results=read('results.html');
  assert.match(results,/Paper performance/);
  assert.match(results,/GENESIS|Genesis/);
  assert.match(results,/\/api\/genesis\/status/);
  assert.match(results,/\/api\/health/);
  assert.match(results,/generated_for !== 'PUBLIC_ARCHIVE_ONLY'/);
  assert.match(results,/<details class="panel archive"/);
  assert.match(results,/Archive temporarily unavailable/);
  assert.match(results,/aria-label="Search historical observations"/);
  assert.match(results,/FRESH_LIMIT_MS = 120000/);
  assert.doesNotMatch(results,/SIGNAL ENGINE IN LEARNING MODE/);
  assert.doesNotMatch(results,/raw\.githubusercontent\.com/);
  assert.doesNotMatch(results,/data\/portfolio\.json/);
  assert.doesNotMatch(results,/function filterResults/);
  assert.doesNotMatch(results,/Last 7 Days/);
});

test('archive mobile cards are compact and STALE is not silently counted as a loss', () => {
  const results=read('results.html');
  assert.match(results,/min-height:64px/);
  assert.match(results,/STALE means the source recorded a stale status/);
  assert.match(results,/not scored as a win or loss/);
  assert.match(results,/id="archive-filter"/);
  assert.match(results,/var archive=null,shown=12/);
  assert.match(results,/shown\+=12/);
  assert.doesNotMatch(results,/result\.textContent='Recorded outcome: '/);
});

test('public app never promises unsupported push alerts or live orders', () => {
  const app=read('app.html');
  assert.match(app,/PAPER API CONNECTED/);
  assert.match(app,/isFresh\(health\.served_at\)/);
  assert.match(app,/isFresh\(status\.updated_at\)/);
  assert.match(app,/Browser push-signal subscriptions are not configured/);
  assert.match(app,/https:\/\/t\.me\/tkempirebot/);
  assert.match(app,/href="\/results\.html"/);
  assert.doesNotMatch(app,/requestNotifications|Notification\.requestPermission/);
  assert.doesNotMatch(app,/You will now receive signal alerts instantly/);
  assert.doesNotMatch(app,/Never miss an entry again/);
  assert.doesNotMatch(app,/class="live-txt">LIVE/);
});
