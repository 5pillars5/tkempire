'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const file=name=>fs.readFileSync(path.join(root,name),'utf8');
test('Genesis signals page is mobile-responsive, accessible and error-safe',()=>{
  const html=file('genesis-signals.html');
  assert.match(html,/<title>Genesis Signals \| TK Empire<\/title>/);
  for(const id of ['feed-pill','last-update','feed-message','signal-cards',
    'status-filter','search','refresh','all-count','qualified-count','rejected-count','paper-count']){
    assert.ok(html.includes('id="'+id+'"'),'missing '+id);
  }
  assert.match(html,/@media\(max-width:720px\)/);
  assert.match(html,/site-tabs\.js\?v=4/);
  assert.match(html,/cache:'no-store'/);
  assert.match(html,/GENESIS_PUBLIC_SIGNAL_PROJECTION/);
  assert.match(html,/data\.execution_authority!=='none'/);
  assert.match(html,/No approved Genesis signal feed yet/);
  assert.match(html,/new Date\(/);
  assert.match(html,/textContent=String\(text\)/);
  assert.equal(html.includes('<nav class="quicklinks"'),false,'Global navigation collision');
  const inline=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .map(m=>m[1]).filter(Boolean);
  assert.equal(inline.length,1);
  new vm.Script(inline[0],{filename:'genesis-signals-inline.js'});
});
test('public Genesis signals entry is included in global navigation and sitemap',()=>{
  const tabs=file('assets/js/site-tabs.js');
  assert.ok(tabs.includes("['Genesis Signals','/genesis-signals.html']"));
  new vm.Script(tabs,{filename:'site-tabs.js'});
  assert.ok(file('sitemap.xml').includes('https://tkempire.io/genesis-signals.html'));
});
test('new public API has no trading verbs, remains feature gated',()=>{
  const api=file('api/genesis/signals.js');
  assert.match(api,/GENESIS_SIGNALS_PUBLICATION_ENABLED/);
  assert.match(api,/CANONICAL_PAPER_LEDGER/);
  assert.match(api,/execution_authority:'none'/);
  assert.match(api,/source:'GENESIS_PUBLIC_SIGNAL_PROJECTION'/);
  assert.doesNotMatch(api,/\/trade\b|placeOrder|createOrder|privateKey|apiSecret/i);
  new vm.Script(api,{filename:'api/genesis/signals.js'});
});
