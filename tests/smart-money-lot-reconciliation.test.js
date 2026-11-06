'use strict';
const assert=require('node:assert/strict');
const {lotLedger,simplifiedPosition,summarizeResolution}=require('../research/smart-money-lot-reconciliation-20261106.js');
const token='12345';
function trade(side,size,usdc,timestamp){
 return {type:'TRADE',side,size,usdc_size:usdc,timestamp,token_id:token,transaction_hash:'tx'+timestamp};
}
{
 const r=lotLedger([trade('BUY',10,6,1),trade('SELL',4,3.2,2)],token);
 assert.equal(r.buys,1);assert.equal(r.sells,1);assert.equal(r.partial_exits,1);
 assert.equal(r.remaining_shares,6);assert.equal(r.remaining_cost_basis_usdc,3.6);
 assert.equal(r.fifo_realized_pnl_usdc,0.8);
 assert.equal(r.complete_accounting,true);
}
{
 const r=lotLedger([trade('SELL',2,1,1)],token);
 assert.equal(r.complete_accounting,false);
 assert.deepEqual(r.anomalies,['exit_without_observed_buy']);
}
{
 const r=lotLedger([trade('BUY',5,2,1),{type:'MERGE',token_id:token,size:5,usdc_size:0,timestamp:2}],token);
 assert.equal(r.complete_accounting,false);
 assert.match(r.anomalies.join(' '),/structural_conversion/);
}
{
 const r=simplifiedPosition({condition_id:'0x'+'a'.repeat(64),token_id:token,status:'CLOSED',realized_pnl:12.2,current_size:0});
 assert.equal(r.realized_pnl,12.2);
 assert.equal(simplifiedPosition({condition_id:'bad',token_id:token}),null);
}
{
 const r=summarizeResolution([{condition_id:'0x'+'a'.repeat(64),status:'RESOLVED'}],'0x'+'a'.repeat(64));
 assert.equal(r.matched,true);assert.equal(r.verified,false);
}
{
 const r=summarizeResolution([{condition_id:'0x'+'a'.repeat(64),status:'resolved',payouts:[0,1]}],'0x'+'a'.repeat(64));
 assert.equal(r.verified,true);
}
console.log('LOT_RECONCILIATION_UNIT_TESTS=PASS');
