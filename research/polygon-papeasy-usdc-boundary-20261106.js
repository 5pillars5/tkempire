'use strict';
/* Read-only USDC.p Polygon wallet-boundary cashflow probe over the previously verified
 * Papeasy two-market block interval; cashflows are NOT assumed attributable if
 * a transaction touches any other wallet-held conditional token.
 */
const URL='https://polygon-bor-rpc.publicnode.com';
const W='0x111f73e91f85b6fe4de1ddec3de2fe32122e355b';
const CTF='0x4d97dcd97ec945f40cf65f87097ace5ea0476045';
const PUSD='0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb';
const TOP20='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const SINGLE='0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62';
const BATCH='0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb';
const ZERO='0x'+'0'.repeat(24)+W.slice(2);
const START=96861000,END=96863000,STEP=250;
const markets=[
 {name:'3:50-3:55 BTC',ids:[
  '87692758099786539256892597915964853187246350375075197360172406675285039873897',
  '46630074644841788196518542612353339209718693059931319467657011673178376809489']},
 {name:'3:45-3:50 BTC',ids:[
  '103941550064996005811610699454127547386506033639530823097686232722434111826760',
  '87641258749126823085479122442154285951041760369755425437468560500784709417932']}
];
const tokenOwners=new Map(markets.flatMap((m,i)=>m.ids.map(id=>[id,i])));
let idx=0;
async function rpc(method,params){
 for(let attempt=0;attempt<3;attempt++){
  try{
   const r=await fetch(URL,{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:++idx,method,params}),signal:AbortSignal.timeout(16000)});
   if(!r.ok)throw Error('http_'+r.status);
   const doc=await r.json();if(doc.error)throw Error(String(doc.error.message||'rpc_error'));
   return doc.result;
  }catch(e){if(attempt===2)throw e;await new Promise(res=>setTimeout(res,350*(attempt+1)));}
 }
}
function unpack(log){
 const typ=String(log.topics?.[0]||'').toLowerCase();
 const h=String(log.data||'0x').slice(2);const word=n=>BigInt('0x'+h.slice(n*64,(n+1)*64));
 const getAddr=t=>String(t||'').length===66?'0x'+t.slice(-40).toLowerCase():null;
 const from=getAddr(log.topics?.[typ===TOP20?1:2]),to=getAddr(log.topics?.[typ===TOP20?2:3]);
 if(!from||!to)return null;
 if(typ===TOP20){if(h.length<64)return null;return {from,to,kind:'USDC',ids:[],values:[],amount:Number(word(0))/1e6};}
 if(typ===SINGLE){if(h.length<128)return null;return {from,to,kind:'CTF',ids:[word(0).toString()],values:[Number(word(1))/1e6]};}
 if(typ===BATCH){
  if(h.length<128)return null;
  const pos1=Number(word(0))/32,pos2=Number(word(1))/32,n=Number(word(pos1)),m=Number(word(pos2));
  if(n!==m||n>200||n<0)return null;
  const ids=[],values=[];
  for(let i=0;i<n;i++){ids.push(word(pos1+1+i).toString());values.push(Number(word(pos2+1+i))/1e6);}
  return {from,to,kind:'CTF',ids,values};
 }
 return null;
}
async function run(){
 if(await rpc('eth_chainId',[])!=='0x89')throw Error('not_polygon');
 const unique=new Map();
 for(let from=START;from<=END;from+=STEP){
  const to=Math.min(END,from+STEP-1);
  for(const [address,sig] of [[CTF,SINGLE],[CTF,BATCH],[PUSD,TOP20]]){
   for(const i of (sig===TOP20?[1,2]:[2,3])){
    const topics=Array(sig===TOP20?3:4).fill(null);topics[0]=sig;topics[i]=ZERO;
    const logs=await rpc('eth_getLogs',[{address,fromBlock:'0x'+from.toString(16),
      toBlock:'0x'+to.toString(16),topics}]);
    for(const log of logs||[]){
     const key=String(log.transactionHash).toLowerCase()+':'+parseInt(log.logIndex,16);
     const d=unpack(log);
     if(d&&(d.from===W||d.to===W))
       unique.set(key,{tx:String(log.transactionHash).toLowerCase(),index:parseInt(log.logIndex,16),...d});
    }
   }
  }
 }
 const txs=new Map();
 for(const ev of unique.values()){
  if(!txs.has(ev.tx))txs.set(ev.tx,{tx:ev.tx,inUSD:0,outUSD:0,tokenIds:new Set(),events:0,
    tokenMovements:[],collateralMovements:[]});
  const t=txs.get(ev.tx);t.events++;
  if(ev.kind==='USDC'){
   if(ev.to===W)t.inUSD+=ev.amount;
   if(ev.from===W)t.outUSD+=ev.amount;
   t.collateralMovements.push(ev);
  }else{
   for(let i=0;i<ev.ids.length;i++){
    t.tokenIds.add(ev.ids[i]);
    t.tokenMovements.push({id:ev.ids[i],amount:ev.values[i],from:ev.from,to:ev.to,index:ev.index});
   }
  }
 }
 const results=markets.map(m=>({name:m.name,exclusive_txs:0,overlap_txs:0,open_fee_evidence:0,
    exclusive_in_usdc:0,exclusive_out_usdc:0,exclusive_net_usdc:0,txs_without_collateral:0,
    wallet_token_txs:0,transactions_total:0}));
 let unknownMarket=0;
 for(const tx of txs.values()){
  const owners=new Set([...tx.tokenIds].map(id=>tokenOwners.get(id)));
  const selected=[...owners].filter(x=>x!==undefined);
  if(!selected.length){unknownMarket++;continue;}
  for(const n of selected){
   const r=results[n];r.wallet_token_txs++;
   if(owners.size===1){
    r.exclusive_txs++;
    r.exclusive_in_usdc+=tx.inUSD;r.exclusive_out_usdc+=tx.outUSD;
    if(tx.collateralMovements.length===0)r.txs_without_collateral++;
   }else r.overlap_txs++;
  }
 }
 for(const r of results){
  r.exclusive_net_usdc=+(r.exclusive_in_usdc-r.exclusive_out_usdc).toFixed(6);
  r.exclusive_in_usdc=+r.exclusive_in_usdc.toFixed(6);
  r.exclusive_out_usdc=+r.exclusive_out_usdc.toFixed(6);
  console.log('PAPEASY_USDC_CASHFLOW '+JSON.stringify({...r,
   note:'Gross wallet-boundary USDC.p cashflow for exclusive token-tx only; fees and other markets may still be involved'}));
 }
 console.log('PAPEASY_USDC_SOURCE '+JSON.stringify({wallet:W,fromBlock:START,toBlock:END,
  ctf:CTF,collateral:PUSD,unique_wallet_logs:unique.size,wallet_txs:txs.size,
  unrelated_usdc_only_txs:unknownMarket,provider:'polygon-bor-rpc.publicnode.com',
  outside_interval_not_covered:true,net_profit_claim:'WITHHELD'}));
}
run().catch(e=>{console.error('PAPEASY_USDC_ERROR '+String(e.message||e));process.exitCode=1});
