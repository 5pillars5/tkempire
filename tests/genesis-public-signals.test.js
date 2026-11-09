'use strict';
// Offline tests: no VPS, network, secrets or trading authority.
const test=require('node:test');
const assert=require('node:assert/strict');
const handler=require('../api/genesis/signals.js');
const original={
  fetch:global.fetch,
  enabled:process.env.GENESIS_SIGNALS_PUBLICATION_ENABLED,
  url:process.env.GENESIS_STATUS_URL,
  token:process.env.GENESIS_STATUS_TOKEN,
  username:process.env.GENESIS_STATUS_USERNAME
};
const now=()=>new Date().toISOString();
const sample=(extras={})=>({
  id:'SIGNAL_SOL_20261109_01',asset:'SOL',side:'SELL',stage:'QUALIFIED',
  observed_at:now(),confidence:78.5,trigger:175,stop_loss:181,target:165,
  reason_code:'CHECKS_PASSED',strategy_secret:'NEVER_PUBLISH',...extras
});
const upstream=(extras={})=>({
  schema_version:1,source:'GENESIS_PUBLIC_SIGNAL_PROJECTION',
  publication_scope:'PUBLIC_APPROVED',execution_authority:'none',
  engine:{mode:'paper',running:true},generated_at:now(),
  signals:[sample()],private_account:{balance:999888},...extras
});
function setup(){
  process.env.GENESIS_SIGNALS_PUBLICATION_ENABLED='true';
  process.env.GENESIS_STATUS_URL='https://api.tkempire.io/internal/genesis/health';
  process.env.GENESIS_STATUS_TOKEN='t'.repeat(48);
  process.env.GENESIS_STATUS_USERNAME='tkempire-prod';
}
function response(){
  return {headers:{},code:200,setHeader(k,v){this.headers[k]=v;return this},
    status(n){this.code=n;return this},json(v){this.body=v;return this}};
}
async function run(method='GET'){const res=response();await handler({method},res);return res;}
function mock(body,check=()=>{},status=200){
  global.fetch=async(url,opts)=>{
    check(url,opts);
    return {ok:status===200,headers:{get:()=>null},text:async()=>JSON.stringify(body)};
  };
}
test.after(()=>{
  global.fetch=original.fetch;
  for(const [key,env] of [['enabled','GENESIS_SIGNALS_PUBLICATION_ENABLED'],
    ['url','GENESIS_STATUS_URL'],['token','GENESIS_STATUS_TOKEN'],
    ['username','GENESIS_STATUS_USERNAME']]){
    if(original[key]===undefined)delete process.env[env];
    else process.env[env]=original[key];
  }
});
test('public signals are opt-in and off by default',async()=>{
  setup();delete process.env.GENESIS_SIGNALS_PUBLICATION_ENABLED;
  global.fetch=async()=>{throw Error('unexpected network call')};
  const r=await run();assert.equal(r.code,503);
  assert.equal(r.body.status,'publication_disabled');
  assert.deepEqual(r.body.signals,[]);
});
test('only approved gateway and bounded server credentials',async()=>{
  setup();process.env.GENESIS_STATUS_URL='http://localhost:5000';
  assert.equal((await run()).body.status,'not_configured');
  setup();process.env.GENESIS_STATUS_TOKEN='unsafe';
  assert.equal((await run()).code,503);
});
test('exposes only approved fields, marks candidates as nonpositions',async()=>{
  setup();
  mock(upstream(),(url,opts)=>{
    assert.equal(url,'https://api.tkempire.io/internal/genesis/signals');
    assert.equal(opts.method,'GET');
    assert.equal(opts.redirect,'error');
    assert.equal(opts.headers.Authorization,'Basic '+
      Buffer.from('tkempire-prod:'+'t'.repeat(48)).toString('base64'));
  });
  const r=await run();
  assert.equal(r.code,200);
  assert.equal(r.body.mode,'PAPER');
  assert.equal(r.body.source,'GENESIS_PUBLIC_SIGNAL_PROJECTION');
  assert.equal(r.body.execution_authority,'none');
  assert.equal(r.body.signals[0].confidence,78.5);
  assert.equal(r.body.signals[0].paper_position_verified,false);
  assert.equal(r.headers['Cache-Control'].includes('no-store'),true);
  for(const secret of ['NEVER_PUBLISH','999888','strategy_secret','private_account']){
    assert.equal(JSON.stringify(r.body).includes(secret),false);
  }
});
test('accepts a verified paper position only with canonical evidence',async()=>{
  setup();
  mock(upstream({signals:[
    sample({id:'POSITION_OPEN_001',stage:'PAPER_OPEN'}),
    sample({id:'QUALIFIED_000001'}),
    sample({id:'QUALIFIED_000001'}),
    sample({id:'POSITION_CLOSED_001',stage:'PAPER_CLOSED',position_evidence:'CANONICAL_PAPER_LEDGER'}),
    sample({id:'BAD_SIDE_000001',side:'HOLD'}),
    sample({id:'BAD_SYMBOL_001',asset:'<script>'})
  ]}));
  const r=await run();
  assert.equal(r.code,200);
  assert.deepEqual(r.body.signals.map(s=>s.id).sort(),['POSITION_CLOSED_001','QUALIFIED_000001']);
  assert.equal(r.body.signals.find(s=>s.id==='POSITION_CLOSED_001').paper_position_verified,true);
});
test('rejects unapproved publication scope, execution authority and non-paper mode',async()=>{
  setup();
  for(const bad of [
    {source:'GENESIS_PRIVATE_STATE'},
    {publication_scope:'INTERNAL'},
    {execution_authority:'trade'},
    {engine:{mode:'live',running:true}},
    {generated_at:new Date(Date.now()-360000).toISOString()},
    {signals:new Array(81).fill(sample())}
  ]){
    mock(upstream(bad));
    const r=await run();assert.equal(r.code,503);
    assert.deepEqual(r.body.signals,[]);
  }
});
test('invalid records are withheld rather than shown as signal facts',async()=>{
  setup();mock(upstream({signals:[
    sample({id:'<img onerror=1>'}),
    sample({id:'SAFE_SIGNAL_0001',confidence:500,trigger:-12,target:'unknown'}),
    sample({id:'FUTURE_TIME_0001',observed_at:new Date(Date.now()+300000).toISOString()})
  ]}));
  const r=await run();assert.equal(r.code,200);
  assert.equal(r.body.signals.length,1);
  assert.equal(r.body.signals[0].confidence,null);
  assert.equal(r.body.signals[0].trigger,null);
  assert.equal(r.body.signals[0].target,null);
});
test('upstream failure returns no fabricated data',async()=>{
  setup();mock({},()=>{},502);
  const r=await run();assert.equal(r.code,502);assert.deepEqual(r.body.signals,[]);
});
test('POST is rejected and cannot place orders',async()=>{
  setup();global.fetch=async()=>{throw Error('unexpected network call')};
  const r=await run('POST');assert.equal(r.code,405);assert.equal(r.headers.Allow,'GET');
});
