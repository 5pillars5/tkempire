'use strict';
/* Atomic public-observation archive writer. No VPS, order, or trading access.
 * Each transaction merges against one immutable main commit and publishes the
 * archive and its matching head in a single non-force fast-forward ref update.
 * A competing writer forces a fresh read/merge; immutable readback never uses
 * mutable main and cannot be invalidated by a later legitimate commit.
 */
const zlib=require('node:zlib');
const crypto=require('node:crypto');
const {mergeDay,hash}=require('./history-core');
const PREFIX='data/smart-money-history-v1/';
const HEAD=PREFIX+'LATEST.json';
const REPO='5pillars5/tkempire';
const SHA=/^[a-f0-9]{40}$/;
const DAY=/^\d{4}-\d{2}-\d{2}$/;
const FINAL=new Set(['PAYOUT_0','PAYOUT_1','PARTIAL_PAYOUT','EXCLUDED']);
const PAYOUT=new Set(['PAYOUT_0','PAYOUT_1','PARTIAL_PAYOUT']);
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const pathEncode=p=>p.split('/').map(encodeURIComponent).join('/');
function checkedSha(s){
 if(typeof s!=='string'||!SHA.test(s))throw Error('INVALID_GIT_OBJECT_SHA');
 return s;
}
function archivePath(day){
 if(typeof day!=='string'||!DAY.test(day))throw Error('INVALID_ARCHIVE_DAY');
 return PREFIX+day+'.json.gz';
}
function gitBlobSha(bytes){
 return crypto.createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex');
}
function githubRequest(token){
 if(!token)throw Error('MISSING_JOB_SCOPED_GITHUB_TOKEN');
 if(process.env.GITHUB_REPOSITORY&&process.env.GITHUB_REPOSITORY!==REPO)throw Error('WRONG_REPOSITORY');
 if(process.env.GITHUB_REF&&process.env.GITHUB_REF!=='refs/heads/main')throw Error('NOT_PROTECTED_MAIN');
 return async(method,path,body)=>{
  const r=await fetch('https://api.github.com/repos/'+REPO+'/'+path,{
   method,redirect:'error',cache:'no-store',headers:{
    Authorization:'Bearer '+token,Accept:'application/vnd.github+json',
    'X-GitHub-Api-Version':'2022-11-28','Content-Type':'application/json','Cache-Control':'no-cache'
   },body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(22000)});
  if(!r.ok){
   const e=Error('GITHUB_'+method+'_'+r.status);e.status=r.status;throw e;
  }
  return r.json();
 };
}
async function mainRef(request){
 const r=await request('GET','git/ref/heads/main');
 if(r?.ref!=='refs/heads/main'||r.object?.type!=='commit')throw Error('INVALID_MAIN_REF');
 return checkedSha(r.object.sha);
}
async function readBytes(request,path,commit){
 checkedSha(commit);
 let r;
 try{r=await request('GET','contents/'+pathEncode(path)+'?ref='+commit)}
 catch(e){if(e.status===404)return null;throw e}
 if(!r||r.encoding!=='base64'||typeof r.content!=='string'||r.type!=='file')throw Error('INVALID_CONTENT_RESPONSE');
 const bytes=Buffer.from(r.content.replace(/\s/g,''),'base64');
 if(bytes.length>1200000||r.size!==bytes.length||gitBlobSha(bytes)!==checkedSha(r.sha))throw Error('CONTENT_BLOB_INTEGRITY_FAILURE');
 return bytes;
}
function unique(items,key){
 const seen=new Set();
 for(const item of items){
  const k=item?.[key];
  if(k===null||k===undefined||k===''||seen.has(k))throw Error('INVALID_OR_DUPLICATE_EVIDENCE_'+key);
  seen.add(k);
 }
 return seen;
}
function decodeDay(bytes,day){
 if(bytes===null)return null;
 const d=JSON.parse(zlib.gunzipSync(bytes,{maxOutputLength:15000000}).toString('utf8'));
 if(d?.schema_version!==1||d.day!==day||!Array.isArray(d.flow_snapshots)||
    !Array.isArray(d.signal_events)||!Array.isArray(d.outcome_checks))throw Error('INVALID_ARCHIVE');
 unique(d.flow_snapshots,'bucket');
 const ids=unique(d.signal_events,'id');
 unique(d.outcome_checks,'signal_id');
 if(d.outcome_checks.some(x=>!ids.has(x.signal_id)))throw Error('OUTCOME_WITHOUT_SIGNAL');
 return d;
}
function decodeHead(bytes){
 if(bytes===null)return null;
 const d=JSON.parse(bytes.toString('utf8'));
 if(d?.schema_version!==1||!DAY.test(d.latest_day||'')||
    d.archive_path!==archivePath(d.latest_day))throw Error('INVALID_HISTORY_HEAD');
 return d;
}
function pack(data){
 const bytes=zlib.gzipSync(Buffer.from(JSON.stringify(data)+'\n'),{level:9,mtime:0});
 if(bytes.length>950000)throw Error('DAY_ARCHIVE_LIMIT');
 return bytes;
}
function mergeOutcomes(data,updates){
 if(!data)throw Error('DAY_ARCHIVE_MISSING');
 const result=structuredClone(data);
 const signals=new Map(result.signal_events.map(x=>[x.id,x]));
 const checks=new Map(result.outcome_checks.map(x=>[x.signal_id,x]));
 let changed=0;
 for(const next of updates){
  const sig=signals.get(next.signal_id);
  if(!sig||sig.condition_id!==next.condition_id||sig.token_id!==next.token_id||
     next.execution_authority!=='none')throw Error('OUTCOME_IDENTITY_MISMATCH');
  const prev=checks.get(next.signal_id);
  if(FINAL.has(prev?.result))continue;
  if(prev?.result===next.result&&prev?.resolution_hash===next.resolution_hash)continue;
  checks.set(next.signal_id,next);changed++;
 }
 result.outcome_checks=[...checks.values()].sort((a,b)=>a.signal_id.localeCompare(b.signal_id));
 return {data:result,changed};
}
function deriveHead(previous,data,archive,observation){
 const same=previous?.latest_day===data.day;
 const latest=data.flow_snapshots.reduce((best,x)=>!best||x.bucket>best.bucket?x:best,null);
 if(!latest)throw Error('HEAD_WITHOUT_FLOW_SNAPSHOT');
 const head={
  ...(same?previous:{}),schema_version:1,source:'GITHUB_PUBLIC_OBSERVATION_MIRROR',
  source_links:['/api/smart-money-flow','/api/smart-money-signals'],
  latest_day:data.day,latest_bucket_utc:latest.bucket,
  flow_status:latest.status,coverage:latest.coverage,
  archived_snapshots_this_day:data.flow_snapshots.length,
  archived_signals_this_day:data.signal_events.length,
  archive_path:archivePath(data.day),archive_sha256:hash(archive),
  legacy_vps_sqlite_import:previous?.legacy_vps_sqlite_import??'NOT_YET_CONNECTED',
  trading_authority:'none',market_probability_calibration:'NOT_VERIFIED'
 };
 // Do not copy an older observation's source counts over a newer captured bucket.
 if(observation&&observation.flow.bucket===latest.bucket&&
    (!same||previous.latest_bucket_utc!==latest.bucket||
     previous.signal_count_current_read===undefined)){
  head.signal_count_current_read=observation.signals.signals.length;
 }
 if(observation&&(!same||!head.written_at||
    Date.parse(observation.at)>Date.parse(head.written_at))){
  head.written_at=observation.at;
 }
 if(!head.written_at)head.written_at=latest.at;
 const checks=data.outcome_checks;
 head.outcome_matching=checks.length?'CTF_PAYOUTS_RECONCILED_WHEN_TOKEN_AND_TIME_VERIFIED':'NOT_SCORED_WITHOUT_TOKEN_CATALOG';
 head.outcome_checks_this_day=checks.length;
 head.verified_outcomes_this_day=checks.filter(x=>PAYOUT.has(x.result)).length;
 head.pending_outcomes_this_day=checks.filter(x=>x.result==='PENDING').length;
 head.excluded_outcomes_this_day=checks.filter(x=>x.result==='EXCLUDED').length;
 head.unverified_outcomes_this_day=checks.length-head.verified_outcomes_this_day-
  head.pending_outcomes_this_day-head.excluded_outcomes_this_day;
 const times=checks.map(x=>x.checked_at).filter(x=>typeof x==='string'&&Number.isFinite(Date.parse(x)));
 if(times.length)head.outcome_evidence_checked_at=new Date(Math.max(...times.map(Date.parse))).toISOString();
 else delete head.outcome_evidence_checked_at;
 return head;
}
async function readback(request,commit,expected,{sleep=pause,attempts=4}={}){
 let last;
 for(let i=0;i<attempts;i++){
  try{
   for(const [path,bytes] of expected){
    const actual=await readBytes(request,path,commit);
    if(bytes===null?actual!==null:!actual||!actual.equals(bytes))throw Error('IMMUTABLE_CONTENT_MISMATCH');
   }
   return;
  }catch(e){last=e;if(i+1<attempts)await sleep(350*(i+1))}
 }
 throw Error('IMMUTABLE_ARCHIVE_READBACK_FAILED: '+String(last?.message||last));
}
async function commitFiles(request,parent,files,message){
 const base=await request('GET','git/commits/'+checkedSha(parent));
 if(base.sha!==parent)throw Error('BASE_COMMIT_MISMATCH');
 const entries=[];
 for(const [path,bytes] of files){
  const blob=await request('POST','git/blobs',{content:bytes.toString('base64'),encoding:'base64'});
  if(checkedSha(blob.sha)!==gitBlobSha(bytes))throw Error('WRITTEN_BLOB_MISMATCH');
  entries.push({path,mode:'100644',type:'blob',sha:blob.sha});
 }
 const tree=await request('POST','git/trees',{base_tree:checkedSha(base.tree?.sha),tree:entries});
 const commit=await request('POST','git/commits',{message,tree:checkedSha(tree.sha),parents:[parent]});
 const sha=checkedSha(commit.sha);
 if(commit.tree?.sha!==tree.sha||commit.parents?.length!==1||commit.parents[0].sha!==parent)
  throw Error('CREATED_COMMIT_MISMATCH');
 let ref;
 try{ref=await request('PATCH','git/refs/heads/main',{sha,force:false})}
 catch(e){if(e.status===409||e.status===422)return {conflict:true};throw e}
 if(ref?.ref!=='refs/heads/main'||ref.object?.sha!==sha)throw Error('REF_UPDATE_READBACK_MISMATCH');
 return {sha};
}
function createStore(request,{sleep=pause,attempts=5,readbackAttempts=4}={}){
 async function transact(day,mutation,observation,message){
  const path=archivePath(day);
  for(let i=0;i<attempts;i++){
   const parent=await mainRef(request);
   const [priorArchive,priorHead]=await Promise.all([readBytes(request,path,parent),readBytes(request,HEAD,parent)]);
   const existing=decodeDay(priorArchive,day),head=decodeHead(priorHead);
   const {data,changed}=mutation(existing);
   const archive=existing&&JSON.stringify(existing)===JSON.stringify(data)?priorArchive:pack(data);
   // Validate before writing and preserve old-day pointer exactly.
   decodeDay(archive,day);
   if(!head&&!observation)throw Error('HISTORY_LATEST_UNAVAILABLE');
   const current=!head||head.latest_day===day||Boolean(observation&&day>head.latest_day);
   if(!current&&day>head.latest_day)throw Error('HISTORY_HEAD_BEHIND_DAY');
   const headBytes=current?Buffer.from(JSON.stringify(deriveHead(head,data,archive,observation),null,2)+'\n'):priorHead;
   const expected=[[path,archive],[HEAD,headBytes]];
   const files=expected.filter(([p,b])=>{
    const old=p===path?priorArchive:priorHead;
    return b!==null&&(!old||!old.equals(b));
   });
   let commit=parent;
   if(files.length){
    const result=await commitFiles(request,parent,files,message);
    if(result.conflict){if(i+1<attempts){await sleep(300*(i+1));continue}throw Error('ARCHIVE_REF_CONFLICT_RETRIES_EXHAUSTED')}
    commit=result.sha;
   }
   await readback(request,commit,expected,{sleep,attempts:readbackAttempts});
   return {commit,changed,snapshots:data.flow_snapshots.length,signals:data.signal_events.length,
    sha256:hash(archive),size:archive.length,head:current?'HEAD_READBACK_PASS':'NOT_LATEST_DAY',wrote:files.length>0};
  }
  throw Error('ARCHIVE_REF_CONFLICT_RETRIES_EXHAUSTED');
 }
 return {
  async listDays(){
   const commit=await mainRef(request);
   let list;
   try{list=await request('GET','contents/'+pathEncode(PREFIX.slice(0,-1))+'?ref='+commit)}
   catch(e){if(e.status===404)return {commit,names:[]};throw e}
   if(!Array.isArray(list))throw Error('HISTORY_DIRECTORY_INVALID');
   return {commit,names:list.map(x=>x.name)};
  },
  async readDay(day,commit){return decodeDay(await readBytes(request,archivePath(day),commit||await mainRef(request)),day)},
  writeObservation(day,flow,signals,at){
   return transact(day,existing=>{
    const data=mergeDay(existing,flow,signals,day+'T23:59:59Z');
    return {data,changed:data.flow_snapshots.length-(existing?.flow_snapshots.length||0)+
     data.signal_events.length-(existing?.signal_events.length||0)};
   },{flow,signals,at},'Atomically archive Genesis Smart Money observations '+day);
  },
  writeOutcomes(day,updates){
   return transact(day,existing=>mergeOutcomes(existing,updates),null,
    'Atomically reconcile Smart Money outcome evidence '+day);
  }
 };
}
module.exports={createStore,githubRequest,gitBlobSha,archivePath,HEAD,PREFIX,decodeDay,deriveHead,mergeOutcomes};
