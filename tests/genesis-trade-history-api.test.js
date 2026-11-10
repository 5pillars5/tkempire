'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const handler=require('../api/genesis/trade-history.js');
const old=global.fetch;
const keys=['GENESIS_HISTORY_PUBLICATION_ENABLED','GENESIS_STATUS_URL','GENESIS_STATUS_USERNAME','GENESIS_STATUS_TOKEN'];
const saved=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
function config(){
  process.env.GENESIS_HISTORY_PUBLICATION_ENABLED='true';
  process.env.GENESIS_STATUS_URL='https://api.tkempire.io/internal/genesis/health';
  process.env.GENESIS_STATUS_USERNAME='tkempire-prod';
  process.env.GENESIS_STATUS_TOKEN='q'.repeat(48);
}
function row(overrides={}){
  return {id:'a'.repeat(32),asset:'SOL',side:'SELL',stage:'PAPER_CLOSED',
    observed_at:new Date(Date.now()-120000).toISOString(),
    closed_at:new Date(Date.now()-60000).toISOString(),
    trigger:120,exit_price:115,realized_pnl:5,pnl_unit:'LEDGER_UNIT_UNVERIFIED',
    result:'WIN',close_reason:'OTHER',position_evidence:'CANONICAL_PAPER_LEDGER',
    close_evidence:'CANONICAL_CLOSED_PAPER_LEDGER',...overrides};
}
function source(rows=[row()],overrides={}){
  return {schema_version:1,source:'GENESIS_VERIFIED_PAPER_HISTORY_V1',
    publication_scope:'PUBLIC_APPROVED',execution_authority:'none',
    generated_at:new Date().toISOString(),engine:{mode:'paper',running:true},
    pnl_unit:'LEDGER_UNIT_UNVERIFIED',revision:'c'.repeat(64),
    page:1,page_size:50,verified_count:rows.length,excluded_count:1,
    total_closed_count:rows.length+1,has_more:false,closed_trades:rows,...overrides};
}
function mock(payload){
  global.fetch=async(url,init)=>{
    assert.equal(url,'https://api.tkempire.io/internal/genesis/history?page=1');
    assert.equal(init.method,'GET');
    assert.equal(init.redirect,'error');
    assert.match(init.headers.Authorization,/^Basic /);
    return {ok:true,headers:{get:()=>null},text:async()=>JSON.stringify(payload)};
  };
}
async function call(page='1',method='GET'){
  const res={headers:{},setHeader(k,v){this.headers[k]=v;return this},
    status(code){this.code=code;return this},json(body){this.body=body;return this}};
  await handler({method,query:{page}},res);
  return res;
}
test.after(()=>{
  global.fetch=old;
  for(const [k,v] of Object.entries(saved)){
    if(v===undefined)delete process.env[k];else process.env[k]=v;
  }
});
test('history publication is disabled by default, independent of existing closed endpoint',async()=>{
  config();delete process.env.GENESIS_HISTORY_PUBLICATION_ENABLED;
  global.fetch=()=>{throw Error('DISABLED_SHOULD_NOT_FETCH')};
  const res=await call();
  assert.equal(res.code,503);
  assert.equal(res.body.status,'publication_disabled');
});
test('exact public fields, explicit unknown units, and coverage are preserved',async()=>{
  config();mock(source());
  const res=await call();
  assert.equal(res.code,200);
  assert.equal(res.body.mode,'PAPER');
  assert.equal(res.body.verified_count,1);
  assert.equal(res.body.excluded_count,1);
  assert.equal(res.body.total_closed_count,2);
  assert.equal(res.body.closed_trades[0].paper_position_verified,true);
  assert.equal(res.body.closed_trades[0].realized_pnl,5);
  assert.equal(res.body.pnl_unit,'LEDGER_UNIT_UNVERIFIED');
  assert.equal(res.body.execution_authority,'none');
  assert.equal(res.headers['Cache-Control'],'no-store, max-age=0');
});
test('reject unsafe or incomplete historical projections',async()=>{
  config();
  const bad=[
    source(undefined,{publication_scope:'PRIVATE_DRY_RUN_ONLY'}),
    source(undefined,{execution_authority:'trade'}),
    source(undefined,{engine:{mode:'live',running:true}}),
    source(undefined,{revision:'INVALID'}),
    source(undefined,{page_size:1000}),
    source(undefined,{generated_at:new Date(Date.now()-5*60000).toISOString()}),
    source(undefined,{excluded_count:0}),
    source(undefined,{has_more:true}),
    source([row({result:'LOSS'})]),
    source([row({pnl_unit:'USD'})]),
    source([row({private_wallet:'secret'})]),
    source([row({id:'not_hex'})]),
    source([row({close_evidence:'UNKNOWN'})]),
    source([row(),row()])
  ];
  for(const data of bad){
    mock(data);const res=await call();
    assert.equal(res.code,503,JSON.stringify(data).slice(0,110));
    assert.equal(res.body.closed_trades.length,0);
  }
});
test('reject bad pages and all write methods',async()=>{
  config();global.fetch=()=>{throw Error('SHOULD_NOT_FETCH')};
  for(const page of ['0','-1','401','1%26x','1e2','test','0001']){
    const res=await call(page);assert.equal(res.code,400,page);
  }
  const res=await call('1','POST');assert.equal(res.code,405);
});
test('never contains trading authority',()=>{
  const fs=require('node:fs'),path=require('node:path');
  const code=fs.readFileSync(path.join(__dirname,'../api/genesis/trade-history.js'),'utf8');
  assert.doesNotMatch(code,/placeOrder|privateKey|createOrder|\/trade\b|\/exchange\b/);
  assert.match(code,/GENESIS_HISTORY_PUBLICATION_ENABLED/);
});
