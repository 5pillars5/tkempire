'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const handler=require('../api/smart-money-polymarket-link');
const good='0x'+'a'.repeat(64), other='0x'+'b'.repeat(64);
const market={conditionId:good,events:[{slug:'what-price-will-bitcoin-hit-in-november-2026'}]};
function response(){
 return {
  headers:{},code:200,body:null,ended:false,
  setHeader(key,value){this.headers[key]=value;return this},
  status(code){this.code=code;return this},
  send(body){this.body=body;return this},
  end(){this.ended=true;return this}
 };
}
test('matches exact condition, never market titles or unrelated conditions',()=>{
 assert.equal(handler._test.exactEventSlug([market],good),'what-price-will-bitcoin-hit-in-november-2026');
 assert.equal(handler._test.exactEventSlug([market],other),null);
 assert.equal(handler._test.exactEventSlug([{conditionId:good,events:[{slug:'https://evil.example'}]}],good),null);
});
test('invalid condition and POST never reach Gamma',async()=>{
 const a=response();await handler({method:'GET',query:{condition:'btc-75000'}},a);
 assert.equal(a.code,400);assert.match(a.body,/no valid public condition identifier/);
 const b=response();await handler({method:'POST',query:{condition:good}},b);
 assert.equal(b.code,405);assert.equal(b.headers.Allow,'GET');
});
test('verified original market redirects to exact event; no unrelated market substitution',async()=>{
 const prev=global.fetch;
 global.fetch=async(url)=>{
  assert.match(url,/gamma-api\.polymarket\.com\/markets\?condition_ids=/);
  return {ok:true,headers:{get:()=>null},text:async()=>JSON.stringify([{conditionId:other,events:[{slug:'not-the-market'}]},market])};
 };
 try{
  const r=response();await handler({method:'GET',query:{condition:good}},r);
  assert.equal(r.code,302);
  assert.equal(r.headers.Location,'https://polymarket.com/event/what-price-will-bitcoin-hit-in-november-2026');
  assert.equal(r.ended,true);
 }finally{global.fetch=prev;}
});
test('no exact record produces clear unavailable page, not a guessed alternative',async()=>{
 const prev=global.fetch;global.fetch=async()=>({ok:true,headers:{get:()=>null},text:async()=>JSON.stringify([{conditionId:other,events:[{slug:'other-market'}]}])});
 try{
  const r=response();await handler({method:'GET',query:{condition:good}},r);
  assert.equal(r.code,404);assert.equal(r.headers.Location,undefined);
  assert.match(r.body,/No alternate market has been substituted/);
 }finally{global.fetch=prev;}
});
test('source outage fails closed',async()=>{
 const prev=global.fetch;global.fetch=async()=>{throw new Error('offline')};
 try{const r=response();await handler({method:'GET',query:{condition:good}},r);assert.equal(r.code,503);assert.equal(r.headers.Location,undefined)}
 finally{global.fetch=prev;}
});
test('flow map links to matching source condition not Coinbase',()=>{
 const js=fs.readFileSync(path.resolve(__dirname,'../assets/js/smart-money-flow-map.js'),'utf8');
 const html=fs.readFileSync(path.resolve(__dirname,'../smart-money-flow.html'),'utf8');
 assert.match(js,/smart-money-polymarket-link\?condition=/);
 assert.match(js,/link\.target='_blank'/);
 assert.match(js,/row\.addEventListener\('click',\(\)=>selectMarket\(m\.market_id\)\)/);
 assert.match(html,/Open original market on Polymarket/);
 assert.doesNotMatch(html,/Coinbase Predictions/);
 assert.doesNotMatch(js,/empireCoinbasePredictionsRoute/);
});
