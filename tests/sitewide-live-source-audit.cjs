'use strict';
// Production READ-ONLY availability and schema census. Never print personal wallets, trade IDs or source JSON.
const BASE='https://www.tkempire.io';
const pages=['/','/app.html','/dashboard.html','/genesis-signals.html','/results.html','/research.html','/portfolio.html','/testnet.html','/smart-money-signals.html','/smart-money.html','/smart-money-flow.html','/smart-money-market.html','/learn.html','/recovery.html','/community.html','/join.html','/about.html'];
const apis=['/api/health','/api/genesis/status','/api/genesis/signals','/api/genesis/trade-history?page=1','/api/genesis/closed-trades','/api/smart-money-signals','/api/smart-money-watch','/api/smart-money-flow','/api/smart-money-history','/api/smart-money-legacy-history'];
const okCode=new Set([200,400,401,403,404,405,502,503]);
const errs=[];
const age=v=>{if(typeof v!=='string')return null;const n=Date.parse(v);return Number.isFinite(n)?Math.round((Date.now()-n)/1000):null};
async function req(path,method='GET'){
 const url=BASE+path;
 try{
   const r=await fetch(url,{method,cache:'no-store',redirect:'error',signal:AbortSignal.timeout(14000),headers:{Accept:'application/json, text/html'}});
   const contentType=(r.headers.get('content-type')||'').split(';')[0];
   if(!okCode.has(r.status))errs.push('UNEXPECTED_HTTP_'+path+'_'+r.status);
   const text=await r.text();
   if(path.startsWith('/api/')){
    let d=null;try{d=JSON.parse(text)}catch{}
    if(!d||typeof d!=='object'||Array.isArray(d)){errs.push('NON_JSON_API_'+path);return}
    const record={
      path,method,http:r.status,status:typeof d.status==='string'?d.status.slice(0,45):null,
      source:typeof d.source==='string'?d.source.slice(0,80):null,
      schema:d.schema_version||null,age_s:age(d.updated_at||d.served_at||d.generated_at),
      mode:typeof d.engine?.mode==='string'?d.engine.mode:(typeof d.mode==='string'?d.mode:null),
      signals:Array.isArray(d.signals)?d.signals.length:null
    };
    // Performance is the PUBLIC AGGREGATE ONLY. Never print private ledger fields.
    if(path==='/api/genesis/status'&&r.ok){
      const p=d.performance||{};
      record.paper_trades=p.trades;record.wins=p.wins;record.losses=p.losses;
      record.breakeven=Number.isSafeInteger(p.trades)&&Number.isSafeInteger(p.wins)&&Number.isSafeInteger(p.losses)?p.trades-p.wins-p.losses:null;
      record.win_rate=p.win_rate;record.performance_source=d.performance_source;
      if(p.wins+p.losses>p.trades)errs.push('INVALID_AGGREGATE_TOTALS');
      if(d.engine?.mode!=='paper')errs.push('STATUS_NOT_PAPER');
    }
    if(path==='/api/health'&&r.ok){
      record.reported_open=d.open_trades?.count;
      if(d.engine?.mode!=='paper')errs.push('HEALTH_NOT_PAPER');
    }
    console.log('API_AUDIT',JSON.stringify(record));
   }else{
    console.log('PAGE_AUDIT',JSON.stringify({path,http:r.status,type:contentType,title:(text.match(/<title[^>]*>([^<]+)<\/title>/i)||[])[1]||null}));
    if(r.status!==200||!/<html[\s>]/i.test(text))errs.push('PAGE_NOT_READY_'+path);
   }
 }catch(e){console.log('AUDIT_UNAVAILABLE',path,String(e.message||e).slice(0,120));errs.push('UNAVAILABLE_'+path)}
}
(async()=>{
 for(const path of pages)await req(path);
 for(const path of apis)await req(path);
 console.log('AUDIT_FINISHED pages='+pages.length+' apis='+apis.length+' errors='+errs.join('|'));
 if(errs.length)process.exitCode=1;
})().catch(e=>{console.error('AUDIT_INTERNAL_ERROR',String(e.message));process.exitCode=1});
