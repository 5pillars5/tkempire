'use strict';
const {matchResolution}=require('./history-core');
const {createStore,githubRequest}=require('./archive-transaction');
const PUBLIC='https://data-api.polymarket.com';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const stringify=x=>JSON.stringify(x);
async function getData(path,condition){
 const u=new URL(path,PUBLIC);u.searchParams.set('condition',condition);
 for(let i=0;i<3;i++){
  try{
   const r=await fetch(u,{redirect:'error',headers:{Accept:'application/json'},
    signal:AbortSignal.timeout(14000)});
   if(!r.ok)throw Error('HTTP_'+r.status);
   const raw=await r.text();if(raw.length>140000)throw Error('OVERSIZED');
   const d=JSON.parse(raw);if(!d||!Array.isArray(d.data))throw Error('BAD_ENVELOPE');
   return d.data;
  }catch(e){if(i===2)throw Error('PUBLIC_SOURCE_'+path+'_'+String(e.message||e));await sleep(950*(i+1))}
 }
}
function eligibleDays(names,now=new Date()){
 const days=names.filter(n=>/^\d{4}-\d\d-\d\d\.json\.gz$/.test(n))
  .map(n=>n.slice(0,10)).filter(n=>(now-Date.parse(n+'T00:00:00Z'))/86400000<=90)
  .sort().reverse();
 const recent=days.slice(0,3);
 const older=days.slice(3);
 const step=Math.floor(now.getTime()/21600000);
 const rotate=older.length?older.slice(step%older.length).concat(older.slice(0,step%older.length)).slice(0,3):[];
 return [...new Set([...recent,...rotate])];
}
async function main(){
 const token=process.env.GITHUB_TOKEN||'';
 if(!token)throw Error('MISSING_GITHUB_TOKEN');
 if(process.env.GITHUB_REPOSITORY&&process.env.GITHUB_REPOSITORY!=='5pillars5/tkempire')throw Error('WRONG_REPO');
 const store=createStore(githubRequest(token));
 const listing=await store.listDays();
 if(!listing.names.length){console.log('SMARTMONEY_OUTCOME_MATCHER=NO_HISTORY_YET');return;}
 const days=eligibleDays(listing.names);
 let updated=0,checked=0,resolved=0,pending=0,unverified=0;
 const marketCache=new Map();
 for(const day of days){
  const original=await store.readDay(day,listing.commit);
  if(!original)continue;
  const prior=new Map(original.outcome_checks.map(x=>[x.signal_id,x]));
  const signals=original.signal_events.filter(s=>s.condition_id&&s.token_id&&
    !['PAYOUT_0','PAYOUT_1','PARTIAL_PAYOUT','EXCLUDED'].includes(prior.get(s.id)?.result));
  const updates=[];
  for(const sig of signals){
   if(checked>=24)break;
   if(!marketCache.has(sig.condition_id)){
    try{
     const [res,tokens]=await Promise.all([
      getData('/v2/resolutions',sig.condition_id),
      getData('/v2/tokens',sig.condition_id)
     ]);
     marketCache.set(sig.condition_id,{resolution:res.find(x=>String(x.condition_id).toLowerCase()===sig.condition_id)||null,tokens});
    }catch(e){
     marketCache.set(sig.condition_id,{resolution:null,tokens:null,error:String(e.message||e)});
    }
   }
   const market=marketCache.get(sig.condition_id);
   const outcome=matchResolution(sig,market.resolution,market.tokens);
   checked++;
   if(['PAYOUT_0','PAYOUT_1','PARTIAL_PAYOUT'].includes(outcome.result))resolved++;
   else if(outcome.result==='PENDING')pending++;
   else unverified++;
   updates.push({...outcome,checked_at:new Date().toISOString(),
    source:'POLYMARKET_V2_RESOLUTION_AND_TOKEN_CATALOG',
    history_event_origin:sig.source,execution_authority:'none'});
  }
  // Also reconcile a stale head when there are no newly changed checks.
  const result=await store.writeOutcomes(day,updates);
  updated+=result.changed;
  console.log('SMARTMONEY_OUTCOME_ARCHIVE_READBACK '+JSON.stringify({
    day,changed:result.changed,sha256:result.sha256,commit:result.commit,
    latest_head:result.head,wrote:result.wrote}));
  if(checked>=24)break;
 }
 console.log('SMARTMONEY_OUTCOME_MATCHER=PASS '+stringify({checked,
  reconciled_this_scan:resolved,pending,unverified,archived_updates:updated,
  days_considered:days,calibrated_probabilities:0,
  trade_profit_claims:0,trading_authority:'none'}));
}
if(require.main===module)main().catch(e=>{console.error('SMARTMONEY_OUTCOME_MATCHER=FAIL '+String(e.message||e));process.exitCode=1});
module.exports={eligibleDays};
