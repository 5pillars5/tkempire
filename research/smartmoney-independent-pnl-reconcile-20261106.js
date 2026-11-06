'use strict';
/*
 * TK Empire independent profit/loss verification for the 14 mismatches.
 * Public read-only source; no execution, keys, VPS, or portfolio modification.
 * Case study, not comprehensive all-market trading-history reconstruction.
 */
const {conditions}=require('./data/smartmoney-fixed-cohort-32-markets-20261106.json');
const targets=conditions.filter(x=>x.original_failed_token_lots>0);
const BASE='https://data-api.polymarket.com';
const round=x=>Math.round((x+Number.EPSILON)*10000)/10000;
const num=x=>typeof x==='number'&&Number.isFinite(x)?x:null;
const goodToken=x=>/^[0-9]+$/.test(String(x||''));
const goodCondition=x=>/^0x[0-9a-f]{64}$/.test(String(x||'').toLowerCase());
async function data(path,params){
 const u=new URL(path,BASE);for(const [k,v]of Object.entries(params||{}))if(v!==null&&v!==undefined)u.searchParams.set(k,String(v));
 for(let n=0;n<4;n++){
  let r;
  try{r=await fetch(u,{method:'GET',redirect:'error',headers:{Accept:'application/json'},
       signal:AbortSignal.timeout(18000)})}
  catch(e){if(n===3)throw new Error('network_'+String(e.name||e));await new Promise(res=>setTimeout(res,600*(n+1)));continue}
  if([429,500,503].includes(r.status)){
   if(n===3)throw Error('rate_limit_'+r.status);
   await new Promise(res=>setTimeout(res,800*(n+1)));continue
  }
  if(r.status!==200)throw Error(path+'_http_'+r.status);
  if(new URL(r.url).hostname!==new URL(BASE).hostname)throw Error('unexpected_origin');
  const body=await r.text();if(body.length>12000000)throw Error('oversize');
  const j=JSON.parse(body);if(!Array.isArray(j.data))throw Error('bad_data_envelope');
  return j;
 }throw Error('retry_exhausted');
}
async function paged(path,params,max=24){
 let cursor=null,complete=false,reason=null;const rows=[],seen=new Set();
 for(let i=0;i<max;i++){
  let doc;try{doc=await data(path,{...params,cursor})}catch(e){reason=String(e.message||e);break}
  rows.push(...doc.data);
  const p=doc.pagination;
  if(!p||typeof p.has_more!=='boolean'){reason='missing_pagination';break}
  if(!p.has_more){
   if(p.next_cursor!==null&&p.next_cursor!==undefined)reason='unexpected_next_cursor';
   else complete=true;
   break
  }
  if(!p.next_cursor||seen.has(p.next_cursor)){reason='cursor_invalid';break}
  seen.add(p.next_cursor);cursor=p.next_cursor;
  if(i===max-1)reason='page_limit';
 }
 return {rows,complete,reason};
}
function payoutVector(record){
 if(!record||record.status!=='resolved')return null;
 let p=record.payouts;
 if(typeof p==='string'){try{p=JSON.parse(p)}catch{return null}}
 if(!Array.isArray(p)||p.length<2||p.length>16||p.some(x=>typeof x!=='number'||!Number.isFinite(x)||x<0))return null;
 const total=p.reduce((s,x)=>s+x,0);
 if(Math.abs(total-1)<1e-6)return p;
 if(Math.abs(total-1000000)<1e-3)return p.map(x=>x/1000000);
 return null;
}
function oracleBinaryVector(record,positionRows){
 if(!record||record.status!=='resolved'||record.new_version_q!==true)return null;
 const price=String(record.price??'');
 if(price!=='0'&&price!=='1000000000000000000')return null;
 const mapped=new Map();
 for(const p of positionRows){
   if(!Number.isInteger(p.outcome_index)||p.outcome_index<0||p.outcome_index>1)continue;
   const name=String(p.outcome||'').toLowerCase();
   if(name!=='yes'&&name!=='no')return null;
   if(mapped.has(p.outcome_index)&&mapped.get(p.outcome_index)!==name)return null;
   mapped.set(p.outcome_index,name);
 }
 if(mapped.size!==2||mapped.get(0)!=='yes'||mapped.get(1)!=='no')return null;
 return price==='1000000000000000000'?[1,0]:[0,1];
}
function identity(e){
 const t=String(e.transaction_hash||'').toLowerCase();
 const condition=String(e.condition_id||'').toLowerCase();
 const token=String(e.token_id||'');
 const ts=num(e.timestamp),size=num(e.size),usdc=num(e.usdc_size);
 if(!/^0x[0-9a-f]{64}$/.test(t)||!goodCondition(condition)||!(goodToken(token)||(['MERGE','SPLIT'].includes(String(e.type||'').toUpperCase())&&token===''))||
    ts===null||size===null||usdc===null)return null;
 return [t,condition,token,String(e.outcome_index??''),String(e.type||''),String(e.side||''),
         ts.toString(),size.toString(),usdc.toString()].join('|');
}
function auditEvents(events,condition,wallet,resolution){
 const unique=new Map(),duplicates=0,invalid=0;
 let duplicateCount=0,invalidCount=0,spillover=0;
 for(const e of events){
  if(String(e.condition_id||'').toLowerCase()!==condition||
     String(e.proxy_wallet||'').toLowerCase()!==wallet){spillover++;continue}
  const k=identity(e);
  if(!k){invalidCount++;continue}
  if(unique.has(k)){duplicateCount++;continue}
  unique.set(k,e)
 }
 const filtered=[...unique.values()].sort((a,b)=>
   a.timestamp-b.timestamp||a.transaction_hash.localeCompare(b.transaction_hash));
 const vectors=payoutVector(resolution),tokens=new Map(),reds=new Map(),structural=[];
 let redemptionChecks=0,redemptionPasses=0,redemptionFailures=0,
     unverifiedRedemption=0,mergeCount=0,splitCount=0,feeUnavailable=0;
 for(const e of filtered){
  const token=String(e.token_id);
  const kind=String(e.type||'').toUpperCase();
  if((kind==='MERGE'||kind==='SPLIT')&&token===''){structural.push(e);continue}
  if(!tokens.has(token))tokens.set(token,{token,idx:new Set(),buys:0,buysUsd:0,sells:0,sellsUsd:0,redeemBurn:0,redeemUsd:0,split:0,merge:0,unknown:0,
    events:[],txSet:new Set()});
  const t=tokens.get(token);t.idx.add(e.outcome_index);t.events.push(e);
  const type=String(e.type||'').toUpperCase(),side=String(e.side||'').toUpperCase();
  if(type==='TRADE'&&side==='BUY'){t.buys+=e.size;t.buysUsd+=e.usdc_size}
  else if(type==='TRADE'&&side==='SELL'){t.sells+=e.size;t.sellsUsd+=e.usdc_size}
  else if(type==='REDEEM'){
   t.redeemBurn+=e.size;t.redeemUsd+=e.usdc_size;
   if(!reds.has(e.transaction_hash))reds.set(e.transaction_hash,[]);
   reds.get(e.transaction_hash).push(e);
   const index=e.outcome_index;
   if(vectors&&Number.isInteger(index)&&index>=0&&index<vectors.length){
    redemptionChecks++;
    const expected=e.size*vectors[index],tol=Math.max(.03,e.size*.00005);
    if(Math.abs(expected-e.usdc_size)<=tol)redemptionPasses++;
    else redemptionFailures++;
   }else unverifiedRedemption++;
  }else if(type==='MERGE'){t.merge+=e.size;mergeCount++}
  else if(type==='SPLIT'){t.split+=e.size;splitCount++}
  else{t.unknown++}
 }
 let structuralNotMapped=0,collateralMerged=0,collateralSplit=0;
 const pair=[...tokens.values()].filter(t=>t.idx.size===1&&[...t.idx][0]>=0&&[...t.idx][0]<=1);
 const hasPair=pair.length===2&&new Set(pair.map(t=>[...t.idx][0])).size===2;
 for(const e of structural){
   const kind=String(e.type||'').toUpperCase();
   if(!hasPair){structuralNotMapped++;continue}
   for(const t of pair){if(kind==='MERGE')t.merge+=e.size;else t.split+=e.size}
   if(kind==='MERGE'){mergeCount++;collateralMerged+=e.usdc_size}
   else{splitCount++;collateralSplit+=e.usdc_size}
 }
 const audited=[];
 for(const t of tokens.values()){
  const net=t.buys-t.sells-t.redeemBurn+t.split-t.merge;
  audited.push({token:t.token,outcome_indices:[...t.idx],
      buys_round:round(t.buys),buy_usdc:round(t.buysUsd),
      sells_round:round(t.sells),sell_usdc:round(t.sellsUsd),
      redeemed_shares:round(t.redeemBurn),redeem_payout_usdc:round(t.redeemUsd),
      merge_shares:round(t.merge),split_shares:round(t.split),
      modeled_remaining_shares:round(net),
      net_cash_flow_usdc:round(t.sellsUsd+t.redeemUsd-t.buysUsd),
      event_count:t.events.length,unknown_events:t.unknown});
 }
 return {
  unique_events:filtered.length,duplicate_fingerprints:duplicateCount,
  invalid_events:invalidCount,spillover,redemption_tx_count:reds.size,
  redemption_event_count:filtered.filter(e=>e.type==='REDEEM').length,
  redemption_checks: redemptionChecks, redemption_passes:redemptionPasses,
  redemption_failures:redemptionFailures,redemption_without_vector:unverifiedRedemption,
  merge_events:mergeCount,split_events:splitCount,
  structural_events_without_pair:structuralNotMapped,
  merged_collateral_usdc:round(collateralMerged),split_collateral_usdc:round(collateralSplit),
  payout_vector:vectors,tokens:audited
 };
}
function marketCashPnl(stats,compares,openRows,closedRows){
 const uniqueClosed=new Map(closedRows.map(x=>[String(x.token_id||''),x]));
 const report=[...uniqueClosed.values()].reduce((s,x)=>s+(num(x.realized_pnl)||0),0);
 const fees=[...uniqueClosed.values()].reduce((s,x)=>s+(num(x.entry_fees_usdc)||0),0);
 const modeled=stats.tokens.reduce((s,t)=>s+t.net_cash_flow_usdc,0)
       + stats.merged_collateral_usdc - stats.split_collateral_usdc;
 const fullShares=compares.length===2&&compares.every(t=>Math.abs(t.residual_delta_shares)<=0.03
      &&!t.missing_opening_basis&&t.classification!=='NOT_RECONCILED_INVENTORY');
 const openHeld=openRows.some(x=>(num(x.current_size)||0)>0.03);
 const complete=fullShares&&!openHeld&&stats.invalid_events===0
   &&stats.duplicate_fingerprints===0&&stats.structural_events_without_pair===0
   &&stats.redemption_failures===0&&stats.redemption_without_vector===0
   &&compares.every(t=>!t.has_closed_open_overlap)&&uniqueClosed.size===2;
 const delta=round(modeled-report);
 const tol=Math.max(0.1,Math.abs(modeled)*0.001);
 return {reported_closed_pnl_usdc:round(report),modeled_market_cash_pnl_usdc:round(modeled),
    reported_remaining_entry_fees_usdc:round(fees),
    delta_usdc:delta,tolerance_usdc:round(tol),
    inventory_reconciled:fullShares,market_fully_flat:!openHeld,
    pnl_eligible:complete,pnl_matches:complete&&Math.abs(delta)<=tol,
    classification:!complete?'INCOMPLETE_ECONOMIC_EVIDENCE':
      Math.abs(delta)<=tol?'PROVISIONAL_MARKET_PNL_MATCH':'MARKET_PNL_DISAGREEMENT',
    note:'Trade/redeem/merge cash flows, before independent fee and on-chain transfer verification'};
}
function positionsForToken(rows,token){
 return rows.filter(x=>String(x.token_id||'')===token);
}
function compareToPositions(stats,openRows,closedRows){
 const out=[];
 for(const token of stats.tokens){
  const opens=positionsForToken(openRows,token.token),closed=positionsForToken(closedRows,token.token);
  const snapshots=[...opens,...closed];
  // Recognize overlapping OPEN/CLOSED snapshots as multiple accounting epochs.
  const overlap=opens.length>0&&closed.length>0;
  const residual=opens.reduce((s,x)=>s+(num(x.current_size)||0),0);
  const lastEntry=Math.max(0,...snapshots.map(x=>num(x.last_event_at)||0));
  const basis=closed.reduce((s,x)=>s+(num(x.avg_price)||0)*(num(x.total_size)||0),0);
  const report=closed.reduce((s,x)=>s+(num(x.realized_pnl)||0),0);
  const missingBasis=snapshots.length===0||token.buys_round+Math.max(0,token.split_shares)<token.sells_round+token.redeemed_shares+token.merge_shares-0.02;
  const shareDelta=round(token.modeled_remaining_shares-residual);
  const tol=Math.max(.02,Math.abs(residual)*.001);
  const exactShares=!overlap&&Math.abs(shareDelta)<=tol&&!missingBasis&&token.unknown_events===0;
  // Fully flat, no splits/merges, and audited buys fully cover every exit:
  // only then compare independent net cash P&L with API realized P&L.
  const fullyFlat=exactShares&&Math.abs(residual)<=.02&&
    token.merge_shares===0&&token.split_shares===0&&
    closed.length===1&&opens.length===0;
  const costDiff=round(token.buy_usdc-basis);
  const pnlDiff=round(token.net_cash_flow_usdc-report);
  const tolerance=Math.max(.05,Math.abs(report)*.001);
  out.push({
    token_prefix:token.token.slice(0,14),
    outcome_indices:token.outcome_indices,
    observed_buys:token.buys_round,observed_sells:token.sells_round,
    observed_redemptions:token.redeemed_shares,
    residual_api_shares:round(residual),modeled_remaining_shares:token.modeled_remaining_shares,
    residual_delta_shares:shareDelta,
    has_closed_open_overlap:overlap,missing_opening_basis:missingBasis,
    reported_closed_pnl_usdc:round(report),reported_basis_proxy_usdc:round(basis),
    independent_cash_pnl_usdc:token.net_cash_flow_usdc,
    cost_basis_proxy_delta_usdc:costDiff,independent_pnl_delta_usdc:pnlDiff,
    independent_pnl_eligible:fullyFlat,
    independent_pnl_pass:fullyFlat&&Math.abs(pnlDiff)<=tolerance,
    independent_pnl_fail:fullyFlat&&Math.abs(pnlDiff)>tolerance,
    classification:!exactShares?'NOT_RECONCILED_INVENTORY':!fullyFlat?'INVENTORY_MATCHED_PNL_NOT_PROVABLE':
      Math.abs(pnlDiff)<=tolerance?'PNL_RECONCILED':'PNL_DISAGREEMENT'
  });
 }
 return out;
}
async function main(){
 const totals={markets_attempted:targets.length,markets_fetched:0,
     activity_records:0,unique_event_records:0,duplicates:0,invalid:0,
     redemption_events:0,redemption_tx:0,redemption_checks:0,redemption_passes:0,
     redemption_failures:0,unverifiable_redemptions:0,
     resolved_with_vector:0,oracle_derived_vector_markets:0,open_status_markets:0,
     token_cases:0,independent_pnl_eligible:0,independent_pnl_passes:0,
     independent_pnl_failures:0,market_pnl_eligible:0,market_pnl_matches:0,
     market_pnl_disagreements:0,recognized_merges:0,unreconciled_inventory:0,
     lot_scores:'WITHHELD',wallet_scores:'WITHHELD'};
 for(const c of targets){
  try{
   const activity=await paged('/v2/activity',{user:c.wallet,condition:c.condition,limit:1000,
       sort_by:'TIMESTAMP',sort_direction:'ASC'},24);
   const closed=await paged('/v2/positions',{user:c.wallet,condition:c.condition,status:'CLOSED',limit:100},3);
   const opened=await paged('/v2/positions',{user:c.wallet,condition:c.condition,status:'OPEN',include_archived:true,limit:100},3);
   const resolution=await data('/v2/resolutions',{condition:c.condition});
   const resolved=resolution.data.find(x=>String(x.condition_id||'').toLowerCase()===c.condition)||null;
   const explicit=payoutVector(resolved);
   const derived=!explicit?oracleBinaryVector(resolved,[...opened.rows,...closed.rows]):null;
   const resolutionForAudit=derived?{status:'resolved',payouts:derived}:resolved;
   const stats=auditEvents(activity.rows,c.condition,c.wallet,resolutionForAudit);
   const compares=compareToPositions(stats,opened.rows,closed.rows);
   const marketPnl=marketCashPnl(stats,compares,opened.rows,closed.rows);
   const reliable=activity.complete&&opened.complete&&closed.complete&&stats.invalid_events===0&&stats.duplicate_fingerprints===0&&stats.spillover===0;
   const item={
    name:c.name,wallet:c.wallet,condition:c.condition,old_unmatched_token_cases:c.original_failed_token_lots,
    activity_complete:activity.complete,activity_failure:activity.reason,closed_complete:closed.complete,
    opened_complete:opened.complete,
    open_positions_count:opened.rows.length,closed_positions_count:closed.rows.length,
    open_positions_conditions:[...new Set(opened.rows.map(x=>x.condition_id))].slice(0,3),
    closed_positions_conditions:[...new Set(closed.rows.map(x=>x.condition_id))].slice(0,3),
    resolution_status:resolved?.status||'not_found',
    payout_vector:stats.payout_vector,
    payout_source:explicit?'EXPLICIT_CTF':derived?'ORACLE_PRICE_DERIVED':'UNVERIFIED',
    events_unique:stats.unique_events,duplicate_event_fingerprints:stats.duplicate_fingerprints,
    invalid_events:stats.invalid_events,spillover:stats.spillover,
    redemption_tx_count:stats.redemption_tx_count,
    redemption_events:stats.redemption_event_count,
    redemption_checks:stats.redemption_checks,redemption_passes:stats.redemption_passes,
    redemption_failures:stats.redemption_failures,
    redemption_without_vector:stats.redemption_without_vector,
    merged_events:stats.merge_events,split_events:stats.split_events,
    mapped_merge_usdc:stats.merged_collateral_usdc,
    structural_unmapped:stats.structural_events_without_pair,
    independent_market_pnl:marketPnl,
    source_pages_complete:reliable,
    token_audits:compares
   };
   console.log('INDEPENDENT_MARKET '+JSON.stringify(item));
   totals.markets_fetched++;
   totals.activity_records+=activity.rows.length;
   totals.unique_event_records+=stats.unique_events;
   totals.duplicates+=stats.duplicate_fingerprints;totals.invalid+=stats.invalid_events;
   totals.redemption_events+=stats.redemption_event_count;
   totals.redemption_tx+=stats.redemption_tx_count;
   totals.redemption_checks+=stats.redemption_checks;
   totals.redemption_passes+=stats.redemption_passes;
   totals.redemption_failures+=stats.redemption_failures;
   totals.unverifiable_redemptions+=stats.redemption_without_vector;
   if(stats.payout_vector)totals.resolved_with_vector++;
   if(derived)totals.oracle_derived_vector_markets++;
   totals.token_cases+=compares.length;
   totals.independent_pnl_eligible+=compares.filter(x=>x.independent_pnl_eligible).length;
   totals.independent_pnl_passes+=compares.filter(x=>x.independent_pnl_pass).length;
   totals.independent_pnl_failures+=compares.filter(x=>x.independent_pnl_fail).length;
   totals.unreconciled_inventory+=compares.filter(x=>x.classification==='NOT_RECONCILED_INVENTORY').length;
   totals.recognized_merges+=stats.merge_events;
   totals.market_pnl_eligible+=marketPnl.pnl_eligible?1:0;
   totals.market_pnl_matches+=marketPnl.pnl_matches?1:0;
   totals.market_pnl_disagreements+=marketPnl.pnl_eligible&&!marketPnl.pnl_matches?1:0;
  }catch(e){console.log('INDEPENDENT_ERROR '+JSON.stringify({wallet:c.wallet,condition:c.condition,error:String(e.message||e)}));}
 }
 console.log('INDEPENDENT_SUMMARY '+JSON.stringify(totals));
 console.log('RESULT='+ (totals.markets_fetched===targets.length?'ALL_EIGHT_MARKETS_AUDITED':'PARTIAL'));
 if(totals.markets_fetched!==targets.length)process.exitCode=2;
}
module.exports={payoutVector,oracleBinaryVector,identity,auditEvents,compareToPositions,marketCashPnl};
if(require.main===module)main().catch(e=>{console.error('FATAL '+String(e));process.exitCode=1});
