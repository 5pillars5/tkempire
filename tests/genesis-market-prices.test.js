'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const handler=require('../api/genesis/prices.js');
const oldFetch=global.fetch;
function res(){
  return {headers:{},statusCode:null,setHeader(k,v){this.headers[k]=v;return this},
    status(n){this.statusCode=n;return this},json(v){this.body=v;return this}};
}
async function call(url,method='GET'){
  const result=res();await handler({url,method},result);return result;
}
test.after(()=>{global.fetch=oldFetch;});
test('request bounds, symbol validation, and no outbound request on invalid input',async()=>{
  global.fetch=()=>{throw Error('should not fetch')};
  for(const suffix of ['','?assets=','?assets=SOL,../etc/passwd',
    '?assets=%3Cscript%3E','?assets=SOL&other=x','?assets=SOL&assets=BNB',
    '?assets='+new Array(21).fill('SOL').join(',')]){
    const r=await call('/api/genesis/prices'+suffix);
    assert.equal(r.statusCode,400,suffix);
    assert.deepEqual(r.body.prices,{});
  }
});
test('bounded allMids mainnet request returns only requested valid mid-prices',async()=>{
  global.fetch=async(url,options)=>{
    assert.equal(url,'https://api.hyperliquid.xyz/info');
    assert.equal(options.method,'POST');
    assert.equal(options.redirect,'error');
    assert.deepEqual(JSON.parse(options.body),{type:'allMids',dex:''});
    assert.ok(!options.headers.Authorization);
    return {ok:true,headers:{get:()=>null},
      text:async()=>JSON.stringify({BNB:'672.91',SOL:'86.125',APT:'2.102',
        OTHER:'123',invalid:'NaN'})};
  };
  const r=await call('/api/genesis/prices?assets=SOL,BNB,SOL,APT');
  assert.equal(r.statusCode,200);
  assert.equal(r.body.source,'HYPERLIQUID_PERP_MID');
  assert.equal(r.body.market,'hyperliquid_mainnet_perpetuals');
  assert.equal(r.body.quote_type,'indicative_mid_usd');
  assert.deepEqual({...r.body.prices},{SOL:86.125,BNB:672.91,APT:2.102});
  assert.deepEqual(r.body.unavailable,[]);
  assert.equal(r.headers['Cache-Control'],'no-store, max-age=0');
  assert.ok(Number.isFinite(Date.parse(r.body.retrieved_at)));
  assert.ok(!JSON.stringify(r.body).includes('OTHER'));
});
test('no imaginary price for unavailable, zero, negative or invalid source data',async()=>{
  global.fetch=async()=>({ok:true,headers:{get:()=>null},
    text:async()=>JSON.stringify({BNB:'0',SOL:'-30',APT:'2.8'})});
  const r=await call('/api/genesis/prices?assets=SOL,BNB,APT,XYZ');
  assert.equal(r.statusCode,200);
  assert.deepEqual({...r.body.prices},{APT:2.8});
  assert.deepEqual(r.body.unavailable,['SOL','BNB','XYZ']);
});
test('network failure, non-200, oversized response and malformed JSON all fail closed',async()=>{
  const mocks=[
    async()=>{throw new Error('offline')},
    async()=>({ok:false}),
    async()=>({ok:true,headers:{get:()=>String(99999999)},text:async()=>''}),
    async()=>({ok:true,headers:{get:()=>null},text:async()=>'{bad JSON'})
  ];
  for(const mock of mocks){
    global.fetch=mock;
    const r=await call('/api/genesis/prices?assets=SOL');
    assert.equal(r.statusCode,502);
    assert.deepEqual(r.body.prices,{});
  }
});
test('only GET allowed, never exposes account or order controls',async()=>{
  global.fetch=()=>{throw Error('should not fetch')};
  const r=await call('/api/genesis/prices?assets=SOL','POST');
  assert.equal(r.statusCode,405);
  assert.equal(r.headers.Allow,'GET');
  const source=require('node:fs').readFileSync(
    require('node:path').join(__dirname,'../api/genesis/prices.js'),'utf8');
  assert.doesNotMatch(source,/privateKey|placeOrder|createOrder|\/exchange\b|\/trade\b|Authorization/i);
  assert.match(source,/type:'allMids'/);
});
