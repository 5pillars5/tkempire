'use strict';
// Read-only Indexed Polygon history provider verification. No orders or private data.
const ORIGIN='https://api.routescan.io';
const API='https://data-api.polymarket.com';
const CTF='0x4d97dcd97ec945f40cf65f87097ace5ea0476045';
const CASES=[
 {name:'Spirit historic 2028 nomination',wallet:'0x0c0e270cf879583d6a0142fc817e05b768d0434e',condition:'0xe50c71cc5e2372bf0f6194a02e51459dd03b2c7b2d78a0d4650e5f36c425338b',token:'48455736546094517370011063312529885328905072240106316551156607253162886762655'},
 {name:'Spirit 2026 resolved',wallet:'0x0c0e270cf879583d6a0142fc817e05b768d0434e',condition:'0x998bc71817b2d76921d1999ce0f3431cfd5945583667a371280ca2b430b0c06e',token:null},
 {name:'Papeasy 5m control',wallet:'0x111f73e91f85b6fe4de1ddec3de2fe32122e355b',condition:'0x197b6683dfa66ae2721066584357219ab8f4154b7b4574fa678e334a7f54b33b0',token:null}
];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function get(url){
 for(let retry=0;retry<3;retry++){
  let res;
  try {res=await fetch(url,{method:'GET',redirect:'error',headers:{accept:'application/json'},
     signal:AbortSignal.timeout(18000)});}catch(e){
     if(retry===2)throw Error('network_'+String(e.message||e));await sleep(900*(retry+1));continue;
  }
  if([429,500,502,503].includes(res.status)){
   if(retry===2)throw Error('HTTP_'+res.status);
   await sleep(1200*(retry+1));continue;
  }
  if(!res.ok)throw Error('HTTP_'+res.status);
  if(new URL(res.url).hostname!==new URL(url).hostname)throw Error('unexpected_redirect');
  const s=await res.text();if(s.length>1500000)throw Error('oversized_response');
  return JSON.parse(s);
 }
}
async function identify(item){
 if(item.token)return item.token;
 const u=new URL('/v2/activity',API);
 u.searchParams.set('user',item.wallet);u.searchParams.set('condition',item.condition);
 u.searchParams.set('start','1');u.searchParams.set('sort_by','TIMESTAMP');
 u.searchParams.set('sort_direction','ASC');u.searchParams.set('limit','20');
 const doc=await get(u);
 if(!Array.isArray(doc.data))throw Error('activity_missing');
 const tokens=[...new Set(doc.data.filter(x=>String(x.condition_id||'').toLowerCase()===item.condition
     &&/^[0-9]+$/.test(String(x.token_id||''))).map(x=>String(x.token_id)))];
 if(!tokens.length)throw Error('no_token_ids');
 console.log('IDENTIFIED_PUBLIC_TOKENS '+JSON.stringify({case_name:item.name,tokens}));
 return tokens[0];
}
async function check(item){
 const token=await identify(item);
 const roots=[
  '/v2/network/mainnet/evm/137/address/'+item.wallet+'/erc1155-transfers',
  '/v2/network/mainnet/evm/137/erc1155-transfers'
 ];
 for(let k=0;k<roots.length;k++){
  const u=new URL(roots[k],ORIGIN);
  u.searchParams.set('sort','asc');
  u.searchParams.set('limit','10');
  if(k===1){
    u.searchParams.set('tokenAddress',CTF);
    u.searchParams.set('tokenId',token);
    u.searchParams.set('timestampFrom','2025-01-01T00:00:00Z');
    u.searchParams.set('timestampTo','2026-11-07T00:00:00Z');
  }
  try{
    const d=await get(u);
    if(!Array.isArray(d.items)||!d.link||typeof d.link!=='object')
       throw Error('unexpected_routescan_shape_'+JSON.stringify(Object.keys(d)));
    console.log('INDEXED_PROBE '+JSON.stringify({
      provider:'Routescan',case_name:item.name,route:k===0?'address_transfers':'token_transfers',
      wallet:item.wallet,token,
      returned:d.items.length,
      next_present:Boolean(d.link.next||d.link.nextToken),
      pagination_keys:Object.keys(d.link),
      rows:d.items.slice(0,3).map(x=>({
        chainId:x.chainId,blockNumber:x.blockNumber,txHash:x.txHash,
        logIndex:x.logIndex,from:x.from,to:x.to,amount:x.amount,
        tokenAddress:x.tokenAddress,tokenId:x.tokenId,timestamp:x.timestamp
      }))
    }));
  }catch(e){
    console.log('INDEXED_PROBE_ERROR '+JSON.stringify({
      provider:'Routescan',case_name:item.name,route:k===0?'address_transfers':'token_transfers',
      error:String(e.message||e)}));
  }
  await sleep(700);
 }
}
(async()=>{
 for(const item of CASES)await check(item);
 console.log('INDEXED_ARCHIVAL_PROBE_COMPLETE');
})().catch(e=>{console.error('INDEXED_ARCHIVAL_PROBE_FAILED '+String(e.message||e));process.exitCode=1});
