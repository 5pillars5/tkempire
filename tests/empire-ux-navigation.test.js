'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const root=path.join(__dirname,'..');
const read=(file)=>fs.readFileSync(path.join(root,file),'utf8');

test('sitewide navigation keeps primary flows and organizes secondary tools',()=>{
 const js=read('assets/js/site-tabs.js'),css=read('assets/css/site-tabs.css');
 assert.doesNotThrow(()=>new vm.Script(js));
 for(const route of ['/app.html','/genesis-signals.html','/smart-money-signals.html','/results.html','/smart-money-flow.html','/smart-money.html','/testnet.html']){
   assert.ok(js.includes("'"+route+"'"),route);
 }
 for(const heading of ['Start here','Genesis & tools','Smart Money','Research & learning','Community & access']){
   assert.ok(js.includes("'"+heading+"'"),heading);
 }
 assert.match(js,/aria-expanded/);assert.match(js,/aria-controls/);assert.match(js,/Escape/);
 assert.match(css,/\.empire-global-nav__group-title/);
 assert.match(css,/\.empire-global-nav__links\.is-open/);
 assert.match(css,/@media\(max-width:620px\)/);
 // Existing legacy operations badge nodes must survive injection.
 assert.match(js,/statusNodes/);
 assert.match(js,/genesisShortcut\.href = '\/genesis-signals\.html'/);
});
test('overview presents verified source status and unambiguous mode distinctions',()=>{
 const html=read('app.html');
 assert.match(html,/empire-overview\.css\?v=1/);
 for(const id of ['appConnectionBadge','appEngine','appMode','appOpenCount','appWinRate','appTrades','appHealthTimestamp','appResultsTimestamp']){
  assert.ok(html.includes('id="'+id+'"'),id);
 }
 for(const mode of ['PAPER','TESTNET','RESEARCH','UNVERIFIED']){
  assert.ok(html.includes(mode),mode);
 }
 for(const path of ['/genesis-signals.html','/smart-money-signals.html','/testnet.html','/results.html']){
  assert.ok(html.includes('href="'+path+'"'),path);
 }
 assert.match(html,/isFresh\(health\.served_at\)/);
 assert.match(html,/isFresh\(status\.updated_at\)/);
 assert.match(html,/Browser push-signal subscriptions are not configured/);
 assert.doesNotMatch(html,/Trade Now|Guaranteed Returns|Live Real Money Profits/i);
 const scripts=[...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
  .filter(m=>!/\bsrc\s*=/.test(m[1])).map(m=>m[2].trim()).filter(Boolean);
 for(const script of scripts)assert.doesNotThrow(()=>new vm.Script(script));
});
test('redesign does not introduce private monitor authorization or trading code',()=>{
 const html=read('app.html'),css=read('assets/css/empire-overview.css');
 assert.doesNotMatch(html,/GENESIS_AUTO_VIEW_KEY|GENESIS_AUTO_MONITOR_TOKEN|private_key|exchangeOrder/i);
 assert.doesNotMatch(css,/url\(.*api\//);
});
