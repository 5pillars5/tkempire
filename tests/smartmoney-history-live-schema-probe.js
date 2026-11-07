'use strict';
const condition='0x197b6683dfa66ae2721066584357219ab8f4154b7b4574fa7db7a00fc40fd9fe';
async function probe(p,params){
 const u=new URL(p,'https://data-api.polymarket.com');for(const [k,v] of Object.entries(params))u.searchParams.set(k,String(v));
 const r=await fetch(u,{headers:{Accept:'application/json'},signal:AbortSignal.timeout(13000)});
 const data=await r.json().catch(()=>null);
 const row=Array.isArray(data?.data)?data.data[0]:data?.data;
 console.log('SCHEMA_PROBE '+JSON.stringify({path:p,http:r.status,envelope_keys:Object.keys(data||{}),
   row_type:Array.isArray(row)?'array':typeof row,row_keys:row&&typeof row==='object'?Object.keys(row):[],
   row:row&&typeof row==='object'?JSON.stringify(row).slice(0,2000):row
 }));
}
(async()=>{await probe('/v2/tokens',{condition});await probe('/v2/resolutions',{condition});})().catch(e=>{console.error('SCHEMA_PROBE_ERROR '+e.message);process.exitCode=1;});
