'use strict';
/* Real browser QA with actual repository assets and controlled, bounded API fixtures.
 * No external market requests, credentials, trading, or VPS actions. */
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const {chromium}=require('playwright-core');
const ROOT=path.resolve(__dirname,'..');
const MIME={'.html':'text/html','.js':'application/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml'};
const BASE=Date.parse('2026-11-13T05:00:00.000Z');
const META={schema_version:1,status:'ok',source:'HYPERLIQUID_PERP_MID',market:'hyperliquid_mainnet_perpetuals',quote_type:'indicative_mid_usd',disclosure:'MARKET_INDICATION_NOT_EXECUTABLE_PRICE'};
function fixture(seconds,sol=100,bnb=600,apt=2.5,changes={}){
 return {...META,retrieved_at:new Date(BASE+seconds*1000).toISOString(),prices:{SOL:sol,BNB:bnb,APT:apt},...changes};
}
function fixtures(kind){
 const ok=[fixture(0,100,600,2.5),fixture(10,100.1,600.1,2.501),fixture(20,100.4,600.25,2.52)];
 if(kind==='expired')return [fixture(-16.5)];
 if(kind==='future')return [fixture(1)];
 if(kind==='wrong_source')return [fixture(0,100,600,2.5,{source:'WRONG_SOURCE'})];
 if(kind==='duplicate')return [...ok,fixture(20,999,999,999)];
 if(kind==='expires_after_ready')return [...ok,fixture(20,999,999,999),fixture(20,999,999,999)];
 return ok;
}
function serve(req,res){
 const url=new URL(req.url,'http://localhost');
 if(url.pathname.startsWith('/api/')){
  res.writeHead(503,{'content-type':'application/json','cache-control':'no-store'});
  res.end(JSON.stringify({status:'unavailable'}));return;
 }
 const pathname=decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname);
 const target=path.resolve(ROOT,'.'+pathname);
 if(!target.startsWith(ROOT+path.sep)){res.writeHead(403);res.end();return;}
 fs.readFile(target,(error,body)=>{
  if(error){res.writeHead(404);res.end();return;}
  res.writeHead(200,{'content-type':MIME[path.extname(target)]||'application/octet-stream','cache-control':'no-store'});
  res.end(body);
 });
}
async function check(browser,base,name,viewport,kind){
 const mobile=viewport.width<=470;
 const context=await browser.newContext({viewport,isMobile:mobile,hasTouch:mobile});
 const page=await context.newPage();
 await page.clock.install({time:new Date(BASE)});
 let requests=[];let errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://**/*',route=>route.fulfill({status:204,body:''}));
 await page.route('**/api/genesis/prices',route=>{
  requests.push({method:route.request().method(),path:new URL(route.request().url()).pathname});
  if(kind==='http_502')return route.fulfill({status:502,contentType:'application/json',body:JSON.stringify({status:'market_data_unavailable'})});
  const seq=fixtures(kind),item=seq[Math.min(requests.length-1,seq.length-1)];
  return route.fulfill({status:200,contentType:'application/json',headers:{'cache-control':'no-store'},body:JSON.stringify(item)});
 });
 try{
  await page.goto(base+'/genesis-market-pulse.html',{waitUntil:'domcontentloaded',timeout:30000});
  const ready=()=>[...document.querySelectorAll('.card .state')].every(n=>n.textContent==='READY');
  const unavailable=()=>[...document.querySelectorAll('.card .state')].every(n=>n.textContent==='UNAVAILABLE');
  if(['fresh','duplicate','expires_after_ready'].includes(kind)){
   await page.waitForFunction(()=>document.querySelector('[data-asset="SOL"] .state').textContent==='COLLECTING');
   await page.clock.runFor(10000);
   await page.clock.runFor(10000);
   await page.waitForFunction(ready,{timeout:6000});
   const sol=page.locator('[data-asset="SOL"]');
   assert.notEqual(await sol.locator('[data-field="move"]').textContent(),'\u2014');
   assert.match(await sol.locator('.direction').textContent(),/Observed: RISING/);
   if(kind!=='fresh'){
    await page.clock.runFor(10000);
    await page.waitForFunction(()=>document.querySelector('#feed').textContent.includes('Delayed or duplicate'),{timeout:6000});
    assert.equal(await sol.locator('.state').textContent(),'READY');
   }
   if(kind==='expires_after_ready'){
    await page.clock.runFor(10000);
    await page.waitForFunction(()=>[...document.querySelectorAll('.card .state')].every(n=>n.textContent==='STALE'),{timeout:6000});
   }
  } else {
   await page.waitForFunction(unavailable,{timeout:6000});
  }
  const states=await page.locator('.card .state').allTextContents();
  if(['fresh','duplicate'].includes(kind))assert.deepEqual(states,['READY','READY','READY']);
  else if(kind==='expires_after_ready')assert.deepEqual(states,['STALE','STALE','STALE']);
  else assert.deepEqual(states,['UNAVAILABLE','UNAVAILABLE','UNAVAILABLE']);
  if(!['fresh','duplicate'].includes(kind)){
   for(const asset of ['BNB','SOL','APT']){
    const card=page.locator('[data-asset="'+asset+'"]');
    if(kind!=='expires_after_ready')assert.equal(await card.locator('.price').textContent(),'\u2014');
    assert.equal(await card.locator('[data-field="move"]').textContent(),'\u2014');
   }
   if(kind!=='expires_after_ready')assert.match(await page.locator('#feed').textContent(),/not verified/i);
   else assert.match(await page.locator('[data-asset="SOL"] .direction').textContent(),/Market sample expired/i);
  }
  const layout=await page.evaluate(()=>{
   const cards=[...document.querySelectorAll('.card')].map(c=>{
    const r=c.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width};
   });
   return {viewport:innerWidth,doc:document.documentElement.scrollWidth,body:document.body.scrollWidth,cards};
  });
  assert.ok(layout.doc<=viewport.width+2,'document horizontal overflow: '+JSON.stringify(layout));
  assert.ok(layout.body<=viewport.width+2,'body horizontal overflow: '+JSON.stringify(layout));
  if(mobile){
   assert.ok(Math.abs(layout.cards[0].x-layout.cards[1].x)<2,'mobile cards must stack');
   assert.ok(layout.cards[1].y>layout.cards[0].y,'mobile cards overlapping');
  }else{
   assert.ok(Math.abs(layout.cards[0].y-layout.cards[1].y)<2,'desktop cards must share a row');
   assert.ok(layout.cards[1].x>layout.cards[0].x,'desktop cards overlapping');
  }
  const nav=page.locator('nav.empire-global-nav');
  await nav.waitFor({timeout:6000});
  const toggle=nav.locator('button.empire-global-nav__toggle');
  await toggle.click();
  assert.equal(await nav.locator('a[href="/genesis-market-pulse.html"]').count(),1,'Market Pulse nav entry missing');
  await page.keyboard.press('Escape');
  assert.equal(await toggle.getAttribute('aria-expanded'),'false','Escape must close menu');
  assert.equal(errors.length,0,'browser runtime errors: '+JSON.stringify(errors));
  assert.ok(requests.length >= (['fresh','duplicate','expires_after_ready'].includes(kind)?3:1),'missing API GET requests');
  assert.ok(requests.every(req=>req.method==='GET'&&req.path==='/api/genesis/prices'));
  console.log('PULSE_BROWSER_PASS '+name+' '+kind+' calls='+requests.length+' states='+states.join(',')+' overflow=0');
 }finally{await context.close();}
}
async function main(){
 const server=http.createServer(serve);
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 let browser;
 try{
  let chrome;
  for(const name of ['google-chrome','chromium','chromium-browser']){
   try{chrome=execFileSync('which',[name],{encoding:'utf8'}).trim();break;}catch{}
  }
  assert.ok(chrome,'Chromium/Chrome executable required');
  browser=await chromium.launch({headless:true,executablePath:chrome,args:['--no-sandbox','--disable-dev-shm-usage']});
  const base='http://127.0.0.1:'+server.address().port;
  for(const [name,viewport] of Object.entries({mobile360:{width:360,height:800},mobile390:{width:390,height:844},desktop1280:{width:1280,height:800},desktop1440:{width:1440,height:900}})){
   for(const kind of ['fresh','expired','future','wrong_source','http_502','duplicate','expires_after_ready']){
    await check(browser,base,name,viewport,kind);
   }
  }
  console.log('PULSE_BROWSER_QA=PASS cases=28 viewports=4 scenarios=7');
 }finally{
  if(browser)await browser.close();
  await new Promise(resolve=>server.close(resolve));
 }
}
main().catch(e=>{console.error('PULSE_BROWSER_QA=FAIL',e.stack||e);process.exitCode=1;});