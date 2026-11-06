'use strict';
const assert=require('node:assert/strict');
const {normalizedTransfer,reconcile,CASES}=require('../research/etherscan-v2-six-token-archival-20261106.js');
const wallet=CASES[0].wallet;
const token=Object.values(CASES[0].conditions)[0][0];
const base={hash:'0x'+'a'.repeat(64),contractAddress:'0x4d97dcd97ec945f40cf65f87097ace5ea0476045',
  tokenID:token,tokenValue:'3000000',blockNumber:'96862000',
  from:'0x'+'0'.repeat(40),to:wallet,logIndex:'3'};
{
 const r=normalizedTransfer(base,wallet,new Set([token]),{start:96861000,end:96863000});
 assert.equal(r.token_id,token);assert.equal(r.quantity_raw,'3000000');assert.equal(r.log_index,3);
 assert.equal(reconcile([r],wallet,token).net_shares,'3.000000');
 const burn=normalizedTransfer({...base,hash:'0x'+'b'.repeat(64),
    from:wallet,to:'0x'+'0'.repeat(40),logIndex:'4'},wallet,new Set([token]),{start:96861000,end:96863000});
 const result=reconcile([r,burn],wallet,token);
 assert.equal(result.net_shares,'0.000000');assert.equal(result.burned_shares,'3.000000');
}
assert.throws(()=>normalizedTransfer({...base,contractAddress:wallet},wallet,new Set([token]),{start:96861000,end:96863000}),/WRONG_TOKEN_CONTRACT/);
assert.throws(()=>normalizedTransfer({...base,blockNumber:'96870000'},wallet,new Set([token]),{start:96861000,end:96863000}),/UNVERIFIED_TRANSFER_SCHEMA/);
assert.throws(()=>normalizedTransfer({...base,to:'0x'+'f'.repeat(40)},wallet,new Set([token]),{start:96861000,end:96863000}),/WALLET_TRANSFER_MISMATCH/);
assert.equal(normalizedTransfer({...base,logIndex:undefined},wallet,new Set([token]),{start:96861000,end:96863000}).log_index,null);
const caseCount=CASES.reduce((n,c)=>n+Object.values(c.conditions).flat().length,0);
assert.equal(caseCount,6);
console.log('ARCHIVAL_TRANSFER_UNIT_TESTS=PASS');
