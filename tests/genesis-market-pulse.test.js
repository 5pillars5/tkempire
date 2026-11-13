'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const core=require('../assets/js/genesis-market-pulse-core.js');
const base=Date.parse('2026-11-12T15:00:00.000Z');
const source={schema_version:1,status:'ok',source:'HYPERLIQUID_PERP_MID',
  market:'hyperliquid_mainnet_perpetuals',quote_type:'indicative_mid_usd',
  disclosure:'MARKET_INDICATION_NOT_EXECUTABLE_PRICE'};
const quote=(price,time)=>({...source,retrieved_at:new Date(time).toISOString(),prices:{SOL:price,BNB:600,APT:2.5}});
test('only fixed, recent, validated indicative prices may become samples',()=>{
 const parsed=core.parseQuote({...quote(100,base),prices:{SOL:100,BNB:600,APT:2.5,BTC:99999}},base+1000);
 assert.equal(parsed.prices.SOL,100);
 assert.equal(Object.hasOwn(parsed.prices,'BTC'),false);
 for(const bad of [{...quote(100,base),source:'COINBASE'},
                   {...quote(100,base),market:'polymarket_settlement'},
                   {...quote(100,base),disclosure:'EXECUTABLE'},
                   {...quote(100,base),schema_version:2},
                   quote(100,base-16000),quote(100,base+1000)]){
   assert.equal(core.parseQuote(bad,base),null);
 }
});
test('20-second trend and acceleration are observed, not probabilities',()=>{
 let s={};for(let i=0;i<3;i++){
   const t=base+i*10000;
   const q=core.parseQuote(quote([100,100.1,100.4][i],t),t);
   s=core.addQuote(s,q);
 }
 const m=core.metrics(s.SOL,base+20000);
 assert.equal(m.state,'READY');assert.equal(m.direction,'RISING');
 assert.equal(m.windowSeconds,20);
 assert.ok(m.moveBps>39&&m.moveBps<41);
 assert.ok(m.speedBpsPerSec>0);
 assert.ok(m.accelerationBpsPerSec2>0);
 assert.equal('probability' in m,false);
 assert.equal('prediction' in m,false);
 assert.equal('side' in m,false);
});
test('flat markets, duplicate timestamps, stale data and irregular windows fail honestly',()=>{
 let s={};
 for(const t of [base,base+10000,base+20000])s=core.addQuote(s,core.parseQuote(quote(100,t),t));
 assert.equal(core.metrics(s.SOL,base+20000).direction,'FLAT');
 s=core.addQuote(s,core.parseQuote(quote(103,base+20000),base+20000));
 assert.equal(s.SOL.length,3);
 assert.equal(core.metrics(s.SOL,base+41000).state,'STALE');
 assert.equal(core.metrics(s.SOL.slice(0,2),base+20000).state,'COLLECTING');
 const irregular=[{t:base,p:100},{t:base+2000,p:101},{t:base+20000,p:102}];
 assert.equal(core.metrics(irregular,base+20000).state,'COLLECTING');
});
test('delayed and duplicate quotes never erase newer observations or rewind the computed window',()=>{
 let history={};
 for(const [i,price] of [100,100.1,100.4].entries()){
   const t=base+i*10000;
   history=core.addQuote(history,core.parseQuote(quote(price,t),t));
 }
 const original=JSON.stringify(history);
 const previous=core.metrics(history.SOL,base+20000);
 assert.equal(previous.state,'READY');
 const delayed=core.parseQuote(quote(97,base+15000),base+21000);
 const rejected=core.addQuote(history,delayed);
 assert.strictEqual(rejected,history,'older quote must be ignored without rebuilding history');
 assert.equal(JSON.stringify(history),original,'existing accepted timestamps and prices must survive');
 assert.deepEqual(core.metrics(history.SOL,base+21000).moveBps,previous.moveBps);
 const duplicate=core.parseQuote(quote(999,base+20000),base+21000);
 assert.strictEqual(core.addQuote(history,duplicate),history,'same timestamp must not overwrite a verified sample');
 const fresh=core.parseQuote(quote(100.5,base+30000),base+30000);
 const advanced=core.addQuote(history,fresh);
 assert.notStrictEqual(advanced,history,'a strictly newer quote should advance the window');
 assert.deepEqual(advanced.SOL.map(x=>x.t),[base,base+10000,base+20000,base+30000]);
 assert.equal(core.metrics(advanced.SOL,base+30000).last,100.5);
});
test('rapid manual refresh is ignored without displacing the valid READY trio',()=>{
 let s={};
 for(const t of [base,base+10000,base+20000])s=core.addQuote(s,core.parseQuote(quote(100,t),t));
 assert.equal(core.metrics(s.SOL,base+20000).state,'READY');
 const quick=core.parseQuote(quote(100.8,base+25000),base+25000);
 assert.strictEqual(core.addQuote(s,quick),s);
 assert.equal(core.metrics(s.SOL,base+25000).state,'READY');
 s=core.addQuote(s,core.parseQuote(quote(101,base+30000),base+30000));
 assert.equal(core.metrics(s.SOL,base+30000).state,'READY');
 s=core.addQuote(s,core.parseQuote(quote(101.3,base+37000),base+37000));
 assert.equal(core.metrics(s.SOL,base+37000).state,'READY');
 assert.strictEqual(core.addQuote(s,core.parseQuote(quote(101.4,base+40000),base+40000)),s);
 s=core.addQuote(s,core.parseQuote(quote(101.6,base+50000),base+50000));
 assert.equal(core.metrics(s.SOL,base+50000).state,'READY');
});
test('a partial older feed cannot backfill stale asset data or rewind another asset',()=>{
 const initial=core.parseQuote({...quote(100,base),prices:{SOL:100,BNB:600}},base);
 const current=core.parseQuote({...quote(101,base+10000),prices:{SOL:101,BNB:601}},base+10000);
 let history=core.addQuote({},initial);
 history=core.addQuote(history,current);
 const delayed=core.parseQuote(quote(99,base+5000),base+11000);
 assert.ok(delayed,'out-of-order source data can still satisfy freshness validation');
 assert.strictEqual(core.addQuote(history,delayed),history,'watermark must apply across the entire multi-asset snapshot');
 assert.deepEqual(history.APT,[]);
 assert.deepEqual(history.SOL.map(x=>x.p),[100,101]);
 assert.deepEqual(history.BNB.map(x=>x.p),[600,601]);
});
test('UI is mobile-safe, read-only, correctly labels source and parses',()=>{
 const html=fs.readFileSync(path.join(root,'genesis-market-pulse.html'),'utf8');
 for(const v of ['data-asset="SOL"','data-asset="BNB"','data-asset="APT"',
   'genesis-market-pulse-core.js','/api/genesis/prices','Polymarket',
   'No trading authority','@media(max-width:850px)','cache:\'no-store\'']){
   assert.ok(html.includes(v),'missing '+v);
 }
 assert.doesNotMatch(html,/placeOrder|createOrder|privateKey|execution_authority:\s*['"]enabled/i);
 assert.match(html,/Delayed, duplicate, or too-soon quote ignored/);
 const scripts=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
   .map(x=>x[1]).filter(Boolean);
 assert.equal(scripts.length,1);
 new vm.Script(scripts[0]);
});
