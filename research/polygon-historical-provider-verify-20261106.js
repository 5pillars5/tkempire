'use strict';
/* Independent historical Polygon RPC provider test.
 * Fixed transaction hashes and read-only JSON RPC only.
 */
const hashes=[
 '0x9d469136d3e36ea152444c507bedcd8be4d56dd31bae489a88ea368b1378269b',
 '0x3260960bffdee9eab00118e80de6075b8e390ad7cb380a1ee0753ef59704355a'
];
const providers=[
 'https://polygon.drpc.org',
 'https://rpc.swiftnodes.io/rpc/polygon',
 'https://api.zan.top/polygon-mainnet',
 'https://rpc-mainnet.matic.quiknode.pro'
];
const CTF='0x4d97dcd97ec945f40cf65f87097ace5ea0476045';
const WALLET='0x0c0e270cf879583d6a0142fc817e05b768d0434e';
let rid=1;
async function call(provider,method,params){
 const res=await fetch(provider,{method:'POST',redirect:'error',headers:{'content-type':'application/json','accept':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:rid++,method,params}),signal:AbortSignal.timeout(12000)});
 if(!res.ok)throw Error('HTTP_'+res.status);
 const data=await res.json();
 if(data.error)throw Error('RPC_'+String(data.error.message||data.error.code));
 return data.result;
}
async function main(){
 const scores=[];
 for(const url of providers){
  const x={provider:new URL(url).hostname,chain_137:false,valid_receipts:0,missing_receipts:0,errors:[],receipt_details:[]};
  try{
   const chain=await call(url,'eth_chainId',[]);
   x.chain_137=chain==='0x89';if(!x.chain_137)throw Error('incorrect_chain_'+chain);
   for(const hash of hashes){
    try{
     const r=await call(url,'eth_getTransactionReceipt',[hash]);
     if(!r){x.missing_receipts++;continue;}
     if(String(r.transactionHash||'').toLowerCase()!==hash)throw Error('receipt_hash_mismatch');
     if(r.status!=='0x1')throw Error('non_success_receipt');
     x.valid_receipts++;
     const logs=(r.logs||[]).filter(l=>String(l.address||'').toLowerCase()===CTF);
     const walletTopic='0x'+'0'.repeat(24)+WALLET.slice(2);
     const relevant=logs.filter(l=>(l.topics||[]).includes(walletTopic));
     x.receipt_details.push({
      tx:hash,block:parseInt(r.blockNumber,16),ctf_logs:logs.length,
      ctf_wallet_topic_logs:relevant.length,
      observed_log_indices:relevant.slice(0,10).map(l=>parseInt(l.logIndex,16))
     });
    }catch(e){x.errors.push(hash.slice(0,12)+':'+String(e.message||e))}
   }
  }catch(e){x.errors.push('provider:'+String(e.message||e))}
  scores.push(x);
  console.log('HISTORICAL_PROVIDER '+JSON.stringify(x));
 }
 const good=scores.filter(x=>x.chain_137&&x.valid_receipts>0);
 console.log('HISTORICAL_PROVIDER_SUMMARY '+JSON.stringify({
  providers_tested:scores.length,providers_with_valid_old_receipts:good.length,
  both_receipts_verified:good.filter(x=>x.valid_receipts===2).length,
  complete_token_history:false,fee_adjusted_pnl:'WITHHELD'
 }));
}
main().catch(e=>{console.error('HISTORICAL_PROVIDER_FATAL '+String(e.message||e));process.exitCode=1});
