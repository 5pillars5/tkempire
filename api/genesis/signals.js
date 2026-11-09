'use strict';
// Public, read-only Genesis PAPER projection; never forward raw source objects.
const UPSTREAM='https://api.tkempire.io/internal/genesis/signals';
const STAGES=new Set(['DETECTED','QUALIFIED','REJECTED','EXPIRED','PAPER_OPEN','PAPER_CLOSED']);
const REASONS=new Set(['CHECKS_PASSED','CONFIDENCE_TOO_LOW','RISK_LIMIT','MEMORY_BLOCK','MARKET_DATA_STALE','ENTRY_NOT_TRIGGERED','OTHER']);
const ISO=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/;
function send(res,code,body){
  res.setHeader('Cache-Control','no-store, max-age=0');
  res.setHeader('X-Content-Type-Options','nosniff');
  return res.status(code).json({schema_version:1,...body});
}
function at(v,now,maxAge){
  if(typeof v!=='string'||!ISO.test(v))return null;
  const t=Date.parse(v),age=now-t;
  return Number.isFinite(t)&&age>=-30000&&age<=maxAge?new Date(t).toISOString():null;
}
function price(v){
  return typeof v==='number'&&Number.isFinite(v)&&v>0&&v<=1e9?Number(v.toFixed(8)):null;
}
function signal(s,now){
  if(!s||typeof s!=='object'||Array.isArray(s)||
    typeof s.id!=='string'||!/^[\w:-]{8,96}$/.test(s.id)||
    typeof s.asset!=='string'||!/^[A-Z0-9]{2,15}$/.test(s.asset)||
    !['BUY','SELL'].includes(s.side)||!STAGES.has(s.stage))return null;
  const observed_at=at(s.observed_at,now,90*86400000);
  if(!observed_at)return null;
  const paper=['PAPER_OPEN','PAPER_CLOSED'].includes(s.stage);
  if(paper&&s.position_evidence!=='CANONICAL_PAPER_LEDGER')return null;
  const confidence=typeof s.confidence==='number'&&Number.isFinite(s.confidence)&&s.confidence>=0&&s.confidence<=100?
    Number(s.confidence.toFixed(2)):null;
  // Closed paper outcomes require an additional canonical close attestation,
  // a verified close price/time and a signed realized amount with explicit unit.
  // A missing position is NEVER converted to a "closed" trade on this website.
  let close=null;
  if(s.stage==='PAPER_CLOSED'){
    if(s.close_evidence!=='CANONICAL_CLOSED_PAPER_LEDGER')return null;
    const closed_at=at(s.closed_at,now,90*86400000);
    const exit_price=price(s.exit_price);
    const entry_price=price(s.trigger);
    if(!closed_at||!exit_price||!entry_price||
      Date.parse(closed_at)<Date.parse(observed_at)||
      typeof s.realized_pnl!=='number'||!Number.isFinite(s.realized_pnl)||
      Math.abs(s.realized_pnl)>1e9||
      !['PAPER_UNITS','SIMULATED_USDC'].includes(s.pnl_unit))return null;
    const close_reason=['TAKE_PROFIT','STOP_LOSS','TRAILING_STOP','TIME_EXIT','OTHER']
      .includes(s.close_reason)?s.close_reason:'OTHER';
    close={closed_at,exit_price,realized_pnl:Number(s.realized_pnl.toFixed(8)),
      pnl_unit:s.pnl_unit,close_reason,
      result:s.realized_pnl>0?'WIN':s.realized_pnl<0?'LOSS':'BREAKEVEN'};
  }
  return {id:s.id,asset:s.asset,side:s.side,stage:s.stage,observed_at,confidence,
    trigger:price(s.trigger),stop_loss:price(s.stop_loss),target:price(s.target),
    reason_code:REASONS.has(s.reason_code)?s.reason_code:'OTHER',
    paper_position_verified:paper,...(close||{})};
}
module.exports=async function publicSignals(req,res){
  if(req.method!=='GET'){res.setHeader('Allow','GET');return send(res,405,{status:'method_not_allowed',signals:[]});}
  if(process.env.GENESIS_SIGNALS_PUBLICATION_ENABLED!=='true')
    return send(res,503,{status:'publication_disabled',signals:[]});
  if(process.env.GENESIS_STATUS_URL!=='https://api.tkempire.io/internal/genesis/health')
    return send(res,503,{status:'not_configured',signals:[]});
  const token=process.env.GENESIS_STATUS_TOKEN;
  const username=process.env.GENESIS_STATUS_USERNAME||'tkempire-site';
  if(typeof token!=='string'||token.length<32||token.length>256||/[\r\n]/.test(token)||
    !['tkempire-site','tkempire-prod'].includes(username))
    return send(res,503,{status:'not_configured',signals:[]});
  try{
    const authorization='Basic '+Buffer.from(username+':'+token,'utf8').toString('base64');
    const response=await fetch(UPSTREAM,{method:'GET',redirect:'error',cache:'no-store',
      headers:{Accept:'application/json',Authorization:authorization},signal:AbortSignal.timeout(4000)});
    if(!response.ok)return send(res,502,{status:'upstream_unavailable',signals:[]});
    if(Number(response.headers.get('content-length'))>65536)
      return send(res,502,{status:'invalid_response',signals:[]});
    const raw=await response.text();
    if(Buffer.byteLength(raw,'utf8')>65536)
      return send(res,502,{status:'invalid_response',signals:[]});
    const data=JSON.parse(raw),now=Date.now();
    if(!data||data.schema_version!==1||data.source!=='GENESIS_PUBLIC_SIGNAL_PROJECTION'||
      data.publication_scope!=='PUBLIC_APPROVED'||data.execution_authority!=='none'||
      String(data.engine?.mode).toLowerCase()!=='paper'||typeof data.engine?.running!=='boolean'||
      !Array.isArray(data.signals)||data.signals.length>80)
      return send(res,503,{status:'publication_disabled',signals:[]});
    const generated_at=at(data.generated_at,now,120000);
    if(!generated_at)return send(res,503,{status:'stale',signals:[]});
    const seen=new Set(),signals=[];
    for(const row of data.signals){const item=signal(row,now);
      if(item&&!seen.has(item.id)){seen.add(item.id);signals.push(item);}}
    signals.sort((a,b)=>b.observed_at.localeCompare(a.observed_at));
    return send(res,200,{status:'ok',source:'GENESIS_PUBLIC_SIGNAL_PROJECTION',
      generated_at,mode:'PAPER',engine_running:data.engine.running,execution_authority:'none',
      signals:signals.slice(0,50),disclosure:'PAPER_RESEARCH_ONLY_NOT_ORDERS'});
  }catch{return send(res,502,{status:'upstream_unavailable',signals:[]});}
};
