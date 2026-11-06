'use strict';
const assert=require('node:assert/strict');
const {payoutVector,identity,auditEvents,compareToPositions}=require('../research/smartmoney-independent-pnl-reconcile-20261106.js');
const condition='0x'+'c'.repeat(64),wallet='0x'+'a'.repeat(40),token='123456789';
const e=(type,side,size,usdc,timestamp,index=0)=>({
 type,side,size,usdc_size:usdc,timestamp,
 token_id:token,transaction_hash:'0x'+timestamp.toString(16).padStart(64,'0'),
 condition_id:condition,proxy_wallet:wallet,outcome_index:index});
assert.deepEqual(payoutVector({status:'resolved',payouts:'[0,1000000]'}),[0,1]);
assert.deepEqual(payoutVector({status:'resolved',payouts:[.5,.5]}),[.5,.5]);
assert.equal(payoutVector({status:'posed',payouts:'[1,0]'}),null);
assert.equal(payoutVector({status:'resolved',payouts:'[0,999999]'}),null);
assert.ok(identity(e('TRADE','BUY',10,3,1)));
assert.equal(identity({...e('TRADE','BUY',10,3,1),transaction_hash:'x'}),null);
{
 const xs=[e('TRADE','BUY',10,3,1),e('TRADE','SELL',4,2,2),e('REDEEM','',6,6,3,1)];
 const r=auditEvents(xs,condition,wallet,{status:'resolved',payouts:'[0,1000000]'});
 assert.equal(r.unique_events,3);
 assert.equal(r.redemption_checks,1);
 assert.equal(r.redemption_passes,1);
 assert.equal(r.redemption_failures,0);
 const z=compareToPositions(r,[],[{token_id:token,realized_pnl:5,avg_price:.3,total_size:10}]);
 assert.equal(z.length,1);
 assert.equal(z[0].modeled_remaining_shares,0);
 assert.equal(z[0].independent_pnl_pass,true); // 2 + 6 - 3 = 5
}
{
 const xs=[e('TRADE','BUY',10,3,1),e('REDEEM','',10,0,2,0)];
 const r=auditEvents(xs,condition,wallet,{status:'resolved',payouts:'[0,1000000]'});
 assert.equal(r.redemption_passes,1);
 assert.equal(compareToPositions(r,[],[{token_id:token,realized_pnl:-3,avg_price:.3,total_size:10}])[0].independent_pnl_pass,true);
}
{
 const xs=[e('REDEEM','',11,11,1,1)];
 const r=auditEvents(xs,condition,wallet,{status:'resolved',payouts:'[0,1000000]'});
 assert.equal(r.redemption_passes,1);
 const z=compareToPositions(r,[],[{token_id:token,realized_pnl:5,avg_price:.5,total_size:11}]);
 assert.equal(z[0].classification,'NOT_RECONCILED_INVENTORY');
}
{
 const x=e('TRADE','BUY',10,3,1);
 const r=auditEvents([x,x],condition,wallet,null);
 assert.equal(r.duplicate_fingerprints,1);
}
{
 const t0=e('TRADE','BUY',10,4,1,0),t1={...e('TRADE','BUY',10,5,2,1),token_id:'98765'};
 const m={...e('MERGE','',10,10,3,999),token_id:''};
 const r=auditEvents([t0,t1,m],condition,wallet,null);
 assert.equal(r.invalid_events,0);
 assert.equal(r.merge_events,1);
 assert.equal(r.merged_collateral_usdc,10);
 assert.equal(r.tokens.length,2);
 assert.deepEqual(r.tokens.map(t=>t.modeled_remaining_shares),[0,0]);
 const positions=[{token_id:token,realized_pnl:1,avg_price:0.4,total_size:10},
                  {token_id:'98765',realized_pnl:0,avg_price:0.5,total_size:10}];
 const cmp=compareToPositions(r,[],positions);
 const mkt=require('../research/smartmoney-independent-pnl-reconcile-20261106.js').marketCashPnl(r,cmp,[],positions);
 assert.equal(mkt.inventory_reconciled,true);
 assert.equal(mkt.pnl_eligible,true);
 assert.equal(mkt.pnl_matches,true);
}
console.log('INDEPENDENT_RECONCILIATION_UNIT_TESTS=PASS');
