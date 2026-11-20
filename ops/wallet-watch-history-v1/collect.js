'use strict';
/* Independent scheduled public wallet observer.
 * Append-only UTC daily compressed archives in GitHub, read-back SHA-256,
 * then optional bounded Telegram digest. No VPS access, execution or signing.
 * Use only on protected main under unique Actions concurrency lock.
 */
const zlib=require('node:zlib');
const crypto=require('node:crypto');
const cohort=require('../../data/wallet-watchlist-v1.json');
const core=require('./history-core');
const {fixedWallets}=require('../../api/wallet-watch')._test;

const OWNER='5pillars5',REPO='tkempire',BRANCH='main';
const BASE='https://api.github.com/repos/'+OWNER+'/'+REPO+'/contents/';
const ORIGIN='https://data-api.polymarket.com/v2/activity';
const PREFIX='data/wallet-watch-history-v1/';
const MAX_PAGES=3, PAGE_LIMIT=200, WINDOW_SECONDS=86400;
const MAX_SOURCE_BYTES=950000,MAX_ARCHIVE_BYTES=950000;
const PAUSE_MS=900;
function sleep(ms){return new Promise(resolve=>setTimeout(resolve,ms));}
function archiveFile(day){return PREFIX+day+'.json.gz';}
function pathUri(path){return path.split('/').map(encodeURIComponent).join('/');}
function assertContext(env){
 if(!env.GITHUB_TOKEN)throw Error('MISSING_SCOPED_GITHUB_TOKEN');
 if(env.GITHUB_REPOSITORY&&env.GITHUB_REPOSITORY!==OWNER+'/'+REPO)throw Error('WRONG_REPO');
 if(env.GITHUB_REF&&env.GITHUB_REF!=='refs/heads/main')throw Error('WRONG_BRANCH');
 if(env.GITHUB_EVENT_NAME==='pull_request')throw Error('PR_WRITE_DISABLED');
}
async function github(method,path,body,token){
 const url=BASE+pathUri(path)+(method==='GET'?'?ref='+BRANCH:'');
 const r=await fetch(url,{
   method,redirect:'error',
   headers:{
     Authorization:'Bearer '+token,Accept:'application/vnd.github+json',
     'X-GitHub-Api-Version':'2022-11-28','Content-Type':'application/json'
   },
   body:body?JSON.stringify(body):undefined,
   signal:AbortSignal.timeout(20000)
 });
 if(method==='GET'&&r.status===404)return null;
 if(!r.ok)throw Error('GITHUB_'+method+'_'+r.status);
 return r.json();
}
async function readGithub(path,token,max=MAX_ARCHIVE_BYTES){
 const response=await github('GET',path,null,token);
 if(!response)return {sha:null,bytes:null};
 if(response.encoding!=='base64'||typeof response.content!=='string')throw Error('UNEXPECTED_GITHUB_SCHEMA');
 const bytes=Buffer.from(response.content.replace(/\s/g,''),'base64');
 if(bytes.length>max)throw Error('REPO_OBJECT_OVERSIZE');
 return {sha:response.sha,bytes};
}
async function saveGithub(path,bytes,token,description,{max=MAX_ARCHIVE_BYTES}={}){
 if(!Buffer.isBuffer(bytes)||bytes.length>max)throw Error('WRITE_SIZE_CAP');
 for(let attempt=0;attempt<4;attempt++){
   const existing=await readGithub(path,token,max);
   if(existing.bytes&&existing.bytes.equals(bytes))return {sha256:core.hash(bytes),unchanged:true};
   const body={message:description,content:bytes.toString('base64'),branch:BRANCH};
   if(existing.sha)body.sha=existing.sha;
   try{
     await github('PUT',path,body,token);
     const after=await readGithub(path,token,max);
     if(!after.bytes||core.hash(after.bytes)!==core.hash(bytes))throw Error('WRITE_READBACK_SHA_MISMATCH');
     return {sha256:core.hash(bytes),unchanged:false};
   }catch(e){
     if(/GITHUB_PUT_(409|422)/.test(String(e.message))&&attempt<3){await sleep(PAUSE_MS*(attempt+1));continue;}
     throw e;
   }
 }
 throw Error('REPO_WRITE_RETRY_EXHAUSTED');
}
async function readArchive(day,token) {
 const stored=await readGithub(archiveFile(day),token);
 if(!stored.bytes)return null;
 const decoded=zlib.gunzipSync(stored.bytes,{maxOutputLength:15000000});
 return core.validateArchive(JSON.parse(decoded.toString('utf8')),day);
}
async function mergeWriteDay(day,trades,at,token){
 const file=archiveFile(day);
 for(let attempt=0;attempt<4;attempt++){
   const current=await readGithub(file,token);
   const base=current.bytes?
     core.validateArchive(JSON.parse(zlib.gunzipSync(current.bytes,{maxOutputLength:15000000}).toString('utf8')),day):
     null;
   const merged=core.mergeArchive(base,day,trades,at);
   const bytes=zlib.gzipSync(Buffer.from(JSON.stringify(merged.archive)+'\n'),{level:9,mtime:0});
   if(bytes.length>MAX_ARCHIVE_BYTES)throw Error('DAILY_ARCHIVE_OVERSIZE');
   if(current.bytes&&current.bytes.equals(bytes))return {day,file,sha256:core.hash(bytes),count:merged.archive.events.length,new_events:0};
   const body={message:'Archive Wallet Watch observed fills '+day,
     branch:BRANCH,content:bytes.toString('base64')};
   if(current.sha)body.sha=current.sha;
   try{
     await github('PUT',file,body,token);
     const after=await readGithub(file,token);
     if(!after.bytes||core.hash(after.bytes)!==core.hash(bytes))throw Error('ARCHIVE_READBACK_SHA_MISMATCH');
     const verified=core.validateArchive(JSON.parse(zlib.gunzipSync(after.bytes,{maxOutputLength:15000000}).toString('utf8')),day);
     if(verified.events.length!==merged.archive.events.length)throw Error('ARCHIVE_READBACK_COUNT_MISMATCH');
     return {day,file,sha256:core.hash(bytes),count:merged.archive.events.length,new_events:merged.added.length};
   }catch(e){
     if(/GITHUB_PUT_(409|422)/.test(String(e.message))&&attempt<3){await sleep(PAUSE_MS*(attempt+1));continue;}
     throw e;
   }
 }
 throw Error('ARCHIVE_CONFLICT_RETRIES_EXHAUSTED');
}
async function fetchWallet(wallet,now){
 const seenCursors=new Set(),events=[],seen=new Set();
 let cursor=null,complete=true,pages=0;
 for(;pages<MAX_PAGES;pages++){
   const url=new URL(ORIGIN);
   const params={user:wallet,type:'TRADE',limit:PAGE_LIMIT,start:now-WINDOW_SECONDS,
     end:now+90,sort_by:'TIMESTAMP',sort_direction:'DESC'};
   for(const [k,v] of Object.entries(params))url.searchParams.set(k,String(v));
   if(cursor)url.searchParams.set('cursor',cursor);
   let data=null;
   for(let attempt=0;attempt<3;attempt++){
     try{
       const r=await fetch(url,{method:'GET',redirect:'error',
         headers:{Accept:'application/json'},signal:AbortSignal.timeout(14500)});
       if(!r.ok){
         if((r.status===429||r.status===503)&&attempt<2){
           const backoff=Number(r.headers.get('retry-after')||0);
           await sleep(Math.min(4500,Math.max(PAUSE_MS*(attempt+1),backoff*1000)));continue;
         }
         throw Error('POLYMARKET_HTTP_'+r.status);
       }
       const length=Number(r.headers.get('content-length'));
       if(Number.isFinite(length)&&length>MAX_SOURCE_BYTES)throw Error('SOURCE_RESPONSE_TOO_LARGE');
       const raw=await r.text();
       if(Buffer.byteLength(raw)>MAX_SOURCE_BYTES)throw Error('SOURCE_RESPONSE_TOO_LARGE');
       data=JSON.parse(raw);break;
     }catch(e){if(attempt===2)throw e;await sleep(PAUSE_MS*(attempt+1));}
   }
   if(!data||!Array.isArray(data.data)||data.data.length>PAGE_LIMIT||
      !data.pagination||typeof data.pagination!=='object')throw Error('INVALID_POLYMARKET_PAGINATION');
   for(const item of core.sanitizeBatch(data.data,wallet,now)){
     if(!seen.has(item.id)){seen.add(item.id);events.push(item);}
   }
   if(data.pagination.has_more!==true){complete=true;break;}
   if(typeof data.pagination.next_cursor!=='string'||!data.pagination.next_cursor||
      data.pagination.next_cursor.length>2048||seenCursors.has(data.pagination.next_cursor))throw Error('INVALID_OR_REPEATED_CURSOR');
   cursor=data.pagination.next_cursor;seenCursors.add(cursor);
   complete=false;
 }
 return {wallet,events,complete,pages:Math.min(MAX_PAGES,pages+1)};
}
async function readJson(path,token){
 const data=await readGithub(path,token,400000);
 if(!data.bytes)return null;
 return JSON.parse(data.bytes.toString('utf8'));
}
async function storeJson(path,object,token,message){
 return saveGithub(path,Buffer.from(JSON.stringify(object,null,2)+'\n'),token,message,{max:400000});
}
async function notifyTelegram(text,env){
 const token=env.WALLET_WATCH_TELEGRAM_BOT_TOKEN;
 const chat=env.WALLET_WATCH_TELEGRAM_CHAT_ID;
 if(!/^\d{6,20}:[A-Za-z0-9_-]{25,}$/.test(token||'')||
    !/^-?\d{5,20}$/.test(chat||''))throw Error('TELEGRAM_DESTINATION_NOT_CONFIGURED');
 const r=await fetch('https://api.telegram.org/bot'+token+'/sendMessage',{
   method:'POST',redirect:'error',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({chat_id:chat,text,parse_mode:'HTML',disable_web_page_preview:true}),
   signal:AbortSignal.timeout(12000)
 });
 // Never log the URL, token, raw response, or chat ID.
 if(!r.ok)throw Error('TELEGRAM_SEND_HTTP_'+r.status);
 const body=await r.json();
 if(body.ok!==true||!Number.isInteger(body.result?.message_id))throw Error('TELEGRAM_NOT_CONFIRMED');
 return {message_id:body.result.message_id};
}
async function run({env=process.env,now=Math.floor(Date.now()/1000)}={}){
 assertContext(env);
 const token=env.GITHUB_TOKEN;
 const capturedAt=new Date(now*1000).toISOString();
 const wallets=fixedWallets();
 if(wallets.length>12)throw Error('COHORT_LIMIT');
 const reads=await Promise.allSettled(wallets.map(w=>fetchWallet(w.wallet,now)));
 const gathered=[],coverage=[];
 for(let i=0;i<reads.length;i++){
   if(reads[i].status==='fulfilled'){
     gathered.push(...reads[i].value.events);
     coverage.push({wallet:wallets[i].wallet,status:reads[i].value.complete?'ok':'truncated',
       pages:reads[i].value.pages,sampled:reads[i].value.events.length});
   }else coverage.push({wallet:wallets[i].wallet,status:'unavailable',pages:0,sampled:null});
 }
 const successes=coverage.filter(x=>x.status!=='unavailable').length;
 if(!successes)throw Error('ALL_SOURCE_FEEDS_UNAVAILABLE');
 const unique=new Map(gathered.map(t=>[t.id,t]));
 const groups=new Map();
 for(const item of unique.values()){
   const day=new Date(item.timestamp*1000).toISOString().slice(0,10);
   if(!groups.has(day))groups.set(day,[]);
   groups.get(day).push(item);
 }
 // GitHub archive is a durable append-only observation mirror; never delete prior records.
 const saved=[];
 for(const day of [...groups.keys()].sort()){
   saved.push(await mergeWriteDay(day,groups.get(day),capturedAt,token));
 }
 const latest={
   schema_version:1,source:'PUBLIC_POLYMARKET_WALLET_WATCH',
   cohort_id:cohort.cohort_id,at:capturedAt,archive_days:saved,
   successful_wallets:successes,monitored_wallets:wallets.length,
   incomplete:coverage.some(x=>x.status!=='ok'),
   coverage,scan_trades:unique.size,execution_authority:'none',
   collection_window_seconds:WINDOW_SECONDS,
   history_limitations:'Up to 3 keyset pages of 200 activities per wallet per scan; missed observations are possible.'
 };
 const headFile=PREFIX+'LATEST.json';
 await storeJson(headFile,latest,token,'Update Wallet Watch archive verification head');
 const head=await readJson(headFile,token);
 if(head?.at!==latest.at||head.cohort_id!==cohort.cohort_id||
    head.scan_trades!==latest.scan_trades)throw Error('ARCHIVE_HEAD_READBACK_FAIL');
 console.log('WALLET_WATCH_ARCHIVE_READBACK=PASS '+JSON.stringify({
   at:capturedAt,successes,monitored:wallets.length,
   incomplete:latest.incomplete,days:saved.map(x=>({day:x.day,count:x.count,new_events:x.new_events,sha256:x.sha256}))
 }));
 // No sending on PR builds, unconfirmed destinations, or first successful run.
 const alertsEnabled=env.WALLET_WATCH_ALERTS_ENABLED==='true';
 if(!alertsEnabled){
   console.log('TELEGRAM_ALERTS=DISABLED_NO_SEND');
   return {archive:latest,telegram:'disabled'};
 }
 if(successes!==wallets.length || latest.incomplete)throw Error('ALERTS_PAUSED_INCOMPLETE_COVERAGE');
 if(!env.WALLET_WATCH_TELEGRAM_BOT_TOKEN||!env.WALLET_WATCH_TELEGRAM_CHAT_ID)
   throw Error('ALERTS_ENABLED_BUT_DESTINATION_MISSING');
 const file=PREFIX+'DELIVERY.json';
 let delivery=await readJson(file,token);
 if(!delivery){
   delivery=core.initialDeliveryLedger(capturedAt);
   await storeJson(file,delivery,token,'Initialize Wallet Watch Telegram baseline; no backfill');
   console.log('TELEGRAM_BASELINE=PASS NO_HISTORICAL_ALERTS');
   return {archive:latest,telegram:'baseline'};
 }
 // Pick up previously archived but unsent events after partial send failures.
 const recentDays=[new Date(now*1000).toISOString().slice(0,10),
   new Date((now-86400)*1000).toISOString().slice(0,10)];
 const recent=[];
 for(const day of [...new Set(recentDays)]){
   const a=await readArchive(day,token);
   if(a)recent.push(...a.events);
 }
 const pending=core.planDelivery(recent,delivery,now,{minAmount:250,maxAgeSeconds:1800});
 const candidates=pending.candidates;
 if(!candidates.length){
   console.log('TELEGRAM_PENDING=0');
   return {archive:latest,telegram:'no_new_eligible'};
 }
 if(candidates.length>150)throw Error('ALERT_BACKLOG_CAP_REQUIRES_REVIEW');
 const aliases=new Map(wallets.map(w=>[w.wallet,w.name]));
 const body=core.telegramDigest(candidates.map(x=>({...x,name:aliases.get(x.wallet)})),{minAmount:250,limit:10});
 await notifyTelegram(body,env);
 const acknowledged=core.acknowledge(delivery,candidates.map(x=>x.id),now);
 await storeJson(file,acknowledged,token,'Acknowledge Wallet Watch Telegram digest');
 const confirmed=await readJson(file,token);
 if(!confirmed || candidates.some(x=>!confirmed.acknowledged[x.id]))throw Error('DELIVERY_ACK_READBACK_FAIL');
 console.log('TELEGRAM_DIGEST=PASS ACK_READBACK=PASS count='+candidates.length);
 return {archive:latest,telegram:'sent',sent:candidates.length};
}
if(require.main===module)run().catch(e=>{
 // Sanitize error; never emit upstream URLs or bot tokens.
 const allowed=String(e.message||e).replace(/https?:\/\/\S+/g,'[URL]').slice(0,190);
 console.error('WALLET_WATCH_COLLECTOR=FAIL '+allowed);
 process.exitCode=1;
});
module.exports={run,fetchWallet,mergeWriteDay,notifyTelegram};
