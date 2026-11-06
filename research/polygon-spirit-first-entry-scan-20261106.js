'use strict';
// Read-only historical Polygon wallet-anchored ERC1155 log probe for two Spirit tokens.
// Finds block by position first_entry_at (no arbitrary historical block guessing),
// scans a bounded window, and reports incomplete lifetime coverage explicitly.
const WALLET='0x0c0e270cf879583d6a0142fc817e05b768d0434e';
const CTF='0x4d97dcd97ec945f40cf65f87097ace5ea0476045';
const TOPS=['0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62','0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb'];
const CONDITIONS=['0x998bc71817b2d76921d1999ce0f3431cfd5945583667a371280ca2b430b0c06e',
 '0xe50c71cc5e2372bf0f6194a02e51459dd03b2c7b2d78a0d4650e5f36c425338b'];
const ENDPOINT='https://polygon.drpc.org';
const TRANSFER=async(url)=>{const r=await fetch(url,{headers:{accept:'application/json'},signal:AbortSignal.timeout(18000)});if(!r.ok)throw Error('http_'+r.status);const d=await r.json();if(!Array.isArray(d.data))throw Error('no_data');return d};
let id=0,calls=0;
async function rpc(method,params){
 for(let a=0;a<3;a++){
  try{
   const r=await fetch(ENDPOINT,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:++id,method,params}),signal:AbortSignal.timeout(16000)});
   if(!r.ok)throw Error('http_'+r.status);
   const out=await r.json();if(out.error)throw Error(String(out.error.message||'rpc_error'));
   calls++;return out.result;
  }catch(e){if(a===2)throw e;await new Promise(res=>setTimeout(res,400*(a+1)));}
 }
}
async function blockAt(t){
 const head=parseInt(await rpc('eth_blockNumber',[]),16);let lo=1,hi=head;
 while(lo<hi){
  const mid=Math.floor((lo+hi)/2);
  const b=await rpc('eth_getBlockByNumber',['0x'+mid.toString(16),false]);
  if(!b||!b.timestamp)throw Error('historic_block_missing_'+mid);
  if(parseInt(b.timestamp,16)<t)lo=mid+1;else hi=mid;
 }
 return lo;
}
function getTransfers(log){
 const h=String(log.data||'0x').slice(2);
 const topics=log.topics||[];
 const type=String(topics[0]||'').toLowerCase();
 const addr=x=>'0x'+String(x).slice(-40).toLowerCase();
 const from=addr(topics[2]),to=addr(topics[3]);
 const word=i=>BigInt('0x'+h.slice(i*64,(i+1)*64));
 if(type===TOPS[0]&&h.length>=128)return {from,to,token_ids:[word(0).toString()],amounts:[Number(word(1))/1e6]};
 if(type===TOPS[1]&&h.length>=128){
  const a=Number(word(0))/32,b=Number(word(1))/32,n=Number(word(a)),m=Number(word(b));
  if(n!==m||n>200)return null;const ids=[],v=[];
  for(let j=0;j<n;j++){ids.push(word(a+j+1).toString());v.push(Number(word(b+j+1))/1e6)}
  return {from,to,token_ids:ids,amounts:v};
 }return null;
}
async function discover(condition){
 const out=[];
 for(const status of ['OPEN','CLOSED']){
  const u=new URL('/v2/positions','https://data-api.polymarket.com');
  for(const [k,v]of Object.entries({user:WALLET,condition,status,limit:100}))u.searchParams.set(k,String(v));
  const d=await TRANSFER(u);out.push(...d.data.filter(x=>String(x.condition_id||'').toLowerCase()===condition));
 }
 const tokens=new Map();
 for(const p of out){if(!/^[0-9]+$/.test(String(p.token_id||'')))continue;
  tokens.set(String(p.token_id),p);
 }
 if(!tokens.size)throw Error('no_positions_'+condition);
 return [...tokens.values()];
}
async function scan(condition,token){
 const first=Number(token.first_entry_at);
 if(!Number.isFinite(first)||first<1500000000)throw Error('missing_first_entry_at');
 const block=await blockAt(first);
 const start=Math.max(1,block-4000),end=block+4000,step=250;
 const topicWallet='0x'+'0'.repeat(24)+WALLET.slice(2);
 let unique=new Map(),queries=0,invalid=0;
 for(let from=start;from<=end;from+=step){
  const to=Math.min(end,from+step-1);
  for(const sig of TOPS)for(const at of [2,3]){
   const topics=[sig,null,null,null];topics[at]=topicWallet;
   const logs=await rpc('eth_getLogs',[{address:CTF,fromBlock:'0x'+from.toString(16),toBlock:'0x'+to.toString(16),topics}]);
   queries++;
   for(const l of logs||[]){
    const d=getTransfers(l);
    if(!d||d.from!==WALLET&&d.to!==WALLET){invalid++;continue}
    const key=l.transactionHash+':'+l.logIndex;
    unique.set(key,{...d,tx:l.transactionHash,log_index:parseInt(l.logIndex,16),block:parseInt(l.blockNumber,16)});
   }
  }
 }
 let got=0,sent=0,matches=0,firstSeen=null;
 for(const ev of unique.values()){
  const i=ev.token_ids.indexOf(String(token.token_id));if(i<0)continue;
  matches++;if(firstSeen===null||ev.block<firstSeen)firstSeen=ev.block;
  if(ev.to===WALLET)got+=ev.amounts[i];if(ev.from===WALLET)sent+=ev.amounts[i];
 }
 return {wallet:WALLET,condition,token_id:String(token.token_id),first_entry_at:first,
  anchor_block:block,scan_first:start,scan_last:end,queries,
  wallet_boundary_logs:unique.size,matching_token_logs:matches,
  incoming_shares:+got.toFixed(6),outgoing_shares:+sent.toFixed(6),
  first_matching_block:firstSeen,
  current_size:token.current_size,position_status:token.status,
  earlier_history_unverified:true,later_history_unverified:true,
  full_cost_basis_verified:false};
}
(async()=>{
 if(await rpc('eth_chainId',[])!=='0x89')throw Error('wrong_chain');
 for(const condition of CONDITIONS){
  try{
   const positions=await discover(condition);
   const chosen=positions.filter(x=>String(x.condition_id||'').toLowerCase()===condition).sort((a,b)=>Number(a.first_entry_at||0)-Number(b.first_entry_at||0))[0];
   const result=await scan(condition,chosen);
   console.log('SPIRIT_HISTORICAL_OPENING '+JSON.stringify(result));
  }catch(e){
   console.log('SPIRIT_HISTORICAL_BLOCKER '+JSON.stringify({condition,error:String(e.message||e)}))
  }
 }
 console.log('SPIRIT_HISTORICAL_PROBE_COMPLETE '+JSON.stringify({rpc_calls:calls,full_lifetime_history:false,score:'WITHHELD'}));
})().catch(e=>{console.error('SPIRIT_HISTORICAL_FATAL '+String(e.message||e));process.exitCode=1});
