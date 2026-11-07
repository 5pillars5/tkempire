'use strict';
/*
 * Genesis Smart Money Flow — read-only public API.
 * Mirrors the current weekly crypto leaderboard selection used by smart-money-signals.
 * Never returns theoretical win probabilities, orders, wallet scores or inferred trades.
 */
const {normalizeWallets}=require('./smart-money-core');
const {buildFlowSnapshot}=require('./smart-money-flow-core');
const ORIGIN='https://data-api.polymarket.com';
const FETCH_CAP=400000, WALLET_LIMIT=8, EVENT_LIMIT=70;
const respond=(res,status,body)=>{
 res.setHeader('X-Content-Type-Options','nosniff');
 res.setHeader('Cache-Control',status===200?'public, s-maxage=35, max-age=0, stale-while-revalidate=10':'no-store');
 return res.status(status).json(body);
};
async function load(path,params){
 const url=new URL(path,ORIGIN);
 for(const [k,v] of Object.entries(params))url.searchParams.set(k,String(v));
 const r=await fetch(url,{method:'GET',redirect:'error',cache:'no-store',
  headers:{Accept:'application/json'},signal:AbortSignal.timeout(6500)});
 if(!r.ok)throw Error('UPSTREAM_HTTP_'+r.status);
 const size=Number(r.headers.get('content-length'));
 if(Number.isFinite(size)&&size>FETCH_CAP)throw Error('UPSTREAM_TOO_LARGE');
 const raw=await r.text();
 if(Buffer.byteLength(raw)>FETCH_CAP)throw Error('UPSTREAM_TOO_LARGE');
 const decoded=JSON.parse(raw);
 if(!decoded||!Array.isArray(decoded.data))throw Error('UPSTREAM_BAD_DATA');
 return decoded.data;
}
module.exports=async function(req,res){
 if(req.method!=='GET'){res.setHeader('Allow','GET');return respond(res,405,{status:'method_not_allowed'});}
 try{
  const ranking=await load('/v2/leaderboard',{time_period:'week',category:'crypto',sort_by:'PNL',limit:16});
  const wallets=normalizeWallets(ranking,WALLET_LIMIT);
  if(!wallets.length)throw Error('NO_WALLETS');
  const now=Math.floor(Date.now()/1000);
  const tasks=await Promise.allSettled(wallets.map(w=>load('/v2/activity',{
   user:w.wallet,type:'TRADE',limit:EVENT_LIMIT,start:now-86400,end:now,
   sort_by:'TIMESTAMP',sort_direction:'DESC'
  })));
  let successful_wallets=0,failed_wallets=0,truncated_wallets=0;
  const byWallet={};
  tasks.forEach((task,i)=>{
   if(task.status==='fulfilled'){
    successful_wallets++;byWallet[wallets[i].wallet]=task.value;
    if(task.value.length>=EVENT_LIMIT)truncated_wallets++;
   } else {failed_wallets++;}
  });
  if(successful_wallets===0)throw Error('NO_ACTIVITY_FEEDS');
  const model=buildFlowSnapshot(wallets,byWallet,now,{
   successful_wallets,failed_wallets,truncated_wallets
  });
  return respond(res,200,model);
 }catch(e){
  return respond(res,503,{
   schema_version:1,status:'unavailable',generated_at:new Date().toISOString(),
   execution_enabled:false,genesis_execution_authority:'none',
   prediction_model_status:'NOT_TRAINED_OR_CALIBRATED',
   markets:[],wallets_selected:0,events_sampled:0,
   error:'Public market-flow evidence unavailable; no values inferred.'
  });
 }
};
