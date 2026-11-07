'use strict';
const assert=require('node:assert/strict');
const test=require('node:test');
const handler=require('../api/smart-money-flow');
const wallet='0x'+'1'.repeat(40),condition='0x'+'a'.repeat(64);
function mockRes(){
 return {code:null,headers:{},setHeader(k,v){this.headers[k]=v;},status(x){this.code=x;return this;},json(x){this.body=x;return this;}};
}
function payload(data){return {ok:true,headers:{get(){return null;}},text:async()=>JSON.stringify({data})}}
function sample(){
 const now=Math.floor(Date.now()/1000);
 return {type:'TRADE',proxy_wallet:wallet,condition_id:condition,side:'BUY',
  usdc_size:1000,size:2000,price:.5,timestamp:now-90,outcome_index:0,
  outcome:'Yes',token_id:'12345',title:'Sample market',transaction_hash:'0x'+'f'.repeat(64)};
}
test('GET API emits bounded read-only measured flow, no model probability',async()=>{
 const old=global.fetch;const urls=[];
 global.fetch=async url=>{
  urls.push(String(url));
  return payload(String(url).includes('/v2/leaderboard')?
   [{user_id:wallet,user_name:'Sample',pnl:99,volume:300,rank:1}]:[sample()]);
 };
 try{
  const res=mockRes();await handler({method:'GET',query:{}},res);
  assert.equal(res.code,200);assert.equal(res.body.status,'ok');
  assert.equal(res.body.market_count,1);assert.equal(res.body.events_sampled,1);
  assert.equal(res.body.total_observed_net_usdc,1000);
  assert.equal(res.body.markets[0].wallets_net_buying,1);
  assert.equal(res.body.markets[0].inferred_win_probability,null);
  assert.equal(res.body.prediction_model_status,'NOT_TRAINED_OR_CALIBRATED');
  assert.equal(res.body.execution_enabled,false);
  assert.ok(urls.every(x=>x.startsWith('https://data-api.polymarket.com/')));
  assert.ok(urls.every(x=>!x.includes('apikey')&&!x.includes('/orders')));
 }finally{global.fetch=old}
});
test('POST rejected without upstream calls',async()=>{
 const old=global.fetch;global.fetch=()=>{throw Error('Must not fetch')};
 try{const res=mockRes();await handler({method:'POST',query:{}},res);
  assert.equal(res.code,405);assert.equal(res.body.status,'method_not_allowed');}
 finally{global.fetch=old}
});
test('invalid public source fails closed with no fabricated values',async()=>{
 const old=global.fetch;global.fetch=async()=>{throw Error('broken upstream')};
 try{const res=mockRes();await handler({method:'GET',query:{}},res);
  assert.equal(res.code,503);assert.equal(res.body.status,'unavailable');
  assert.deepEqual(res.body.markets,[]);
  assert.equal(res.body.execution_enabled,false);}
 finally{global.fetch=old}
});
