'use strict';
/*
 * Read-only ERC1155 identity enrichment for Etherscan responses lacking logIndex.
 * Uses exact Polygon receipt logs (not economic inference).
 */
const CONTRACT='0x4d97dcd97ec945f40cf65f87097ace5ea0476045';
const SINGLE='0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62';
const BATCH='0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb';
const PROVIDERS=[
 'https://polygon.drpc.org',
 'https://api.zan.top/polygon-mainnet',
 'https://rpc-mainnet.matic.quiknode.pro'
];
const hexWord=(str,i)=>BigInt('0x'+str.slice(64*i,64*(i+1)));
const address=t=>'0x'+String(t||'').slice(-40).toLowerCase();
function decodeReceipt(receipt,selected,wallet){
 if(!receipt||receipt.status!=='0x1'||!Array.isArray(receipt.logs))throw Error('INVALID_RECEIPT');
 const seen=new Set(),out=[];
 for(const x of receipt.logs){
  if(String(x.address||'').toLowerCase()!==CONTRACT)continue;
  const topics=x.topics||[],kind=String(topics[0]||'').toLowerCase();
  if(kind!==SINGLE&&kind!==BATCH)continue;
  if(topics.length<4)throw Error('BAD_ERC1155_TOPICS');
  const from=address(topics[2]),to=address(topics[3]);
  if(from!==wallet&&to!==wallet)continue;
  const data=String(x.data||'0x').slice(2);
  let ids=[],amounts=[];
  if(kind===SINGLE){
   if(data.length!==128)throw Error('INVALID_SINGLE_LOG');
   ids=[hexWord(data,0).toString()];
   amounts=[hexWord(data,1).toString()];
  }else{
   if(data.length<128)throw Error('INVALID_BATCH_LOG');
   const a=Number(hexWord(data,0))/32,b=Number(hexWord(data,1))/32;
   if(!Number.isSafeInteger(a)||!Number.isSafeInteger(b)||a<2||b<2)throw Error('BAD_BATCH_OFFSETS');
   const n=Number(hexWord(data,a)),m=Number(hexWord(data,b));
   if(n!==m||n<0||n>1000||data.length<(Math.max(a,b)+n+1)*64)throw Error('INVALID_BATCH_LENGTH');
   for(let i=0;i<n;i++){ids.push(hexWord(data,a+1+i).toString());amounts.push(hexWord(data,b+1+i).toString());}
  }
  const index=Number.parseInt(String(x.logIndex||''),16);
  if(!Number.isSafeInteger(index)||index<0)throw Error('MISSING_RECEIPT_LOG_INDEX');
  for(let i=0;i<ids.length;i++){
   if(!selected.has(ids[i]))continue;
   const id=index+':'+ids[i];
   if(seen.has(id))throw Error('DUPLICATE_RECEIPT_TRANSFER_ID');
   seen.add(id);out.push({tx_hash:String(receipt.transactionHash||'').toLowerCase(),
     log_index:index,from,to,token_id:ids[i],quantity_raw:amounts[i]});
  }
 }
 return out;
}
async function queryReceipt(hash){
 for(const provider of PROVIDERS){
  for(let retry=0;retry<2;retry++){
   try{
    const res=await fetch(provider,{method:'POST',redirect:'error',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_getTransactionReceipt',params:[hash]}),
      signal:AbortSignal.timeout(18000)});
    if(!res.ok)throw Error('HTTP_'+res.status);
    const payload=await res.json();
    if(payload.error||!payload.result)throw Error('RPC_RESULT_UNAVAILABLE');
    if(String(payload.result.transactionHash||'').toLowerCase()!==hash)throw Error('RECEIPT_HASH_MISMATCH');
    return payload.result;
   }catch(err){
    if(retry===0)await new Promise(res=>setTimeout(res,500));
   }
  }
 }
 throw Error('PUBLIC_RECEIPT_UNAVAILABLE');
}
function signature(x){return [x.from,x.to,x.token_id,x.quantity_raw].join('|')}
async function enrich(rows,wallet,selected,receiptFetcher=queryReceipt){
 const groups=new Map();
 for(const row of rows){
  if(!selected.has(row.token_id))continue;
  if(!groups.has(row.tx_hash))groups.set(row.tx_hash,[]);
  groups.get(row.tx_hash).push(row);
 }
 if(groups.size>2500)throw Error('RECEIPT_ENRICHMENT_TX_CAP');
 let checks=0,updated=0,matched=0;
 for(const [tx,subset] of groups){
  // Validate ALL selected ERC1155 transfer source entries in a tx,
  // even if Etherscan supplied logIndex, to detect missing batch rows.
  const receipt=await receiptFetcher(tx);
  const decoded=decodeReceipt(receipt,selected,wallet);
  const buckets=new Map();
  for(const log of decoded){
    const sig=signature(log);
    if(!buckets.has(sig))buckets.set(sig,[]);
    buckets.get(sig).push(log);
  }
  for(const row of subset){
    const bucket=buckets.get(signature(row))||[];
    if(!bucket.length)throw Error('MISSING_RECEIPT_MATCH');
    const index=row.log_index===null?0:bucket.findIndex(x=>x.log_index===row.log_index);
    const match=index<0?null:bucket.splice(index,1)[0];
    if(!match)throw Error('RECEIPT_LOG_INDEX_MISMATCH');
    if(row.log_index===null){row.log_index=match.log_index;updated++;}
    matched++;
  }
  for(const remaining of buckets.values())if(remaining.length)throw Error('MISSING_INDEXER_TRANSFER_ROW');
  checks++;
 }
 return {rows,transactions_verified:checks,identities_enriched:updated,matched_events:matched};
}
module.exports={decodeReceipt,enrich,queryReceipt};
