'use strict';
const assert=require('node:assert/strict');
const test=require('node:test');
const {normalize,buildFlowSnapshot}=require('../api/smart-money-flow-core');
const A='0x'+'1'.repeat(40),B='0x'+'2'.repeat(40),C='0x'+'3'.repeat(40);
const COND='0x'+'a'.repeat(64),T='987654321',OPPOSITE='123456';
const now=1800000000;
const wallets=[{wallet:A},{wallet:B},{wallet:C}];
function trade(wallet,side,amount,secondsAgo,token=T,outcome='YES',index=0){
 const size=amount*2;
 const timestamp=now-secondsAgo;
 return {type:'TRADE',proxy_wallet:wallet,condition_id:COND,
  transaction_hash:'0x'+(wallet.slice(2,3)+(side==='BUY'?'b':'c')+String(secondsAgo).padStart(6,'0')).padEnd(64,'a'),
  title:'Bitcoin example market',outcome,outcome_index:index,token_id:token,
  usdc_size:amount,price:.5,size,timestamp,side};
}
test('normalization rejects activity from wrong wallet and fake fills',()=>{
 assert.equal(normalize({...trade(A,'BUY',500,10),proxy_wallet:B},A,now),null);
 assert.equal(normalize({...trade(A,'BUY',500,10),type:'REDEEM'},A,now),null);
 assert.equal(normalize({...trade(A,'BUY',500,10),price:1.5},A,now),null);
 assert.equal(normalize({...trade(A,'BUY',500,10),timestamp:now+1000},A,now),null);
 assert.ok(normalize(trade(A,'BUY',500,10),A,now));
});
test('net USD, distinct wallet agreement, exact outcome separation and duplicate removal',()=>{
 const a=trade(A,'BUY',1200,100);
 const b=trade(B,'BUY',900,200);
 const c=trade(C,'BUY',700,300);
 const sell=trade(A,'SELL',150,70);
 const other=trade(B,'SELL',500,140,OPPOSITE,'NO',1);
 const out=buildFlowSnapshot(wallets,{[A]:[a,a,sell],[B]:[b,other],[C]:[c]},now);
 assert.equal(out.events_sampled,5);
 assert.equal(out.market_count,2);
 const yes=out.markets.find(m=>m.token_id===T);
 const no=out.markets.find(m=>m.token_id===OPPOSITE);
 assert.equal(yes.observed_buy_usdc,2800);
 assert.equal(yes.observed_sell_usdc,150);
 assert.equal(yes.observed_net_usdc,2650);
 assert.equal(yes.wallets_net_buying,3);
 assert.equal(yes.wallets_net_selling,0);
 assert.equal(yes.consensus_level,'OBSERVED_3_PLUS_NET_BUYERS');
 assert.equal(no.observed_net_usdc,-500);
 assert.equal(no.wallets_net_selling,1);
 assert.equal(yes.inferred_win_probability,null);
 assert.equal(yes.entry_edge,null);
 assert.equal(out.market_pressure_is_win_probability,false);
 assert.equal(out.quality_weighting_enabled,false);
 assert.equal(out.execution_enabled,false);
 assert.equal(out.genesis_execution_authority,'none');
 assert.equal(out.prediction_model_status,'NOT_TRAINED_OR_CALIBRATED');
});
test('net participants measure wallet net direction not trade count',()=>{
 const out=buildFlowSnapshot(wallets,{[A]:[trade(A,'BUY',100,300),trade(A,'SELL',300,290)]},now);
 const m=out.markets[0];
 assert.equal(m.wallets_net_buying,0);
 assert.equal(m.wallets_net_selling,1);
 assert.equal(m.observed_net_usdc,-200);
 assert.equal(m.consensus_level,'NOT_ESTABLISHED');
});
test('15 minute acceleration compares separate intervals, not future values',()=>{
 const nowTrade=trade(A,'BUY',100,400);
 const older=trade(A,'SELL',70,1100);
 const stale=trade(B,'BUY',999,90000);
 const out=buildFlowSnapshot(wallets,{[A]:[nowTrade,older],[B]:[stale]},now);
 const m=out.markets[0];
 assert.equal(out.events_sampled,2);
 assert.equal(m.net_15m_usdc,100);
 assert.equal(m.net_previous_15m_usdc,-70);
 assert.equal(m.flow_change_15m_usdc,170);
 assert.equal(m.cumulative_flow_15m.length,97);
 assert.equal(m.cumulative_flow_15m.at(-1).v,30);
});
test('reduced coverage remains explicitly degraded and no predictive model inferred',()=>{
 const out=buildFlowSnapshot(wallets,{[A]:[trade(A,'BUY',30,30)]},now,
  {successful_wallets:1,failed_wallets:2,truncated_wallets:1});
 assert.equal(out.status,'degraded');
 assert.equal(out.wallets_failed,2);
 assert.equal(out.wallets_truncated,1);
 assert.equal(out.markets[0].evidence_quality,'PARTIAL_WALLET_FEEDS');
 assert.equal(out.market_pressure_is_win_probability,false);
 assert.equal(out.markets[0].quality_weighted_score,null);
});
test('no data renders genuine zeros and no fabricated probability',()=>{
 const out=buildFlowSnapshot(wallets,{},now);
 assert.equal(out.market_count,0);
 assert.equal(out.events_sampled,0);
 assert.equal(out.total_observed_net_usdc,0);
 assert.equal(out.markets.length,0);
});
