'use strict';
const assert=require('node:assert/strict');
const BASE='https://www.tkempire.io';
async function get(path){
 let last='';
 for(let attempt=1;attempt<=4;attempt++){
  try{
    const res=await fetch(BASE+path,{redirect:'error',cache:'no-store',headers:{Accept:'application/json'},signal:AbortSignal.timeout(18000)});
    const raw=await res.text();
    console.log(path,'HTTP',res.status,'BYTES',raw.length,'ATTEMPT',attempt);
    if(res.ok)return {res,raw};
    last='HTTP '+res.status+' '+raw.slice(0,250);
  }catch(err){last=err.message;}
  await new Promise(resolve=>setTimeout(resolve,2500));
 }
 throw new Error(path+' failed: '+last);
}
async function main(){
 const page=await get('/smart-money-signals.html');
 assert.ok(page.raw.includes('Smart Money <span>Signals</span>'));
 const watch=await get('/smart-money.html');
 assert.ok(watch.raw.includes('/smart-money-signals.html'));
 const board=await get('/api/smart-money-watch?view=board&period=week&category=crypto');
 const b=JSON.parse(board.raw);
 assert.equal(b.status,'ok');assert.ok(Array.isArray(b.rows));assert.ok(b.rows.length>0);
 console.log('WALLET_WATCH_ROWS',b.rows.length);
 const signals=await get('/api/smart-money-signals');
 const s=JSON.parse(signals.raw);
 assert.ok(['ok','degraded'].includes(s.status));
 assert.ok(Array.isArray(s.signals));
 assert.ok(s.monitored_wallets>0);
 assert.equal(s.execution_enabled,false);
 assert.equal(s.genesis_execution_authority,'none');
 console.log('SIGNAL_FEED',s.status,'MONITORED',s.monitored_wallets,'TRADES',s.trades_scanned,'SIGNALS',s.qualifying_signals,'FAILED_WALLETS',s.failed_wallets);
 console.log('TK_EMPIRE_SMART_MONEY_PRODUCTION=PASS');
}
main().catch(err=>{console.error('TK_EMPIRE_SMART_MONEY_PRODUCTION=FAIL',err.message);process.exitCode=1;});