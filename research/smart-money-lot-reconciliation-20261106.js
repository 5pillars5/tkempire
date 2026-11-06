'use strict';
/*
 TK Empire Smart Money — targeted fill/partial exit/redemption/redeemability
 reconciliation. Research only. Public GET API; no orders, private keys, or VPS.

 Fixed Nov 6 cohort. Samples a small subset of markets per wallet; never
 extrapolates to an all-history wallet quality score.
*/
const API='https://data-api.polymarket.com';
const WALLETS=[
 ['Papeasy','0x111f73e91f85b6fe4de1ddec3de2fe32122e355b'],
 ['0x06dc...4524','0x06dc51826bc524d9a83770e7de9dd7e005b04524'],
 ['033033033','0xd1c769317bd15de7768a70d0214cf0bbcc531d2b'],
 ['justdance','0xcc500cbcc8b7cf5bd21975ebbea34f21b5644c82'],
 ['fred4332','0x301e286fd88abb7cda0a19a24e4dc4823c4db752'],
 ['floatingraft','0x56ad6bd05999e0f33ea9c05a48ccb1364a46f13e'],
 ['0xb6fe...7394','0xb6fef4c2c436ab8bbf07d017952e851dcf717394'],
 ['Spirit of Ukraine>UMA','0x0c0e270cf879583d6a0142fc817e05b768d0434e']
];
const PAGE_LIMIT=1000;
const MAX_ACTIVITY_PAGES=22;
const MAX_POSITIONS_PER_VIEW=600;
const MAX_CONDITIONS_PER_WALLET=4;
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const finite=v=>typeof v==='number'&&Number.isFinite(v)?v:null;
const rnd=v=>Math.round((v+Number.EPSILON)*100)/100;
const validCond=c=>/^0x[0-9a-f]{64}$/.test(String(c||'').toLowerCase());
const validToken=t=>/^[0-9]+$/.test(String(t||''));
async function get(path,params){
 const u=new URL(path,API);
 for(const [k,v] of Object.entries(params||{}))if(v!==null&&v!==undefined)u.searchParams.set(k,String(v));
 for(let attempt=0;attempt<5;attempt++){
  let res;
  try{
   res=await fetch(u,{method:'GET',redirect:'error',headers:{
    Accept:'application/json','User-Agent':'TK-Empire-Public-Lot-Audit/1.0'},
    signal:AbortSignal.timeout(25000)});
  }catch(e){
   if(attempt===4)throw new Error('network_failure '+String(e.name||e));
   await pause(750*(attempt+1));continue;
  }
  if([429,500,503].includes(res.status)){
   if(attempt===4)throw new Error('upstream_'+res.status);
   const retry=Number(res.headers.get('retry-after'));
   await pause(Math.min(15000,1000*(Number.isFinite(retry)&&retry>0?retry:attempt+1)));
   continue;
  }
  if(res.status!==200)throw new Error('http_'+res.status+' '+path);
  if(new URL(res.url).hostname!==new URL(API).hostname)throw new Error('untrusted_redirect');
  const text=await res.text();
  if(Buffer.byteLength(text,'utf8')>12000000)throw new Error('oversize_response');
  const body=JSON.parse(text);
  if(!body||!Array.isArray(body.data))throw new Error('invalid_api_envelope');
  return body;
 }
 throw new Error('retry_exhausted');
}
async function pages(path,params,maximum){
 const all=[],seenCursor=new Set();
 let cursor=null,why=null,count=0,complete=false;
 try{
  for(let i=0;i<maximum;i++){
   const body=await get(path,{...params,cursor});count++;
   if(!body.pagination||typeof body.pagination.has_more!=='boolean')
     throw new Error('missing_pagination');
   all.push(...body.data);
   const p=body.pagination;
   if(!p.has_more){
    if(p.next_cursor!==null&&p.next_cursor!==undefined){why='false_has_more_but_cursor';}
    else complete=true;
    break;
   }
   if(!p.next_cursor||typeof p.next_cursor!=='string'){why='missing_cursor';break;}
   if(seenCursor.has(p.next_cursor)){why='repeated_cursor';break;}
   seenCursor.add(p.next_cursor);cursor=p.next_cursor;
   if(i===maximum-1)why='page_cap';
   await pause(65);
  }
 }catch(e){why=String(e.message||e);}
 return {data:all,pages:count,complete,why};
}
function simplifiedPosition(raw){
 const condition=String(raw.condition_id||'').toLowerCase();
 const token=String(raw.token_id||'');
 if(!validCond(condition)||!validToken(token))return null;
 return {
   condition,token,id:condition+'|'+token,
   status:String(raw.status||''),
   current_size:finite(raw.current_size),
   realized_pnl:finite(raw.realized_pnl),total_pnl:finite(raw.total_pnl),
   current_value:finite(raw.current_value),
   redeemable:raw.redeemable===true,
   title:String(raw.title||'').slice(0,90)
 };
}
function selectConditions(views){
 const selections=new Map();
 function add(row,from){
  if(!row||selections.size>=MAX_CONDITIONS_PER_WALLET)return;
  if(!selections.has(row.condition))selections.set(row.condition,{condition:row.condition,reason:from});
 }
 const lost=views.REDEEMABLE_LOST.data.map(simplifiedPosition).filter(Boolean);
 const opened=views.OPEN.data.map(simplifiedPosition).filter(Boolean);
 const closed=views.CLOSED.data.map(simplifiedPosition).filter(Boolean);
 // Include a redeemed-but-unclaimed loser, an unresolved held market,
 // and recent closed markets. These are evidence classes, not a random sample.
 add(lost.find(x=>x.total_pnl!==null&&x.total_pnl<0)||lost[0],'settled_unredeemed');
 add(opened.find(x=>!x.redeemable&&x.current_size>0),'unresolved_held');
 for(const c of closed.slice(0,100))if(selections.size<MAX_CONDITIONS_PER_WALLET)add(c,'recent_closed');
 return Array.from(selections.values());
}
function summarizeResolution(rows,condition){
 const matches=rows.filter(x=>String(x.condition_id||x.condition||x.conditionId||'').toLowerCase()===condition);
 if(!matches.length)return {matched:false,verified:false,reason:'no_condition_match'};
 const row=matches[0];
 const keys=Object.keys(row).sort();
 const explicit={};
 for(const key of keys){
  if(/^(state|status|resolved|resolved_at|winning_outcome|winning_token|payout|payouts|resolution|result|outcome)$/i.test(key)){
    const val=row[key];
    if(typeof val==='string'||typeof val==='number'||typeof val==='boolean'||Array.isArray(val))
      explicit[key]=Array.isArray(val)?val.slice(0,8):val;
  }
 }
 const terminal=Object.keys(explicit).some(k=>/state|status|resolved/i.test(k) && /resolve|final|redeem/i.test(String(explicit[k])));
 // Terminal status alone is not proof of the winning token/payout index.
 // Live API uses integer micro-unit payout weights, e.g. [0, 1000000].\n const hasPayout=Array.isArray(explicit.payouts) && explicit.payouts.length >= 2 && explicit.payouts.every(v=>typeof v==='number' && Number.isFinite(v) && v>=0) && [1,1000000].some(scale=>Math.abs(explicit.payouts.reduce((a,b)=>a+b,0)-scale)<0.0001);
 return {matched:true,verified:terminal&&hasPayout,keys:keys.slice(0,35),explicit,
    reason:terminal&&!hasPayout?'terminal_without_valid_payout_vector':null};
}
function lotLedger(events,token){
 const sorted=events.filter(e=>String(e.token_id||'')===token).sort((a,b)=>
    Number(a.timestamp||0)-Number(b.timestamp||0));
 const lots=[],anomalies=new Set();
 let buys=0,sells=0,redemptions=0,structural=0,partialExits=0,matchedShares=0,
     spent=0,received=0,realized=0,totalIn=0,totalOut=0,unmatchedShares=0,
     unknown=0,duplicateSignatures=0;
 const signatures=new Set();
 for(const e of sorted){
  const type=String(e.type||'').toUpperCase(),side=String(e.side||'').toUpperCase();
  const size=finite(e.size),usdc=finite(e.usdc_size);
  const sig=[type,side,e.transaction_hash,e.timestamp,e.size,e.usdc_size].join('|');
  if(signatures.has(sig))duplicateSignatures++;else signatures.add(sig);
  if(type==='TRADE'&&side==='BUY'){
    if(size===null||size<=0||usdc===null||usdc<0){anomalies.add('invalid_buy');continue;}
    lots.push({shares:size,cost:usdc,initial:size});spent+=usdc;totalIn+=size;buys++;continue;
  }
  if((type==='TRADE'&&side==='SELL')||type==='REDEEM'){
    if(size===null||size<=0||usdc===null||usdc<0){anomalies.add('invalid_exit');continue;}
    if(type==='REDEEM')redemptions++;else sells++;
    // FIFO cost basis, pro-rate exit proceeds for the matched shares.
    let left=size,matched=0,costBasis=0;
    for(const lot of lots){
      if(left<=1e-7)break;
      if(lot.shares<=1e-7)continue;
      const take=Math.min(left,lot.shares);
      const basis=lot.cost*(take/lot.shares);
      lot.shares-=take;lot.cost-=basis;
      left-=take;matched+=take;costBasis+=basis;
    }
    if(left>1e-5){unmatchedShares+=left;anomalies.add('exit_without_observed_buy');}
    matchedShares+=matched;
    const attributedProceeds=size>0?usdc*(matched/size):0;
    realized+=attributedProceeds-costBasis;
    received+=usdc;totalOut+=size;
    const remainder=lots.reduce((s,l)=>s+l.shares,0);
    if(type==='TRADE'&&remainder>1e-5)partialExits++;
    continue;
  }
  if(['SPLIT','MERGE','CONVERSION','CONVERT','COMPRESS','WRAP','UNWRAP'].includes(type)){
    structural++;anomalies.add('structural_conversion_requires_basis_allocation');continue;
  }
  unknown++;anomalies.add('unmodeled_'+(type||'unknown'));
 }
 const remaining=lots.reduce((s,l)=>s+l.shares,0),remainingBasis=lots.reduce((s,l)=>s+l.cost,0);
 return {
   buys,sells,redemptions,partial_exits:partialExits,structural,unknown,
   duplicate_signatures:duplicateSignatures,
   matched_exit_shares:rnd(matchedShares),unmatched_exit_shares:rnd(unmatchedShares),
   remaining_shares:rnd(remaining),remaining_cost_basis_usdc:rnd(remainingBasis),
   observed_cash_in_usdc:rnd(received),observed_cash_out_usdc:rnd(spent),
   fifo_realized_pnl_usdc:rnd(realized),
   anomalies:[...anomalies],
   complete_accounting:anomalies.size===0&&duplicateSignatures===0,
 };
}
function auditCondition(conditions,activity,resolution,positionRows,wallet){
 const pos=positionRows.filter(p=>p.condition===conditions.condition);
 const byToken=new Map();
 for(const p of pos)byToken.set(p.token,p);
 const eventTokens=new Set(activity.data.map(x=>String(x.token_id||'')).filter(validToken));
 for(const p of pos)eventTokens.add(p.token);
 const tokens=[];
 let matched=0,matchFailures=0,partials=0,redeemEvents=0,unmatched=0;
 const types={};
 for(const row of activity.data){
  const type=String(row.type||'UNKNOWN').toUpperCase();types[type]=(types[type]||0)+1;
 }
 for(const token of [...eventTokens].slice(0,8)){
   const computed=lotLedger(activity.data,token);
   const snapshot=byToken.get(token)||null;
   const snapshotsForToken=pos.filter(x=>x.token===token);
   const held=snapshotsForToken.find(x=>x.status!=='CLOSED'&&x.current_size!==null);
   const expected=held?held.current_size:0;
   const delta=Math.abs(computed.remaining_shares-expected);
   const sharesVerified=activity.complete&&computed.complete_accounting&&delta<=0.02+expected*0.001;
   if(sharesVerified)matched++;else matchFailures++;
   partials+=computed.partial_exits;redeemEvents+=computed.redemptions;
   unmatched+=computed.unmatched_exit_shares;
   tokens.push({
    token:token.slice(0,12)+'...',snapshot_status:snapshot?snapshot.status:'no_snapshot',
    snapshot_rows:snapshotsForToken.length,expected_current_shares:rnd(expected),
    residual_delta_shares:rnd(delta),share_reconciliation_pass:sharesVerified,
    ledger:computed
   });
 }
 return {
   condition:conditions.condition,reason:conditions.reason,activity_pages:activity.pages,
   activity_complete:activity.complete,activity_failure:activity.why,
   activity_rows:activity.data.length,activity_type_counts:types,
   resolution:resolution,positions_sampled:pos.length,
   token_ledgers:tokens,matched_token_lots:matched,unmatched_token_lots:matchFailures,
   partial_exits:partials,redemption_events:redeemEvents,unmatched_exit_shares:rnd(unmatched),
   quality_score:'WITHHELD',
 };
}
async function auditWallet(name,wallet){
 const views={};
 for(const status of ['REDEEMABLE_LOST','OPEN','CLOSED']){
   const view=await pages('/v2/positions',{
      user:wallet,status,limit:MAX_POSITIONS_PER_VIEW,
      sort_by:'TIMESTAMP',sort_direction:'DESC',
      ...(status==='CLOSED'?{}:{include_archived:true})
   },1);
   views[status]=view;
 }
 const picked=selectConditions(views);
 const results=[];
 for(const item of picked){
  const cond=item.condition;
  let activity=await pages('/v2/activity',{
     user:wallet,condition:cond,start:1,limit:PAGE_LIMIT,
     sort_by:'TIMESTAMP',sort_direction:'ASC'
  },MAX_ACTIVITY_PAGES);
  // Filter any API cohort spillover; fail closed rather than silently use it.
  const mismatches=activity.data.filter(x=>
    String(x.proxy_wallet||'').toLowerCase()!==wallet||
    String(x.condition_id||'').toLowerCase()!==cond).length;
  if(mismatches){activity.complete=false;activity.why='wallet_condition_mismatch_'+mismatches;}
  let resolution={matched:false,verified:false,reason:'not_requested'};
  try{
   const r=await get('/v2/resolutions',{condition:cond});
   resolution=summarizeResolution(r.data,cond);
  }catch(e){resolution={matched:false,verified:false,reason:'resolution_api_'+String(e.message||e)};}
  const positionRows=[];
  for(const status of ['OPEN','CLOSED']){
   // Condition-anchored position snapshot, independently of recent-list limits.
   const v=await pages('/v2/positions',{
     user:wallet,condition:cond,status,limit:100,
     ...(status==='CLOSED'?{}:{include_archived:true})
   },3);
   if(!v.complete){activity.complete=false;activity.why='position_snapshot_incomplete_'+status;}
   for(const raw of v.data){
    const p=simplifiedPosition(raw);
    if(p){p.status=status;positionRows.push(p);}
   }
  }
  const outcome=auditCondition(item,activity,resolution,positionRows,wallet);
  results.push(outcome);
  console.log('CONDITION_AUDIT '+JSON.stringify({
    wallet,name,condition:cond,selection:item.reason,activity_rows:outcome.activity_rows,
    pages:outcome.activity_pages,activity_complete:outcome.activity_complete,
    activity_failure:outcome.activity_failure,activity_types:outcome.activity_type_counts,
    resolution:outcome.resolution,
    token_lots:outcome.token_ledgers, matched_token_lots:outcome.matched_token_lots,
    failed_token_lots:outcome.unmatched_token_lots,partial_exits:outcome.partial_exits,
    redemption_events:outcome.redemption_events,
  }));
 }
 const summary={
   wallet,name,selected_conditions:results.length,
   activity_complete_conditions:results.filter(x=>x.activity_complete).length,
   resolved_with_verified_payout:results.filter(x=>x.resolution.verified).length,
   total_activity_rows:results.reduce((n,x)=>n+x.activity_rows,0),
   matched_token_lots:results.reduce((n,x)=>n+x.matched_token_lots,0),
   unmatched_token_lots:results.reduce((n,x)=>n+x.unmatched_token_lots,0),
   partial_exit_matches:results.reduce((n,x)=>n+x.partial_exits,0),
   redemption_events:results.reduce((n,x)=>n+x.redemption_events,0),
   snapshot_page_limits:Object.fromEntries(Object.entries(views).map(([k,v])=>[k,!v.complete])),
   score:'WITHHELD: targeted sample, not full fills and all-category wallet history',
 };
 console.log('WALLET_LOT_AUDIT '+JSON.stringify(summary));
 return summary;
}
async function main(){
 console.log('READ_ONLY_LOT_AUDIT_STARTED='+new Date().toISOString());
 console.log('COHORT=2026-11-06_fixed_eight');
 const results=[];
 for(const [name,wallet] of WALLETS){
  try{results.push(await auditWallet(name,wallet));}
  catch(e){console.log('WALLET_LOT_ERROR '+JSON.stringify({name,wallet,error:String(e.message||e)}));}
 }
 console.log('LOT_AUDIT_SUMMARY '+JSON.stringify({
  wallets_targeted:WALLETS.length,wallets_audited:results.length,
  sampled_conditions:results.reduce((n,x)=>n+x.selected_conditions,0),
  history_complete_conditions:results.reduce((n,x)=>n+x.activity_complete_conditions,0),
  sampled_activity_rows:results.reduce((n,x)=>n+x.total_activity_rows,0),
  matched_token_lots:results.reduce((n,x)=>n+x.matched_token_lots,0),
  unmatched_token_lots:results.reduce((n,x)=>n+x.unmatched_token_lots,0),
  partial_exit_matches:results.reduce((n,x)=>n+x.partial_exit_matches,0),
  redemption_events:results.reduce((n,x)=>n+x.redemption_events,0),
  verified_resolution_payouts:results.reduce((n,x)=>n+x.resolved_with_verified_payout,0),
  wallet_quality_scores:'WITHHELD',
  caveats:['targeted markets only; 100k+ positions not individually reconstructed',
           'activity can have identical tx/amount rows without a unique event ID',
           'SPLIT/MERGE/CONVERSION require nontrivial cost basis',
           'held/closed overlapping history must not be added twice',
           'public market resolution state may lack token-level payout evidence']
 }));
 console.log('AUDIT_RESULT='+ (results.length===WALLETS.length?'ALL_EIGHT_SAMPLED':'PARTIAL'));
 if(results.length!==WALLETS.length)process.exitCode=2;
}
module.exports={lotLedger,summarizeResolution,simplifiedPosition,selectConditions};
if(require.main===module)main().catch(e=>{
 console.error('AUDIT_RESULT=FAILED '+String(e.message||e));process.exitCode=1;
});
