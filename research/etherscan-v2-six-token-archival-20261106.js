'use strict';
/*
 * Research-only ERC-1155 archival indexer for fixed Papeasy/Spirit cohort.
 * Authenticated Etherscan V2 (Polygon chainid=137), GET only.
 * No secrets or signed transactions in outputs. Results fail closed on partial coverage.
 */
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const API='https://api.etherscan.io/v2/api';
const CTF='0x4d97dcd97ec945f40cf65f87097ace5ea0476045';
const maxPages=12,perPage=1000,maxRanges=128,minBlock=0;
const CASES=[
 {wallet:'0x111f73e91f85b6fe4de1ddec3de2fe32122e355b',label:'Papeasy',
  start:96861000,end:96863000,conditions:{
  '0x197b6683dfa66ae2721066584357219ab8f4154b7b4574fa7db7a00fc40fd9fe':[
   '46630074644841788196518542612353339209718693059931319467657011673178376809489',
   '87692758099786539256892597915964853187246350375075197360172406675285039873897'],
  '0xe5e31527a8c0e9b7edeadb69acb2a2a31bbf751e2c3ec10c88e2517f9237b239':[
   '87641258749126823085479122442154285951041760369755425437468560500784709417932',
   '103941550064996005811610699454127547386506033639530823097686232722434111826760']}},
 {wallet:'0x0c0e270cf879583d6a0142fc817e05b768d0434e',label:'Spirit of Ukraine > UMA',
  start:0,end:999999999,conditions:{
  '0x998bc71817b2d76921d1999ce0f3431cfd5945583667a371280ca2b430b0c06e':[
   '6302359956133594764084277082169634158291609371270652093164054687145970756151'],
  '0xe50c71cc5e2372bf0f6194a02e51459dd03b2c7b2d78a0d4650e5f36c425338b':[
   '48455736546094517370011063312529885328905072240106316551156607253162886762655']}}
];
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const validAddr=x=>/^0x[0-9a-f]{40}$/.test(String(x||'').toLowerCase());
const validHash=x=>/^0x[0-9a-f]{64}$/.test(String(x||'').toLowerCase());
const validId=x=>/^[0-9]+$/.test(String(x||''));
const errorText=e=>String(e.message||e).replace(/(apikey|key|token)[=:\s]+[A-Za-z0-9_-]+/gi,'$1=[REDACTED]').slice(0,180);
let requestCount=0;
async function get(action,params,key){
 const u=new URL(API);
 for(const [k,v] of Object.entries({chainid:'137',module:'account',action,...params,apikey:key}))
  u.searchParams.set(k,String(v));
 // Call-rate 2/sec, intentionally below public tier default.
 for(let attempt=0;attempt<4;attempt++){
  await sleep(520);
  let res;
  try{
   res=await fetch(u,{method:'GET',redirect:'error',headers:{accept:'application/json'},
     signal:AbortSignal.timeout(26000)});
  }catch(e){
   if(attempt===3)throw Error('API_NETWORK_'+String(e.name||'failure'));
   await sleep(1200*(attempt+1));continue;
  }
  requestCount++;
  if([429,500,502,503].includes(res.status)){
   if(attempt===3)throw Error('API_UNAVAILABLE_HTTP_'+res.status);
   await sleep(1800*(attempt+1));continue;
  }
  if(!res.ok)throw Error('API_HTTP_'+res.status);
  let payload;
  try{payload=await res.json()}catch{throw Error('API_NON_JSON')}
  if(payload.status==='1'&&Array.isArray(payload.result))return payload.result;
  const message=String(payload.result||payload.message||'').slice(0,160);
  if(payload.status==='0'&&Array.isArray(payload.result)&&payload.result.length===0)return [];
  if(payload.status==='0'&&/no transactions found/i.test(message))return [];
  if(/rate limit|busy|timeout/i.test(message)&&attempt<3){await sleep(1800*(attempt+1));continue}
  // Don't print provider response because it might echo the API credential.
  if(/free api access.*not supported|upgrade.*plan/i.test(message))throw Error('PLAN_DOES_NOT_COVER_POLYGON_137');
  if(/invalid api key|missing.invalid api key|invalid key/i.test(message))throw Error('ETHERSCAN_CREDENTIAL_INVALID');
  throw Error('API_REJECTED_'+String(payload.message||'NOTOK').replace(/[^A-Za-z0-9_ -]/g,'').slice(0,40));
 }
 throw Error('API_RETRIES_EXHAUSTED');
}
function normalizedTransfer(raw,wallet,selected,range){
 const tx=String(raw.hash||raw.transactionHash||'').toLowerCase();
 const id=String(raw.tokenID||raw.tokenId||raw.token_id||'');
 const from=String(raw.from||'').toLowerCase(),to=String(raw.to||'').toLowerCase();
 const amountStr=String(raw.tokenValue??raw.value??'');
 const idx=raw.logIndex??raw.log_index??null;
 const index=idx===null?null:Number(idx);
 const block=Number(raw.blockNumber);
 if(!validHash(tx)||!validId(id)||!validAddr(from)||!validAddr(to)
     ||!validId(amountStr)||!Number.isSafeInteger(block)||block<range.start||block>range.end)
   throw Error('UNVERIFIED_TRANSFER_SCHEMA');
 const contract=String(raw.contractAddress||raw.contractaddress||'').toLowerCase();
 if(contract!==CTF)throw Error('WRONG_TOKEN_CONTRACT');
 if(from!==wallet&&to!==wallet)throw Error('WALLET_TRANSFER_MISMATCH');
 if(index!==null&&(!Number.isSafeInteger(index)||index<0))throw Error('INVALID_LOG_INDEX');
 return {
   tx_hash:tx,log_index:index,block_number:block,
   from,to,token_id:id,quantity_raw:amountStr,
   selected: selected.has(id)
 };
}
function digest(s){return crypto.createHash('sha256').update(s).digest('hex')}
function reconcile(rows,wallet,tokenId){
 // Exact token amounts are stored as decimal bigint strings; ERC-1155 CTF has 6 share decimals.
 let incoming=0n,outgoing=0n,mint=0n,burn=0n;
 for(const r of rows){
  if(r.token_id!==tokenId)continue;
  const x=BigInt(r.quantity_raw);
  if(r.to===wallet)incoming+=x;
  if(r.from===wallet)outgoing+=x;
  if(r.from==='0x'+'0'.repeat(40)&&r.to===wallet)mint+=x;
  if(r.to==='0x'+'0'.repeat(40)&&r.from===wallet)burn+=x;
 }
 const unit=x=>(Number(x)/1e6).toFixed(6);
 return {received_shares:unit(incoming),sent_shares:unit(outgoing),
   burned_shares:unit(burn),minted_shares:unit(mint),
   net_shares:unit(incoming-outgoing),transfer_rows:rows.filter(r=>r.token_id===tokenId).length};
}
async function fetchRange(key,item,selected,start,end,depth=0){
 const rows=[],seenPages=new Set();
 for(let page=1;page<=maxPages;page++){
  const batch=await get('token1155tx',{
    address:item.wallet,contractaddress:CTF,startblock:start,endblock:end,
    page,offset:perPage,sort:'asc'},key);
  if(batch.length>perPage)throw Error('PAGE_OVERFLOW');
  if(batch.length===0)return {rows,complete:true};
  const fingerprints=batch.map(r=>String(r.hash)+'|'+String(r.logIndex??'')+'|'+String(r.tokenID??'')+'|'+String(r.tokenValue??''));
  const fingerprint=digest(JSON.stringify(fingerprints));
  if(seenPages.has(fingerprint))throw Error('REPEATED_PAGE');
  seenPages.add(fingerprint);
  for(const raw of batch)rows.push(normalizedTransfer(raw,item.wallet,selected,{start,end}));
  if(batch.length<perPage)return {rows,complete:true};
  if(page===maxPages){
   if(start===end)throw Error('SINGLE_BLOCK_PAGINATION_OVERFLOW');
   if(depth>16)throw Error('RANGE_SPLIT_DEPTH_EXCEEDED');
   // The same block range may still be truncated by a provider hard cap.
   const mid=Math.floor((start+end)/2);
   const left=await fetchRange(key,item,selected,start,mid,depth+1);
   const right=await fetchRange(key,item,selected,mid+1,end,depth+1);
   return {rows:left.rows.concat(right.rows),complete:left.complete&&right.complete};
  }
 }
 throw Error('UNEXPECTED_PAGINATION');
}
async function run(){
 if(!process.env.ETHERSCAN_API_KEY){console.log('AUTH_CONFIGURATION=MISSING_ETHERSCAN_API_KEY');process.exitCode=2;return;}
 const key=process.env.ETHERSCAN_API_KEY.trim();
 if(key.length<12)throw Error('CREDENTIAL_TOO_SHORT');
 const all=[];
 for(const item of CASES){
  const tokens=Object.values(item.conditions).flat();
  if(tokens.some(t=>!validId(t)))throw Error('INVALID_PINNED_TOKEN_ID');
  const selection=new Set(tokens);
  const start=Date.now();
  console.log('INDEX_SCOPE '+JSON.stringify({wallet:item.wallet,label:item.label,
    token_ids:tokens.length,from_block:item.start,to_block:item.end}));
  let source;
  try{source=await fetchRange(key,item,selection,item.start,item.end)}
  catch(e){console.log('INDEX_BLOCKER '+JSON.stringify({wallet:item.wallet,reason:errorText(e),calls:requestCount}));process.exitCode=2;continue}
  let duplicates=0,withoutLogIndex=0;
  const unique=new Map();
  for(const r of source.rows){
   if(r.log_index===null){withoutLogIndex++;continue;}
   const identity=r.tx_hash+':'+r.log_index+':'+r.token_id;
   if(unique.has(identity))duplicates++;else unique.set(identity,r);
  }
  const rows=[...unique.values()].sort((a,b)=>a.block_number-b.block_number||(a.log_index-b.log_index));
  const eligible=source.complete&&withoutLogIndex===0&&duplicates===0;
  for(const [condition,ids] of Object.entries(item.conditions)){
   for(const id of ids){
    const metrics=reconcile(rows,item.wallet,id);
    const status={wallet:item.wallet,label:item.label,condition,token_id:id,
      scope_start_block:item.start,scope_end_block:item.end,
      indexed_transfer_complete:eligible,log_indices_present:withoutLogIndex===0,
      ...metrics};
    console.log('TOKEN_ARCHIVAL_RESULT '+JSON.stringify(status));
    all.push(status);
  }}
  // Write evidence with no credentials, for independent after-the-fact audit.
  const artifact={wallet:item.wallet,source:'Etherscan API V2 token1155tx chainid=137',
    startblock:item.start,endblock:item.end,selected_token_ids:tokens,
    source_complete:source.complete,identity_complete:withoutLogIndex===0,
    unique_transfer_rows:rows.length,duplicates,without_log_index:withoutLogIndex,
    elapsed_ms:Date.now()-start,records:rows.filter(x=>x.selected)};
  const outDir=process.env.EVIDENCE_DIR||'/tmp/tk-smartmoney-index';
  fs.mkdirSync(outDir,{recursive:true,mode:0o700});
  const dst=path.join(outDir,item.label.startsWith('Papeasy')?'papeasy_transfers.json':'spirit_transfers.json');
  fs.writeFileSync(dst,JSON.stringify(artifact,null,2)+'\n',{mode:0o600,flag:'w'});
  console.log('EVIDENCE_FILE '+JSON.stringify({wallet:item.wallet,
    path:dst,sha256:digest(fs.readFileSync(dst)),selected_rows:artifact.records.length}));
  if(!eligible){process.exitCode=2;console.log('INDEX_BLOCKER '+JSON.stringify({
    wallet:item.wallet,reason:withoutLogIndex?'MISSING_LOG_INDEX_IN_INDEXER_RESPONSE':'DUPLICATE_OR_INCOMPLETE_PAGE'}));}
 }
 console.log('ARCHIVAL_INDEX_SUMMARY '+JSON.stringify({
  tokens_reported:all.length,provider:'Etherscan API V2',chainid:137,
  credential_used:true,secret_logged:false,api_calls:requestCount,
  independently_verified_trade_fees:false,fee_adjusted_pnl:'WITHHELD',
  scoring:'DISABLED'}));
 if(all.length!==6)process.exitCode=2;
}
module.exports={normalizedTransfer,reconcile,CASES};
if(require.main===module)run().catch(e=>{console.error('ARCHIVAL_INDEX_ERROR '+errorText(e));process.exitCode=1});
