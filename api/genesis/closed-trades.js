'use strict';
// Public adapter for separately reconciled Genesis PAPER_CLOSED outcomes.
// It reads ONLY the existing authenticated /internal/genesis/signals endpoint;
// no trader keys, filesystem access, wallet writes, or execution methods.
const SOURCE='GENESIS_PUBLIC_SIGNAL_PROJECTION';
const UPSTREAM='https://api.tkempire.io/internal/genesis/signals';
const ISO=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/;
const ID=/^[0-9a-f]{32}$/;
const ASSET=/^[A-Z0-9]{2,15}$/;
const ROW_KEYS=new Set([
  'id','asset','side','stage','observed_at','trigger','stop_loss','target',
  'confidence','reason_code','position_evidence','close_evidence',
  'closed_at','exit_price','realized_pnl','pnl_unit','result','close_reason'
]);
function send(res,code,body){
  res.setHeader('Cache-Control','no-store, max-age=0');
  res.setHeader('X-Content-Type-Options','nosniff');
  return res.status(code).json({schema_version:1,...body});
}
function iso(v,now,retention){
  if(typeof v!=='string'||!ISO.test(v))return null;
  const ts=Date.parse(v),age=now-ts;
  return Number.isFinite(ts)&&age>=-30000&&age<=retention?new Date(ts).toISOString():null;
}
function number(v,allowZero=false){
  return typeof v==='number'&&Number.isFinite(v)&&
    (allowZero?Math.abs(v)<=1e9:v>0&&v<=1e9)?v:null;
}
function normalize(s,now){
  if(!s||typeof s!=='object'||Array.isArray(s)||Object.keys(s).some(k=>!ROW_KEYS.has(k))||
    s.stage!=='PAPER_CLOSED'||s.position_evidence!=='CANONICAL_PAPER_LEDGER'||
    s.close_evidence!=='CANONICAL_CLOSED_PAPER_LEDGER'||
    s.pnl_unit!=='LEDGER_UNIT_UNVERIFIED'||
    s.reason_code!=='CHECKS_PASSED'||s.close_reason!=='OTHER'||
    s.stop_loss!==null||s.target!==null||s.confidence!==null||
    typeof s.id!=='string'||!ID.test(s.id)||typeof s.asset!=='string'||!ASSET.test(s.asset)||
    !['BUY','SELL'].includes(s.side))return null;
  const observed_at=iso(s.observed_at,now,90*86400000);
  const closed_at=iso(s.closed_at,now,90*86400000);
  const trigger=number(s.trigger),exit_price=number(s.exit_price);
  const realized_pnl=number(s.realized_pnl,true);
  if(!observed_at||!closed_at||Date.parse(closed_at)<Date.parse(observed_at)||
    trigger===null||exit_price===null||realized_pnl===null||
    !['WIN','LOSS','BREAKEVEN'].includes(s.result)||(
      realized_pnl>0&&s.result!=='WIN'||realized_pnl<0&&s.result!=='LOSS'||
      realized_pnl===0&&s.result!=='BREAKEVEN'))return null;
  return {id:s.id,asset:s.asset,side:s.side,stage:'PAPER_CLOSED',
    paper_position_verified:true,observed_at,closed_at,trigger,exit_price,
    stop_loss:null,target:null,confidence:null,reason_code:'CHECKS_PASSED',
    close_reason:'OTHER',result:s.result,
    realized_pnl:Number(realized_pnl.toFixed(8)),pnl_unit:'LEDGER_UNIT_UNVERIFIED'};
}
module.exports=async function verifiedClosedTrades(req,res){
  if(req.method!=='GET'){res.setHeader('Allow','GET');
    return send(res,405,{status:'method_not_allowed',closed_trades:[]});}
  if(process.env.GENESIS_CLOSED_PUBLICATION_ENABLED!=='true')
    return send(res,503,{status:'publication_disabled',closed_trades:[]});
  if(process.env.GENESIS_STATUS_URL!=='https://api.tkempire.io/internal/genesis/health')
    return send(res,503,{status:'not_configured',closed_trades:[]});
  const token=process.env.GENESIS_STATUS_TOKEN;
  const username=process.env.GENESIS_STATUS_USERNAME||'tkempire-site';
  if(typeof token!=='string'||token.length<32||token.length>256||/[\r\n]/.test(token)||
    !['tkempire-site','tkempire-prod'].includes(username))
    return send(res,503,{status:'not_configured',closed_trades:[]});
  try{
    const response=await fetch(UPSTREAM,{method:'GET',redirect:'error',cache:'no-store',
      headers:{Accept:'application/json',
        Authorization:'Basic '+Buffer.from(username+':'+token,'utf8').toString('base64')},
      signal:AbortSignal.timeout(4500)});
    if(!response.ok)return send(res,502,{status:'upstream_unavailable',closed_trades:[]});
    if(Number(response.headers.get('content-length'))>65536)
      return send(res,502,{status:'upstream_invalid',closed_trades:[]});
    const raw=await response.text();
    if(Buffer.byteLength(raw,'utf8')>65536)
      return send(res,502,{status:'upstream_invalid',closed_trades:[]});
    const data=JSON.parse(raw),now=Date.now();
    if(!data||data.schema_version!==1||data.source!==SOURCE||
      data.publication_scope!=='PUBLIC_APPROVED'||data.execution_authority!=='none'||
      data.engine?.mode!=='paper'||data.engine?.running!==true||
      data.position_verification!=='verified'||
      !Array.isArray(data.closed_trades)||data.closed_trades.length>50)
      return send(res,503,{status:'closed_feed_unverified',closed_trades:[]});
    const generated_at=iso(data.generated_at,now,120000);
    if(!generated_at)return send(res,503,{status:'closed_feed_stale',closed_trades:[]});
    const seen=new Set(),out=[];
    for(const row of data.closed_trades){
      const item=normalize(row,now);
      if(!item||seen.has(item.id))
        return send(res,503,{status:'closed_rows_unverified',closed_trades:[]});
      seen.add(item.id);out.push(item);
    }
    out.sort((a,b)=>b.closed_at.localeCompare(a.closed_at));
    return send(res,200,{status:'ok',source:'GENESIS_VERIFIED_CLOSED_PAPER_PROJECTION',
      generated_at,mode:'PAPER',execution_authority:'none',pnl_unit:'LEDGER_UNIT_UNVERIFIED',
      closed_trades:out,disclosure:'RECORDED_PAPER_PNL_UNIT_UNVERIFIED_NOT_USD'});
  }catch{
    return send(res,502,{status:'upstream_unavailable',closed_trades:[]});
  }
};
