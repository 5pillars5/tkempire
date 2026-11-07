'use strict';
/*
 * Genesis public Smart Money Flow Map.
 * Evidence only: net observed USDC among sampled wallet fills.
 * This is NEVER a price forecast, win probability, wallet quality or trading authority.
 */
const crypto=require('node:crypto');
const ADDR=/^0x[0-9a-f]{40}$/i, COND=/^0x[0-9a-f]{64}$/i,TX=/^0x[0-9a-f]{64}$/i;
const RANGES=Object.freeze([900,3600,21600,86400]);
const clean=(s,max=180)=>typeof s==='string'?s.trim().slice(0,max):'';
const n=x=>typeof x==='number'&&Number.isFinite(x)?x:null;
const money=x=>Math.round(x*100)/100;
const id=x=>crypto.createHash('sha256').update(x).digest('hex').slice(0,20);
function normalize(row,wallet,now,windowSeconds=86400){
 if(!row||row.type!=='TRADE'||!ADDR.test(wallet))return null;
 const owner=clean(row.proxy_wallet,42).toLowerCase();
 const cond=clean(row.condition_id,66).toLowerCase(),tx=clean(row.transaction_hash,66).toLowerCase();
 const side=clean(row.side,5).toUpperCase(),outcome=clean(row.outcome,85);
 const index=n(row.outcome_index),amount=n(row.usdc_size),price=n(row.price),size=n(row.size),timestamp=n(row.timestamp);
 const token=clean(row.token_id,110);
 if(owner!==wallet.toLowerCase()||!COND.test(cond)||!TX.test(tx)||!['BUY','SELL'].includes(side)||
    !Number.isInteger(index)||index<0||index>998||!outcome||!token||!/^\d+$/.test(token)||
    amount===null||amount<=0||amount>1e10||size===null||size<=0||size>1e12||
    price===null||price<0||price>1||!Number.isInteger(timestamp)||timestamp<now-windowSeconds||timestamp>now+90)return null;
 const eventKey=[owner,tx,cond,index,token,side,timestamp,size,price,amount].join('|');
 return {id:id(eventKey),wallet:owner,condition_id:cond,token_id:token,
   outcome_index:index,title:clean(row.title,190)||'Unnamed market',outcome,
   side,usdc_size:amount,size_shares:size,price,timestamp};
}
function buildFlowSnapshot(wallets,rawByWallet,now=Math.floor(Date.now()/1000),meta={}){
 if(!Array.isArray(wallets)||!rawByWallet||typeof rawByWallet!=='object')throw Error('INVALID_FLOW_INPUT');
 const seen=new Set(),events=[];
 for(const w of wallets){
  const rows=rawByWallet[w.wallet]||[];
  if(!Array.isArray(rows))continue;
  for(const row of rows){
   const e=normalize(row,w.wallet,now);
   if(!e||seen.has(e.id))continue;
   seen.add(e.id);events.push(e);
  }
 }
 events.sort((a,b)=>a.timestamp-b.timestamp||a.id.localeCompare(b.id));
 const markets=new Map();
 const keyOf=e=>e.condition_id+'|'+e.token_id;
 for(const e of events){
  const key=keyOf(e);
  let m=markets.get(key);
  if(!m){
   m={key,condition_id:e.condition_id,token_id:e.token_id,
     title:e.title,outcome:e.outcome,first_timestamp:e.timestamp,last_timestamp:e.timestamp,
     buy:0,sell:0,net:0,activity_count:0,participants:new Map(),
     last_price:e.price, recent_15m:0,previous_15m:0,recent_60m:0,
     points:new Map(),is_multi_outcome:false};
   markets.set(key,m);
  }
  const signed=e.side==='BUY'?e.usdc_size:-e.usdc_size;
  m.buy+=e.side==='BUY'?e.usdc_size:0;
  m.sell+=e.side==='SELL'?e.usdc_size:0;
  m.net+=signed;m.activity_count++;m.last_timestamp=Math.max(m.last_timestamp,e.timestamp);
  m.first_timestamp=Math.min(m.first_timestamp,e.timestamp);
  if(e.timestamp===m.last_timestamp)m.last_price=e.price;
  m.participants.set(e.wallet,(m.participants.get(e.wallet)||0)+signed);
  if(e.timestamp>=now-900)m.recent_15m+=signed;
  else if(e.timestamp>=now-1800)m.previous_15m+=signed;
  if(e.timestamp>=now-3600)m.recent_60m+=signed;
  const bucket=Math.floor(e.timestamp/900)*900;
  m.points.set(bucket,(m.points.get(bucket)||0)+signed);
 }
 const data=[];
 for(const m of markets.values()){
  const values=[...m.participants.values()];
  const buyers=values.filter(x=>x>0.000001).length,sellers=values.filter(x=>x<-.000001).length;
  const gross=m.buy+m.sell,pressure=gross?100*m.buy/gross:null;
  const independent=buyers+sellers;
  // This is *only* share of observed gross BUY volume, NOT odds.
  const density=independent>0?buyers/independent:null;
  const points=[];
  let running=0;
  for(let bucket=Math.floor((now-86400)/900)*900;bucket<=Math.floor(now/900)*900;bucket+=900){
   running+=m.points.get(bucket)||0;
   points.push({t:bucket,v:money(running)});
  }
  data.push({
   market_id:id(m.key),condition_id:m.condition_id,token_id:m.token_id,title:m.title,
   outcome:m.outcome,observed_buy_usdc:money(m.buy),observed_sell_usdc:money(m.sell),
   observed_net_usdc:money(m.net),observed_gross_usdc:money(gross),
   buy_share_of_observed_flow_pct:pressure===null?null:Math.round(pressure*10)/10,
   wallets_net_buying:buyers,wallets_net_selling:sellers,participating_wallets:independent,
   share_of_participants_net_buying_pct:density===null?null:Math.round(100*density),
   activity_count:m.activity_count,last_observed_at:new Date(m.last_timestamp*1000).toISOString(),
   last_sampled_trade_price:m.last_price,net_15m_usdc:money(m.recent_15m),
   net_previous_15m_usdc:money(m.previous_15m),net_60m_usdc:money(m.recent_60m),
   flow_change_15m_usdc:money(m.recent_15m-m.previous_15m),
   cumulative_flow_15m:points,
   evidence_quality:meta.failed_wallets>0?'PARTIAL_WALLET_FEEDS':'BOUNDED_SAMPLE',
   inferred_win_probability:null,quality_weighted_score:null,entry_edge:null,
   // Count how many wallets net bought or net sold the *same exact outcome*.
   consensus_level:buyers>=3&&buyers>sellers?'OBSERVED_3_PLUS_NET_BUYERS':
    sellers>=3&&sellers>buyers?'OBSERVED_3_PLUS_NET_SELLERS':'NOT_ESTABLISHED'
  });
 }
 data.sort((a,b)=>Math.abs(b.observed_net_usdc)-Math.abs(a.observed_net_usdc)||
   b.observed_gross_usdc-a.observed_gross_usdc||a.market_id.localeCompare(b.market_id));
 const totalGross=events.reduce((s,e)=>s+e.usdc_size,0);
 const totalBuys=events.filter(e=>e.side==='BUY').reduce((s,e)=>s+e.usdc_size,0);
 const totalSells=totalGross-totalBuys;
 return {
   schema_version:1,status:meta.failed_wallets>0?'degraded':'ok',
   generated_at:new Date(now*1000).toISOString(),
   scope:'public_all_market_activity_of_current_weekly_crypto_leaderboard_cohort',
   measurement_window_seconds:86400,
   window_ranges_seconds:RANGES,source:'Polymarket Data API v2',
   execution_enabled:false,genesis_execution_authority:'none',
   prediction_model_status:'NOT_TRAINED_OR_CALIBRATED',
   market_pressure_is_win_probability:false,quality_weighting_enabled:false,
   market_count:data.length,events_sampled:events.length,
   wallets_selected:wallets.length,wallets_returned:meta.successful_wallets??wallets.length,
   wallets_failed:meta.failed_wallets??0,wallets_truncated:meta.truncated_wallets??0,
   total_observed_buy_usdc:money(totalBuys),total_observed_sell_usdc:money(totalSells),
   total_observed_net_usdc:money(totalBuys-totalSells),
   oldest_activity_at:events[0]?new Date(events[0].timestamp*1000).toISOString():null,
   newest_activity_at:events.length?new Date(events[events.length-1].timestamp*1000).toISOString():null,
   markets:data.slice(0,80),
   limitations:[
    'Leaderboard cohort is chosen for current weekly profit in crypto, and changes over time; selection bias.',
    'Trades include all market categories these wallets traded, not only crypto markets.',
    'At most 70 events per wallet in the prior 24 hours; incomplete pagination may omit trades.',
    'BUY/SELL reflects observed wallet fill direction; not complete positions, realized PnL or exchange-wide liquidity.',
    'Participation is unweighted until wallet outcome histories, fees and quality scores are independently verified.',
    'Pressure and consensus are not calibrated event probabilities or claims of trading edge.',
    'No persistent history, future outcome validation, execution, wallet access or orders.'
   ]
 };
}
module.exports={normalize,buildFlowSnapshot,RANGES};
