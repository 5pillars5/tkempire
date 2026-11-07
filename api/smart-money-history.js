'use strict';
/* Public immutable historical snapshots behind a bounded Vercel read-only API.
 * Data is fetched from the repository's compressed daily archives, not from
 * mutable page state; no GitHub secret, VPS access, orders, or probability.
 */
const zlib=require('node:zlib');
const BASE='https://raw.githubusercontent.com/5pillars5/tkempire/main/data/smart-money-history-v1/';
const VALID=/^0x[a-f0-9]{64}$/i, TOKEN=/^[0-9]+$/;
const n=x=>typeof x==='number'&&Number.isFinite(x)?x:null;
const reply=(res,status,data)=>{res.setHeader('Cache-Control',status===200?'public,max-age=0,s-maxage=55':'no-store');
 res.setHeader('X-Content-Type-Options','nosniff');return res.status(status).json(data)};
async function get(path,max=1500000){
 const u=new URL(path,BASE);if(u.hostname!=='raw.githubusercontent.com')throw Error('ORIGIN_DISALLOWED');
 // A cache key changes each minute to avoid pinning historical reads indefinitely.
 u.searchParams.set('minute',String(Math.floor(Date.now()/60000)));
 const r=await fetch(u,{redirect:'error',headers:{Accept:'application/octet-stream'},
  signal:AbortSignal.timeout(6500)});
 if(r.status===404)return null;
 if(!r.ok)throw Error('ARCHIVE_UPSTREAM_'+r.status);
 const raw=Buffer.from(await r.arrayBuffer());
 if(raw.length>max)throw Error('ARCHIVE_OVERSIZED');
 return raw;
}
async function dayRecord(day){
 if(!/^\d{4}-\d{2}-\d{2}$/.test(day))throw Error('BAD_DAY');
 const raw=await get(day+'.json.gz');
 if(!raw)return null;
 const unpacked=zlib.gunzipSync(raw,{maxOutputLength:15000000});
 const content=JSON.parse(unpacked.toString('utf8'));
 if(content.schema_version!==1||content.day!==day||
    !Array.isArray(content.flow_snapshots)||!Array.isArray(content.signal_events)||
    !Array.isArray(content.outcome_checks))throw Error('CORRUPT_ARCHIVE');
 return content;
}
const utcDay=(d)=>new Date(d).toISOString().slice(0,10);
async function readDays(nDays){
 const days=Array.from({length:nDays},(_,i)=>utcDay(Date.now()-i*86400000));
 const settled=await Promise.allSettled(days.map(dayRecord));
 // Deliberately mark inaccessible days incomplete rather than treating errors as zero activity.
 const dates=days.map((day,i)=>({
  day,status:settled[i].status==='rejected'?'error':
   settled[i].value?'present':'missing',
  content:settled[i].status==='fulfilled'?settled[i].value:null
 }));
 return dates;
}
function summary(dates){
 let observations=0,events=0,verified=0,fail=0,pending=0,unverified=0;
 let newest=null,earliest=null;
 const groups=[];
 for(const item of dates){
  if(!item.content)continue;
  const rec=item.content;
  observations+=rec.flow_snapshots.length;
  events+=rec.signal_events.length;
  for(const r of rec.outcome_checks){
   if(['PAYOUT_0','PAYOUT_1','PARTIAL_PAYOUT'].includes(r.result))verified++;
   else if(r.result==='PENDING')pending++;
   else unverified++;
  }
  for(const s of rec.flow_snapshots){
   if(!newest||s.at>newest)newest=s.at;
   if(!earliest||s.at<earliest)earliest=s.at;
  }
  groups.push({day:item.day,snapshots:rec.flow_snapshots.length,
   signals:rec.signal_events.length,matched_outcomes:rec.outcome_checks.length});
 }
 return {status:observations?'ok':'not_yet_archived',schema_version:1,source:'GITHUB_PUBLIC_OBSERVATION_MIRROR',
  trading_authority:'none',legacy_vps_sqlite_import:'NOT_YET_CONNECTED',
  calibrated_probability:'NOT_VERIFIED',wallet_quality:'WITHHELD',
  observation_snapshots:observations,signal_events:events,
  verified_outcomes:verified,pending_outcomes:pending,unverified_outcomes:unverified,
  oldest_snapshot_at:earliest,latest_snapshot_at:newest,
  date_coverage:dates.map(({day,status})=>({day,status})),daily_archives:groups};
}
function marketHistory(dates,condition,token){
 const points=[],checks=[];
 for(const item of [...dates].reverse()){
  if(!item.content)continue;
  for(const snap of item.content.flow_snapshots){
   const market=snap.markets.find(m=>m.condition_id===condition&&m.token_id===token);
   if(market)points.push({at:snap.at,net_24h_usdc:market.net_usdc,
    observed_buy_24h_usdc:market.buy_usdc,observed_sell_24h_usdc:market.sell_usdc,
    observed_last_price:market.last_price,
    wallets_net_buying:market.distinct_net_buyers,
    wallets_net_selling:market.distinct_net_sellers,
    sampled_fills:market.fills,coverage_incomplete:snap.coverage.incomplete});
  }
  const indexed=new Map(item.content.outcome_checks.map(r=>[r.signal_id,r]));
  for(const signal of item.content.signal_events){
   if(signal.condition_id!==condition||signal.token_id!==token)continue;
   const check=indexed.get(signal.id);
   checks.push({id:signal.id,at:signal.observed_at,captured_at:signal.captured_at,
    side:signal.side,representative_price:signal.representative_price,
    result:check?.result||'NOT_YET_CHECKED',
    payout:check?.payout??null,
    inferred_profit:null});
  }
 }
 points.sort((a,b)=>a.at.localeCompare(b.at));
 return {status:points.length?'ok':'no_history_for_outcome',condition_id:condition,token_id:token,
  source:'GITHUB_PUBLIC_OBSERVATION_MIRROR',trend:points.slice(-500),
  signal_evidence:checks.slice(-120),points_total:points.length,
  interpretation:'Each point is the observed rolling 24h net USDC at one archival scan. Missing points are not zero volume.',
  score:null,probability:null,trade_profit:null,execution_authority:'none'};
}
module.exports=async(req,res)=>{
 if(req.method!=='GET'){res.setHeader('Allow','GET');return reply(res,405,{status:'method_not_allowed'})}
 const view=String(req.query?.view||'summary');
 const days=Number(req.query?.days||3);
 if(!Number.isInteger(days)||days<1||days>7)return reply(res,400,{status:'invalid_days'});
 if(!['summary','market'].includes(view))return reply(res,400,{status:'invalid_view'});
 const cond=String(req.query?.condition||'').toLowerCase(),
  token=String(req.query?.token||'');
 if(view==='market'&&(!VALID.test(cond)||!TOKEN.test(token)))return reply(res,400,{status:'invalid_market_token'});
 try{
  const records=await readDays(days);
  if(records.every(x=>x.status==='error'))throw Error('ARCHIVE_SOURCE_UNAVAILABLE');
  const data=view==='summary'?summary(records):marketHistory(records,cond,token);
  return reply(res,200,data);
 }catch(e){
  return reply(res,503,{status:'unavailable',source:'durable_history',
   probability:null,execution_authority:'none',error:'Historical evidence unavailable or unverified'});
 }
};
module.exports._test={summary,marketHistory};
