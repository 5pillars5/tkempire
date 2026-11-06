'use strict';
const assert=require('node:assert/strict');
const {decodeReceipt,enrich}=require('../research/etherscan-v2-receipt-enrich-20261106.js');
const tok='123',wallet='0x'+'1'.repeat(40),sender='0x'+'2'.repeat(40);
const addr=x=>'0x'+'0'.repeat(24)+x.slice(2);
const pad=x=>BigInt(x).toString(16).padStart(64,'0');
const base={address:'0x4d97dcd97ec945f40cf65f87097ace5ea0476045',
 transactionHash:'0x'+'a'.repeat(64),logIndex:'0x15'};
const log={...base,topics:[
 '0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62',
 addr(sender),addr(sender),addr(wallet)],data:'0x'+pad(tok)+pad(1250000)};
const rec={transactionHash:base.transactionHash,status:'0x1',logs:[log]};
const decoded=decodeReceipt(rec,new Set([tok]),wallet);
assert.equal(decoded.length,1);
assert.equal(decoded[0].log_index,21);
assert.equal(decoded[0].quantity_raw,'1250000');
const entry={tx_hash:base.transactionHash,from:sender,to:wallet,token_id:tok,quantity_raw:'1250000',log_index:null};
(async()=>{
 const verified=await enrich([entry],wallet,new Set([tok]),async()=>rec);
 assert.equal(verified.transactions_verified,1);
 assert.equal(verified.identities_enriched,1);
 assert.equal(entry.log_index,21);
 await assert.rejects(()=>enrich([{...entry,quantity_raw:'1250001'}],wallet,new Set([tok]),async()=>rec),/MISSING_RECEIPT_MATCH/);
 await assert.rejects(()=>enrich([{...entry,log_index:22}],wallet,new Set([tok]),async()=>rec),/RECEIPT_LOG_INDEX_MISMATCH/);
 const extra={...log,logIndex:'0x16'};
 const bad={...rec,logs:[log,extra]};
 await assert.rejects(()=>enrich([{...entry}],wallet,new Set([tok]),async()=>bad),/MISSING_INDEXER_TRANSFER_ROW/);
 console.log('RECEIPT_IDENTITY_UNIT_TESTS=PASS');
})().catch(e=>{console.error('TEST_FAILURE='+e.message);process.exitCode=1});
