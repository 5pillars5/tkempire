'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),zlib=require('node:zlib');
const {stage}=require('../ops/smart-money-history-v1/reconcile-legacy-export');
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const cond='0x'+'b'.repeat(64);
const id='a'.repeat(24);
const at=new Date(Date.now()-180000).toISOString();
const seen=new Date(Date.now()-150000).toISOString();
const mirrorSeen=new Date(Date.now()-60000).toISOString();
const sample=(id=id)=>({id,source:'VPS_SQLITE_MONITOR_V1_VERIFIED_EXPORT',
 captured_at:seen,legacy_first_seen_at:seen,observed_at:at,
 condition_id:cond,token_id:'12345',side:'BUY',title:'Market evidence',
 outcome:'Yes',type:'SMART_MONEY_BUY',amount_usdc:250,representative_price:.37,
 wallets:['0x'+'c'.repeat(40)],source_payload_sha256:sha('payload')});
function fixture({mirror=true,conflict=false}={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'eip-legacy-reconcile-'));
 const dir=path.join(root,'mirror'),destination=path.join(root,'verified-stage'),source=path.join(root,'source.json');
 fs.mkdirSync(dir);
 const sig=sample();
 const exportBody={
  schema_version:2,origin:'VPS_SQLITE_MONITOR_V1',
  exported_at:new Date().toISOString(),
  source_read_only:true,source_hashes_stable_before_after:true,
  source_consistent_snapshot_integrity:'ok',
  source_file_evidence:{sqlite_db:{sha256:sha('sqlite'),bytes:4096},sqlite_wal:null},
  source_consistent_snapshot_sha256:sha('sqlite-backup'),
  signal_rows:1,scan_rows:10,
  oldest_first_seen_at:seen,newest_first_seen_at:seen,
  github_import_performed:false,flow_history_backfilled:false,records:[sig]};
 fs.writeFileSync(source,JSON.stringify(exportBody)+'\n');
 const mirrorRecord={...sig,source:'PUBLIC_SIGNAL_FEED_V1',captured_at:mirrorSeen,
  legacy_first_seen_at:undefined,source_payload_sha256:sha('payload-other'),
  amount_usdc:conflict?999:250};
 const day=new Date().toISOString().slice(0,10);
 const archive={schema_version:1,day,signal_events:mirror?[mirrorRecord]:[],
  flow_snapshots:[{bucket:Math.floor(Date.now()/900000)*900,at:new Date().toISOString(),markets:[]}],
  outcome_checks:[]};
 fs.writeFileSync(path.join(dir,day+'.json.gz'),zlib.gzipSync(Buffer.from(JSON.stringify(archive))));
 return {root,dir,destination,source,sha:sha(fs.readFileSync(source)),mirrorRecord};
}
function close(f){fs.rmSync(f.root,{force:true,recursive:true})}
test('verified source SHA, stable ID match and earliest first-seen survive staged round-trip',()=>{
 const f=fixture();
 try{
  const out=stage({exportFile:f.source,expectedSHA:f.sha,mirrorDir:f.dir,outputDir:f.destination});
  assert.equal(out.manifest.matched_ids,1);
  assert.equal(out.manifest.legacy_only_ids,0);
  assert.equal(out.manifest.conflicting_ids,0);
  const staged=JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(f.destination,'verified-vps-sqlite-signals.json.gz'))));
  assert.equal(staged.records[0].id,id);
  assert.equal(staged.records[0].captured_at,seen);
  assert.equal(staged.records[0].mirror_first_seen_at,mirrorSeen);
  assert.equal(staged.records[0].reconciled_first_seen_at,seen);
  assert.equal(staged.source_database_sha256,sha('sqlite'));
  assert.equal(staged.source_export_sha256,f.sha);
  assert.equal(sha(fs.readFileSync(path.join(f.destination,'verified-vps-sqlite-signals.json.gz'))),out.manifest.archive_sha256);
  assert.equal(staged.source_imported_to_main,false);
  assert.equal(JSON.parse(fs.readFileSync(f.source,'utf8')).github_import_performed,false);
  assert.throws(()=>stage({exportFile:f.source,expectedSHA:f.sha,mirrorDir:f.dir,outputDir:f.destination}),/STAGING_DIRECTORY_ALREADY_EXISTS/);
 }finally{close(f)}
});
test('legacy-only entries preserved but cannot invent historic Flow Map snapshots',()=>{
 const f=fixture({mirror:false});
 try{
  const out=stage({exportFile:f.source,expectedSHA:f.sha,mirrorDir:f.dir,outputDir:f.destination});
  assert.equal(out.manifest.matched_ids,0);
  assert.equal(out.manifest.legacy_only_ids,1);
  assert.equal(out.staged.flow_history_backfilled,false);
 }finally{close(f)}
});
test('conflicting core event identity fails closed; no staged archive is published',()=>{
 const f=fixture({mirror:true,conflict:true});
 try{
  assert.throws(()=>stage({exportFile:f.source,expectedSHA:f.sha,mirrorDir:f.dir,outputDir:f.destination}),/RECONCILIATION_CONFLICT/);
  assert.equal(fs.existsSync(f.destination),false);
 }finally{close(f)}
});
test('mismatched user-provided SHA fails before directory writes',()=>{
 const f=fixture();
 try{
  assert.throws(()=>stage({exportFile:f.source,expectedSHA:sha('wrong'),mirrorDir:f.dir,outputDir:f.destination}),/EXPORT_SHA256_MISMATCH/);
  assert.equal(fs.existsSync(f.destination),false);
 }finally{close(f)}
});
test('tampered source manifest fails before publication',()=>{
 const f=fixture();
 try{
  const body=JSON.parse(fs.readFileSync(f.source,'utf8'));
  body.source_hashes_stable_before_after=false;
  fs.writeFileSync(f.source,JSON.stringify(body));
  assert.throws(()=>stage({exportFile:f.source,expectedSHA:sha(fs.readFileSync(f.source)),mirrorDir:f.dir,outputDir:f.destination}),/SOURCE_EXPORT_MANIFEST_INVALID/);
 }finally{close(f)}
});
