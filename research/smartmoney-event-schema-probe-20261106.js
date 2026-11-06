'use strict';
// Public API schema probe; fixed eight affected markets, no secrets/trading.
const {conditions}=require('./data/smartmoney-fixed-cohort-32-markets-20261106.json');
const targets=conditions.filter(c=>c.original_failed_token_lots>0);
async function get(path,params){
 const u=new URL(path,'https://data-api.polymarket.com');
 for(const [k,v] of Object.entries(params))u.searchParams.set(k,String(v));
 let r=await fetch(u,{signal:AbortSignal.timeout(17000),headers:{Accept:'application/json'},redirect:'error'});
 if(!r.ok)throw Error(path+' HTTP '+r.status);
 const j=await r.json();if(!j||!Array.isArray(j.data))throw Error('bad_envelope_'+path);
 return j;
}
const val=(x)=>JSON.stringify(x).slice(0,3500);
async function main(){
 for(const c of targets){
  console.log('TARGET '+JSON.stringify({name:c.name,wallet:c.wallet,condition:c.condition,prior_unmatched:c.original_failed_token_lots}));
  try{
   const act=await get('/v2/activity',{user:c.wallet,condition:c.condition,limit:1000,sort_by:'TIMESTAMP',sort_direction:'ASC'});
   const by={};for(const e of act.data){const k=e.type||'UNKNOWN';by[k]??=[];if(by[k].length<2)by[k].push(e)}
   for(const [type,examples]of Object.entries(by))for(const e of examples)console.log('ACTIVITY_EXAMPLE '+JSON.stringify({wallet:c.wallet,condition:c.condition,type,event:e}));
   const positions=await get('/v2/positions',{user:c.wallet,condition:c.condition,status:'CLOSED',limit:100});
   console.log('POSITION_EXAMPLE '+JSON.stringify({condition:c.condition,item:positions.data[0]||null}));
   const resolution=await get('/v2/resolutions',{condition:c.condition});
   console.log('RESOLUTION_EXAMPLE '+JSON.stringify({condition:c.condition,item:resolution.data[0]||null}));
  }catch(e){console.log('PROBE_ERROR '+JSON.stringify({condition:c.condition,error:String(e.message||e)}))}
 }
}
main().catch(e=>{console.error('FATAL '+String(e));process.exitCode=1});
