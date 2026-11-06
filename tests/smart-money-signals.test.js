'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {normalizeWallets, normalizeActivity, buildSignals} = require('../api/smart-money-core');
const NOW = 1793991600;
const wallet = i => '0x' + String(i).padStart(40,'0');
const CONDITION = '0x' + 'a'.repeat(64);
const TX = i => '0x' + i.toString(16).padStart(64,'0');
const w1=wallet(1),w2=wallet(2),w3=wallet(3);
function entry(w,side,secs,tx,amount=500,outcomeIndex=0) {
  return {type:'TRADE',proxy_wallet:w,condition_id:CONDITION,side,
    timestamp:NOW-secs,transaction_hash:TX(tx),price:0.48,size:amount/0.48,
    usdc_size:amount, title:'Will BTC reach target?', outcome:outcomeIndex===0?'Yes':'No',
    outcome_index:outcomeIndex,event_slug:'bitcoin-target',token_id:'1234'};
}
const wallets=[w1,w2,w3].map((w,i)=>({wallet:w,name:'W'+i,window_pnl_usdc:1000,volume_shares:2000}));
test('valid leaderboard wallets and positive PnL only',()=>{
 const rows=[{user_id:w1,user_name:'one',pnl:12,volume:101,rank:1},{user_id:w2,pnl:-1,volume:500,rank:2},{user_id:w1,pnl:12,volume:101,rank:1}];
 assert.equal(normalizeWallets(rows).length,1);
});
test('reject malformed wallet and invalid amount',()=>{
 assert.equal(normalizeActivity(entry(w1,'BUY',5,1),w2,NOW),null);
 assert.equal(normalizeActivity({...entry(w1,'BUY',5,1),usdc_size:-5},w1,NOW),null);
 assert.equal(normalizeActivity({...entry(w1,'BUY',5,1),timestamp:NOW+200},w1,NOW),null);
});
test('observed buy and sell signals',()=>{
 const result=buildSignals(wallets,{[w1]:[entry(w1,'BUY',10,1),entry(w1,'SELL',20,2)]},NOW);
 assert.deepEqual(new Set(result.signals.map(x=>x.type)),new Set(['SMART_MONEY_BUY','SMART_MONEY_SELL']));
 assert.ok(result.signals.every(x=>x.execution_authority==='none'));
});
test('duplicate activity does not duplicate signals',()=>{
 const a=entry(w1,'BUY',10,1);
 const result=buildSignals(wallets,{[w1]:[a,a]},NOW);
 assert.equal(result.trades_seen,1);
 assert.equal(result.signals.length,1);
});
test('three distinct wallet consensus within 30 minutes',()=>{
 const result=buildSignals(wallets,{[w1]:[entry(w1,'BUY',1000,1)], [w2]:[entry(w2,'BUY',500,2)], [w3]:[entry(w3,'BUY',50,3)]},NOW);
 const a=result.signals.find(x=>x.type==='WHALE_CONSENSUS');
 assert.ok(a);
 assert.equal(a.wallet_count,3);
});
test('no consensus for three trades by same wallet',()=>{
 const result=buildSignals(wallets,{[w1]:[entry(w1,'BUY',200,1),entry(w1,'BUY',100,2),entry(w1,'BUY',50,3)]},NOW);
 assert.ok(!result.signals.some(x=>x.type==='WHALE_CONSENSUS'));
});
test('no consensus for different outcomes',()=>{
 const result=buildSignals(wallets,{[w1]:[entry(w1,'BUY',250,1,500,0)], [w2]:[entry(w2,'BUY',220,2,500,1)], [w3]:[entry(w3,'BUY',200,3,500,0)]},NOW);
 assert.ok(!result.signals.some(x=>x.type==='WHALE_CONSENSUS'));
});
test('same-wallet recent opposing outcome sell then buy flags possible reversal',()=>{
 const result=buildSignals(wallets,{[w1]:[entry(w1,'SELL',300,1,500,1),entry(w1,'BUY',90,2,600,0)]},NOW);
 assert.ok(result.signals.some(x=>x.type==='POSSIBLE_WALLET_REVERSAL'));
});
test('oversized trade against sample baseline flags unusual activity',()=>{
 const history=[];
 for(let i=0;i<7;i++)history.push(entry(w1,'BUY',1000+i,100+i,300));
 history.push(entry(w1,'BUY',20,250,5000));
 const result=buildSignals(wallets,{[w1]:history},NOW);
 assert.ok(result.signals.some(x=>x.type==='UNUSUAL_ACTIVITY'));
});
test('stale activity is not eligible for fresh browser alerts',()=>{
 const result=buildSignals(wallets,{[w1]:[entry(w1,'BUY',2000,1)]},NOW);
 assert.equal(result.signals[0].alert_fresh,false);
});
test('reject cross-market consensus despite matching title',()=>{
 const a=entry(w1,'BUY',100,1),b=entry(w2,'BUY',100,2),c=entry(w3,'BUY',100,3);
 c.condition_id='0x'+'b'.repeat(64);
 const result=buildSignals(wallets,{[w1]:[a],[w2]:[b],[w3]:[c]},NOW);
 assert.ok(!result.signals.some(x=>x.type==='WHALE_CONSENSUS'));
});
test('strict evidence and no executor imports or dispatch surfaces',()=>{
 const fs=require('node:fs');
 const src=['api/smart-money-core.js','api/smart-money-signals.js','smart-money-signals.html']
   .map(p=>fs.readFileSync(require('node:path').join(__dirname,'..',p),'utf8')).join('\n');
 assert.ok(!src.includes('private_key'));
 assert.ok(!src.includes('place_order('));
 assert.ok(!src.includes('api.hyperliquid'));
});