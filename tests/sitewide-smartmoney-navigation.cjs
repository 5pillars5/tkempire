'use strict';
/* Test local repo using a real browser, with API mock and no production requests. */
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const {chromium}=require('playwright-core');
const ROOT=path.resolve(__dirname,'..');
const FILES=['index.html','research.html','dashboard.html','smart-money.html','smart-money-signals.html','smart-money-flow.html','genesis-signals.html','results.html','learn.html','portfolio.html','recovery.html','testnet.html','about.html','join.html','community.html','app.html'];
const mime={'.html':'text/html','.js':'application/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml','.json':'application/json'};
function serve(req,res){
 const url=new URL(req.url,'http://localhost');
 if(url.pathname.startsWith('/api/')){
  res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});
  const result=url.pathname.includes('smart-money-watch')?{status:'ok',rows:[]}:
   url.pathname.includes('smart-money-signals')?{status:'degraded',signals:[],monitored_wallets:0,trades_scanned:0,qualifying_signals:0,successful_wallets:0,failed_wallets:0}:
   {status:'unavailable',performance:{},health:{},engine:{},trades:[],positions:[]};
  res.end(JSON.stringify(result));return;
 }
 const pathname=decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname);
 const target=path.resolve(ROOT,'.'+pathname);
 if(!target.startsWith(ROOT+path.sep)){res.writeHead(403);res.end();return}
 fs.readFile(target,(e,b)=>{if(e){res.writeHead(404);res.end();return}res.writeHead(200,{'content-type':mime[path.extname(target)]||'application/octet-stream'});res.end(b)});
}
async function run(){
 const js=fs.readFileSync(path.join(ROOT,'assets/js/site-tabs.js'),'utf8');
 const css=fs.readFileSync(path.join(ROOT,'assets/css/site-tabs.css'),'utf8');
 const sitemap=fs.readFileSync(path.join(ROOT,'sitemap.xml'),'utf8');
 for(const name of ['Flow Map','Smart Money Positions','Live Signals','Genesis Signals'])assert.ok(js.includes("['"+name+"'"),name+' missing');
 for(const file of FILES){
  const source=fs.readFileSync(path.join(ROOT,file),'utf8');
  assert.match(source,/site-tabs\.js\?v=4/,file+' must load current navigation JS');
  assert.match(source,/site-tabs\.css\?v=4/,file+' must load current navigation CSS');
 }
 for(const file of ['smart-money.html','smart-money-signals.html','smart-money-flow.html','genesis-signals.html'])assert.ok(sitemap.includes(file));
 assert.match(css,/@media\(max-width:1120px\)/);
 console.log('STATIC_SITE_NAVIGATION=PASS files='+FILES.length);
 const server=http.createServer(serve);
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 let browser;
 try{
  let chrome=null;
  for(const bin of ['google-chrome','chromium','chromium-browser']){try{chrome=execFileSync('which',[bin],{encoding:'utf8'}).trim();break}catch{}}
  if(!chrome)throw Error('Chromium/Chrome executable missing');
  browser=await chromium.launch({headless:true,executablePath:chrome,args:['--no-sandbox','--disable-dev-shm-usage']});
  const base='http://127.0.0.1:'+server.address().port;
  const desktop=await browser.newContext({viewport:{width:1440,height:900}});
  let errors=0;
  for(const file of FILES){
   const page=await desktop.newPage();
   page.on('pageerror',error=>{if(/site-tabs/i.test(error.stack||'')){console.error('NAV_JS_ERROR',file,error.message);errors++}});
   await page.goto(base+'/'+file,{waitUntil:'domcontentloaded',timeout:30000});
   const nav=page.locator('nav.empire-global-nav[aria-label="Main navigation"]');
   await nav.waitFor({timeout:12000});
   assert.equal(await nav.count(),1,file+' navigation count');
   // Redesigned desktop navigation is intentionally collapsed until the user opens it.
   const menu=nav.getByRole('button',{name:/menu/i});
   await menu.click();
   assert.equal(await menu.getAttribute('aria-expanded'),'true',file+' menu did not open');
   for(const name of ['Flow Map','Smart Money Positions','Live Signals','Genesis Signals']){
    const a=nav.getByRole('link',{name,exact:true});
    assert.equal(await a.count(),1,file+' missing '+name);
    assert.equal(await a.getAttribute('href'),name==='Smart Money Positions'?'/smart-money.html':name==='Flow Map'?'/smart-money-flow.html':name==='Genesis Signals'?'/genesis-signals.html':'/smart-money-signals.html');
   }
   if(file==='dashboard.html')for(const id of ['modePill','lastUpdated','genesis-nav-status'])
    assert.equal(await page.locator('#'+id).count(),1,'dashboard status removed: '+id);
   if(file.startsWith('smart-money')){
    const active=nav.locator('a[aria-current="page"]');
    assert.equal(await active.count(),1,file+' active count');
    assert.equal(await active.getAttribute('href'),'/'+file);
   }
   console.log('DESKTOP_NAV_PASS',file);
   await page.close();
  }
  await desktop.close();
  const mobile=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  for(const file of ['index.html','dashboard.html','research.html','smart-money.html','smart-money-signals.html','smart-money-flow.html','genesis-signals.html']){
   const page=await mobile.newPage();
   await page.goto(base+'/'+file,{waitUntil:'domcontentloaded'});
   const nav=page.locator('nav.empire-global-nav');
   const toggle=nav.getByRole('button',{name:/menu/i});
   await toggle.waitFor();
   const links=nav.locator('#empire-nav-links');
   assert.equal(await toggle.getAttribute('aria-expanded'),'false');
   assert.equal(await links.isVisible(),false,'closed menu visible '+file);
   await toggle.click();
   assert.equal(await toggle.getAttribute('aria-expanded'),'true');
   assert.equal(await links.isVisible(),true,'expanded menu invisible '+file);
   assert.equal(await links.getByRole('link',{name:'Live Signals',exact:true}).isVisible(),true);
   assert.equal(await links.getByRole('link',{name:'Flow Map',exact:true}).isVisible(),true);
   await page.keyboard.press('Escape');
   assert.equal(await toggle.getAttribute('aria-expanded'),'false');
   await toggle.click();
   assert.equal(await toggle.getAttribute('aria-expanded'),'true');
   await page.evaluate(()=>document.body.click());
   assert.equal(await toggle.getAttribute('aria-expanded'),'false','outside-click failed '+file);
   console.log('MOBILE_NAV_PASS',file);
   await page.close();
  }
  await mobile.close();
  assert.equal(errors,0);
  console.log('SITEWIDE_BROWSER_NAVIGATION=PASS desktop='+FILES.length+' mobile=6 keyboard=yes');
 }finally{
  if(browser)await browser.close();
  await new Promise(resolve=>server.close(resolve));
 }
}
run().catch(e=>{console.error('SITEWIDE_NAVIGATION_TEST_FAIL',e.stack||e);process.exitCode=1});
