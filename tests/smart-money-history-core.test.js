'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {validateFlow,validateSignalFeed,matchResolution,catalogTokens,mergeDay,hash}=require('../ops/smart-money-history-v1/history-core');
const c='0x'+'a'.repeat(64),a='123456789',b='987654321',now=1794000000;
const at=new Date(now*1000).toISOString();
const catalog={data:[
 {condition_id:c,token_id:a,outcome_index:0,outcome:'Yes'},
 {condition_id:c,token_id:b,outcome_index:1,outcome:'No'}]};
const res={condition_id:c,status:'resolved',payouts:[1000000,0],
 resolved_at:new Date((now+100)*1000).toISOString(),transaction_hash:'0x'+'f'.repeat(64),log_index:'1'};
const signal=(token=a,side='BUY')=>({
 id:'f'.repeat(24),condition_id:c,token_id:token,side,observed_at:at,captured_at:at,
 amount_usdc:100,representative_price:.45,source:'PUBLIC_SIGNAL_FEED_V1'
});
const feed={status:'ok',generated_at:at,execution_enabled:false,genesis_execution_authority:'none',
 signals:[{...signal(),execution_authority:'none',signal_mode:'OBSERVATION_ONLY',paper_trade:false,
 type:'SMART_MONEY_BUY',market:'Market',outcome:'Yes',wallets:['0x'+'1'.repeat(40)]}]};
const flow={schema_version:1,status:'ok',generated_at:at,execution_enabled:false,
 genesis_execution_authority:'none',market_pressure_is_win_probability:false,
 prediction_model_status:'NOT_TRAINED_OR_CALIBRATED',wallets_selected:8,
 wallets_returned:8,wallets_failed:0,wallets_truncated:1,events_sampled:20,market_count:1,
 markets:[{condition_id:c,token_id:a,observed_buy_usdc:100,observed_sell_usdc:40,
 observed_net_usdc:60,inferred_win_probability:null,quality_weighted_score:null,entry_edge:null,
 last_sampled_trade_price:.5,activity_count:4, wallets_net_buying:1,wallets_net_selling:0,
 title:'Market',outcome:'Yes'}]};
test('strict flow snapshot and incomplete-source coverage',()=>{
 const got=validateFlow(flow,now);
 assert.equal(got.bucket,Math.floor(now/900)*900);
 assert.equal(got.coverage.incomplete,true);
 assert.equal(got.markets[0].net_usdc,60);
 assert.match(got.sha256,/^[a-f0-9]{64}$/);
 assert.throws(()=>validateFlow({...flow,markets:[{...flow.markets[0],inferred_win_probability:.8}]},now),/INVALID_OUTCOME_FLOW/);
 assert.throws(()=>validateFlow({...flow,generated_at:'2020-01-01T00:00:00Z'},now),/STALE/);
});
test('identical monitor public feed ID and deduplication',()=>{
 const got=validateSignalFeed({...feed,signals:[feed.signals[0],feed.signals[0]]},now);
 assert.equal(got.signals.length,1);
 assert.equal(got.signals[0].id,'f'.repeat(24));
 assert.equal(got.signals[0].token_id,a);
 assert.equal(got.signals[0].source,'PUBLIC_SIGNAL_FEED_V1');
 assert.throws(()=>validateSignalFeed({...feed,signals:[{...feed.signals[0],paper_trade:true}]},now),/INVALID_SIGNAL/);
});
test('winner, loser and token-index reversal are matched exactly',()=>{
 assert.deepEqual(catalogTokens(catalog,c).map(x=>x.index),[0,1]);
 assert.equal(matchResolution(signal(a),res,catalog).result,'PAYOUT_1');
 assert.equal(matchResolution(signal(b),res,catalog).result,'PAYOUT_0');
 assert.equal(matchResolution(signal(b),{...res,payouts:[0,1000000]},catalog).result,'PAYOUT_1');
 assert.equal(matchResolution(signal(a),{...res,payouts:[0.3,0.7]},catalog).result,'PARTIAL_PAYOUT');
});
test('unresolved, bad mapping, missing/wrong token and invalid payout fail closed',()=>{
 assert.equal(matchResolution(signal(),{...res,status:'proposed'},catalog).result,'PENDING');
 assert.equal(matchResolution(signal(),res,{data:[{...catalog.data[0],token_id:'222'},catalog.data[1]]}).result,'UNVERIFIED');
 assert.equal(matchResolution(signal('1234'),res,catalog).reason,'OUTCOME_TOKEN_MISMATCH');
 assert.equal(matchResolution(signal(),res,{data:[{...catalog.data[0],outcome_index:1},catalog.data[1]]}).reason,'TOKEN_CATALOG_UNVERIFIED');
 assert.equal(matchResolution(signal(),{...res,payouts:[700000,200000]},catalog).result,'UNVERIFIED');
 assert.equal(matchResolution({...signal(),condition_id:null},res,catalog).reason,'UNMATCHABLE_SIGNAL_IDENTITY');
});
test('late signal cannot be labeled as a successful prediction',()=>{
 assert.equal(matchResolution({...signal(),observed_at:new Date((now+200)*1000).toISOString()},res,catalog).result,'EXCLUDED');
});
test('resolution result never pretends to be wallet profit, winning chance or score',()=>{
 const out=matchResolution(signal(),res,catalog);
 assert.equal(out.event_profit_usdc,null);
 assert.equal(out.probability_estimate,null);
 assert.equal(out.quality_score,null);
});
test('mergeDay persists first snapshot immutable and dedups monitor signal ID',()=>{
 const sn=validateFlow(flow,now);
 const events=validateSignalFeed(feed,now);
 const day=at.slice(0,10);
 const first=mergeDay(null,sn,events,day+'T23:59:59Z');
 const revised=validateFlow({...flow,markets:[{...flow.markets[0],observed_net_usdc:70,observed_buy_usdc:110}]},now);
 const second=mergeDay(first,revised,events,day+'T23:59:59Z');
 assert.equal(second.flow_snapshots.length,1);
 assert.equal(second.signal_events.length,1);
 assert.equal(second.flow_snapshots[0].sha256,sn.sha256);
 assert.deepEqual(second.signal_events[0].id,events.signals[0].id);
});
