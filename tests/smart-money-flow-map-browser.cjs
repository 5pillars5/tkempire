'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const http=require('node:http');
const path=require('node:path');
const cp=require('node:child_process');
const {chromium}=require('playwright-core');
const root=path.resolve(__dirname,'..');
const market=(name,token,net)=>{
 const now=Math.floor(Date.now()/1000);
 return {market_id:'market-'+token,condition_id:'0x'+'a'.repeat(64),token_id:token,
 title:name,outcome:token==='123'?'YES':'NO',
 observed_buy_usdc:net>0?1500:200,observed_sell_usdc:net>0?300:1000,
 observed_net_usdc:net,observed_gross_usdc:net>0?1800:1200,
 buy_share_of_observed_flow_pct:net>0?83.3:16.7,
 wallets_net_buying:net>0?3:0,wallets_net_selling:net>0?0:2,
 participating_wallets:net>0?3:2,activity_count:6,
 last_observed_at:new Date(now*1000).toISOString(),last_sampled_trade_price:.52,
 net_15m_usdc:net>0?150:-80,net_previous_15m_usdc:net>0?30:-20,
 net_60m_usdc:net>0?400:-130,flow_change_15m_usdc:net>0?120:-60,
 consensus_level:net>0?'OBSERVED_3_PLUS_NET_BUYERS':'NOT_ESTABLISHED',
 cumulative_flow_15m:Array.from({length:97},(_,i)=>({t:now-86400+i*900,v:Math.round(net*i/96)}))};
};
let failMode=false;
const fixture={schema_version:1,status:'ok',source:'Polymarket Data API v2',
 generated_at:new Date().toISOString(),execution_enabled:false,genesis_execution_authority:'none',
 prediction_model_status:'NOT_TRAINED_OR_CALIBRATED',
 market_pressure_is_win_probability:false,market_count:2,events_sampled:12,
 wallets_selected:8,wallets_returned:8,wallets_failed:0,wallets_truncated:1,
 total_observed_buy_usdc:1700,total_observed_sell_usdc:1300,total_observed_net_usdc:400,
 markets:[market('Bitcoin goes up','123',1200),market('Bitcoin goes down','456',-800)]};
const mimes={'.html':'text/html','.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml','.jpg':'image/jpeg','.jpeg':'image/jpeg'};
const server=http.createServer((req,res)=>{
 const u=new URL(req.url,'http://localhost');
 if(u.pathname==='/api/smart-money-flow'){
  res.writeHead(failMode?503:200,{'content-type':'application/json'});
  res.end(JSON.stringify(failMode?{status:'unavailable',markets:[]}:fixture));return;
 }
 if(u.pathname.startsWith('/api/')){res.writeHead(503);res.end('{}');return}
 const p=path.resolve(root,'.'+(u.pathname==='/'?'/index.html':u.pathname));
 if(!p.startsWith(root+path.sep)){res.writeHead(403);res.end();return}
 fs.readFile(p,(err,bytes)=>{if(err){res.writeHead(404);res.end();return}res.writeHead(200,{'content-type':mimes[path.extname(p)]||'text/plain'});res.end(bytes)});
});
async function run(){
 await new Promise(done=>server.listen(0,'127.0.0.1',done));
 const base='http://127.0.0.1:'+server.address().port;
 let exe;
 for(const bin of ['google-chrome','chromium','chromium-browser']){try{exe=cp.execFileSync('which',[bin],{encoding:'utf8'}).trim();break}catch{}}
 if(!exe)throw Error('Chromium missing');
 const browser=await chromium.launch({executablePath:exe,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  const uncaught=[];page.on('pageerror',e=>uncaught.push(e.message));
  await page.goto(base+'/smart-money-flow.html',{waitUntil:'domcontentloaded'});
  await page.locator('#healthTag').filter({hasText:'OK'}).waitFor({timeout:12000});
  assert.equal(await page.locator('.flowrow').count(),2);
  assert.match(await page.locator('#detailTitle').innerText(),/Bitcoin/);
  assert.ok(await page.locator('#flowChart path').count()>0);
  assert.equal(await page.locator('nav.empire-global-nav a[href="/smart-money-flow.html"]').count(),1);
  await page.locator('#directionFilter').selectOption('sell');
  assert.equal(await page.locator('.flowrow').count(),1);
  assert.match(await page.locator('.flowrow').innerText(),/down/);
  await page.locator('#directionFilter').selectOption('all');
  await page.locator('#windowFilter').selectOption('900');
  assert.equal(await page.locator('.flowrow').count(),2);
  await page.locator('.flowrow').nth(1).click();
  assert.match(await page.locator('#detailTitle').innerText(),/down/);
  failMode=true;
  await page.locator('#refreshBtn').click();
  await page.locator('#healthTag').filter({hasText:'UNAVAILABLE'}).waitFor({timeout:12000});
  assert.equal(await page.locator('.flowrow').count(),0);
  assert.equal(await page.locator('#grossFlow').innerText(),'—');
  assert.deepEqual(uncaught,[]);
  console.log('FLOW_MAP_DESKTOP_INTERACTIVE=PASS');
  await page.close();
  failMode=false;
  const mobile=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  await mobile.goto(base+'/smart-money-flow.html',{waitUntil:'domcontentloaded'});
  await mobile.locator('#healthTag').filter({hasText:'OK'}).waitFor({timeout:12000});
  assert.equal(await mobile.locator('.flowrow').count(),2);
  const toggle=mobile.locator('nav.empire-global-nav button.empire-global-nav__toggle');
  await toggle.click();
  assert.equal(await mobile.locator('nav.empire-global-nav a[href="/smart-money-flow.html"]').isVisible(),true);
  await mobile.keyboard.press('Escape');
  assert.equal(await toggle.getAttribute('aria-expanded'),'false');
  console.log('FLOW_MAP_MOBILE=PASS');
  await mobile.close();
 }finally{await browser.close();await new Promise(done=>server.close(done))}
}
run().catch(e=>{console.error('FLOW_MAP_BROWSER=FAIL',e.stack||e);process.exitCode=1});
