'use strict';
/*
 * Legacy VPS SQLite reconciliation, OFFLINE ONLY.
 * Requires the original hash-verified operator export.
 * Never contacts or mutates the VPS, GitHub, collector, or trading engine.
 * Writes staged immutable archive+manifest to a NEW local directory.
 */
const fs=require('node:fs');
const path=require('node:path');
const zlib=require('node:zlib');
const crypto=require('node:crypto');
const SHA=/^[0-9a-f]{64}$/i, ID=/^[0-9a-f]{24}$/i;
const COND=/^0x[0-9a-f]{64}$/i,TOKEN=/^[0-9]+$/;
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const iso=s=>{if(typeof s!=='string'||!s.includes('T'))throw Error('INVALID_TIME'); const x=Date.parse(s);if(!Number.isFinite(x))throw Error('INVALID_TIME');return new Date(x).toISOString()};
const n=x=>typeof x==='number'&&Number.isFinite(x)?x:null;
const money=x=>Math.round(x*100)/100;
function fail(name){throw Error(name)}
function readJSON(p,limit=12e6){
 const b=fs.readFileSync(p);if(b.length>limit)fail('INPUT_TOO_LARGE');
 return {body:JSON.parse(b.toString('utf8')),sha256:sha(b),length:b.length};
}
function validateExport(exported,bytesHash,expectedHash){
 if(!SHA.test(expectedHash||'')||bytesHash.toLowerCase()!==expectedHash.toLowerCase())fail('EXPORT_SHA256_MISMATCH');
 if(!exported||exported.schema_version!==2||exported.origin!=='VPS_SQLITE_MONITOR_V1'||
   exported.source_read_only!==true||exported.source_hashes_stable_before_after!==true||
   exported.source_consistent_snapshot_integrity!=='ok'||exported.github_import_performed!==false||
   exported.flow_history_backfilled!==false||!Array.isArray(exported.records)||
   !Number.isInteger(exported.signal_rows)||exported.signal_rows!==exported.records.length||
   !Number.isInteger(exported.scan_rows)||exported.scan_rows<0)fail('SOURCE_EXPORT_MANIFEST_INVALID');
 const db=exported.source_file_evidence?.sqlite_db;
 if(!db||!SHA.test(db.sha256)||!Number.isSafeInteger(db.bytes)||db.bytes<=0||
   !SHA.test(exported.source_consistent_snapshot_sha256))fail('SOURCE_SHA_EVIDENCE_INVALID');
 const wal=exported.source_file_evidence.sqlite_wal;
 if(wal!==null&&(!wal||!SHA.test(wal.sha256)||!Number.isSafeInteger(wal.bytes)))fail('WAL_SHA_EVIDENCE_INVALID');
 const oldest=exported.records.length?Math.min(...exported.records.map(r=>Date.parse(r.captured_at))):null;
 const newest=exported.records.length?Math.max(...exported.records.map(r=>Date.parse(r.captured_at))):null;
 if(exported.records.length&&(!Number.isFinite(oldest)||!Number.isFinite(newest)||
   iso(exported.oldest_first_seen_at)!==new Date(oldest).toISOString()||
   iso(exported.newest_first_seen_at)!==new Date(newest).toISOString()))
   fail('EXPORT_FIRST_SEEN_RANGE_INCONSISTENT');
 return {db_sha256:db.sha256,wal_sha256:wal?.sha256||null,
  snapshot_sha256:exported.source_consistent_snapshot_sha256};
}
function signature(record){
 return {
  id:record.id,condition_id:COND.test(record.condition_id||'')?record.condition_id.toLowerCase():null,
  token_id:TOKEN.test(String(record.token_id||''))?String(record.token_id):null,
  side:record.side||null,
  observed_at:iso(record.observed_at),
  amount_usdc:n(record.amount_usdc)===null?null:money(record.amount_usdc),
  representative_price:n(record.representative_price)
 };
}
function compareIdentity(a,b){
 const x=signature(a),y=signature(b);
 const differences=[];
 for(const k of ['id','condition_id','token_id','side','observed_at','amount_usdc','representative_price']){
  if(x[k]!==y[k])differences.push(k);
 }
 return differences;
}
function validateSourceRecord(r,source){
 if(!r||!ID.test(String(r.id||''))||!['VPS_SQLITE_MONITOR_V1_VERIFIED_EXPORT','PUBLIC_SIGNAL_FEED_V1'].includes(source))fail('SIGNAL_ID_OR_SOURCE_INVALID');
 if(source==='VPS_SQLITE_MONITOR_V1_VERIFIED_EXPORT'){
  if(r.source!==source||r.legacy_first_seen_at!==r.captured_at||!SHA.test(r.source_payload_sha256||''))fail('VPS_SIGNAL_PROVENANCE_INVALID');
 }
 const created=Date.parse(r.captured_at),observed=Date.parse(r.observed_at);
 if(!Number.isFinite(created)||!Number.isFinite(observed)||created<observed-90000)fail('OBSERVATION_TIME_ORDER_INVALID');
 if(created>Date.now()+90000)fail('FUTURE_FIRST_SEEN');
 if(r.condition_id!==null&&!COND.test(String(r.condition_id||'')))fail('BAD_CONDITION_ID');
 if(r.token_id!==null&&!TOKEN.test(String(r.token_id||'')))fail('BAD_TOKEN_ID');
 if(r.side!==null&&!['BUY','SELL'].includes(r.side))fail('BAD_SIDE');
 if(n(r.amount_usdc)===null||r.amount_usdc<0||r.amount_usdc>1e12)fail('BAD_AMOUNT');
 if(r.representative_price!==null&&(n(r.representative_price)===null||r.representative_price<0||r.representative_price>1))fail('BAD_PRICE');
 return r;
}
function loadDailyMirrors(root){
 const files=[];
 if(!fs.existsSync(root))fail('MIRROR_HISTORY_DIRECTORY_MISSING');
 for(const name of fs.readdirSync(root)){
  if(!/^\d{4}-\d\d-\d\d\.json\.gz$/.test(name))continue;
  const p=path.join(root,name);
  const compressed=fs.readFileSync(p);
  if(compressed.length>1.2e6)fail('DAILY_ARCHIVE_TOO_LARGE');
  const o=JSON.parse(zlib.gunzipSync(compressed,{maxOutputLength:15e6}).toString('utf8'));
  if(o.schema_version!==1||!Array.isArray(o.signal_events)||!Array.isArray(o.flow_snapshots)||!Array.isArray(o.outcome_checks)||o.day!==name.slice(0,10))
    fail('INVALID_DAILY_ARCHIVE_'+name);
  files.push({name,sha256:sha(compressed),data:o});
 }
 if(!files.length)fail('NO_DAILY_ARCHIVES_TO_RECONCILE');
 const index=new Map(),duplicateIds=[];
 for(const f of files){
  for(const r of f.data.signal_events){
   validateSourceRecord(r,'PUBLIC_SIGNAL_FEED_V1');
   const previous=index.get(r.id);
   if(previous){
    const drift=compareIdentity(previous.record,r);
    if(drift.length)fail('MIRROR_DUPLICATE_CONFLICT_'+r.id+'_'+drift.join(','));
    duplicateIds.push(r.id);
    if(Date.parse(r.captured_at)<Date.parse(previous.record.captured_at))index.set(r.id,{record:r,day:f.name});
   }else index.set(r.id,{record:r,day:f.name});
  }
 }
 return {files,index,duplicates:[...new Set(duplicateIds)]};
}
function buildReconciliation(exported,sourceEvidence,exportSHA,mirror){
 const ids=new Set(),records=[],matched=[],legacyOnly=[],conflicts=[];
 for(const r of exported.records){
  validateSourceRecord(r,'VPS_SQLITE_MONITOR_V1_VERIFIED_EXPORT');
  if(ids.has(r.id))fail('DUPLICATE_SOURCE_ID_'+r.id);
  ids.add(r.id);
  const match=mirror.index.get(r.id);
  if(match){
   const different=compareIdentity(r,match.record);
   if(different.length){
    conflicts.push({id:r.id,fields:different,mirror_day:match.day});
    continue;
   }
   matched.push({id:r.id,legacy_first_seen_at:iso(r.captured_at),
    mirror_first_seen_at:iso(match.record.captured_at),mirror_day:match.day,
    earliest_verified_first_seen_at:new Date(Math.min(Date.parse(r.captured_at),Date.parse(match.record.captured_at))).toISOString()});
  }else legacyOnly.push({id:r.id,first_seen_at:iso(r.captured_at)});
  records.push({...r,
   captured_at:iso(r.captured_at),
   observed_at:iso(r.observed_at),
   mirror_first_seen_at:match?iso(match.record.captured_at):null,
   reconciled_first_seen_at:match?
    new Date(Math.min(Date.parse(r.captured_at),Date.parse(match.record.captured_at))).toISOString():iso(r.captured_at),
   history_identity_status:match?'MATCHED_PUBLIC_MIRROR':'LEGACY_SOURCE_ONLY'});
 }
 if(conflicts.length)fail('RECONCILIATION_CONFLICT_'+JSON.stringify(conflicts.slice(0,10)));
 if(records.length!==exported.signal_rows||matched.length+legacyOnly.length!==exported.signal_rows)
  fail('RECONCILIATION_COUNT_MISMATCH');
 records.sort((a,b)=>a.reconciled_first_seen_at.localeCompare(b.reconciled_first_seen_at)||a.id.localeCompare(b.id));
 matched.sort((a,b)=>a.id.localeCompare(b.id));
 const core={schema_version:1,origin:'VPS_SQLITE_MONITOR_V1_VERIFIED_EXPORT',
  exported_at:exported.exported_at,source_export_sha256:exportSHA,
  source_database_sha256:sourceEvidence.db_sha256,source_wal_sha256:sourceEvidence.wal_sha256,
  source_sqlite_snapshot_sha256:sourceEvidence.snapshot_sha256,
  source_scan_rows:exported.scan_rows,source_signal_rows:exported.signal_rows,
  mirror_archive_files:mirror.files.map(x=>({name:x.name,sha256:x.sha256})),
  mirrored_id_count:mirror.index.size,mirror_duplicate_ids:mirror.duplicates,
  matched_ids:matched.length,legacy_only_ids:legacyOnly.length,conflicting_ids:0,
  matched_first_seen:matched,records,
  source_db_mutated:false,source_imported_to_main:false,
  flow_history_backfilled:false,order_execution_enabled:false,
  probability_model_calibrated:false};
 return core;
}
function stage({exportFile,expectedSHA,mirrorDir,outputDir}){
 const source=readJSON(exportFile);
 const sourceEvidence=validateExport(source.body,source.sha256,expectedSHA);
 const mirror=loadDailyMirrors(mirrorDir);
 const core=buildReconciliation(source.body,sourceEvidence,source.sha256,mirror);
 if(fs.existsSync(outputDir))fail('STAGING_DIRECTORY_ALREADY_EXISTS');
 fs.mkdirSync(outputDir,{recursive:false,mode:0o700});
 const packed=zlib.gzipSync(Buffer.from(JSON.stringify(core)+'\n'),{mtime:0,level:9});
 if(packed.length>950000)fail('LEGACY_ARCHIVE_TOO_LARGE');
 const archivePath=path.join(outputDir,'verified-vps-sqlite-signals.json.gz');
 fs.writeFileSync(archivePath,packed,{flag:'wx',mode:0o600});
 const manifest={schema_version:1,archive_file:'verified-vps-sqlite-signals.json.gz',
  archive_sha256:sha(packed),source_export_sha256:source.sha256,
  source_database_sha256:sourceEvidence.db_sha256,source_wal_sha256:sourceEvidence.wal_sha256,
  source_sqlite_snapshot_sha256:sourceEvidence.snapshot_sha256,
  signal_rows:core.source_signal_rows,matched_ids:core.matched_ids,
  legacy_only_ids:core.legacy_only_ids,conflicting_ids:0,
  public_commit_performed:false,verification_status:'STAGED_NOT_PUBLISHED'};
 const manifestPath=path.join(outputDir,'IMPORT_MANIFEST.json');
 fs.writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});
 const staged=JSON.parse(zlib.gunzipSync(fs.readFileSync(archivePath)).toString('utf8'));
 const replay=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
 if(sha(fs.readFileSync(archivePath))!==replay.archive_sha256||
    staged.records.length!==replay.signal_rows||
    staged.matched_ids!==replay.matched_ids||
    staged.legacy_only_ids!==replay.legacy_only_ids||
    staged.source_export_sha256!==replay.source_export_sha256)fail('STAGED_IMPORT_READBACK_FAIL');
 return {staged:core,manifest,outputDir};
}
if(require.main===module){
 const args=process.argv.slice(2),opts={};
 for(let i=0;i<args.length;i+=2){
  if(!args[i]?.startsWith('--')||args[i+1]===undefined)fail('INVALID_ARGUMENTS');
  opts[args[i].slice(2)]=args[i+1];
 }
 for(const k of ['export','expected-export-sha256','mirror-dir','output-dir']){
  if(!opts[k])fail('MISSING_ARGUMENT_'+k);
 }
 const out=stage({exportFile:opts.export,expectedSHA:opts['expected-export-sha256'],
  mirrorDir:opts['mirror-dir'],outputDir:opts['output-dir']});
 console.log('SOURCE_EXPORT_SHA256=PASS');
 console.log('MIRROR_HISTORY_READBACK=PASS');
 console.log('SIGNAL_ID_FIRST_SEEN_RECONCILIATION=PASS');
 console.log('LEGACY_STAGING_READBACK=PASS');
 console.log('STAGED_SIGNAL_ROWS='+out.manifest.signal_rows);
 console.log('STAGED_MATCHED_IDS='+out.manifest.matched_ids);
 console.log('STAGED_LEGACY_ONLY_IDS='+out.manifest.legacy_only_ids);
 console.log('STAGED_ARCHIVE_SHA256='+out.manifest.archive_sha256);
 console.log('STAGING_DIRECTORY='+out.outputDir);
 console.log('PUBLIC_IMPORT=NOT_YET_PERFORMED');
}
module.exports={validateExport,compareIdentity,loadDailyMirrors,buildReconciliation,stage};
