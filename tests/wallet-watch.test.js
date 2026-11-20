'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const { selectWallets, normalizeTrade } = require('../api/wallet-watch');
const wallet = i => '0x' + String(i).padStart(40, '0');
const tx = i => '0x' + String(i).padStart(64, 'a');
const now = 1795180000;
function activity(address, side, id, size = 1234) {
  return {
    type: 'TRADE', proxy_wallet: address,
    side, usdc_size: size, timestamp: now - 15,
    transaction_hash: tx(id), condition_id: '0x' + 'b'.repeat(64),
    token_id: '123', size: size * 2, price: 0.5,
    title: 'A public prediction market?', outcome: 'Yes', event_slug: 'sample-event'
  };
}
test('weekly leaderboard selects only valid positive-PnL current wallet addresses', () => {
  const list = selectWallets([
    { user_id: wallet(1), user_name: 'One', pnl: 500, volume: 5000, rank: 1 },
    { user_id: wallet(2), user_name: 'Two', pnl: -500, volume: 5000, rank: 2 },
    { user_id: wallet(3), user_name: 'Three', pnl: 100, volume: 5000, rank: 3 }
  ]);
  assert.equal(list.length, 2);
  assert.deepEqual(list.map(r => r.wallet), [wallet(1), wallet(3)]);
  assert.ok(list.every(r => r.selection === 'weekly_crypto'));
});
test('trade verifies wallet, direction, recent timestamp, hash and amount', () => {
  const a = activity(wallet(1), 'BUY', 1);
  assert.equal(normalizeTrade(a, wallet(1), now).side, 'BUY');
  assert.equal(normalizeTrade({...a,side:'SELL'},wallet(1),now).side,'SELL');
  assert.equal(normalizeTrade(a,wallet(2),now),null);
  assert.equal(normalizeTrade({...a,side:'MINT'},wallet(1),now),null);
  assert.equal(normalizeTrade({...a,usdc_size:-1},wallet(1),now),null);
  assert.equal(normalizeTrade({...a,timestamp:now-90000},wallet(1),now),null);
  assert.equal(normalizeTrade({...a,transaction_hash:'wrong'},wallet(1),now),null);
  assert.equal(normalizeTrade({...a,type:'REDEEM'},wallet(1),now),null);
});
test('event slugs reject external URLs and untrusted separators', () => {
  const entry=normalizeTrade({...activity(wallet(1),'BUY',1),event_slug:'https://bad.site/redirect'},wallet(1),now);
  assert.equal(entry.event_slug,null);
});
test('HTML is a compact read-only responsive page with bounded pagination', () => {
  const html=fs.readFileSync(path.join(ROOT,'wallet-watch.html'),'utf8');
  const scripts=[...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter(match=>!/src\s*=/.test(match[1])).map(match=>match[2].trim()).filter(Boolean);
  for(const src of scripts)assert.doesNotThrow(()=>new vm.Script(src));
  assert.match(html,/PAGE_SIZE = 6/);
  assert.match(html,/setInterval\(\(\)=>\{if\(!document.hidden\)load\(\);\},30000\)/);
  assert.match(html,/@media\(max-width:720px\)/);
  assert.match(html,/wallet-watch/);
  assert.doesNotMatch(html,/private_key|place_order|hyperliquid.*order/i);
  assert.match(html,/Feed unavailable/);
});
test('navigation preserves existing links and adds Wallet Watch', () => {
  const nav=fs.readFileSync(path.join(ROOT,'assets/js/site-tabs.js'),'utf8');
  const unified=fs.readFileSync(path.join(ROOT,'assets/js/empire-unified.js'),'utf8');
  const sitemap=fs.readFileSync(path.join(ROOT,'sitemap.xml'),'utf8');
  assert.match(nav,/\['Wallet Watch','\/wallet-watch.html','smart'\]/);
  assert.match(unified,/'wallet-watch':\['Wallet Watch'/);
  assert.match(sitemap,/wallet-watch.html/);
});
test('read-only API does not invoke exchange order or VPS execution paths', () => {
  const api=fs.readFileSync(path.join(ROOT,'api/wallet-watch.js'),'utf8');
  assert.doesNotMatch(api,/private_key|place_order|api\.hyperliquid|143\.244\.155\.109|ssh\s|exec\(/i);
  assert.match(api,/execution_authority: 'none'/);
  assert.match(api,/Promise.allSettled/);
  assert.match(api,/upstream_unavailable|unavailable/);
});
