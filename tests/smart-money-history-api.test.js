'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const zlib=require('node:zlib');
const handler=require('../api/smart-money-history');
const baseDate=new Date().toISOString().slice(0,10);
function res(){return {code:0,headers:{},setHeader(k,v){this.headers[k]=v},status(x){this.code=x;return this},json(x){this.body=x;return this}}}
const cond='0x'+'a'.repeat(64),token='123456';
const signalId='1'.repeat(24);
const sample={schema_version:1,day:baseDate,signal_events:[{
 id:signalId,condition_id:cond,token_id:token,observed_at:new Date().toISOString(),captured_at:new Date().toISOString(),
 side:'BUY',representative_price:.45,source:'PUBLIC_SIGNAL_FEED_V1'}],
 outcome_checks:[{signal_id:signalId,result:'PAYOUT_1',payout:1}],
 flow_snapshots:[{at:new Date().toISOString(),coverage:{incomplete:true},
  markets:[{condition_id:cond,token_id:token,net_usdc:150,buy_usdc:250,
   sell_usdc:100,last_price:.46,distinct_net_buyers:1,distinct_net_sellers:0,fills:3}]}]};
const packed=zlib.gzipSync(Buffer.from(JSON.stringify(sample)));
function mocked(){return async url=>{
 if(String(url).includes(baseDate+'.json.gz'))return {ok:true,status:200,arrayBuffer:async()=>packed};
 return {ok:false,status:404};
}}
test('historical summary displays only real persisted entries and provenance',async()=>{
 const prior=global.fetch;global.fetch=mocked();
 try{
  const r=res();await handler({method:'GET',query:{view:'summary',days:'3'}},r);
  assert.equal(r.code,200);assert.equal(r.body.observation_snapshots,1);
  assert.equal(r.body.signal_events,1);assert.equal(r.body.verified_outcomes,1);
  assert.equal(r.body.calibrated_probability,'NOT_VERIFIED');
  assert.equal(r.body.trading_authority,'none');
  assert.equal(r.body.legacy_vps_sqlite_import,'NOT_YET_CONNECTED');
 }finally{global.fetch=prior}
});
test('market-only endpoint tracks recorded rolling flow rather than synthetic profit',async()=>{
 const prior=global.fetch;global.fetch=mocked();
 try{
  const r=res();await handler({method:'GET',query:{view:'market',days:'3',condition:cond,token}},r);
  assert.equal(r.code,200);
  assert.equal(r.body.trend.length,1);
  assert.equal(r.body.trend[0].net_24h_usdc,150);
  assert.equal(r.body.trend[0].coverage_incomplete,true);
  assert.equal(r.body.signal_evidence[0].result,'PAYOUT_1');
  assert.equal(r.body.trade_profit,null);
  assert.equal(r.body.probability,null);
 }finally{global.fetch=prior}
});
test('missing archive is a missing state, not fake historical zero profit',async()=>{
 const prior=global.fetch;global.fetch=async()=>({status:404,ok:false});
 try{
  const r=res();await handler({method:'GET',query:{view:'summary',days:'3'}},r);
  assert.equal(r.code,200);
  assert.equal(r.body.status,'not_yet_archived');
  assert.equal(r.body.verified_outcomes,0);
  assert.equal(r.body.oldest_snapshot_at,null);
 }finally{global.fetch=prior}
});
test('bad method, invalid token, too many days fail without upstream access',async()=>{
 const prior=global.fetch;global.fetch=()=>{throw Error('should not fetch')};
 try{
  for(const query of [{view:'market',condition:'x',token:'1'}, {view:'summary',days:999},{view:'unknown'}]){
   const r=res();await handler({method:'GET',query},r);assert.equal(r.code,400);
  }
  const r=res();await handler({method:'POST',query:{}},r);assert.equal(r.code,405);
 }finally{global.fetch=prior}
});
