'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const handler=require('../api/smart-money-market');
function mockResponse(){
 let code=200;let payload;
 const headers={};
 return {headers,get code(){return code},get payload(){return payload},setHeader(k,v){headers[k]=v;},status(n){code=n;return this},json(v){payload=v;return this}};
}
const caseEvent={slug:'btc-price-on-nov-8',title:'BTC price on Nov 8',active:true,closed:false,markets:[
 {conditionId:'0x'+'a'.repeat(64),groupItemTitle:'$75,000 or above',question:'Will BTC be $75,000 or above?',outcomes:'["Yes","No"]',outcomePrices:'["0.71","0.30"]',active:true,closed:false,volume:'12345.99',slug:'btc-75000'},
 {conditionId:'0x'+'b'.repeat(64),groupItemTitle:'$75,100 or above',question:'Will BTC be $75,100 or above?',outcomes:'["Yes","No"]',outcomePrices:'["0.63","0.38"]',active:true,closed:false,volume:'12000',slug:'btc-75100'},
 {conditionId:'0x'+'c'.repeat(64),groupItemTitle:'$75,200 or above',question:'Will BTC be $75,200 or above?',outcomes:'["Yes","No"]',outcomePrices:'["--","0.02"]',active:true,closed:false,volume:'100',slug:'btc-75200'}
]};
test('binary price decoder preserves unavailable prices and independent YES/NO values',()=>{
 assert.deepEqual(handler._test.binaryPrices(caseEvent.markets[0]),{yes_price:.71,no_price:.30});
 assert.deepEqual(handler._test.binaryPrices(caseEvent.markets[2]),{yes_price:null,no_price:.02});
 assert.deepEqual(handler._test.binaryPrices({outcomes:'["No","Yes"]',outcomePrices:'["0.20","0.80"]'}),{yes_price:.80,no_price:.20});
});
test('reject method and untrusted event slug without upstream access',async()=>{
 const prev=global.fetch;global.fetch=()=>{throw Error('must not fetch')};
 try{
  const x=mockResponse();await handler({method:'POST',query:{event:'btc-price-on-nov-8'}},x);assert.equal(x.code,405);
  const y=mockResponse();await handler({method:'GET',query:{event:'https://example.com'}},y);assert.equal(y.code,400);
 }finally{global.fetch=prev;}
});
test('serves public event markets only; no wallet or execution fields',async()=>{
 const prev=global.fetch;let seen;
 global.fetch=async(url)=>{seen=url;return {status:200,ok:true,headers:{get:()=>null},text:async()=>JSON.stringify(caseEvent)}};
 try{
  const res=mockResponse();await handler({method:'GET',query:{event:caseEvent.slug}},res);
  assert.equal(res.code,200);assert.equal(res.payload.status,'ok');assert.equal(res.payload.markets.length,3);
  assert.equal(res.payload.markets[2].yes_price,null);
  assert.equal(res.payload.execution_enabled,false);
  assert.match(seen,/gamma-api.polymarket.com\/events\/slug\//);
  assert.equal(JSON.stringify(res.payload).includes('private_key'),false);
 }finally{global.fetch=prev;}
});
test('upstream error never invents quotes',async()=>{
 const prev=global.fetch;global.fetch=async()=>{throw Error('network')};
 try{
  const res=mockResponse();await handler({method:'GET',query:{event:'btc-price-on-nov-8'}},res);
  assert.equal(res.code,503);assert.deepEqual(res.payload.markets,[]);
 }finally{global.fetch=prev;}
});
