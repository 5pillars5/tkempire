'use strict';
/**
 * Durable, read-only public monitor evidence mirror.
 * Captures the same public signals consumed by existing VPS smartmoney-v1 SQLite,
 * plus bounded Flow Map snapshots; never pretends to have imported VPS history.
 * Neither a performance score nor probability forecast.
 */
const crypto=require('node:crypto');
const CONDITION=/^0x[0-9a-f]{64}$/i, TOKEN=/^[0-9]+$/;
const SIGNAL=/^[a-f0-9]{24}$/i;
const r2=v=>Math.round(v*100)/100;
const number=v=>typeof v==='number'&&Number.isFinite(v)?v:null;
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const obj=o=>o&&typeof o==='object'&&!Array.isArray(o);
function timestamp(s){
 const n=Date.parse(s);
 return typeof s==='string'&&Number.isFinite(n)&&s.includes('T')?Math.floor(n/1000):null;
}
function validateFlow(flow,now=Date.now()/1000){
 if(!obj(flow)||!['ok','degraded'].includes(flow.status)||
  flow.schema_version!==1||flow.execution_enabled!==false||
  flow.genesis_execution_authority!=='none'||
  flow.prediction_model_status!=='NOT_TRAINED_OR_CALIBRATED'||
  flow.market_pressure_is_win_probability!==false||
  !Array.isArray(flow.markets)||flow.markets.length>80||
  !Number.isInteger(flow.wallets_selected)||flow.wallets_selected<1||
  !Number.isInteger(flow.wallets_returned)||flow.wallets_returned<1||
  !Number.isInteger(flow.events_sampled)||flow.events_sampled<0)throw Error('INVALID_FLOW_SCHEMA');
 const ts=timestamp(flow.generated_at);
 if(ts===null||ts>now+90||ts<now-900)throw Error('STALE_OR_FUTURE_FLOW');
 const markets=[];
 for(const m of flow.markets){
  if(!obj(m)||!CONDITION.test(m.condition_id)||!TOKEN.test(String(m.token_id))||
    number(m.observed_buy_usdc)===null||m.observed_buy_usdc<0||
    number(m.observed_sell_usdc)===null||m.observed_sell_usdc<0||
    number(m.observed_net_usdc)===null||
    Math.abs((m.observed_buy_usdc-m.observed_sell_usdc)-m.observed_net_usdc)>0.025||
    m.inferred_win_probability!==null||m.entry_edge!==null||
    m.quality_weighted_score!==null)throw Error('INVALID_OUTCOME_FLOW');
  markets.push({condition_id:m.condition_id.toLowerCase(),token_id:String(m.token_id),
   title:String(m.title||'').slice(0,160),outcome:String(m.outcome||'').slice(0,80),
   net_usdc:r2(m.observed_net_usdc),buy_usdc:r2(m.observed_buy_usdc),
   sell_usdc:r2(m.observed_sell_usdc),
   distinct_net_buyers:Number(m.wallets_net_buying)||0,
   distinct_net_sellers:Number(m.wallets_net_selling)||0,
   fills:Number(m.activity_count)||0,last_price:number(m.last_sampled_trade_price)});
 }
 const bucket=Math.floor(ts/900)*900;
 const coverage={selected:flow.wallets_selected,received:flow.wallets_returned,
   failed:flow.wallets_failed??0,truncated:flow.wallets_truncated??0,
   events:flow.events_sampled,markets_total:flow.market_count,markets_stored:markets.length,
   incomplete:(flow.wallets_failed||0)>0||(flow.wallets_truncated||0)>0||
    flow.market_count>flow.markets.length};
 const record={bucket,at:new Date(ts*1000).toISOString(),source:'PUBLIC_FLOW_API_V1',
   coverage,status:flow.status,markets};
 return {...record,sha256:hash(JSON.stringify(record))};
}
function validateSignalFeed(feed,now=Date.now()/1000){
 if(!obj(feed)||!['ok','degraded'].includes(feed.status)||
   feed.execution_enabled!==false||feed.genesis_execution_authority!=='none'||
   !Array.isArray(feed.signals)||feed.signals.length>100)throw Error('INVALID_SIGNAL_FEED');
 const ts=timestamp(feed.generated_at);
 if(ts===null||ts<now-900||ts>now+90)throw Error('STALE_OR_FUTURE_SIGNAL_FEED');
 const signals=[],seen=new Set();
 for(const s of feed.signals){
  if(!obj(s)||!SIGNAL.test(s.id)||s.execution_authority!=='none'||
    s.signal_mode!=='OBSERVATION_ONLY'||s.paper_trade!==false)throw Error('INVALID_SIGNAL');
  if(seen.has(s.id))continue;
  seen.add(s.id);
  const observed=timestamp(s.observed_at);
  if(observed===null||observed>ts+90||observed<ts-86400*3)throw Error('INVALID_SIGNAL_TIME');
  const condition=String(s.condition_id||'').toLowerCase(),
    token=String(s.token_id||'');
  const direction=String(s.side||'').toUpperCase();
  signals.push({id:s.id,source:'PUBLIC_SIGNAL_FEED_V1',observed_at:s.observed_at,
   captured_at:feed.generated_at,condition_id:CONDITION.test(condition)?condition:null,
   token_id:TOKEN.test(token)?token:null,
   title:String(s.market||'').slice(0,190),outcome:String(s.outcome||'').slice(0,90),
   type:String(s.type||'').slice(0,60),side:['BUY','SELL'].includes(direction)?direction:null,
   representative_price:number(s.representative_price),
   amount_usdc:number(s.amount_usdc),
   wallets:Array.isArray(s.wallets)?s.wallets.filter(w=>/^0x[0-9a-f]{40}$/i.test(w)).slice(0,8):[],
   source_payload_sha256:hash(JSON.stringify(s))});
 }
 return {at:feed.generated_at,source:'PUBLIC_SIGNAL_FEED_V1',signals};
}
function parseArray(x){
 if(Array.isArray(x))return x;
 if(typeof x==='string'){try{const y=JSON.parse(x);return Array.isArray(y)?y:null}catch{return null}}
 return null;
}
function catalogTokens(catalog,condition){
 // Require explicit token-id index mapping from the actual same condition.
 const rows=Array.isArray(catalog)?catalog:obj(catalog)&&Array.isArray(catalog.data)?catalog.data:null;
 if(!rows)return null;
 // Gamma market: clobTokenIds ordered with outcomes.
 for(const entry of rows){
  if(!obj(entry))continue;
  const cond=String(entry.conditionId||entry.condition_id||'').toLowerCase();
  if(cond!==condition)return null; // fail closed when wrong market in list
  const tokens=parseArray(entry.clobTokenIds),outcomes=parseArray(entry.outcomes);
  if(tokens&&outcomes&&tokens.length===outcomes.length&&tokens.length>=2&&tokens.length<=16&&
     tokens.every(t=>TOKEN.test(String(t)))&&new Set(tokens.map(String)).size===tokens.length)
    return tokens.map((t,index)=>({token_id:String(t),index,outcome:String(outcomes[index])}));
 }
 return null;
}
function payoutVector(resolution){
 if(!obj(resolution)||resolution.status!=='resolved'||resolution.extended_review===true)return null;
 const v=parseArray(resolution.payouts);
 if(!v||v.length<2||v.length>16||v.some(x=>number(x)===null||x<0))return null;
 const sum=v.reduce((s,x)=>s+x,0);
 const denom=Math.abs(sum-1)<1e-6?1:Math.abs(sum-1000000)<.001?1000000:null;
 if(!denom)return null;
 return v.map(x=>x/denom);
}
function matchResolution(signal,resolution,catalog){
 const base={signal_id:signal.id,condition_id:signal.condition_id||null,token_id:signal.token_id||null,
   result:'UNVERIFIED',payout:null,reason:'NO_VERIFIED_RESOLUTION',event_profit_usdc:null,
   probability_estimate:null,quality_score:null,resolution_hash:null};
 if(!CONDITION.test(String(signal.condition_id||''))||!TOKEN.test(String(signal.token_id||''))||
    !['BUY','SELL'].includes(signal.side))return {...base,reason:'UNMATCHABLE_SIGNAL_IDENTITY'};
 if(!obj(resolution))return {...base,reason:'RESOLUTION_NOT_RETRIEVED'};
 if(String(resolution.condition_id||'').toLowerCase()!==signal.condition_id)return {...base,reason:'CONDITION_MISMATCH'};
 if(resolution.status!=='resolved')return {...base,result:'PENDING',reason:'MARKET_UNRESOLVED'};
 const payouts=payoutVector(resolution);
 if(!payouts)return {...base,reason:'INVALID_OR_PENDING_PAYOUT_VECTOR'};
 const tokens=catalogTokens(catalog,signal.condition_id);
 if(!tokens||tokens.length!==payouts.length)return {...base,reason:'TOKEN_CATALOG_UNVERIFIED'};
 const chosen=tokens.find(t=>t.token_id===signal.token_id);
 if(!chosen)return {...base,reason:'OUTCOME_TOKEN_MISMATCH'};
 const observed=timestamp(signal.observed_at),resolved=timestamp(resolution.resolved_at);
 if(observed===null||resolved===null||observed>=resolved)return {...base,result:'EXCLUDED',
   reason:'SIGNAL_NOT_PRE_RESOLUTION'};
 const payout=payouts[chosen.index];
 const result=payout>=1-1e-8?'PAYOUT_1':payout<=1e-8?'PAYOUT_0':'PARTIAL_PAYOUT';
 return {...base,result,payout,reason:'CTF_PAYOUT_MATCHED_TOKEN_INDEX',
   token_index:chosen.index,resolved_at:resolution.resolved_at,
   resolution_hash:hash(JSON.stringify({
    condition_id:signal.condition_id,payouts,resolved_at:resolution.resolved_at,
    transaction_hash:resolution.transaction_hash||null,log_index:resolution.log_index??null
   }))};
}
function mergeDay(existing,flow,signals,checkedAt){
 const day=String(checkedAt||'').slice(0,10);
 if(!/^\d{4}-\d\d-\d\d$/.test(day))throw Error('INVALID_DAY');
 const db=obj(existing)?structuredClone(existing):{schema_version:1,day,
  flow_snapshots:[],signal_events:[],outcome_checks:[]};
 if(db.schema_version!==1||db.day!==day||!Array.isArray(db.flow_snapshots)||
   !Array.isArray(db.signal_events)||!Array.isArray(db.outcome_checks))throw Error('INVALID_EXISTING_HISTORY');
 const snapshots=new Map(db.flow_snapshots.map(x=>[x.bucket,x]));
 if(flow){
  const prev=snapshots.get(flow.bucket);
  // An existing time bucket must be immutable; never overwrite a prior observation.
  if(!prev)snapshots.set(flow.bucket,flow);
 }
 const events=new Map(db.signal_events.map(x=>[x.id,x]));
 for(const e of (signals?.signals||[])){
  if(!events.has(e.id))events.set(e.id,e);
 }
 db.flow_snapshots=[...snapshots.values()].sort((a,b)=>a.bucket-b.bucket);
 db.signal_events=[...events.values()].sort((a,b)=>a.observed_at.localeCompare(b.observed_at)||a.id.localeCompare(b.id));
 return db;
}
module.exports={validateFlow,validateSignalFeed,matchResolution,catalogTokens,payoutVector,mergeDay,hash};
