'use strict';
/* Durable public Smart Money history writer.
 * No trading keys or VPS access. Saves compressed daily immutable 15-minute
 * observations via GitHub Contents API using the job-scoped GITHUB_TOKEN.
 * One scheduled writer at a time. No force pushes, no automatic deletions.
 */
const zlib=require('node:zlib');
const {validateFlow,validateSignalFeed,mergeDay,hash}=require('./history-core');
const OWNER='5pillars5',REPO='tkempire';
const BASE='https://api.github.com/repos/'+OWNER+'/'+REPO+'/contents/';
const UPSTREAM='https://www.tkempire.io/api/';
const PATH='data/smart-money-history-v1/';
function sleep(ms){return new Promise(resolve=>setTimeout(resolve,ms))}
async function getFeed(endpoint,attempts=3){
 const url=UPSTREAM+endpoint;
 for(let i=0;i<attempts;i++){
  try{
   const r=await fetch(url,{method:'GET',redirect:'error',
    headers:{Accept:'application/json'},signal:AbortSignal.timeout(15000)});
   if(!r.ok)throw Error('HTTP_'+r.status);
   const raw=await r.text();
   if(Buffer.byteLength(raw)>3e6)throw Error('FEED_OVERSIZED');
   return JSON.parse(raw);
  }catch(e){if(i===attempts-1)throw Error('SOURCE_'+endpoint+'_'+String(e.message||e));await sleep(1200*(i+1))}
 }
}
async function github(method,file,data,token){
 const url=BASE+file.split('/').map(encodeURIComponent).join('/')+
  (method==='GET'?'?ref=main':'');
 const r=await fetch(url,{method,headers:{
  Accept:'application/vnd.github+json',
  Authorization:'Bearer '+token,
  'X-GitHub-Api-Version':'2022-11-28',
  'Content-Type':'application/json'},
  body:data?JSON.stringify(data):undefined,signal:AbortSignal.timeout(22000)});
 if(r.status===404&&method==='GET')return null;
 if(!r.ok)throw Error('GITHUB_'+method+'_'+r.status);
 return r.json();
}
async function readDay(file,token){
 const content=await github('GET',file,null,token);
 if(!content)return {sha:null,data:null};
 if(!content.content||content.encoding!=='base64')throw Error('UNEXPECTED_GITHUB_CONTENT_RESPONSE');
 const raw=Buffer.from(content.content.replace(/\s/g,''),'base64');
 if(raw.length>1200000)throw Error('COMPRESSED_DAY_TOO_LARGE');
 const decoded=zlib.gunzipSync(raw,{maxOutputLength:15000000});
 return {sha:content.sha,archive_sha256:hash(raw),data:JSON.parse(decoded.toString('utf8'))};
}
async function putDay(file,day,token){
 const archive=zlib.gzipSync(Buffer.from(JSON.stringify(day)+'\n'),{level:9,mtime:0});
 if(archive.length>950000)throw Error('DAY_ARCHIVE_LIMIT_REACHED');
 for(let attempt=0;attempt<4;attempt++){
  const current=await readDay(file,token);
  const merged=mergeDay(current.data,day.flow_snapshots[0],{signals:day.signal_events},day.day+'T23:59:59Z');
  const output=zlib.gzipSync(Buffer.from(JSON.stringify(merged)+'\n'),{level:9,mtime:0});
  if(output.length>950000)throw Error('DAY_ARCHIVE_LIMIT_REACHED');
  const body={message:'Archive observed Genesis Smart Money history '+day.day,
   content:output.toString('base64'),branch:'main'};
  if(current.sha)body.sha=current.sha;
  try{
   await github('PUT',file,body,token);
   return {snapshots:merged.flow_snapshots.length,signals:merged.signal_events.length,sha256:hash(output),size:output.length};
  }catch(e){
   if(/GITHUB_PUT_(409|422)/.test(String(e.message))&&attempt<3){await sleep(900*(attempt+1));continue}
   throw e;
  }
 }
 throw Error('GITHUB_WRITE_RETRIES_EXHAUSTED');
}
async function putLatest(obj,token){
 const file=PATH+'LATEST.json';
 for(let i=0;i<3;i++){
  const current=await github('GET',file,null,token);
  const body={message:'Update Genesis Smart Money history read-only head',
   content:Buffer.from(JSON.stringify(obj,null,2)+'\n').toString('base64'),branch:'main'};
  if(current?.sha)body.sha=current.sha;
  try{return await github('PUT',file,body,token)}catch(e){
   if(/GITHUB_PUT_(409|422)/.test(String(e.message))&&i<2){await sleep(800*(i+1));continue}
   throw e;
  }
 }
}
async function main(){
 const token=process.env.GITHUB_TOKEN||'';
 if(!token)throw Error('MISSING_JOB_SCOPED_GITHUB_TOKEN');
 if(process.env.GITHUB_REPOSITORY&&process.env.GITHUB_REPOSITORY!==OWNER+'/'+REPO)throw Error('WRONG_REPOSITORY');
 if(process.env.GITHUB_REF&&process.env.GITHUB_REF!=='refs/heads/main')throw Error('NOT_PROTECTED_MAIN');
 // Feed clock is compared to runner clock; do not fabricate timestamps.
 const now=Math.floor(Date.now()/1000);
 const [flowRaw,signalRaw]=await Promise.all([getFeed('smart-money-flow'),getFeed('smart-money-signals')]);
 const flow=validateFlow(flowRaw,now),signal=validateSignalFeed(signalRaw,now);
 // Preserve first actual historian capture time independently of source
 // generation time, preventing post-resolution hindsight classification.
 const capturedAt=new Date().toISOString();
 for(const event of signal.signals){
  event.source_feed_generated_at=event.captured_at;
  event.captured_at=capturedAt;
 }
 const day=flow.at.slice(0,10);
 if(signal.at.slice(0,10)!==day)throw Error('CROSS_DAY_CAPTURE_RETRY_NEXT_WINDOW');
 const input=mergeDay(null,flow,signal,day+'T23:59:59Z');
 const file=PATH+day+'.json.gz';
 const written=await putDay(file,input,token);
 const latest={schema_version:1,source:'GITHUB_PUBLIC_OBSERVATION_MIRROR',
  source_links:['/api/smart-money-flow','/api/smart-money-signals'],
  latest_day:day,latest_bucket_utc:flow.bucket,
  written_at:new Date().toISOString(),flow_status:flow.status,
  coverage:flow.coverage,signal_count_current_read:signal.signals.length,
  archived_snapshots_this_day:written.snapshots,archived_signals_this_day:written.signals,
  archive_path:file,archive_sha256:written.sha256,
  legacy_vps_sqlite_import:'NOT_YET_CONNECTED',
  outcome_matching:'NOT_SCORED_WITHOUT_TOKEN_CATALOG',
  trading_authority:'none',market_probability_calibration:'NOT_VERIFIED'};
 await putLatest(latest,token);
 // Verify durable GitHub readback; a successful PUT alone is not an archive checkpoint.
 const after=await readDay(file,token);
 if(!after?.data||after.data.day!==day||
    after.data.flow_snapshots.length!==written.snapshots||
    after.data.signal_events.length!==written.signals||
    after.archive_sha256!==written.sha256)throw Error('ARCHIVE_READBACK_MISMATCH');
 const stored=await github('GET',PATH+'LATEST.json',null,token);
 if(!stored?.content||stored.encoding!=='base64')throw Error('ARCHIVE_HEAD_UNREADABLE');
 const head=JSON.parse(Buffer.from(stored.content.replace(/\s/g,''),'base64').toString('utf8'));
 if(head.archive_path!==file||head.archive_sha256!==written.sha256||
    head.archived_snapshots_this_day!==written.snapshots)throw Error('ARCHIVE_HEAD_READBACK_MISMATCH');
 console.log('ARCHIVE_READBACK=PASS HEAD_READBACK=PASS '+JSON.stringify({
    day,stored_snapshots:after.data.flow_snapshots.length,
    stored_signals:after.data.signal_events.length,compressed_sha256:written.sha256}));
 console.log('SMARTMONEY_HISTORY_WRITE=PASS '+JSON.stringify({
  day,archive:file,bucket:flow.bucket,snapshots:written.snapshots,signals:written.signals,
  compressed_sha256:written.sha256,legacy_import:'NOT_YET_CONNECTED',
  probability:'NOT_CALIBRATED',trading_authority:'none'}));
}
if(require.main===module)main().catch(e=>{console.error('SMARTMONEY_HISTORY_WRITE=FAIL '+String(e.message||e));process.exitCode=1});
module.exports={getFeed,readDay,putDay};
