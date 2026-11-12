'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {parseSnapshot,unavailable}=require('../api/genesis/auto-worker-feed');
const now=Date.now();
const date=n=>new Date(n).toISOString();
const base=()=>({
  schema_version:1,source:'GENESIS_AUTO_TESTNET_MONITOR',publication_scope:'PRIVATE_READ_ONLY',
  execution_authority:'none',network:'TESTNET_ONLY',generated_at:date(now-1000),
  service:{state:'RUNNING',heartbeat_at:date(now-1200),restarts:0,production_mode:'PAPER',mainnet_authorized:false,auto_testnet_enabled:true},
  counters:{signals_eligible:4,signals_blocked:3,entries_submitted:2,entries_filled:1,exits_reconciled:1,errors:0},
  events:[{id:'a'.repeat(32),at:date(now-2000),coin:'APT',side:'BUY',stage:'CLOSED',reason_code:'NONE',entry_price:1.22,realized_pnl_usd:0.1,fees_usd:0.004,secret:'DO_NOT_LEAK'}],
  private_key:'SECRET',account:'PRIVATE_ACCOUNT'
});
test('valid private worker snapshot is sanitized',()=>{const data=parseSnapshot(base(),now);assert.equal(data.connected,true);assert.equal(data.service.state,'RUNNING');assert.equal(data.counters.entries_filled,1);assert.equal(data.events[0].realized_pnl_usd,0.1);assert.equal(JSON.stringify(data).includes('DO_NOT_LEAK'),false);assert.equal(JSON.stringify(data).includes('PRIVATE_ACCOUNT'),false);assert.equal(JSON.stringify(data).includes('SECRET'),false)});
test('wrong source and scope fail closed',()=>{for(const key of ['source','publication_scope','execution_authority','network']){const x=base();x[key]='BAD';assert.equal(parseSnapshot(x,now).connected,false)}});
test('stale heartbeat fails closed',()=>{const x=base();x.service.heartbeat_at=date(now-300000);assert.equal(parseSnapshot(x,now).status,'HEARTBEAT_STALE')});
test('unknown event reason is sanitized',()=>{const x=base();x.events[0].reason_code='INTERNAL_REASON:SECRET';const data=parseSnapshot(x,now);assert.equal(data.connected,true);assert.equal(data.events[0].reason_code,'OTHER')});
test('oversized/invalid counts and event identifiers fail closed',()=>{for(const mutate of [x=>x.counters.entries_filled=-1,x=>x.events[0].id='bad',x=>x.events[0].coin='SOL',x=>x.service.mainnet_authorized=true]){const x=base();mutate(x);assert.equal(parseSnapshot(x,now).connected,false)}});
test('unavailable return shape is empty and clear',()=>{const data=unavailable('DISABLED');assert.equal(data.connected,false);assert.deepEqual(data.events,[])});
