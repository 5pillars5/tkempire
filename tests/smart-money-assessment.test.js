'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const handler=require('../api/smart-money-assessment'),{summarize,assess}=handler._test;
const condition='0x'+'a'.repeat(64),now=Date.now();
function raw(token='1',asks=[{price:'.4',size:'5'},{price:'.5',size:'20'}]){return {asset_id:token,market:condition,timestamp:String(now),min_order_size:'5',bids:[{price:'0.3',size:'30'}],asks:asks.map(a=>({...a,price:String(Number(a.price))}))};}
function book(){return summarize(raw(),'1',condition,10,now);}
test('sorts unsorted asks and walks depth, rather than extrapolating best ask',()=>{
 const b=book();assert.equal(b.best_ask,.4);assert.equal(b.buy_cost,4.5);assert.equal(b.buy_average,.45);assert.equal(b.ask_size_at_best,5);
 const reverse=raw();reverse.asks.reverse();assert.equal(summarize(reverse,'1',condition,10,now).buy_cost,4.5);
});
test('rejects token/condition mismatch and malformed levels',()=>{
 assert.throws(()=>summarize(raw(),'2',condition,10,now));
 const b=raw();b.asks[0].size='garbage';assert.throws(()=>summarize(b,'1',condition,10,now));
});
test('no gap, fees unknown, missing depth, stale or minimum failures cannot produce candidate',()=>{
 const y=book(),n={...y,buy_cost:6};assert.equal(assess(y,n,[0,0],10).status,'no_pair_gap');
 assert.equal(assess(y,y,[null,0],10).status,'fees_unverified');
 assert.equal(assess({...y,sufficient_depth:false,buy_cost:null},y,[0,0],10).status,'insufficient_liquidity');
 assert.equal(assess({...y,fresh:false},y,[0,0],10).status,'stale_quotes');
 assert.equal(assess({...y,minimum_met:false},y,[0,0],10).status,'below_minimum_size');
 assert.equal(assess({...y,crossed:true},y,[0,0],10).status,'inconsistent_book');
 assert.equal(assess(y,y,[0,0],10).status,'potential_pair_gap');
 assert.equal(assess(y,y,[0,0],10).gross_gap,1);
});
test('old, missing and future book times fail freshness',()=>{
 for(const timestamp of [undefined,String(now-61000),String(now+60000)])assert.equal(summarize({...raw(),timestamp},'1',condition,10,now).fresh,false);
});
function response(){return {code:0,body:null,setHeader(){},status(c){this.code=c;return this;},json(b){this.body=b;return this;}};}
test('request validation avoids all network calls',async()=>{
 const original=global.fetch;global.fetch=()=>{throw Error('unexpected fetch');};
 try{const r=response();await handler({method:'GET',query:{event:'https://evil',condition}},r);assert.equal(r.code,400);}finally{global.fetch=original;}
});
test('full handler maps reversed outcomes, matches identity and withholds unknown fees',async()=>{
 const original=global.fetch,calls=[];
 global.fetch=async url=>{calls.push(url);const u=new URL(url);let body;
 if(u.hostname==='gamma-api.polymarket.com')body={slug:'test-event',markets:[{conditionId:condition,active:true,acceptingOrders:true,enableOrderBook:true,outcomes:'["No","Yes"]',clobTokenIds:'["2","1"]',endDate:'2099-01-01T00:00:00Z'}]};
 else if(u.pathname==='/book')body={...raw(u.searchParams.get('token_id')),timestamp:String(Date.now())};
 else body={base_fee:0};
 return {ok:true,headers:{get(){return null;}},text:async()=>JSON.stringify(body)};
 };
 try{const r=response();await handler({method:'GET',query:{event:'test-event',condition}},r);assert.equal(r.code,200);assert.equal(r.body.status,'potential_pair_gap');assert.equal(r.body.execution_enabled,false);assert.equal(calls.length,5);}finally{global.fetch=original;}
});
test('upstream failure yields no invented prices',async()=>{
 const original=global.fetch;global.fetch=async()=>{throw Error('network');};
 try{const r=response();await handler({method:'GET',query:{event:'test-event',condition}},r);assert.equal(r.code,503);assert.equal(r.body.yes,undefined);}finally{global.fetch=original;}
});
