'use strict';
/*
 * Bounded public Wallet Watch history readback. Never accesses Telegram,
 * private credentials, Genesis runtime or trading services.
 */
const zlib=require('node:zlib');
const crypto=require('node:crypto');
const {validateArchive}=require('../ops/wallet-watch-history-v1/history-core');
const ORIGIN='https://raw.githubusercontent.com/5pillars5/tkempire/main/data/wallet-watch-history-v1/';
const ADDRESS=/^0x[a-f0-9]{40}$/i;
const MAX_COMPRESSED=950000,MAX_INFLATED=15000000;
const reply=(res,code,data)=>{
  res.setHeader('Content-Type','application/json; charset=utf-8');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Cache-Control',code===200?'public,max-age=0,s-maxage=60':'no-store');
  return res.status(code).json(data);
};
const dayAt = ms => new Date(ms).toISOString().slice(0,10);
async function readDay(day){
  const u=new URL(day+'.json.gz',ORIGIN);
  const r=await fetch(u,{redirect:'error',cache:'no-store',
    headers:{Accept:'application/octet-stream'},signal:AbortSignal.timeout(8000)});
  if(r.status===404)return null;
  if(!r.ok)throw Error('ARCHIVE_UPSTREAM_'+r.status);
  const len=Number(r.headers.get('content-length'));
  if(Number.isFinite(len)&&len>MAX_COMPRESSED)throw Error('ARCHIVE_COMPRESSED_OVER_LIMIT');
  const raw=Buffer.from(await r.arrayBuffer());
  if(raw.length>MAX_COMPRESSED)throw Error('ARCHIVE_COMPRESSED_OVER_LIMIT');
  const decoded=zlib.gunzipSync(raw,{maxOutputLength:MAX_INFLATED});
  return validateArchive(JSON.parse(decoded.toString('utf8')),day);
}
module.exports=async(req,res)=>{
  if(req.method!=='GET'){res.setHeader('Allow','GET');return reply(res,405,{status:'method_not_allowed'});}
  const days=Number(req.query?.days??3),limit=Number(req.query?.limit??60);
  const wallet=String(req.query?.wallet||'').toLowerCase();
  if(!Number.isInteger(days)||days<1||days>7||
     !Number.isInteger(limit)||limit<1||limit>100||
     (wallet&&!ADDRESS.test(wallet)))return reply(res,400,{status:'invalid_query'});
  try{
    const now=Date.now();
    const range=Array.from({length:days},(_,i)=>dayAt(now-86400000*i));
    const reads=await Promise.allSettled(range.map(readDay));
    if(reads.every(x=>x.status==='rejected'))throw Error('ARCHIVE_UNAVAILABLE');
    const coverage=[];
    const dedup=new Map();
    for(let i=0;i<range.length;i++){
      const state=reads[i];
      const archive=state.status==='fulfilled'?state.value:null;
      coverage.push({day:range[i],status:state.status==='rejected'?'error':archive?'present':'missing'});
      if(!archive)continue;
      for(const e of archive.events){
        if(wallet&&e.wallet!==wallet)continue;
        const seen=dedup.get(e.id);
        if(seen&&seen.record_sha256!==e.record_sha256)throw Error('CROSS_DAY_CONFLICT');
        dedup.set(e.id,e);
      }
    }
    const rows=[...dedup.values()].sort((a,b)=>b.timestamp-a.timestamp||a.id.localeCompare(b.id));
    const status=coverage.some(x=>x.status==='error')?'degraded':coverage.every(x=>x.status==='missing')?'not_yet_archived':'ok';
    return reply(res,200,{
      schema_version:1,status,source:'GITHUB_PUBLIC_WALLET_WATCH_ARCHIVE',
      wallet:wallet||null,requested_days:days,available_days:coverage.filter(x=>x.status==='present').length,
      date_coverage:coverage,observed_events:rows.length,returned:Math.min(rows.length,limit),
      incomplete:true,
      limit,
      newest_observed_trade_at:rows.length?new Date(rows[0].timestamp*1000).toISOString():null,
      execution_authority:'none',
      limitations:'Observed public trades only. Gaps, source delays, scan caps and missing archives are not zero trading activity.',
      rows:rows.slice(0,limit).map(e=>({
        id:e.id,wallet:e.wallet,side:e.side,market:e.market,outcome:e.outcome,
        amount_usdc:e.amount_usdc,timestamp:e.timestamp,event_slug:e.event_slug,
        tx_hash:e.tx_hash,first_observed_at:e.first_observed_at
      }))
    });
  }catch(_){
    return reply(res,503,{
      schema_version:1,status:'unavailable',source:'GITHUB_PUBLIC_WALLET_WATCH_ARCHIVE',
      execution_authority:'none',rows:[],date_coverage:[],
      message:'Historical evidence unavailable or unverified. No inferred transactions.'
    });
  }
};
module.exports._test={readDay};
