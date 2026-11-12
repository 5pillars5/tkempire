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
    'status-filter','search','refresh','all-count','qualified-count','paper-count',
    'mode-label','view-positions','view-closed','view-signals','tab-open-count','tab-closed-count','tab-signal-count','price-feed-status']){
    assert.ok(html.includes('id="'+id+'"'),'missing '+id);
  }
  assert.match(html,/@media\(max-width:720px\)/);
  assert.match(html,/aria-label="Choose Genesis view"/);
  assert.match(html,/id="view-positions"[^>]*aria-pressed="true"/);
  assert.match(html,/id="view-signals"[^>]*aria-pressed="false"/);
  assert.match(html,/id="view-closed"[^>]*aria-pressed="false"/);
  assert.match(html,/view==='closed'/);
  assert.match(html,/Verified closed paper trades/);
  assert.match(html,/Closed-trade feed not verified/);
  assert.match(html,/Close|Closed trades/);
  assert.match(html,/realized_pnl/);
  assert.match(html,/CANONICAL_CLOSED_PAPER_LEDGER|canonical close/i);
  assert.match(html,/No result is inferred from disappearing positions/i);
  assert.match(html,/fetch\('\/api\/genesis\/trade-history\?page='/);
  assert.match(html,/LEDGER_UNIT_UNVERIFIED/);
  assert.match(html,/positions=view==='positions'/);
  assert.match(html,/Only positions corroborated by Genesis/);
  assert.match(html,/Signal trigger/);
  assert.match(html,/paper_position_verified===true/);
  assert.doesNotMatch(html,/id="rejected-count"/);
  assert.match(html,/site-tabs\.js\?v=4/);
  assert.match(html,/cache:'no-store'/);
  assert.match(html,/GENESIS_PUBLIC_SIGNAL_PROJECTION/);
  assert.match(html,/data\.execution_authority!=='none'/);
  assert.match(html,/Awaiting approved Genesis signal feed/);
  assert.match(html,/new Date\(/);
  assert.match(html,/Current market mid \(USD\)/);
  assert.match(html,/HYPERLIQUID_PERP_MID/);
  assert.match(html,/fetch\('\/api\/genesis\/prices'/);
  assert.match(html,/MARKET_INDICATION_NOT_EXECUTABLE_PRICE|Indicative Hyperliquid perpetual mid-prices/);
  assert.match(html,/quoteFetchedAt/);
  assert.match(html,/Price stale/);
  assert.match(html,/Market prices unavailable/);
  assert.match(html,/Gross unrealized movement/);
  assert.match(html,/paper-pnl/);
  assert.match(html,/GenesisPaperMark\.calculate/);
  assert.match(html,/not total P&L/i);
  assert.match(html,/genesis-paper-mark\.js\?v=1/);
  assert.match(html,/15000/);
  assert.match(html,/textContent=String\(text\)/);
  assert.equal(html.includes('<nav class="quicklinks"'),false,'Global navigation collision');
  const inline=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .map(m=>m[1]).filter(Boolean);
  assert.equal(inline.length,1);
  new vm.Script(inline[0],{filename:'genesis-signals-inline.js'});
});
test('complete verified PAPER history is separate, paginated and fail closed',()=>{
  const html=file('genesis-signals.html');
  for(const id of ['history-progress','history-actions','history-load']){
    assert.match(html,new RegExp('id="'+id+'"'));
  }
  assert.match(html,/fetch\('\/api\/genesis\/trade-history\?page='/);
  assert.match(html,/GENESIS_VERIFIED_PAPER_HISTORY_V1/);
  assert.match(html,/LEDGER_UNIT_UNVERIFIED/);
  assert.match(html,/closedTotal\+closedExcluded/);
  assert.match(html,/history-load'\)\.addEventListener\('click',loadMoreClosed/);
  assert.match(html,/History ledger changed while paging/);
  assert.match(html,/Search applies to loaded records only/);
  assert.match(html,/Full closed-history feed not verified/);
  assert.doesNotMatch(html,/fetch\('\/api\/genesis\/closed-trades'/);
});
test('public Genesis signals entry is included in global navigation and sitemap',()=>{
  const tabs=file('assets/js/site-tabs.js');
  assert.ok(tabs.includes("['Genesis Signals','/genesis-signals.html'"));
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
