'use strict';
// Polymarket winning redemption USDC denomination discovery;
// read-only: inspect all ERC20 Transfer logs in exact verified payout transactions.
const RPC='https://polygon.drpc.org';
const WALLET='0x111f73e91f85b6fe4de1ddec3de2fe32122e355b';
const TOP='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55';
const txs=[
 ['3:50–3:55','0xb89238639e75050e5e4a8cd042db780fe197359e5b83df83709db85d52f6539e'],
 ['3:45–3:50','0xedff73c024579fdb1d6c5b48b8c56d56665531707411323556de3d583b42d017']
];
async function rpc(method,params){
 const r=await fetch(RPC,{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),
    signal:AbortSignal.timeout(15000)});
 if(!r.ok)throw Error('RPC_HTTP_'+r.status);
 const obj=await r.json();if(obj.error)throw Error(String(obj.error.message||obj.error.code));
 return obj.result;
}
async function main(){
 if(await rpc('eth_chainId',[])!=='0x89')throw Error('not_polygon');
 for(const [name,hash]of txs){
  const rec=await rpc('eth_getTransactionReceipt',[hash]);
  if(!rec||rec.status!=='0x1')throw Error('bad_receipt_'+name);
  const rows=[];
  for(const log of rec.logs||[]){
   if(String(log.topics?.[0]||'').toLowerCase()!==TOP||log.topics.length<3)continue;
   const from='0x'+log.topics[1].slice(-40).toLowerCase();
   const to='0x'+log.topics[2].slice(-40).toLowerCase();
   if(from!==WALLET&&to!==WALLET)continue;
   const raw=BigInt(log.data);
   rows.push({address:log.address.toLowerCase(),from,to,value_raw:raw.toString(),
     normalized_if_6_decimals:Number(raw)/1e6,log_index:parseInt(log.logIndex,16)});
  }
  console.log('REDEMPTION_COLLATERAL '+JSON.stringify({name,tx:hash,block:parseInt(rec.blockNumber,16),
   gas_used:parseInt(rec.gasUsed,16),gas_price_wei:String(BigInt(rec.effectiveGasPrice||'0x0')),
   tx_hash_status:rec.status,erc20_transfers_towards_wallet:rows}));
 }
 console.log('REDEMPTION_COLLATERAL_PROBE=COMPLETE');
}
main().catch(e=>{console.error('REDEMPTION_COLLATERAL_ERROR '+String(e.message||e));process.exitCode=1});
