'use strict';
const assert=require('node:assert/strict');
const test=require('node:test');
const fs=require('node:fs');
const path=require('node:path');
const {route}=require('../assets/js/coinbase-predictions-routing');
const html=fs.readFileSync(path.resolve(__dirname,'../smart-money-flow.html'),'utf8');
const script=fs.readFileSync(path.resolve(__dirname,'../assets/js/smart-money-flow-map.js'),'utf8');
test('routes Bitcoin / BTC flow to verified Coinbase BTC predictions category',()=>{
 const r=route('Will Bitcoin dip to $72,500 in November?');
 assert.equal(r.url,'https://www.coinbase.com/predictions/crypto/BTC');
 assert.equal(r.matched_contract,false);
 assert.match(r.label,/BTC/);
 assert.equal(route('Bitcoin Up or Down - November 8').url,r.url);
});
test('routes ETH/SOL and non-BTC crypto to relevant categories without invented contracts',()=>{
 assert.equal(route('Will the price of Ethereum be above $2,300 on November 9?').url,
 'https://www.coinbase.com/predictions/crypto/ETH');
 assert.equal(route('Solana price forecast').url,
 'https://www.coinbase.com/predictions/crypto/SOL');
 assert.equal(route('XRP price on November 10?').url,
 'https://www.coinbase.com/predictions/crypto');
});
test('unrecognized markets use official Coinbase predictions home, never a guessed deep link',()=>{
 assert.equal(route('2026 weather outcome').url,'https://www.coinbase.com/predictions');
 assert.equal(route(null).url,'https://www.coinbase.com/predictions');
 assert.equal(route('btc javascript:alert(1)').url,'https://www.coinbase.com/predictions/crypto/BTC');
});
test('flow rows preserve inspect selection while adding separate one-tap external navigation',()=>{
 assert.ok(script.includes("row.addEventListener('click',()=>selectMarket(m.market_id))"));
 assert.ok(script.includes('target.append(entry)'));
 assert.ok(script.includes("link.target='_blank'"));
 assert.ok(script.includes("link.rel='noopener noreferrer'"));
 assert.match(html,/Coinbase Predictions/);
 assert.ok(html.includes('coinbase-predictions-routing.js'));
 assert.ok(html.includes('smart-money-flow-map.js?v=4'));
});
