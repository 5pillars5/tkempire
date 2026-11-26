'use strict';
/* Durable public Smart Money history writer.
 * No trading keys or VPS access. Saves compressed daily immutable 15-minute
 * observations via atomic Git data commits using the job-scoped GITHUB_TOKEN.
 * One scheduled writer at a time. No force pushes, no automatic deletions.
 */
const {validateFlow,validateSignalFeed}=require('./history-core');
const {createStore,githubRequest,archivePath}=require('./archive-transaction');
const OWNER='5pillars5',REPO='tkempire';
const UPSTREAM='https://www.tkempire.io/api/';
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
 const store=createStore(githubRequest(token));
 const file=archivePath(day);
 const written=await store.writeObservation(day,flow,signal,capturedAt);
 console.log('ARCHIVE_READBACK=PASS '+written.head+' '+JSON.stringify({
    day,commit:written.commit,stored_snapshots:written.snapshots,
    stored_signals:written.signals,compressed_sha256:written.sha256}));
 console.log('SMARTMONEY_HISTORY_WRITE=PASS '+JSON.stringify({
  day,archive:file,bucket:flow.bucket,snapshots:written.snapshots,signals:written.signals,
  compressed_sha256:written.sha256,legacy_import:'NOT_YET_CONNECTED',
  probability:'NOT_CALIBRATED',trading_authority:'none'}));
}
if(require.main===module)main().catch(e=>{console.error('SMARTMONEY_HISTORY_WRITE=FAIL '+String(e.message||e));process.exitCode=1});
module.exports={getFeed};
