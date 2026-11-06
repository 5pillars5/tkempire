'use strict';
/* Bounded public Polygon eth_getLogs ledger of Papeasy's two 5-minute markets.
 * ERC-1155 wallet boundary only: no clearing-house double count, no signing.
 */
const {decodeLog}=require('./polygon-six-token-receipt-probe-20261106.js');
const W='0x111f73e91f85b6fe4de1ddec3de2fe32122e355b';
const CTF='0x4d97dcd97ec945f40cf65f87097ace5ea0476045';
const S='0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62';
const B='0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb';
const MARKETS=['0x197b6683dfa66ae2721066584357219ab8f4154b7b4574fa7db7a00fc40fd9fe','0xe5e31527a8c0e9b7edeadb69acb2a2a31bbf751e2c3ec10c88e2517f9237b239'];
const RPC='https://polygon-bor-rpc.publicnode.com';
const FIRST=96861000,LAST=96863000,STEP=250;
const word='0x'+'0'.repeat(24)+W.slice(2);
let i=1;
async function rpc(method,params){
 for(let n=0;n<3;n++){
  const r=await fetch(RPC,{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:i++,method,params}),signal:AbortSignal.timeout(16000)});
  if(r.status===429||r.status===503){await new Promise(res=>setTimeout(res,1000*(n+1)));continue}
  if(!r.ok)throw Error('RPC_HTTP_'+r.status);
  const d=await r.json();if(d.error)throw Error('RPC_'+d.error.message);
  return d.result;
 }
 throw Error('RPC_retry_exhausted');
}
async function tokensFromData(){
 const all=new Set(),map=new Map();
 for(const condition of MARKETS){
  const u=new URL('/v2/activity','https://data-api.polymarket.com');
  u.searchParams.set('user',W);u.searchParams.set('condition',condition);u.searchParams.set('limit','1000');
  const r=await fetch(u,{headers:{Accept:'application/json'},signal:AbortSignal.timeout(16000)});
  if(!r.ok)throw Error('data_http_'+r.status);
  const d=await r.json();if(!Array.isArray(d.data))throw Error('data_not_array');
  const ids=new Set(d.data.filter(e=>/^[0-9]+$/.test(String(e.token_id||''))).map(e=>String(e.token_id)));
  if(ids.size!==2)throw Error('unexpected_token_cohort_'+condition+'_'+ids.size);
  map.set(condition,[...ids]);for(const id of ids)all.add(id);
 }
 return {all,map};
}
async function main(){
 if(await rpc('eth_chainId',[])!=='0x89')throw Error('wrong_chain');
 const {all,map}=await tokensFromData();
 const unique=new Map();
 let calls=0;
 for(let from=FIRST;from<=LAST;from+=STEP){
  const to=Math.min(from+STEP-1,LAST);
  for(const sig of [S,B])for(const index of [2,3]){
   const topics=[sig,null,null,null];topics[index]=word;
   const logs=await rpc('eth_getLogs',[{address:CTF,fromBlock:'0x'+from.toString(16),toBlock:'0x'+to.toString(16),topics}]);
   calls++;
   for(const l of logs||[]){
    const decoded=decodeLog(l);
    if(!decoded||decoded.address!==CTF)continue;
    if(decoded.from!==W&&decoded.to!==W)continue;
    const key=[l.transactionHash,l.logIndex].join(':');
    unique.set(key,decoded);
   }
  }
  console.log('LOG_SCAN_PROGRESS '+JSON.stringify({from,to,logs:unique.size,calls}));
 }
 const perToken=Object.fromEntries([...all].map(id=>[id,{token_id:id,in:0,out:0,mints:0,burns:0,events:0,txs:new Set()}]));
 for(const log of unique.values()){
  const ids=log.event==='TransferSingle'?[log.id]:log.ids;
  const vals=log.event==='TransferSingle'?[log.value]:log.values;
  for(let k=0;k<ids.length;k++){
   const x=perToken[ids[k]];if(!x)continue;
   const value=vals[k];x.events++;x.txs.add(log.tx);
   if(log.to===W)x.in+=value;
   if(log.from===W)x.out+=value;
   if(log.from===W&&log.to==='0x'+'0'.repeat(40))x.burns+=value;
   if(log.to===W&&log.from==='0x'+'0'.repeat(40))x.mints+=value;
  }
 }
 for(const [condition,ids] of map){
  for(const id of ids){
   const x=perToken[id],net=x.in-x.out;
   console.log('ONCHAIN_TOKEN_BALANCE '+JSON.stringify({
    wallet:W,condition,token_id:id,range_start:FIRST,range_end:LAST,
    events:x.events,unique_txs:x.txs.size,received_shares:+x.in.toFixed(6),sent_shares:+x.out.toFixed(6),
    redeemed_burns_shares:+x.burns.toFixed(6),net_change_shares:+net.toFixed(6),
    complete_lifetime_history:false,
    basis_note:'No independent fills/fee allocation proven by token balances alone'
   }));
  }
 }
 console.log('ONCHAIN_LOG_SUMMARY '+JSON.stringify({range_start:FIRST,range_end:LAST,queries:calls,
    unique_wallet_transfer_logs:unique.size,covered_tokens:all.size,all_four_tokens:all.size===4,
    interval_completeness:'ONLY_BOUNDED_BLOCK_WINDOW',wallet_quality_score:'WITHHELD'}));
}
main().catch(e=>{console.error('ONCHAIN_LOG_AUDIT_FAILED '+String(e.message||e));process.exitCode=1});
