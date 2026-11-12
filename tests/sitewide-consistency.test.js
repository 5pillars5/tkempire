'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const root=require('node:path').join(__dirname,'..');
const read=p=>fs.readFileSync(require('node:path').join(root,p),'utf8');

test('homepage does not confuse completed paper trades with independent signal count',()=>{
 const s=read('index.html');
 assert.match(s,/id="metricSignals"/);assert.match(s,/id="proofSignals"/);
 assert.match(s,/>Completed paper trades<\/div>/);
 assert.doesNotMatch(s,/>Signals tracked<\/div>/);
 assert.match(s,/d\?\.source==='GENESIS_PAPER_AGGREGATE'/);
 assert.match(s,/age<=120000/);
 assert.doesNotMatch(s,/Number\.isFinite\(Number\(p\.win_rate\)\)/);
 assert.doesNotMatch(s,/signals\|\|'—'/);
});
test('results accept public aggregate where wins+losses are below total and label residual accurately',()=>{
 const s=read('results.html');
 assert.match(s,/wins \+ losses > trades/);
 assert.doesNotMatch(s,/wins \+ losses !== trades/);
 assert.match(s,/composition-other/);
 assert.match(s,/Other \/ unclassified/);
 assert.match(s,/trades-wins-losses/);
 assert.match(s,/100\*wins\/trades/);
});
test('shared Genesis strip is explicitly PAPER and does not show or inject private trade text',()=>{
 const s=read('assets/js/genesis-live.js');
 assert.doesNotThrow(()=>new vm.Script(s));
 assert.match(s,/GENESIS PAPER/);
 assert.match(s,/GENESIS_PAPER_PUBLIC_SUMMARY/);
 assert.match(s,/GENESIS_PAPER_AGGREGATE/);
 assert.match(s,/details_public===false/);
 assert.match(s,/el\.replaceChildren\(inner\)/);
 assert.doesNotMatch(s,/innerHTML|GENESIS LIVE|ACTIVE TRADE/);
});
test('sitewide private exchange and public PAPER routes remain separate',()=>{
 const h=read('testnet.html'),p=read('genesis-signals.html');
 assert.match(h,/TESTNET/);
 assert.match(h,/does not show Genesis internal paper positions/);
 assert.match(p,/Paper research, not live orders/);
 assert.doesNotMatch(read('index.html'),/GENESIS_AUTO_VIEW_KEY|GENESIS_AUTO_MONITOR_TOKEN/);
});
