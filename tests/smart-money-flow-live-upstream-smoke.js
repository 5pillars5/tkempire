'use strict';
/* Live public upstream contract smoke. Does not trade, persist or infer outcome probability. */
const assert=require('node:assert/strict');
const handler=require('../api/smart-money-flow');
const res={code:null,headers:{},
 setHeader(k,v){this.headers[k]=v;},
 status(v){this.code=v;return this;},
 json(body){this.body=body;return this;}
};
const retry=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
 let last;
 for(let i=1;i<=3;i++){
  await handler({method:'GET',query:{}},res);
  if(res.code===200)break;
  last=res.body?.status||'unknown';
  if(i<3)await retry(2500*i);
 }
 assert.equal(res.code,200,'Public Polymarket API unavailable: '+last);
 const b=res.body;
 assert.ok(['ok','degraded'].includes(b.status));
 assert.ok(b.wallets_selected>0);
 assert.ok(b.wallets_returned>0);
 assert.ok(b.events_sampled>=0);
 assert.ok(Array.isArray(b.markets));
 assert.equal(b.prediction_model_status,'NOT_TRAINED_OR_CALIBRATED');
 assert.equal(b.market_pressure_is_win_probability,false);
 assert.equal(b.execution_enabled,false);
 assert.equal(b.genesis_execution_authority,'none');
 assert.ok(b.markets.every(m=>m.inferred_win_probability===null&&m.entry_edge===null));
 console.log('LIVE_FLOW_API_SMOKE=PASS '+JSON.stringify({
  status:b.status,wallets:b.wallets_selected,returned:b.wallets_returned,
  truncated:b.wallets_truncated,events:b.events_sampled,markets:b.market_count,
  reportedRows:b.markets.length,probabilities:'NOT_CALIBRATED',execution:false
 }));
})().catch(e=>{console.error('LIVE_FLOW_API_SMOKE=FAIL '+String(e.message||e));process.exitCode=1});
