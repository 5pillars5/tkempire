'use strict';
// Assert the ACTUAL public production site serves the released navigation.
// Polls during Vercel propagation; does not pass if old HTML is still served.
const assert=require('node:assert/strict');
const BASE='https://www.tkempire.io';
const SLEEP_MS=4000,MAX_ATTEMPTS=35;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const paths=['/','/research.html','/dashboard.html','/smart-money.html','/smart-money-signals.html','/assets/js/site-tabs.js?v=4','/assets/css/site-tabs.css?v=4'];
async function pull(p){
 const r=await fetch(BASE+p+(p.includes('?')?'&':'?')+'ci_check='+Date.now(),
   {cache:'no-store',redirect:'error',headers:{Accept:'text/html, text/css, application/javascript'},signal:AbortSignal.timeout(15000)});
 if(!r.ok)throw Error(p+'_HTTP_'+r.status);
 return r.text();
}
function verify(files){
 for(const p of paths.slice(0,5)){
  assert.ok(files[p].includes('site-tabs.js?v=4'),p+': old shared navigation JS');
  assert.ok(files[p].includes('site-tabs.css?v=4'),p+': old shared navigation CSS');
 }
 const home=files['/'],research=files['/research.html'],dash=files['/dashboard.html'];
 for(const needle of ['href="smart-money.html"','href="smart-money-signals.html"'])
  assert.ok(home.includes(needle),'homepage missing destination: '+needle);
 for(const needle of ['href="/smart-money.html"','href="/smart-money-signals.html"']){
  assert.ok(research.includes(needle),'research page missing '+needle);
  assert.ok(dash.includes(needle),'dashboard page missing '+needle);
 }
 const js=files['/assets/js/site-tabs.js?v=4'];
 assert.ok(js.includes("['Smart Money','/smart-money.html']"),'live JS missing wallet link');
 assert.ok(js.includes("['Live Signals','/smart-money-signals.html']"),'live JS missing signals link');
 assert.ok(js.includes('statusNodes'),'live JS missing dashboard status preservation');
 const css=files['/assets/css/site-tabs.css?v=4'];
 assert.ok(css.includes('@media(max-width:1120px)'), 'live CSS missing tablet menu');
 console.log('PRODUCTION_NAVIGATION=PASS 5 HTML pages, canonical JS+CSS, homepage/research/dashboard links, accessible tablet menu');
}
async function main(){
 let reason='';
 for(let attempt=1;attempt<=MAX_ATTEMPTS;attempt++){
  try{
   const files={};
   for(const p of paths) files[p]=await pull(p);
   verify(files);
   console.log('PRODUCTION_NAVIGATION_ATTEMPT='+attempt+' VERIFIED_LIVE_DOMAIN='+BASE);
   return;
  }catch(e){
   reason=String(e.message||e);
   console.log('PRODUCTION_NAVIGATION_NOT_READY='+attempt+' REASON='+reason);
   if(attempt<MAX_ATTEMPTS)await sleep(SLEEP_MS);
  }
 }
 throw Error('PRODUCTION_NAVIGATION_NOT_VERIFIED '+reason);
}
main().catch(e=>{console.error('PRODUCTION_NAVIGATION=FAIL '+String(e.message||e));process.exitCode=1;});
