'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const zlib=require('node:zlib');
const fs=require('node:fs');
const path=require('node:path');
const core=require('../ops/wallet-watch-history-v1/history-core');
const collector=require('../ops/wallet-watch-history-v1/collect');
const histApi=require('../api/wallet-watch-history');
const cohort=require('../data/wallet-watchlist-v1.json');
const now=1795207000;
const wallet=cohort.wallets[0].wallet;
const TX = id => '0x'+id.toString(16).padStart(64,'0');
function rawTrade(id, timestamp=now-20, usdc=330) {
 return {type:'TRADE',proxy_wallet:wallet,side:'BUY',usdc_size:usdc,timestamp,
   transaction_hash:TX(id),condition_id:'0x'+'a'.repeat(64),
   token_id:'1234',size:usdc*2,price:.5,title:'Will market X close above target?',
   outcome:'Yes',event_slug:'sample-market'};
}
function sample(id,stamp=now-20) {
 return core.sanitizeBatch([rawTrade(id,stamp)],wallet,now)[0];
}
test('stable id + exact-wallet validation + on-chain proof',()=>{
 const one=core.sanitizeBatch([rawTrade(1),rawTrade(1),rawTrade(2),{...rawTrade(3),proxy_wallet:'0x'+'f'.repeat(40)}],wallet,now);
 assert.equal(one.length,2);assert.notEqual(one[0].id,one[1].id);
 assert.throws(()=>core.sanitizeBatch([], 'invalid',now),/INVALID_SOURCE_BATCH/);
});
test('UTC daily history append is immutable and deduplicated across rescans',()=>{
 const t=sample(1),day=new Date(t.timestamp*1000).toISOString().slice(0,10);
 const start=new Date(now*1000).toISOString();
 const first=core.mergeArchive(null,day,[t],start);
 assert.equal(first.added.length,1);
 const second=core.mergeArchive(first.archive,day,[t],new Date((now+500)*1000).toISOString());
 assert.equal(second.added.length,0);
 assert.equal(second.archive.events[0].first_observed_at,start);
 core.validateArchive(second.archive,day);
 const corrupt=structuredClone(second.archive);
 corrupt.events[0].amount_usdc=9999;
 assert.throws(()=>core.validateArchive(corrupt,day),/CORRUPT_ARCHIVE_EVENT/);
});
test('alert bootstrap is silent and idempotent with bounded recent selection',()=>{
 const base=core.planDelivery([],null,now);
 assert.equal(base.bootstrap,true);assert.deepEqual(base.candidates,[]);
 const t=sample(2),day=new Date(t.timestamp*1000).toISOString().slice(0,10);
 const seen=core.mergeArchive(null,day,[t],new Date((now+10)*1000).toISOString()).archive.events;
 const r=core.planDelivery(seen,base.ledger,now+20);
 assert.equal(r.candidates.length,1);
 const ack=core.acknowledge(r.ledger,r.candidates.map(x=>x.id),now+20);
 assert.equal(core.planDelivery(seen,ack,now+100).candidates.length,0);
 assert.equal(core.planDelivery(seen,ack,now+2500).candidates.length,0);
});
test('Telegram HTML escapes public titles; no unverified claims',()=>{
 const t={...sample(3),name:'<script> & Wallet',market:'a <b>prediction</b>'};
 const out=core.telegramDigest([t]);
 assert.match(out,/&lt;script&gt; &amp; Wallet/);
 assert.doesNotMatch(out,/<script>|<b>prediction<\/b>/);
 assert.match(out,/Public observations, not trading signals/);
});
test('cursor pagination follows opaque next_cursor; repeats rejected',async()=>{
 const old=global.fetch;let calls=0;
 global.fetch=async url=>{
   const u=new URL(String(url));calls++;
   const p=u.searchParams;
   assert.equal(p.get('user'),wallet);
   assert.equal(p.get('type'),'TRADE');
   assert.equal(p.get('sort_direction'),'DESC');
   const first=p.get('cursor')===null;
   return {ok:true,status:200,headers:new Headers(),
     text:async()=>JSON.stringify({data:first?[rawTrade(1)]:[rawTrade(2)],
       pagination:{has_more:first,next_cursor:first?'opaque-v2-seek':null}})};
 };
 try{
   const r=await collector.fetchWallet(wallet,now);
   assert.equal(calls,2);
   assert.equal(r.events.length,2);
   assert.equal(r.complete,true);
 }finally{global.fetch=old;}
});
test('end-to-end dry-run: archive readback, silent first alert cycle, single send and ack',async()=>{
 const old=global.fetch;
 const records=new Map(),messages=[];
 let tick=now,showSecond=false;
 global.fetch=async (url,opts={})=>{
   const u=new URL(String(url));
   if(u.hostname==='data-api.polymarket.com'){
     const isActive=u.searchParams.get('user')===wallet;
     const rows=isActive?[rawTrade(1,now-20),...(showSecond?[rawTrade(2,now+55,475)]:[])]:[];
     return {ok:true,status:200,headers:new Headers(),text:async()=>JSON.stringify({
       data:rows,pagination:{has_more:false,next_cursor:null}
     })};
   }
   if(u.hostname==='api.github.com'){
     const key=decodeURIComponent(u.pathname.split('/contents/')[1]);
     if(opts.method==='GET'){
       const record=records.get(key);
       if(!record)return {ok:false,status:404};
       return {ok:true,status:200,json:async()=>({
         sha:record.sha,encoding:'base64',content:record.bytes.toString('base64')
       })};
     }
     if(opts.method==='PUT'){
       const body=JSON.parse(opts.body);
       const before=records.get(key);
       if(before&&body.sha!==before.sha)return {ok:false,status:409};
       const bytes=Buffer.from(body.content,'base64');
       records.set(key,{sha:core.hash(bytes),bytes});
       return {ok:true,status:200,json:async()=>({content:{sha:core.hash(bytes)}})};
     }
   }
   if(u.hostname==='api.telegram.org'){
     messages.push(JSON.parse(opts.body));
     return {ok:true,status:200,json:async()=>({ok:true,result:{message_id:messages.length}})};
   }
   throw Error('UNEXPECTED_URL_HOST_'+u.hostname);
 };
 const env={GITHUB_TOKEN:'safe-test-token',GITHUB_REPOSITORY:'5pillars5/tkempire',
   GITHUB_REF:'refs/heads/main',GITHUB_EVENT_NAME:'workflow_dispatch',
   WALLET_WATCH_ALERTS_ENABLED:'true',
   WALLET_WATCH_TELEGRAM_BOT_TOKEN:'123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef',
   WALLET_WATCH_TELEGRAM_CHAT_ID:'-1001234567890'};
 try{
   const first=await collector.run({env,now:tick});
   assert.equal(first.telegram,'baseline');assert.equal(messages.length,0);
   assert.ok(records.has('data/wallet-watch-history-v1/LATEST.json'));
   assert.ok([...records.keys()].some(k=>k.endsWith('.json.gz')));
   tick+=60;showSecond=true;
   const second=await collector.run({env,now:tick});
   assert.equal(second.telegram,'sent');assert.equal(second.sent,1);
   assert.equal(messages.length,1);
   assert.equal(messages[0].chat_id,env.WALLET_WATCH_TELEGRAM_CHAT_ID);
   tick+=60;
   const third=await collector.run({env,now:tick});
   assert.equal(third.telegram,'no_new_eligible');
   assert.equal(messages.length,1);
   const ledger=JSON.parse(records.get('data/wallet-watch-history-v1/DELIVERY.json').bytes.toString('utf8'));
   assert.equal(Object.keys(ledger.acknowledged).length,1);
 } finally {global.fetch=old;}
});
test('history API fails closed, bounds input and never imports execution credentials',()=>{
 const src=fs.readFileSync(path.join(__dirname,'../api/wallet-watch-history.js'),'utf8');
 const writer=fs.readFileSync(path.join(__dirname,'../ops/wallet-watch-history-v1/collect.js'),'utf8');
 const workflow=fs.readFileSync(path.join(__dirname,'../.github/workflows/wallet-watch-history.yml'),'utf8');
 assert.match(src,/MAX_INFLATED/);assert.match(src,/validateArchive/);
 assert.match(writer,/WALLET_WATCH_ALERTS_ENABLED==='true'/);
 assert.match(workflow,/cancel-in-progress: false/);
 assert.match(workflow,/cron: '3,13,23,33,43,53 \* \* \* \*'/);
 assert.match(workflow,/github.event_name != 'pull_request'/);
 assert.doesNotMatch(writer,/private_key|place_order|api\.hyperliquid|143\.244\.155\.109|ssh\s/i);
 assert.doesNotMatch(src,/TELEGRAM_CHAT_ID|GITHUB_TOKEN/);
 const html=fs.readFileSync(path.join(__dirname,'../wallet-watch.html'),'utf8');
 assert.match(html,/api\/wallet-watch-history/);
 assert.match(html,/id="viewMode"/);
});


test('adaptive lookback overlaps routine polls and restores full capture after long gaps',()=>{
 const prev={schema_version:1,cohort_id:cohort.cohort_id,at:new Date(now*1000).toISOString()};
 assert.equal(collector.nextWindow(null,now+600),86400);
 assert.equal(collector.nextWindow(prev,now+600),3600);
 assert.equal(collector.nextWindow(prev,now+4000),4900);
 assert.equal(collector.nextWindow(prev,now+7300),86400);
 assert.equal(collector.nextWindow({...prev,cohort_id:'wrong'},now+600),86400);
});
