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