'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const policy=require('../lib/imperian-pricing-policy.js');
const DAY=86400000;
const NOW='2026-11-13T18:00:00Z';
const END=new Date(Date.parse(NOW)-3600000);
const h=(c)=>c.repeat(64);
function sample({end=END,days=28,wins=62,losses=38,breakevens=0,net=10,risk='PASS',hash=h('a'),...other}={}){
 return {schema_version:1,source:policy.SOURCE,reconciliation_status:'INDEPENDENTLY_VERIFIED',
 execution_mode:'PAPER',pnl_unit:'USD_VERIFIED',fees_accounted:true,
 window_start:new Date(end.getTime()-days*DAY).toISOString(),
 window_end:end.toISOString(),generated_at:end.toISOString(),
 wins,losses,breakevens,closed_trades:wins+losses+breakevens,
 net_pnl_usd:net,risk_review:risk,reconciliation_sha256:hash,...other};
}
function state(price){return {...policy.defaultState(),current_public_rate_usdc:price};}
const wallet='0x'+'ab'.repeat(20);

test('exact approved ladder including boundaries and rejects invalid numbers',()=>{
 const cases=[[0,30],[54.999,30],[55,49],[59.999,49],[60,99],
 [64.999,99],[65,199],[69.999,199],[70,300],[100,300]];
 for(const [v,expected] of cases)assert.equal(policy.rateForWinRate(v),expected);
 for(const bad of [-1,101,NaN,Infinity,'62'])assert.throws(()=>policy.rateForWinRate(bad));
});
test('lowers only with independently verified complete evidence',()=>{
 const result=policy.assessPricing(sample({wins:53,losses:47}),state(99),NOW);
 assert.equal(result.status,'LOWER_PROPOSED');
 assert.equal(result.current_public_rate_usdc,30);
 assert.equal(result.next_state.current_public_rate_usdc,30);
});
test('member quote never exceeds original maximum, drops and recovers without changing cap',()=>{
 const member={wallet_address:wallet,status:'ACTIVE',locked_max_rate_usdc:99};
 for(const [publicRate,expected] of [[30,30],[49,49],[99,99],[199,99],[300,99]]){
  const quote=policy.quoteRenewal(member,state(publicRate));
  assert.equal(quote.next_renewal_usdc,expected);
  assert.equal(quote.locked_max_rate_usdc,99);
 }
 assert.equal(policy.quoteRenewal({...member,status:'EXPIRED'},state(30)).status,'NOT_ELIGIBLE');
 assert.equal(policy.quoteRenewal({...member,wallet_address:'invalid'},state(30)).status,'NOT_ELIGIBLE');
});
test('unverified feed, stale evidence, insufficient samples, invalid units hold unchanged',()=>{
 const bad=[
  sample({source:'GENESIS_PAPER_AGGREGATE'}),
  sample({pnl_unit:'LEDGER_UNIT_UNVERIFIED'}),
  sample({wins:49,losses:50}),
  sample({closed_trades:120}),
  sample({fees_accounted:false}),
  sample({reconciliation_status:'PENDING'}),
  sample({reconciliation_sha256:'nonsense'}),
  sample({risk_review:'UNKNOWN'}),
  sample({generated_at:'2026-11-01T00:00:00Z'}),
  sample({window_start:'broken'}),
 ];
 for(const datum of bad){
  const original=state(199),result=policy.assessPricing(datum,original,NOW);
  assert.equal(result.status,'HOLD');
  assert.equal(result.next_state.current_public_rate_usdc,199);
  assert.deepEqual(original,state(199));
 }
});
test('identical or backwards evidence never applies twice',()=>{
 const s=sample(),first=policy.assessPricing(s,state(99),NOW);
 assert.equal(first.status,'HOLD');
 assert.equal(first.reason,'AWAITING_SECOND_VERIFIED_REVIEW');
 const replay=policy.assessPricing(s,first.next_state,NOW);
 assert.equal(replay.reason,'REPLAY_OR_NONADVANCING_EVIDENCE');
});
test('positive PnL alone cannot immediately raise prices',()=>{
 const r=policy.assessPricing(sample({wins:75,losses:25}),state(99),NOW);
 assert.equal(r.status,'HOLD');assert.equal(r.next_state.pending_increase.target_rate_usdc,300);
});
test('two distinct verified weekly reports can propose an increase',()=>{
 const olderEnd=new Date(END.getTime()-7*DAY);
 const old=sample({end:olderEnd,wins:70,losses:30,hash:h('a')});
 const first=policy.assessPricing(old,state(99),new Date(olderEnd.getTime()+3600000).toISOString());
 assert.equal(first.reason,'AWAITING_SECOND_VERIFIED_REVIEW');
 const second=policy.assessPricing(sample({wins:72,losses:28,hash:h('b')}),first.next_state,NOW);
 assert.equal(second.status,'RAISE_PROPOSED');assert.equal(second.current_public_rate_usdc,300);
 assert.equal(second.next_state.pending_increase,null);
});
test('unprofitable or blocked risk blocks increases but allows verified decreases',()=>{
 for(const fields of [{net:-1},{risk:'BLOCK'}]){
  const proposed=policy.assessPricing(sample({wins:75,losses:25,...fields}),state(99),NOW);
  assert.equal(proposed.reason,'UNPROFITABLE_OR_RISK_NOT_APPROVED');
  assert.equal(proposed.current_public_rate_usdc,99);
  const decrease=policy.assessPricing(sample({wins:52,losses:48,...fields}),state(199),NOW);
  assert.equal(decrease.status,'LOWER_PROPOSED');
  assert.equal(decrease.current_public_rate_usdc,30);
 }
});
test('new sample is never sufficient if risk sample time is too short',()=>{
 const bad=policy.assessPricing(sample({days:7}),state(99),NOW);
 assert.equal(bad.reason,'STALE_OR_INVALID_WINDOW');
});
test('pure decision only, no payment or trading capabilities imported',()=>{
 const fs=require('node:fs');
 const source=fs.readFileSync(require('node:path').join(__dirname,'../lib/imperian-pricing-policy.js'),'utf8');
 assert.doesNotMatch(source,/fetch\s*\(|require\s*\(\s*['"](?:node:)?(?:fs|http|https|child_process)/);
 assert.doesNotMatch(source,/privateKey|placeOrder|createOrder|sendTransaction|transferFrom|process\.env/i);
});
