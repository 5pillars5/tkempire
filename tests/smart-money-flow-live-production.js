'use strict';
// Verify deployed public Flow Map, script and live Vercel endpoint, not a mock.
// No VPS, wallet keys, orders, or trading configuration.
const assert=require('node:assert/strict');
const root='https://www.tkempire.io';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function fetchChecked(path,retries=5){
 let last;
 for(let i=0;i<retries;i++){
  try{
   const r=await fetch(root+path,{redirect:'error',cache:'no-store',
    headers:{Accept:'application/json, text/html, application/javascript'},
    signal:AbortSignal.timeout(20000)});
   if(r.ok)return {code:r.status,text:await r.text()};
   last='HTTP_'+r.status;
  }catch(e){last=String(e.message||e);}
  if(i+1<retries)await delay(2500*(i+1));
 }
 throw Error('UNAVAILABLE_'+path+'_'+last);
}
(async()=>{
 const page=await fetchChecked('/smart-money-flow.html');
 const version=page.text.match(/smart-money-flow-map\.js\?v=([1-9]\d*)/)?.[1];
 assert.ok(version,'Live Flow Map asset version not found');
 const [client,api]=await Promise.all([
  fetchChecked('/assets/js/smart-money-flow-map.js?v='+version),
  fetchChecked('/api/smart-money-flow')
 ]);
 assert.match(page.text,/Smart Money <span>Flow Map<\/span>/,'deployed public page heading');
 assert.ok(page.text.includes('site-tabs.js?v=4'),'shared navigation missing');
 assert.ok(client.text.includes("'/api/smart-money-flow'"),'client not attached to production API');
 if(page.text.includes('DURABLE OBSERVATION HISTORY')) assert.ok(client.text.includes("'/api/smart-money-history?"),'new historian UI not attached to live history API');
 const d=JSON.parse(api.text);
 assert.ok(['ok','degraded'].includes(d.status),'status not verified');
 assert.equal(d.schema_version,1);
 assert.equal(d.execution_enabled,false);
 assert.equal(d.genesis_execution_authority,'none');
 assert.equal(d.prediction_model_status,'NOT_TRAINED_OR_CALIBRATED');
 assert.equal(d.market_pressure_is_win_probability,false);
 assert.equal(d.quality_weighting_enabled,false);
 assert.ok(d.wallets_selected>0);
 assert.ok(d.wallets_returned>0);
 assert.ok(Number.isInteger(d.events_sampled)&&d.events_sampled>=0);
 assert.ok(Array.isArray(d.markets)&&d.markets.length<=80);
 assert.ok(Number.isInteger(d.market_count)&&d.market_count>=d.markets.length);
 for(const m of d.markets){
  assert.match(m.condition_id,/^0x[a-f0-9]{64}$/);
  assert.match(m.token_id,/^[0-9]+$/);
  assert.equal(m.inferred_win_probability,null);
  assert.equal(m.quality_weighted_score,null);
  assert.equal(m.entry_edge,null);
  assert.ok(m.observed_buy_usdc>=0&&m.observed_sell_usdc>=0);
  assert.ok(Math.abs(m.observed_buy_usdc-m.observed_sell_usdc-m.observed_net_usdc)<.025);
  assert.ok(m.wallets_net_buying+m.wallets_net_selling<=d.wallets_selected);
 }
 console.log('GENESIS_FLOW_MAP_PRODUCTION=PASS '+JSON.stringify({
  domain:root,page_status:page.code,js_status:client.code,api_status:api.code,
  wallet_feeds:d.wallets_returned,events:d.events_sampled,
  outcomes_total:d.market_count,outcomes_in_payload:d.markets.length,
  state:d.status,probability:'NOT_CALIBRATED',execution_authority:'none'
 }));
})().catch(e=>{console.error('GENESIS_FLOW_MAP_PRODUCTION=FAIL '+String(e.stack||e));process.exitCode=1});
