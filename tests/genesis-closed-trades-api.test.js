'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const handler=require('../api/genesis/closed-trades.js');
const originalFetch=global.fetch;
const prior=Object.fromEntries(['GENESIS_CLOSED_PUBLICATION_ENABLED','GENESIS_STATUS_URL','GENESIS_STATUS_TOKEN','GENESIS_STATUS_USERNAME'].map(k=>[k,process.env[k]]));
function setup(){
  process.env.GENESIS_CLOSED_PUBLICATION_ENABLED='true';
  process.env.GENESIS_STATUS_URL='https://api.tkempire.io/internal/genesis/health';
  process.env.GENESIS_STATUS_TOKEN='x'.repeat(48);
  process.env.GENESIS_STATUS_USERNAME='tkempire-prod';
}
function closed(data={}){
  return {
    id:'a'.repeat(32),asset:'SOL',side:'SELL',stage:'PAPER_CLOSED',
    observed_at:new Date(Date.now()-60000).toISOString(),
    closed_at:new Date(Date.now()-30000).toISOString(),
    trigger:88,exit_price:86,stop_loss:null,target:null,confidence:null,
    reason_code:'CHECKS_PASSED',position_evidence:'CANONICAL_PAPER_LEDGER',
    close_evidence:'CANONICAL_CLOSED_PAPER_LEDGER',close_reason:'OTHER',
    result:'WIN',realized_pnl:2,pnl_unit:'LEDGER_UNIT_UNVERIFIED',...data
  };
}
function source(records=[closed()],extra={}){
  return {schema_version:1,source:'GENESIS_PUBLIC_SIGNAL_PROJECTION',
    publication_scope:'PUBLIC_APPROVED',execution_authority:'none',
    engine:{mode:'paper',running:true},position_verification:'verified',
    generated_at:new Date().toISOString(),closed_trades:records,...extra};
}
function mock(body){
  global.fetch=async(url,options)=>{
    assert.equal(url,'https://api.tkempire.io/internal/genesis/signals');
    assert.equal(options.method,'GET');
    assert.equal(options.redirect,'error');
    assert.match(options.headers.Authorization,/^Basic /);
    return {ok:true,headers:{get:()=>null},text:async()=>JSON.stringify(body)};
  };
}
async function call(method='GET'){
  const r={headers:{},setHeader(k,v){this.headers[k]=v;return this},
    status(n){this.code=n;return this},json(body){this.body=body;return this}};
  await handler({method},r);
  return r;
}
test.after(()=>{
  global.fetch=originalFetch;
  for(const [k,v] of Object.entries(prior)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
});
test('disabled by default, unchanged live feed never presented as closed',async()=>{
  setup();delete process.env.GENESIS_CLOSED_PUBLICATION_ENABLED;
  global.fetch=()=>{throw Error('should never fetch')};
  let r=await call();assert.equal(r.code,503);assert.equal(r.body.status,'publication_disabled');
  setup();mock(source(undefined,{closed_trades:undefined}));
  r=await call();assert.equal(r.code,503);assert.deepEqual(r.body.closed_trades,[]);
});
test('strict close evidence and explicit unknown ledger denomination',async()=>{
  setup();mock(source());
  const r=await call();
  assert.equal(r.code,200);assert.equal(r.body.closed_trades.length,1);
  assert.equal(r.body.pnl_unit,'LEDGER_UNIT_UNVERIFIED');
  assert.equal(r.body.closed_trades[0].realized_pnl,2);
  assert.equal(r.body.execution_authority,'none');
  assert.equal(r.headers['Cache-Control'],'no-store, max-age=0');
});
test('rejects wrong scope, stale, duplicates, missing proof or bad accounting',async()=>{
  setup();
  const bad=[
    source([], {publication_scope:'STAGING_NOT_APPROVED'}),
    source([], {execution_authority:'trade'}),
    source([], {generated_at:new Date(Date.now()-300000).toISOString()}),
    source([closed(),closed()]),
    source([closed({close_evidence:undefined})]),
    source([closed({pnl_unit:'USD'})]),
    source([closed({realized_pnl:-2,result:'WIN'})]),
    source([closed({secret_api_token:'unsafe'})]),
    source([closed({closed_at:new Date(Date.now()-3600000).toISOString()})])
  ];
  for(const input of bad){
    mock(input);const r=await call();
    assert.equal(r.code,503,JSON.stringify(input).slice(0,120));
    assert.equal(r.body.closed_trades.length,0);
  }
});
test('GET only; no wallet or order permissions',async()=>{
  setup();global.fetch=()=>{throw Error('should never fetch')};
  const r=await call('POST');
  assert.equal(r.code,405);
  const code=require('node:fs').readFileSync(require('node:path').join(__dirname,'../api/genesis/closed-trades.js'),'utf8');
  assert.doesNotMatch(code,/placeOrder|privateKey|createOrder|\/trade\b|\/exchange\b/i);
});
