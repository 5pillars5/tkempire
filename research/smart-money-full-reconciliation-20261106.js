'use strict';

/*
 * Empire Smart Money fixed-cohort full-history reconciliation, Nov 6 2026.
 * Public GET data only. NO private keys, orders, Genesis/VPS access,
 * database mutation, signal scoring, or runtime services.
 *
 * A position is NOT a resolved market prediction. CLOSED is fully exited.
 * OPEN includes resolved-but-unredeemed REDEEMABLE rows. REDEEMABLE_LOST
 * is a subset of REDEEMABLE; never double count these three views.\n * REDEEMABLE_LOST may still report positive TOTAL_PNL from earlier partial exits;\n * count economic gains/losses by pnl sign, not the status label.
 */
const ORIGIN = 'https://data-api.polymarket.com';
const COHORT_FROM = '2026-11-06T20:30:17.802Z';
const FIXED_WALLETS = Object.freeze([
 {name:'Papeasy',wallet:'0x111f73e91f85b6fe4de1ddec3de2fe32122e355b'},
 {name:'0x06dc...4524',wallet:'0x06dc51826bc524d9a83770e7de9dd7e005b04524'},
 {name:'033033033',wallet:'0xd1c769317bd15de7768a70d0214cf0bbcc531d2b'},
 {name:'justdance',wallet:'0xcc500cbcc8b7cf5bd21975ebbea34f21b5644c82'},
 {name:'fred4332',wallet:'0x301e286fd88abb7cda0a19a24e4dc4823c4db752'},
 {name:'floatingraft',wallet:'0x56ad6bd05999e0f33ea9c05a48ccb1364a46f13e'},
 {name:'0xb6fe...7394',wallet:'0xb6fef4c2c436ab8bbf07d017952e851dcf717394'},
 {name:'Spirit of Ukraine>UMA',wallet:'0x0c0e270cf879583d6a0142fc817e05b768d0434e'}
]);
const PAGE_LIMIT = 1000;
const CAP_BY_STATUS = {CLOSED:120, OPEN:40, REDEEMABLE:40, REDEEMABLE_LOST:40};
const EXPECTED_SOURCE = new URL(ORIGIN).hostname;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const n = v => typeof v === 'number' && Number.isFinite(v) ? v : null;
const round = v => Math.round((v + Number.EPSILON) * 100) / 100;

async function get(path, params) {
  const url=new URL(path, ORIGIN);
  for (const [k,v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  for (let attempt=0;attempt<5;attempt++) {
    let response;
    try {
      response=await fetch(url,{
        method:'GET',redirect:'error',
        headers:{'Accept':'application/json','User-Agent':'TK-Empire-Research-FixedCohort/2.0'},
        signal:AbortSignal.timeout(30000),
      });
    } catch(e) {
      if(attempt>=4) throw new Error('fetch_failed_'+String(e.name||'unknown'));
      await sleep(1000*(attempt+1));
      continue;
    }
    if ([429,500,503].includes(response.status)) {
      if (attempt===4) throw new Error('upstream_retry_exhausted_'+response.status);
      const ra=Number(response.headers.get('retry-after'));
      await sleep(Math.min(12000,Math.max(1000,(Number.isFinite(ra) && ra>0?ra:attempt+1)*1000)));
      continue;
    }
    if (response.status!==200) throw new Error('upstream_http_'+response.status+'_'+path);
    if(new URL(response.url).hostname!==EXPECTED_SOURCE) throw new Error('unexpected_redirect');
    const content=await response.text();
    if(Buffer.byteLength(content,'utf8')>12000000)throw new Error('upstream_payload_too_large');
    const data=JSON.parse(content);
    if(!data||!Array.isArray(data.data)||!data.pagination||
        typeof data.pagination!=='object')throw new Error('upstream_schema_invalid');
    if(typeof data.pagination.has_more!=='boolean')throw new Error('pagination_has_more_missing');
    return data;
  }
  throw new Error('unexpected_retry_termination');
}
function reducePosition(raw,wallet) {
  if(!raw||typeof raw!=='object')throw new Error('position_not_object');
  const proxy=String(raw.proxy_wallet||'').toLowerCase();
  if(proxy!==wallet)throw new Error('position_wallet_mismatch');
  const condition=String(raw.condition_id||'').toLowerCase();
  const token=String(raw.token_id||'');
  if(!/^0x[0-9a-f]{64}$/.test(condition)||!/^[0-9]+$/.test(token)){
    throw new Error('position_missing_valid_identity');
  }
  const id=condition+'|'+token;
  const realized=n(raw.realized_pnl),total=n(raw.total_pnl),unrealized=n(raw.unrealized_pnl);
  const value=n(raw.current_value),cost=n(raw.total_cost_usdc);
  const currentSize=n(raw.current_size);
  const clock=n(raw.last_event_at);
  return {id,condition,token,realized,total,unrealized,value,cost,currentSize,
    eventAt:clock,redeemable:raw.redeemable===true,status:String(raw.status||''),
    archived:raw.archived===true};
}
async function pageView(wallet,status) {
  const isClosed=status==='CLOSED';
  const params={user:wallet,status,limit:PAGE_LIMIT,sort_by:'TIMESTAMP',sort_direction:'DESC'};
  if(!isClosed) params.include_archived=true;
  const rows=new Map(),seenCursors=new Set();
  let pages=0,cursor=null,complete=false,reason=null;
  const stats={rows_received:0,duplicates:0,conflicts:0,invalid:0,first_timestamp:null,last_timestamp:null};
  try {
    for(let idx=0;idx<CAP_BY_STATUS[status];idx++){
      const response=await get('/v2/positions',{...params,cursor});
      pages++;
      for(const raw of response.data){
        stats.rows_received++;
        let row;
        try {row=reducePosition(raw,wallet)}
        catch(e){stats.invalid++;continue}
        if(row.eventAt!==null && row.eventAt>0){
          stats.first_timestamp=stats.first_timestamp===null?row.eventAt:Math.max(stats.first_timestamp,row.eventAt);
          stats.last_timestamp=stats.last_timestamp===null?row.eventAt:Math.min(stats.last_timestamp,row.eventAt);
        }
        const prior=rows.get(row.id);
        if(prior) {
          stats.duplicates++;
          if(prior.realized!==row.realized||prior.total!==row.total||
             prior.currentSize!==row.currentSize)stats.conflicts++;
        } else rows.set(row.id,row);
      }
      const p=response.pagination;
      if(p.has_more===false){
        if(p.next_cursor!==null && p.next_cursor!==undefined){
          // An inconsistent pagination spine must not silently be called complete.
          reason='has_more_false_with_cursor';
        } else {complete=true}
        break;
      }
      if(typeof p.next_cursor!=='string'||!p.next_cursor){
        reason='has_more_true_cursor_missing';break;
      }
      if(seenCursors.has(p.next_cursor)){
        reason='repeated_cursor';break;
      }
      seenCursors.add(p.next_cursor);
      cursor=p.next_cursor;
      if(pages%20===0)console.log('PAGE_PROGRESS '+JSON.stringify({wallet,status,pages,unique:rows.size}));
      if(idx===CAP_BY_STATUS[status]-1)reason='safety_page_cap_'+String(CAP_BY_STATUS[status]);
      await sleep(80);
    }
  }catch(e){reason=String(e.message||e)}
  return {rows,pages,complete,reason,stats};
}
function pnlMetric(rows,field){
  const list=Array.from(rows);
  const valid=list.map(row=>row[field]).filter(v=>typeof v==='number'&&Number.isFinite(v));
  const wins=valid.filter(x=>x>0).length,losses=valid.filter(x=>x<0).length;
  const grossProfit=valid.reduce((s,x)=>s+Math.max(0,x),0);
  const grossLoss=valid.reduce((s,x)=>s+Math.max(0,-x),0);
  return {
    positions:list.length,with_pnl:valid.length,missing_pnl:list.length-valid.length,
    wins,losses,breakevens:valid.length-wins-losses,
    win_rate_pct:wins+losses?round(100*wins/(wins+losses)):null,
    pnl_usdc:round(valid.reduce((s,x)=>s+x,0)),
    gross_profit_usdc:round(grossProfit),gross_loss_usdc:round(grossLoss),
    profit_factor:grossLoss?round(grossProfit/grossLoss):wins>0?'no_sample_losses':null,
    average_win_usdc:wins?round(grossProfit/wins):null,
    average_loss_usdc:losses?round(-grossLoss/losses):null,
  };
}
function summarizeWallet(item,views){
  const closed=views.CLOSED,open=views.OPEN,redeem=views.REDEEMABLE,lost=views.REDEEMABLE_LOST;
  const held=new Map(open.rows);
  for(const [id,row] of redeem.rows){if(!held.has(id))held.set(id,row)}
  for(const [id,row] of lost.rows){if(!held.has(id))held.set(id,row)}
  const settled=new Map(redeem.rows);
  for(const [id,row] of lost.rows){if(!settled.has(id))settled.set(id,row)}
  for(const [id,row] of open.rows){if(row.redeemable && !settled.has(id))settled.set(id,row)}
  const unsettled=[...held.values()].filter(x=>!settled.has(x.id));
  const closedRows=[...closed.rows.values()];
  const settledRows=[...settled.values()];
  const lostRows=[...lost.rows.values()];
  const overlapClosedHeld=closedRows.filter(x=>held.has(x.id)).length;
  const missingLostInRedeem=lostRows.filter(x=>!redeem.rows.has(x.id)).length;
  const missingRedeemInOpen=[...redeem.rows.keys()].filter(id=>!open.rows.has(id)).length;
  const actualLostFromSettled=settledRows.filter(x=>x.total!==null && x.total<0).length;
  const metricClosed=pnlMetric(closedRows,'realized');
  const metricSettled=pnlMetric(settledRows,'total');
  const metricLost=pnlMetric(lostRows,'total');
  const metricUnresolved=pnlMetric(unsettled,'total');
  const economicResolved=pnlMetric(
    closedRows.map(x=>({...x,pnl:x.realized})).concat(
      settledRows.map(x=>({...x,pnl:x.total}))), 'pnl'
  );
  const incomplete=Object.entries(views).filter(([status,view])=>!view.complete).map(([status,view])=>status+':'+String(view.reason||'incomplete'));
  const missing=Object.entries(views).reduce((n,[,view])=>n+view.stats.invalid,0);
  const conflicts=Object.entries(views).reduce((n,[,view])=>n+view.stats.conflicts,0);
  const completeness=(incomplete.length===0&&missing===0&&conflicts===0&&overlapClosedHeld===0&&missingLostInRedeem===0&&missingRedeemInOpen===0);
  return {
    wallet:item.wallet,name:item.name,
    view_pages:Object.fromEntries(Object.entries(views).map(([key,v])=>[key,v.pages])),
    view_counts:Object.fromEntries(Object.entries(views).map(([key,v])=>[key,v.rows.size])),
    view_complete:Object.fromEntries(Object.entries(views).map(([key,v])=>[key,v.complete])),
    closed:metricClosed,
    settled_held_unredeemed:metricSettled,
    settled_held_losing_subset:metricLost,
    unresolved_held:metricUnresolved,
    resolved_economic_sample: economicResolved,
    unresolved_current_market_value_usdc:round(unsettled.reduce((a,x)=>a+(x.value||0),0)),
    settled_negative_pnl_positions:actualLostFromSettled,
    overlaps:{closed_and_held:overlapClosedHeld,lost_missing_from_redeemable:missingLostInRedeem,
      redeemable_missing_from_open:missingRedeemInOpen},
    data_quality:{complete:completeness,incomplete_views:incomplete,
      invalid_rows:missing,economic_conflicts:conflicts,
      note:'Closed realized PnL vs settled-but-unredeemed TOTAL PnL; OPEN unsettled excluded from win-rate'},
    quality_score:'WITHHELD_UNTIL_COMPLETE_RECONCILIATION',
  };
}
async function auditWallet(item){
  const views={};
  for(const status of ['REDEEMABLE_LOST','REDEEMABLE','OPEN','CLOSED']){
    views[status]=await pageView(item.wallet,status);
    const v=views[status];
    console.log('VIEW_DONE '+JSON.stringify({wallet:item.wallet,name:item.name,
      status,pages:v.pages,rows:v.rows.size,complete:v.complete,
      reason:v.reason,invalid:v.stats.invalid,duplicates:v.stats.duplicates,
      conflicts:v.stats.conflicts,last_event_min:v.stats.last_timestamp,
      last_event_max:v.stats.first_timestamp}));
  }
  return summarizeWallet(item,views);
}
async function main(){
  console.log('FIXED_COHORT='+COHORT_FROM+' WALLETS='+FIXED_WALLETS.length
      +' REQUESTED_AT_UTC='+new Date().toISOString()
      +' PAGE_LIMIT='+PAGE_LIMIT+' CLOSED_MAX_PAGES='+CAP_BY_STATUS.CLOSED);
  const results=[];
  for(const item of FIXED_WALLETS){
    try{
      const outcome=await auditWallet(item);
      results.push(outcome);
      console.log('WALLET_RECONCILIATION '+JSON.stringify(outcome));
    }catch(e){
      console.log('WALLET_FATAL '+JSON.stringify({wallet:item.wallet,name:item.name,error:String(e.message||e)}));
    }
  }
  let totals={wallets_scanned:results.length,fully_reconciled:results.filter(x=>x.data_quality.complete).length,
    closed_wins:0,closed_losses:0,settled_held_wins:0,settled_held_losses:0,
    unresolved_held_positions:0,redeemable_lost_positions:0,total_closed_positions:0,
    score_status:'WITHHELD'};
  for(const x of results){
    totals.closed_wins+=x.closed.wins;
    totals.closed_losses+=x.closed.losses;
    totals.settled_held_wins+=x.settled_held_unredeemed.wins;
    totals.settled_held_losses+=x.settled_held_unredeemed.losses;
    totals.unresolved_held_positions+=x.unresolved_held.positions;
    totals.redeemable_lost_positions+=x.settled_held_losing_subset.positions;
    totals.total_closed_positions+=x.closed.positions;
  }
  console.log('RECONCILIATION_SUMMARY '+JSON.stringify(totals));
  console.log('DATASET_INTERPRETATION=CLOSED_MEANS_EXITED;REDEEMABLE_LOST_IS_SUBSET_OF_REDEEMABLE_AND_CAN_HAVE_POSITIVE_TOTAL_PNL;OPEN_UNRESOLVED_IS_NOT_CLOSED');
  console.log('CRYPTO_SCOPE_WARNING=Wallet histories span all market categories, not crypto only');
  console.log('ACCURACY_WARNING=Position_PnL_sign_is_not_market_prediction_hit_rate;CLOSED_HELD_OVERLAP_REQUIRES_LOT_LEVEL_RECONCILIATION');
  console.log('RESULT='+(results.length===FIXED_WALLETS.length?'RECONCILIATION_RETRIEVED':'RECONCILIATION_PARTIAL'));
  if(results.length!==FIXED_WALLETS.length)process.exitCode=2;
}
module.exports={pnlMetric,summarizeWallet,reducePosition,FIXED_WALLETS};
if(require.main===module)main().catch(e=>{
  console.error('RESULT=FAILED error='+String(e.message||e));process.exitCode=1;
});
