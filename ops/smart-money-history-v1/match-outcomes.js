'use strict';
const zlib=require('node:zlib');
const {matchResolution,hash}=require('./history-core');
const OWNER='5pillars5',REPO='tkempire',BASE='https://api.github.com/repos/'+OWNER+'/'+REPO+'/contents/';
const PUBLIC='https://data-api.polymarket.com';
const PREFIX='data/smart-money-history-v1/';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const stringify=x=>JSON.stringify(x);
async function gh(method,path,body,token){
 const url=BASE+path.split('/').map(encodeURIComponent).join('/')+
  (method==='GET'?'?ref=main':'');
 const r=await fetch(url,{method,redirect:'error',headers:{
  Authorization:'Bearer '+token,Accept:'application/vnd.github+json',
  'X-GitHub-Api-Version':'2022-11-28','Content-Type':'application/json'},
  body:body?stringify(body):undefined,signal:AbortSignal.timeout(22000)});
 if(r.status===404&&method==='GET')return null;
 if(!r.ok)throw Error('GITHUB_'+method+'_'+r.status);
 return r.json();
}
async function getData(path,condition){
 const u=new URL(path,PUBLIC);u.searchParams.set('condition',condition);
 for(let i=0;i<3;i++){
  try{
   const r=await fetch(u,{redirect:'error',headers:{Accept:'application/json'},
    signal:AbortSignal.timeout(14000)});
   if(!r.ok)throw Error('HTTP_'+r.status);
   const raw=await r.text();if(raw.length>140000)throw Error('OVERSIZED');
   const d=JSON.parse(raw);if(!d||!Array.isArray(d.data))throw Error('BAD_ENVELOPE');
   return d.data;
  }catch(e){if(i===2)throw Error('PUBLIC_SOURCE_'+path+'_'+String(e.message||e));await sleep(950*(i+1))}
 }
}
async function getDay(day,token){
 const p=PREFIX+day+'.json.gz',r=await gh('GET',p,null,token);
 if(!r)return null;
 const content=Buffer.from(String(r.content||'').replace(/\s/g,''),'base64');
 if(content.length>1200000)throw Error('HISTORY_COMPRESSED_FILE_LIMIT');
 const raw=zlib.gunzipSync(content,{maxOutputLength:15000000});
 const data=JSON.parse(raw.toString('utf8'));
 if(data.day!==day||data.schema_version!==1||!Array.isArray(data.signal_events)||
    !Array.isArray(data.flow_snapshots)||!Array.isArray(data.outcome_checks))throw Error('INVALID_ARCHIVE');
 return {sha:r.sha,data};
}
async function putDay(day,updates,token){
 for(let attempt=0;attempt<4;attempt++){
  const current=await getDay(day,token);
  if(!current)throw Error('DAY_ARCHIVE_MISSING');
  const data=current.data,old=new Map(data.outcome_checks.map(x=>[x.signal_id,x]));
  let changed=0;
  for(const next of updates){
   const prev=old.get(next.signal_id);
   if(prev?.result===next.result&&prev?.resolution_hash===next.resolution_hash)continue;
   if(['PAYOUT_0','PAYOUT_1','PARTIAL_PAYOUT'].includes(prev?.result))continue;
   old.set(next.signal_id,next);changed++;
  }
  if(!changed)return {changed:0,total:data.outcome_checks.length};
  data.outcome_checks=[...old.values()].sort((a,b)=>a.signal_id.localeCompare(b.signal_id));
  const packed=zlib.gzipSync(Buffer.from(stringify(data)+'\n'),{level:9,mtime:0});
  if(packed.length>950000)throw Error('DAY_ARCHIVE_LIMIT');
  const body={message:'Reconcile verified Smart Money market resolutions '+day,
   content:packed.toString('base64'),sha:current.sha,branch:'main'};
  try{
   await gh('PUT',PREFIX+day+'.json.gz',body,token);
   return {changed,total:data.outcome_checks.length,sha256:hash(packed)};
  }catch(e){if(/GITHUB_PUT_(409|422)/.test(String(e.message))&&attempt<3){
    await sleep(900*(attempt+1));continue;
   }throw e}
 }
 throw Error('OUTCOME_ARCHIVE_CONFLICT');
}
async function refreshLatestIfMatching(day,archiveSha,token){
 const path=PREFIX+'LATEST.json';
 for(let i=0;i<3;i++){
  const current=await gh('GET',path,null,token);
  if(!current?.content)throw Error('HISTORY_LATEST_UNAVAILABLE');
  const latest=JSON.parse(Buffer.from(current.content.replace(/\s/g,''),'base64').toString('utf8'));
  if(latest.latest_day!==day)return {status:'NOT_LATEST_DAY'};
  latest.archive_sha256=archiveSha;
  latest.outcome_evidence_checked_at=new Date().toISOString();
  latest.outcome_matching='CTF_PAYOUTS_RECONCILED_WHEN_TOKEN_AND_TIME_VERIFIED';
  const content=Buffer.from(JSON.stringify(latest,null,2)+'\n').toString('base64');
  try{
   await gh('PUT',path,{branch:'main',sha:current.sha,
    message:'Synchronize durable Smart Money history head after payout evidence update',content},token);
   const check=await gh('GET',path,null,token);
   const echoed=JSON.parse(Buffer.from(check.content.replace(/\s/g,''),'base64').toString('utf8'));
   if(echoed.archive_sha256!==archiveSha)throw Error('OUTCOME_HEAD_READBACK_MISMATCH');
   return {status:'HEAD_READBACK_PASS'};
  }catch(e){
   if(/GITHUB_PUT_(409|422)/.test(String(e.message))&&i<2){await sleep(800*(i+1));continue}
   throw e;
  }
 }
 throw Error('OUTCOME_HEAD_WRITE_CONFLICT');
}
function eligibleDays(names,now=new Date()){
 const days=names.filter(n=>/^\d{4}-\d\d-\d\d\.json\.gz$/.test(n))
  .map(n=>n.slice(0,10)).filter(n=>(now-Date.parse(n+'T00:00:00Z'))/86400000<=90)
  .sort().reverse();
 const recent=days.slice(0,3);
 const older=days.slice(3);
 const step=Math.floor(now.getTime()/21600000);
 const rotate=older.length?older.slice(step%older.length).concat(older.slice(0,step%older.length)).slice(0,3):[];
 return [...new Set([...recent,...rotate])];
}
async function main(){
 const token=process.env.GITHUB_TOKEN||'';
 if(!token)throw Error('MISSING_GITHUB_TOKEN');
 if(process.env.GITHUB_REPOSITORY&&process.env.GITHUB_REPOSITORY!=='5pillars5/tkempire')throw Error('WRONG_REPO');
 const list=await gh('GET',PREFIX.slice(0,-1),null,token);
 if(list===null){console.log('SMARTMONEY_OUTCOME_MATCHER=NO_HISTORY_YET');return;}
 if(!Array.isArray(list))throw Error('HISTORY_DIRECTORY_INVALID');
 const days=eligibleDays(list.map(x=>x.name));
 let updated=0,checked=0,resolved=0,pending=0,unverified=0;
 const marketCache=new Map();
 for(const day of days){
  const original=await getDay(day,token);
  if(!original)continue;
  const prior=new Map(original.data.outcome_checks.map(x=>[x.signal_id,x]));
  const signals=original.data.signal_events.filter(s=>s.condition_id&&s.token_id&&
    !['PAYOUT_0','PAYOUT_1','PARTIAL_PAYOUT','EXCLUDED'].includes(prior.get(s.id)?.result));
  const updates=[];
  for(const sig of signals){
   if(checked>=24)break;
   if(!marketCache.has(sig.condition_id)){
    try{
     const [res,tokens]=await Promise.all([
      getData('/v2/resolutions',sig.condition_id),
      getData('/v2/tokens',sig.condition_id)
     ]);
     marketCache.set(sig.condition_id,{resolution:res.find(x=>String(x.condition_id).toLowerCase()===sig.condition_id)||null,tokens});
    }catch(e){
     marketCache.set(sig.condition_id,{resolution:null,tokens:null,error:String(e.message||e)});
    }
   }
   const market=marketCache.get(sig.condition_id);
   const outcome=matchResolution(sig,market.resolution,market.tokens);
   checked++;
   if(['PAYOUT_0','PAYOUT_1','PARTIAL_PAYOUT'].includes(outcome.result))resolved++;
   else if(outcome.result==='PENDING')pending++;
   else unverified++;
   updates.push({...outcome,checked_at:new Date().toISOString(),
    source:'POLYMARKET_V2_RESOLUTION_AND_TOKEN_CATALOG',
    history_event_origin:sig.source,execution_authority:'none'});
  }
  if(updates.length){
   const result=await putDay(day,updates,token);updated+=result.changed;
   if(result.changed>0){
    const headStatus=await refreshLatestIfMatching(day,result.sha256,token);
    console.log('SMARTMONEY_OUTCOME_ARCHIVE_READBACK '+JSON.stringify({
      day,changed:result.changed,sha256:result.sha256,latest_head:headStatus.status}));
   }
  }
  if(checked>=24)break;
 }
 console.log('SMARTMONEY_OUTCOME_MATCHER=PASS '+stringify({checked,
  reconciled_this_scan:resolved,pending,unverified,archived_updates:updated,
  days_considered:days,calibrated_probabilities:0,
  trade_profit_claims:0,trading_authority:'none'}));
}
if(require.main===module)main().catch(e=>{console.error('SMARTMONEY_OUTCOME_MATCHER=FAIL '+String(e.message||e));process.exitCode=1});
module.exports={eligibleDays,refreshLatestIfMatching};
