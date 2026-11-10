'use strict';
// Paginated, read-only, independently approved Genesis PAPER history.
// Never proxy raw canonical ledgers, credentials, position sizes or wallet identifiers.
const UPSTREAM='https://api.tkempire.io/internal/genesis/history';
const SOURCE='GENESIS_VERIFIED_PAPER_HISTORY_V1';
const TIME=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/;
const ID=/^[a-f0-9]{32}$/;
const SHA=/^[a-f0-9]{64}$/;
const ASSET=/^[A-Z0-9]{2,15}$/;
const ROW_KEYS=new Set(['id','asset','side','stage','observed_at','closed_at','trigger','exit_price','realized_pnl','pnl_unit','result','close_reason','position_evidence','close_evidence']);
const KEYS=new Set(['schema_version','source','publication_scope','execution_authority','generated_at','engine','pnl_unit','revision','page','page_size','verified_count','excluded_count','total_closed_count','has_more','closed_trades']);
function send(res,code,body){
  res.setHeader('Cache-Control','no-store, max-age=0');
  res.setHeader('X-Content-Type-Options','nosniff');
  return res.status(code).json({schema_version:1,...body});
}
function exact(value,keys){return value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(k=>keys.has(k));}
function count(v,max=20000){return Number.isSafeInteger(v)&&v>=0&&v<=max;}
function positive(v){return typeof v==='number'&&Number.isFinite(v)&&v>0&&v<=1e9;}
function pnl(v){return typeof v==='number'&&Number.isFinite(v)&&Math.abs(v)<=1e9;}
function time(v,now,ageLimit){
  if(typeof v!=='string'||!TIME.test(v))return false;
  const t=Date.parse(v);
  return Number.isFinite(t)&&t<=now+30000&&now-t>=0-30000&&now-t<=ageLimit;
}
function row(s,now){
  if(!exact(s,ROW_KEYS)||Object.keys(s).length!==ROW_KEYS.size||!ID.test(s.id||'')||
    !ASSET.test(s.asset||'')||!['BUY','SELL'].includes(s.side)||s.stage!=='PAPER_CLOSED'||
    s.position_evidence!=='CANONICAL_PAPER_LEDGER'||
    s.close_evidence!=='CANONICAL_CLOSED_PAPER_LEDGER'||
    !time(s.observed_at,now,20*365*86400000)||!time(s.closed_at,now,20*365*86400000)||
    Date.parse(s.closed_at)<Date.parse(s.observed_at)||!positive(s.trigger)||
    !positive(s.exit_price)||!pnl(s.realized_pnl)||
    s.pnl_unit!=='LEDGER_UNIT_UNVERIFIED'||s.close_reason!=='OTHER'||
    !['WIN','LOSS','BREAKEVEN'].includes(s.result)||
    (s.realized_pnl>0&&s.result!=='WIN')||
    (s.realized_pnl<0&&s.result!=='LOSS')||
    (s.realized_pnl===0&&s.result!=='BREAKEVEN'))return null;
  return {...Object.fromEntries([...ROW_KEYS].map(k=>[k,s[k]])),paper_position_verified:true};
}
module.exports=async function tradeHistory(req,res){
  if(req.method!=='GET'){res.setHeader('Allow','GET');return send(res,405,{status:'method_not_allowed',closed_trades:[]});}
  if(process.env.GENESIS_HISTORY_PUBLICATION_ENABLED!=='true')
    return send(res,503,{status:'publication_disabled',closed_trades:[]});
  if(process.env.GENESIS_STATUS_URL!=='https://api.tkempire.io/internal/genesis/health')
    return send(res,503,{status:'not_configured',closed_trades:[]});
  const token=process.env.GENESIS_STATUS_TOKEN;
  const username=process.env.GENESIS_STATUS_USERNAME||'tkempire-site';
  if(typeof token!=='string'||token.length<32||token.length>256||/[\r\n]/.test(token)||
    !['tkempire-site','tkempire-prod'].includes(username))
    return send(res,503,{status:'not_configured',closed_trades:[]});
  const requestPage=String(req.query?.page??'1');
  if(!/^[1-9]\d{0,3}$/.test(requestPage)||Number(requestPage)>400)
    return send(res,400,{status:'invalid_page',closed_trades:[]});
  try{
    const response=await fetch(UPSTREAM+'?page='+requestPage,{
      method:'GET',redirect:'error',cache:'no-store',
      headers:{Accept:'application/json',Authorization:'Basic '+Buffer.from(username+':'+token,'utf8').toString('base64')},
      signal:AbortSignal.timeout(5000)});
    if(!response.ok)return send(res,502,{status:'upstream_unavailable',closed_trades:[]});
    if(Number(response.headers.get('content-length'))>65536)
      return send(res,502,{status:'upstream_invalid',closed_trades:[]});
    const raw=await response.text();
    if(Buffer.byteLength(raw,'utf8')>65536)
      return send(res,502,{status:'upstream_invalid',closed_trades:[]});
    const data=JSON.parse(raw),now=Date.now();
    if(!exact(data,KEYS)||Object.keys(data).length!==KEYS.size||
      data.schema_version!==1||data.source!==SOURCE||
      data.publication_scope!=='PUBLIC_APPROVED'||data.execution_authority!=='none'||
      data.engine?.mode!=='paper'||data.engine?.running!==true||
      data.pnl_unit!=='LEDGER_UNIT_UNVERIFIED'||!SHA.test(data.revision||'')||
      !time(data.generated_at,now,120000)||
      data.page!==Number(requestPage)||data.page_size!==50||
      !count(data.verified_count)||!count(data.excluded_count)||!count(data.total_closed_count)||
      data.verified_count+data.excluded_count!==data.total_closed_count||
      typeof data.has_more!=='boolean'||!Array.isArray(data.closed_trades)||
      data.closed_trades.length>50||
      data.closed_trades.length!==Math.max(0,Math.min(50,data.verified_count-50*(data.page-1)))||
      data.has_more!==(data.page*50<data.verified_count))
      return send(res,503,{status:'history_unverified',closed_trades:[]});
    const seen=new Set(),items=[];
    let latest=null;
    for(const rawRow of data.closed_trades){
      const item=row(rawRow,now);
      if(!item||seen.has(item.id)||(latest&&item.closed_at>latest))
        return send(res,503,{status:'history_rows_unverified',closed_trades:[]});
      seen.add(item.id);latest=item.closed_at;items.push(item);
    }
    return send(res,200,{status:'ok',source:SOURCE,generated_at:data.generated_at,
      execution_authority:'none',mode:'PAPER',revision:data.revision,
      pnl_unit:'LEDGER_UNIT_UNVERIFIED',page:data.page,page_size:50,
      verified_count:data.verified_count,excluded_count:data.excluded_count,
      total_closed_count:data.total_closed_count,has_more:data.has_more,
      closed_trades:items,disclosure:'PAPER_LEDGER_UNITS_UNVERIFIED_NOT_USD'});
  }catch{return send(res,502,{status:'upstream_unavailable',closed_trades:[]});}
};
