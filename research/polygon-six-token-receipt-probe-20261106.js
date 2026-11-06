'use strict';
/**
 * Read-only Polygon transaction receipt probe: eight markets containing
 * the six still-unreconciled outcome tokens. Does not sign, submit, or trade.
 */
const {conditions}=require('./data/smartmoney-fixed-cohort-32-markets-20261106.json');
const markets=conditions.filter(x=>x.original_failed_token_lots>0);
const API='https://data-api.polymarket.com';
const RPCS=['https://polygon-bor-rpc.publicnode.com','https://polygon-rpc.com'];
const CTF='0x4d97dcd97ec945f40cf65f87097ace5ea0476045';
const PUSD='0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb';
const SINGLE='0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62';
const BATCH='0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb';
const ERC20='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const fmt=(x)=>Number(x)/1e6;
function decodeLog(log) {
 const topics=log.topics||[],d=String(log.data||'0x').slice(2);
 const typ=String(topics[0]||'').toLowerCase();
 if(typ!==SINGLE&&typ!==BATCH&&typ!==ERC20)return null;
 const address=log.address.toLowerCase();
 const getAddress=t=>t&&t.length===66?'0x'+t.slice(-40).toLowerCase():null;
 const from=typ===ERC20?getAddress(topics[1]):getAddress(topics[2]);
 const to=typ===ERC20?getAddress(topics[2]):getAddress(topics[3]);
 if(typ===ERC20){
  if(d.length<64)return null;
  return {event:'ERC20',address,from,to,value:fmt(BigInt('0x'+d.slice(0,64))),
    logIndex:parseInt(log.logIndex,16),tx:log.transactionHash};
 }
 if(typ===SINGLE){
  if(d.length<128)return null;
  return {event:'TransferSingle',address,from,to,id:BigInt('0x'+d.slice(0,64)).toString(),
    value:fmt(BigInt('0x'+d.slice(64,128))),logIndex:parseInt(log.logIndex,16),
    tx:log.transactionHash};
 }
 // TransferBatch ABI: head offsets, dynamic arrays of ids and values.
 const word=i=>BigInt('0x'+d.slice(i*64,(i+1)*64));
 if(d.length<128)return null;
 const posIds=Number(word(0))/32, posValues=Number(word(1))/32;
 if(!Number.isSafeInteger(posIds)||!Number.isSafeInteger(posValues))return null;
 const n=Number(word(posIds)),m=Number(word(posValues));
 if(n!==m||n>400||n<0)return null;
 const ids=[],values=[];
 for(let k=0;k<n;k++){ids.push(word(posIds+1+k).toString());values.push(fmt(word(posValues+1+k)))}
 return {event:'TransferBatch',address,from,to,ids,values,logIndex:parseInt(log.logIndex,16),tx:log.transactionHash};
}
async function api(condition,wallet){
 const u=new URL('/v2/activity',API);u.searchParams.set('user',wallet);
 u.searchParams.set('condition',condition);u.searchParams.set('limit','1000');
 u.searchParams.set('start','1');u.searchParams.set('sort_by','TIMESTAMP');
 u.searchParams.set('sort_direction','ASC');
 const r=await fetch(u,{signal:AbortSignal.timeout(15000),headers:{Accept:'application/json'}});
 if(!r.ok)throw Error('activity_HTTP_'+r.status);
 const j=await r.json();if(!Array.isArray(j.data))throw Error('invalid_api');
 return j;
}
let rid=1;
async function rpc(method,params){
 let fail=[];
 for(const url of RPCS){
  for(let n=0;n<2;n++){
   try{
    const r=await fetch(url,{method:'POST',redirect:'error',headers:{'content-type':'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id:rid++,method,params}),
      signal:AbortSignal.timeout(17000)});
    if(!r.ok)throw Error('HTTP_'+r.status);
    const result=await r.json();
    if(result.error)throw Error(String(result.error.message||result.error.code));
    if(result.result===undefined)throw Error('missing_result');
    return {result:result.result,provider:new URL(url).hostname};
   }catch(e){fail.push(new URL(url).hostname+':'+String(e.message||e));}
  }
 }
 throw Error('RPC_unavailable '+fail.slice(-4).join(' | '));
}
async function main(){
 const chain=await rpc('eth_chainId',[]);
 if(chain.result!=='0x89')throw Error('unexpected_chain_'+chain.result);
 console.log('POLYGON_RPC_VERIFIED '+JSON.stringify({chainId:137,provider:chain.provider}));
 for(const m of markets){
  const data=await api(m.condition,m.wallet);
  const items=data.data;
  const hashes=[...new Set([...(items.slice(0,2)),...(items.slice(-2))].map(x=>x.transaction_hash))].filter(Boolean).slice(0,3);
  const tokenSet=new Set(items.map(x=>x.token_id).filter(x=>/^[0-9]+$/.test(String(x||''))));
  for(const hash of hashes){
   try{
    const receipt=(await rpc('eth_getTransactionReceipt',[hash])).result;
    if(!receipt){console.log('RECEIPT_MISSING '+JSON.stringify({wallet:m.wallet,condition:m.condition,tx:hash}));continue}
    if(receipt.status!=='0x1')throw Error('transaction_reverted');
    const all=(receipt.logs||[]).map(decodeLog).filter(Boolean);
    const matched=[];
    for(const l of all){
     if(l.address===CTF&&(l.event==='TransferSingle'||l.event==='TransferBatch')){
      const touched=(l.event==='TransferSingle'?tokenSet.has(l.id):l.ids.some(x=>tokenSet.has(x)));
      if(touched || l.from===m.wallet.toLowerCase()||l.to===m.wallet.toLowerCase())
       matched.push(l);
     }else if(l.address===PUSD&&(l.from===m.wallet.toLowerCase()||l.to===m.wallet.toLowerCase())){
       matched.push(l);
     }
    }
    const sample={wallet:m.wallet,name:m.name,condition:m.condition,tx:hash,
      block:parseInt(receipt.blockNumber,16),chain:137,receipt_status:receipt.status,
      source_log_count:(receipt.logs||[]).length,ctf_transfer_count:all.filter(x=>x.address===CTF).length,
      relevant_logs:matched.slice(0,25),provider:chain.provider};
    console.log('POLYGON_RECEIPT '+JSON.stringify(sample));
   }catch(e){console.log('POLYGON_RECEIPT_ERROR '+JSON.stringify({name:m.name,condition:m.condition,tx:hash,error:String(e.message||e)}))}
  }
 }
 console.log('POLYGON_PROBE_COMPLETE');
}
module.exports={decodeLog};
if(require.main===module)main().catch(e=>{console.error('POLYGON_PROBE_FAILED '+String(e.message||e));process.exitCode=1});
