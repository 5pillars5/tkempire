'use strict';
// Public-only upstream compatibility smoke test. No credentials, no orders.
const assert = require('node:assert/strict');
const { normalizeWallets, normalizeActivity } = require('../api/smart-money-core');
const BASE='https://data-api.polymarket.com';
async function get(path,params){
 const url=new URL(path,BASE);
 for(const [key,value] of Object.entries(params))url.searchParams.set(key,String(value));
 const response=await fetch(url,{redirect:'error',headers:{Accept:'application/json'},signal:AbortSignal.timeout(13000)});
 console.log('UPSTREAM_STATUS',path,response.status);
 assert.equal(response.status,200);
 const body=await response.json();
 assert.ok(Array.isArray(body.data),'Expected public v2 data array');
 return body.data;
}
async function main(){
 const board=await get('/v2/leaderboard',{time_period:'week',category:'crypto',sort_by:'PNL',limit:16});
 const wallets=normalizeWallets(board,8);
 console.log('LEADERBOARD_ROWS',board.length,'QUALIFIED_WALLETS',wallets.length);
 assert.ok(wallets.length>=1,'No qualified wallet; do not report operational signal feed');
 const now=Math.floor(Date.now()/1000);
 const activities=await get('/v2/activity',{
   user:wallets[0].wallet,type:'TRADE',limit:20,
   start:now-86400,end:now,sort_by:'TIMESTAMP',sort_direction:'DESC'
 });
 const normalized=activities.map(r=>normalizeActivity(r,wallets[0].wallet,now)).filter(Boolean);
 console.log('ACTIVITY_ROWS',activities.length,'VALIDATED_TRADES',normalized.length);
 if(activities.length>0)assert.ok(normalized.length>0,'Activity schema mismatch; parsed zero valid rows');
 console.log('READ_ONLY_POLYMARKET_CONTRACT=PASS');
}
main().catch(err=>{console.error('READ_ONLY_POLYMARKET_CONTRACT=FAIL',err.message);process.exitCode=1;});