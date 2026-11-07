'use strict';
/*
 * Readback of the OPTIONAL verified legacy VPS signal layer.
 * Never claims legacy history was imported merely because current public
 * Signal Monitor and Flow Map feeds are running.
 */
const crypto=require('node:crypto');
const zlib=require('node:zlib');
const ROOT='https://raw.githubusercontent.com/5pillars5/tkempire/main/data/smart-money-history-v1/legacy/';
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const reply=(res,status,body)=>{
 res.setHeader('Cache-Control',status===200?'public,s-maxage=80,max-age=0':'no-store');
 res.setHeader('X-Content-Type-Options','nosniff');
 return res.status(status).json(body);
};
async function fetchFile(file,maxBytes){
 const r=await fetch(ROOT+file+'?v='+Math.floor(Date.now()/120000),
  {redirect:'error',cache:'no-store',signal:AbortSignal.timeout(8000)});
 if(r.status===404)return null;
 if(!r.ok)throw Error('LEGACY_EVIDENCE_HTTP_'+r.status);
 const b=Buffer.from(await r.arrayBuffer());
 if(b.length>maxBytes)throw Error('LEGACY_EVIDENCE_OVERSIZED');
 return b;
}
module.exports=async(req,res)=>{
 if(req.method!=='GET'){res.setHeader('Allow','GET');return reply(res,405,{status:'method_not_allowed'})}
 const id=String(req.query?.id||'').toLowerCase();
 if(id&&!/^[a-f0-9]{24}$/.test(id))return reply(res,400,{status:'invalid_id'});
 try{
  const manifestRaw=await fetchFile('IMPORT_MANIFEST.json',250000);
  if(manifestRaw===null)return reply(res,200,{
   status:'not_imported',origin:'VPS_SQLITE_MONITOR_V1',
   published:false,verified:false,signal_rows:null,
   explanation:'Legacy VPS SQLite evidence has not been published and verified.',
   calibrated_probability:null,trade_profit:null,execution_authority:'none'});
  const manifest=JSON.parse(manifestRaw);
  if(manifest.schema_version!==1||manifest.archive_file!=='verified-vps-sqlite-signals.json.gz'||
   !/^[a-f0-9]{64}$/.test(manifest.archive_sha256)||manifest.public_commit_performed!==true||
   manifest.conflicting_ids!==0)throw Error('UNVERIFIED_IMPORT_MANIFEST');
  const bytes=await fetchFile(manifest.archive_file,1.2e6);
  if(!bytes||sha(bytes)!==manifest.archive_sha256)throw Error('ARCHIVE_HASH_MISMATCH');
  const archive=JSON.parse(zlib.gunzipSync(bytes,{maxOutputLength:16000000}));
  if(archive.schema_version!==1||
   archive.origin!=='VPS_SQLITE_MONITOR_V1_VERIFIED_EXPORT'||
   archive.source_export_sha256!==manifest.source_export_sha256||
   archive.source_database_sha256!==manifest.source_database_sha256||
   !Array.isArray(archive.records)||archive.records.length!==manifest.signal_rows||
   archive.matched_ids!==manifest.matched_ids||archive.legacy_only_ids!==manifest.legacy_only_ids||
   archive.conflicting_ids!==0||
   !archive.records.every(x=>/^[a-f0-9]{24}$/.test(x.id))||
   new Set(archive.records.map(x=>x.id)).size!==archive.records.length)
   throw Error('ARCHIVE_RECONCILIATION_MISMATCH');
  const result={
   status:'verified',origin:archive.origin,published:true,verified:true,
   source_export_sha256:archive.source_export_sha256,
   source_database_sha256:archive.source_database_sha256,
   source_sqlite_snapshot_sha256:archive.source_sqlite_snapshot_sha256,
   archive_sha256:manifest.archive_sha256,
   signal_rows:archive.records.length,
   matched_ids:archive.matched_ids,legacy_only_ids:archive.legacy_only_ids,
   conflicting_ids:archive.conflicting_ids,
   earliest_first_seen_at:archive.records[0]?.reconciled_first_seen_at||null,
   latest_first_seen_at:archive.records.at(-1)?.reconciled_first_seen_at||null,
   flow_history_backfilled:false,
   calibrated_probability:null,trade_profit:null,execution_authority:'none'
  };
  if(id){
   const found=archive.records.find(x=>x.id===id);
   result.signal=found?{
    id:found.id,observed_at:found.observed_at,
    original_vps_first_seen_at:found.legacy_first_seen_at,
    public_mirror_first_seen_at:found.mirror_first_seen_at,
    reconciled_first_seen_at:found.reconciled_first_seen_at,
    history_identity_status:found.history_identity_status,
    condition_id:found.condition_id,token_id:found.token_id,
    side:found.side,amount_usdc:found.amount_usdc,
    source_payload_sha256:found.source_payload_sha256
   }:null;
  }
  return reply(res,200,result);
 }catch(e){
  return reply(res,503,{status:'unverified_import',
   published:null,verified:false,signal_rows:null,
   explanation:'Legacy source evidence or independent SHA-256 readback could not be verified.',
   probability:null,trade_profit:null,execution_authority:'none'});
 }
};
