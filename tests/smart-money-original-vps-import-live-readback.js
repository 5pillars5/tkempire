'use strict';
const assert=require('node:assert/strict');
const ROOT='https://www.tkempire.io';
async function json(path){
 const r=await fetch(ROOT+path,{redirect:'error',cache:'no-store',
  headers:{Accept:'application/json'},signal:AbortSignal.timeout(20000)});
 if(!r.ok)throw Error('HTTP_'+r.status+'_'+path);
 return r.json();
}
async function html(path){
 const r=await fetch(ROOT+path,{redirect:'error',cache:'no-store',
  signal:AbortSignal.timeout(20000)});
 if(!r.ok)throw Error('HTTP_'+r.status+'_'+path);
 return r.text();
}
(async()=>{
 const [page,status]=await Promise.all([
  html('/smart-money-flow.html'),
  json('/api/smart-money-legacy-history')
 ]);
 assert.ok(page.includes('id="legacyImportStatus"'),'missing original VPS import status element');
 const version=page.match(/smart-money-flow-map\.js\?v=([1-9]\d*)/)?.[1];
 assert.ok(version,'Flow Map asset version missing');
 const js=await html('/assets/js/smart-money-flow-map.js?v='+version);
 assert.ok(js.includes("'/api/smart-money-legacy-history'"),'live JS not linked to import readback API');
 assert.equal(status.execution_authority,'none');
 assert.equal(status.trade_profit,null);
 if(status.status==='not_imported'){
  assert.equal(status.verified,false);
  assert.equal(status.published,false);
  assert.equal(status.signal_rows,null);
  console.log('VPS_ORIGINAL_SIGNALS_LIVE_READBACK=PASS STATE=NOT_IMPORTED SOURCE_EXPORT_STILL_REQUIRED');
 }else if(status.status==='verified'){
  assert.equal(status.verified,true);assert.equal(status.published,true);
  assert.match(status.archive_sha256,/^[a-f0-9]{64}$/);
  assert.match(status.source_database_sha256,/^[a-f0-9]{64}$/);
  assert.ok(Number.isInteger(status.signal_rows)&&status.signal_rows>0);
  assert.equal(status.matched_ids+status.legacy_only_ids,status.signal_rows);
  assert.equal(status.conflicting_ids,0);
  console.log('VPS_ORIGINAL_SIGNALS_LIVE_READBACK=PASS STATE=VERIFIED '+JSON.stringify({
   source_database_sha256:status.source_database_sha256,
   archive_sha256:status.archive_sha256,signals:status.signal_rows,
   matched:status.matched_ids,legacy_only:status.legacy_only_ids}));
 }else throw Error('UNEXPECTED_OR_UNVERIFIED_IMPORT_STATE '+status.status);
})().catch(e=>{console.error('VPS_ORIGINAL_SIGNALS_LIVE_READBACK=FAIL '+String(e.stack||e));process.exitCode=1});
