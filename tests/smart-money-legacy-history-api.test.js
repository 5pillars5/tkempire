'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const zlib=require('node:zlib'),crypto=require('node:crypto');
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const handler=require('../api/smart-money-legacy-history');
function res(){return {code:null,headers:{},setHeader(k,v){this.headers[k]=v},status(n){this.code=n;return this},json(d){this.body=d;return this}}}
const first=new Date(Date.now()-120000).toISOString(),id='a'.repeat(24);
const core={schema_version:1,origin:'VPS_SQLITE_MONITOR_V1_VERIFIED_EXPORT',
 source_export_sha256:sha('source'),source_database_sha256:sha('database'),
 source_sqlite_snapshot_sha256:sha('snapshot'),
 matched_ids:1,legacy_only_ids:0,conflicting_ids:0,
 records:[{id,observed_at:first,legacy_first_seen_at:first,reconciled_first_seen_at:first,
 mirror_first_seen_at:first,history_identity_status:'MATCHED_PUBLIC_MIRROR',
 condition_id:'0x'+'a'.repeat(64),token_id:'123',side:'BUY',amount_usdc:50,
 source_payload_sha256:sha('payload')}]};
const gz=zlib.gzipSync(Buffer.from(JSON.stringify(core)));
const manifest={schema_version:1,archive_file:'verified-vps-sqlite-signals.json.gz',
 archive_sha256:sha(gz),source_export_sha256:sha('source'),
 source_database_sha256:sha('database'),signal_rows:1,matched_ids:1,
 legacy_only_ids:0,conflicting_ids:0,public_commit_performed:true};
const response=(bytes,status=200)=>({ok:status===200,status,arrayBuffer:async()=>Buffer.from(bytes)});
test('absent import reads as not imported, never as zero historical signals',async()=>{
 const old=global.fetch;global.fetch=async()=>response('',404);
 try{const out=res();await handler({method:'GET',query:{}},out);
  assert.equal(out.code,200);assert.equal(out.body.status,'not_imported');
  assert.equal(out.body.signal_rows,null);assert.equal(out.body.verified,false)}
 finally{global.fetch=old}
});
test('verified persisted file SHA, original first seen and stable signal IDs',async()=>{
 const old=global.fetch;
 global.fetch=async url=>String(url).includes('IMPORT_MANIFEST')?
  response(JSON.stringify(manifest)):response(gz);
 try{
  const out=res();await handler({method:'GET',query:{id}},out);
  assert.equal(out.code,200);assert.equal(out.body.status,'verified');
  assert.equal(out.body.signal_rows,1);assert.equal(out.body.matched_ids,1);
  assert.equal(out.body.signal.original_vps_first_seen_at,first);
  assert.equal(out.body.signal.reconciled_first_seen_at,first);
  assert.equal(out.body.trade_profit,null);assert.equal(out.body.calibrated_probability,null);
 }finally{global.fetch=old}
});
test('tampered or unpublished archive never shows verified history',async()=>{
 const old=global.fetch;
 try{
  global.fetch=async url=>String(url).includes('IMPORT_MANIFEST')?
    response(JSON.stringify(manifest)):response(zlib.gzipSync(Buffer.from('{}')));
  let out=res();await handler({method:'GET',query:{}},out);
  assert.equal(out.code,503);assert.equal(out.body.status,'unverified_import');
  global.fetch=async url=>String(url).includes('IMPORT_MANIFEST')?
    response(JSON.stringify({...manifest,public_commit_performed:false})):response(gz);
  out=res();await handler({method:'GET',query:{}},out);
  assert.equal(out.code,503);assert.equal(out.body.verified,false);
 }finally{global.fetch=old}
});
test('invalid ID and POST are rejected without looking at GitHub',async()=>{
 const old=global.fetch;global.fetch=()=>{throw Error('no network expected')};
 try{
  let out=res();await handler({method:'GET',query:{id:'INVALID'}},out);
  assert.equal(out.code,400);
  out=res();await handler({method:'POST',query:{}},out);
  assert.equal(out.code,405);
 }finally{global.fetch=old}
});
