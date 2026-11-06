'use strict';
// Public identity check for fixed six-token research cohort. No secrets or trading.
const {CASES}=require('./etherscan-v2-six-token-archival-20261106.js');
async function main(){
 let pass=0,fail=0;
 for(const c of CASES){
  for(const [condition,expected] of Object.entries(c.conditions)){
   const u=new URL('https://data-api.polymarket.com/v2/activity');
   for(const [k,v] of Object.entries({user:c.wallet,condition,limit:1000,sort_by:'TIMESTAMP',sort_direction:'ASC'}))u.searchParams.set(k,String(v));
   const res=await fetch(u,{method:'GET',redirect:'error',headers:{accept:'application/json'},signal:AbortSignal.timeout(20000)});
   if(!res.ok)throw Error('POLYMARKET_DATA_HTTP_'+res.status);
   const payload=await res.json();if(!Array.isArray(payload.data))throw Error('INVALID_POLYMARKET_COHORT_RESPONSE');
   const observed=new Set(payload.data.filter(row=>
     String(row.proxy_wallet||'').toLowerCase()===c.wallet&&
     String(row.condition_id||'').toLowerCase()===condition&&
     /^[0-9]+$/.test(String(row.token_id||''))).map(row=>String(row.token_id)));
   const matched=expected.filter(t=>observed.has(t));
   const missing=expected.filter(t=>!observed.has(t));
   pass+=matched.length;fail+=missing.length;
   console.log('COHORT_TOKEN_IDENTITY '+JSON.stringify({
      wallet:c.wallet,condition,expected_tokens:expected.length,found:matched.length,
      missing,first_page_events:payload.data.length,
      result:missing.length?'MISMATCH':'PASS'}));
  }
 }
 console.log('COHORT_IDENTITY_SUMMARY '+JSON.stringify({matched:pass,missing:fail,required:6}));
 if(fail)process.exitCode=2;
}
main().catch(e=>{console.error('COHORT_IDENTITY_ERROR='+String(e.message||e));process.exitCode=1});
