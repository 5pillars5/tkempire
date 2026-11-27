'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const zlib=require('node:zlib');
const crypto=require('node:crypto');
const {hash}=require('../ops/smart-money-history-v1/history-core');
const {createStore,gitBlobSha,archivePath,HEAD}=require('../ops/smart-money-history-v1/archive-transaction');
const day='2026-11-26',nextDay='2026-11-27';
const now=day+'T01:00:00.000Z';
const condition='0x'+'a'.repeat(64);
const signal=id=>({id,condition_id:condition,token_id:'123',observed_at:now,captured_at:now,side:'BUY'});
const flow=(d,bucket)=>({bucket,at:d+'T01:00:00.000Z',status:'ok',coverage:{received:8},markets:[]});
const observation=(store,d,bucket,ids)=>store.writeObservation(d,flow(d,bucket),{signals:ids.map(signal)},d+'T02:00:00.000Z');
const check=(id,result='PAYOUT_1')=>({signal_id:id,condition_id:condition,token_id:'123',
 result,payout:result==='PAYOUT_1'?1:result==='PAYOUT_0'?0:null,
 resolution_hash:result.startsWith('PAYOUT_')?'a'.repeat(64):null,
 checked_at:day+'T03:00:00.000Z',execution_authority:'none'});
const error=status=>Object.assign(Error('MOCK_'+status),{status});
const json=b=>JSON.parse(b.toString('utf8'));
const fakeSha=s=>crypto.createHash('sha1').update(s).digest('hex');
// Model immutable Git objects and GitHub's no-force fast-forward ref semantics.
function fakeGit(){
 let n=0;
 const blobs=new Map(),trees=new Map(),commits=new Map();
 const tree=fakeSha('root-tree'),root=fakeSha('root-commit');
 trees.set(tree,new Map());commits.set(root,{sha:root,tree:{sha:tree},parents:[]});
 let head=root,conflicts=0,readHook=null,patchHook=null;
 const updates=[];
 function snapshot(ref){return trees.get(commits.get(ref).tree.sha)}
 function response(ref,path){
  const sha=snapshot(ref).get(path);
  if(!sha)throw error(404);
  const b=blobs.get(sha);return {type:'file',encoding:'base64',size:b.length,sha,content:b.toString('base64')};
 }
 const request=async(method,path,body)=>{
  if(method==='GET'&&path==='git/ref/heads/main')return {ref:'refs/heads/main',object:{sha:head,type:'commit'}};
  if(method==='GET'&&path.startsWith('contents/')){
   const [p,ref]=path.slice(9).split('?ref=');
   assert.match(ref,/^[a-f0-9]{40}$/,'all data reads pinned to an immutable commit');
   if(readHook){const override=readHook(ref,p,response);if(override!==undefined)return override}
   return response(ref,p);
  }
  if(method==='GET'&&path.startsWith('git/commits/'))return commits.get(path.slice(12));
  if(method==='POST'&&path==='git/blobs'){
   const b=Buffer.from(body.content,'base64'),sha=gitBlobSha(b);blobs.set(sha,b);return {sha};
  }
  if(method==='POST'&&path==='git/trees'){
   const contents=new Map(trees.get(body.base_tree));for(const f of body.tree)contents.set(f.path,f.sha);
   const sha=fakeSha('tree'+(++n));trees.set(sha,contents);return {sha};
  }
  if(method==='POST'&&path==='git/commits'){
   const sha=fakeSha('commit'+(++n)),c={sha,tree:{sha:body.tree},parents:body.parents.map(sha=>({sha}))};
   commits.set(sha,c);return c;
  }
  if(method==='PATCH'&&path==='git/refs/heads/main'){
   assert.equal(body.force,false);
   if(patchHook){const fn=patchHook;patchHook=null;await fn()}
   const c=commits.get(body.sha);
   if(c.parents[0].sha!==head){conflicts++;throw error(422)}
   head=body.sha;updates.push({commit:head,paths:[...snapshot(head).keys()]});
   return {ref:'refs/heads/main',object:{sha:head,type:'commit'}};
  }
  throw Error('Unexpected request '+method+' '+path);
 };
 return {request,root,get head(){return head},get conflicts(){return conflicts},updates,
  bytes(path,ref=head){const sha=snapshot(ref).get(path);return sha?Buffer.from(blobs.get(sha)):null},
  hookRead(fn){readHook=fn},hookPatch(fn){patchHook=fn}};
}
const make=git=>createStore(git.request,{sleep:async()=>{},attempts:5,readbackAttempts:4});
function assertHead(git,d=day,ref=git.head){
 const b=git.bytes(archivePath(d),ref),h=json(git.bytes(HEAD,ref));
 const a=json(zlib.gunzipSync(b));
 assert.equal(h.latest_day,d);assert.equal(h.archive_sha256,hash(b));
 assert.equal(h.archived_snapshots_this_day,a.flow_snapshots.length);
 assert.equal(h.archived_signals_this_day,a.signal_events.length);
 assert.equal(h.outcome_checks_this_day,a.outcome_checks.length);
 assert.equal(h.trading_authority,'none');
 return {a,h};
}
test('bootstrap publishes archive and head in one fast-forward commit',async()=>{
 const g=fakeGit(),s=make(g);
 const r=await observation(s,day,1,['a']);
 assert.equal(g.updates.length,1);
 assert.equal(r.commit,g.head);
 assert.equal(r.head,'HEAD_READBACK_PASS');
 assert.deepEqual(g.updates[0].paths.sort(),[HEAD,archivePath(day)].sort());
 assertHead(g);
});
test('concurrent collector and matcher remerge after conflict, preserving both evidence sets',async()=>{
 const g=fakeGit(),s=make(g);
 await observation(s,day,1,['a']);
 const first=g.bytes(archivePath(day));
 g.hookPatch(()=>s.writeOutcomes(day,[check('a')]));
 await observation(s,day,2,['a','b']);
 assert.equal(g.conflicts,1);
 const {a,h}=assertHead(g);
 assert.deepEqual(a.signal_events.map(x=>x.id),['a','b']);
 assert.equal(a.flow_snapshots.length,2);
 assert.equal(a.outcome_checks[0].result,'PAYOUT_1');
 assert.equal(h.verified_outcomes_this_day,1);
 assert.equal(h.outcome_matching,'CTF_PAYOUTS_RECONCILED_WHEN_TOKEN_AND_TIME_VERIFIED');
 assert.deepEqual(a.flow_snapshots[0],json(zlib.gunzipSync(first)).flow_snapshots[0]);
});
test('matcher racing collector cannot overwrite new signals or flow snapshots',async()=>{
 const g=fakeGit(),s=make(g);
 await observation(s,day,1,['a']);
 g.hookPatch(()=>observation(s,day,2,['b']));
 await s.writeOutcomes(day,[check('a')]);
 assert.equal(g.conflicts,1);
 const {a,h}=assertHead(g);
 assert.deepEqual(a.signal_events.map(x=>x.id),['a','b']);
 assert.equal(a.flow_snapshots.length,2);
 assert.equal(h.verified_outcomes_this_day,1);
});
test('concurrent matchers preserve distinct outcomes and terminal results',async()=>{
 const g=fakeGit(),s=make(g);
 await observation(s,day,1,['a','b']);
 g.hookPatch(()=>s.writeOutcomes(day,[check('b','PAYOUT_0')]));
 await s.writeOutcomes(day,[check('a')]);
 assert.equal(g.conflicts,1);
 const before=g.head;
 const r=await s.writeOutcomes(day,[check('a','PAYOUT_0')]);
 assert.equal(r.wrote,false);
 assert.equal(g.head,before);
 const {a,h}=assertHead(g);
 assert.deepEqual(a.outcome_checks.map(x=>x.result),['PAYOUT_1','PAYOUT_0']);
 assert.equal(h.verified_outcomes_this_day,2);
});
test('transient stale immutable readback retries, without rewriting',async()=>{
 const g=fakeGit(),s=make(g);
 const old=await observation(s,day,1,['a']);
 let stale=0;
 g.hookRead((ref,p,respond)=>{
  if(ref!==old.commit&&p===HEAD&&stale++===0)return respond(old.commit,p);
 });
 const r=await s.writeOutcomes(day,[check('a')]);
 assert.equal(r.head,'HEAD_READBACK_PASS');
 assert.ok(stale>=2);
 assert.equal(g.updates.length,2);
 assertHead(g);
});
test('later main advancement does not invalidate verified immutable commit',async()=>{
 const g=fakeGit(),s=make(g);
 await observation(s,day,1,['a']);
 const r=await s.writeOutcomes(day,[check('a')]);
 await observation(s,day,2,['b']);
 assert.notEqual(r.commit,g.head);
 assert.equal(assertHead(g,day,r.commit).h.archived_signals_this_day,1);
 assert.equal(assertHead(g).h.archived_signals_this_day,2);
});
test('persistent mismatched immutable readback fails closed, preserves committed evidence',async()=>{
 const g=fakeGit(),s=make(g);
 const old=await observation(s,day,1,['a']);
 let stale=0;
 g.hookRead((ref,p,respond)=>{
  if(ref!==old.commit&&p===HEAD){stale++;return respond(old.commit,p)}
 });
 await assert.rejects(s.writeOutcomes(day,[check('a')]),/IMMUTABLE_ARCHIVE_READBACK_FAILED/);
 assert.equal(stale,4);
 assert.equal(g.updates.length,2);
 assert.equal(assertHead(g).a.outcome_checks.length,1);
 g.hookRead(null);
 assert.equal((await s.writeOutcomes(day,[check('a')])).head,'HEAD_READBACK_PASS');
});
test('midnight and older day writes never roll back newest head',async()=>{
 const g=fakeGit(),s=make(g);
 await observation(s,day,1,['a']);
 await observation(s,nextDay,2,['b']);
 const head=g.bytes(HEAD);
 const old=await s.writeOutcomes(day,[check('a')]);
 assert.equal(old.head,'NOT_LATEST_DAY');
 assert.deepEqual(g.bytes(HEAD),head);
 assert.equal((await observation(s,day,3,['c'])).head,'NOT_LATEST_DAY');
 assert.deepEqual(g.bytes(HEAD),head);
 assertHead(g,nextDay);
 assert.equal((await s.readDay(day)).outcome_checks.length,1);
});
test('invalid outcome identity rejected before committing',async()=>{
 const g=fakeGit(),s=make(g);
 await observation(s,day,1,['a']);
 const old=g.head;
 await assert.rejects(s.writeOutcomes(day,[{...check('a'),token_id:'999'}]),/OUTCOME_IDENTITY_MISMATCH/);
 assert.equal(g.head,old);
});
test('bounded non-fast-forward conflicts fail without publishing losing transaction',async()=>{
 const g=fakeGit(),s=make(g);
 await observation(s,day,1,['a']);
 let attempts=0;
 const retry=async()=>{
  attempts++;
  await observation(s,day,attempts+1,['race'+attempts]);
  g.hookPatch(retry);
 };
 g.hookPatch(retry);
 await assert.rejects(s.writeOutcomes(day,[check('a')]),/ARCHIVE_REF_CONFLICT_RETRIES_EXHAUSTED/);
 assert.equal(g.conflicts,5);
 const {a}=assertHead(g);
 assert.equal(a.outcome_checks.length,0);
 assert.equal(a.signal_events.length,6);
});
