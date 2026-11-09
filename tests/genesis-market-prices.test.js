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
test('fixed Genesis quote universe ignores all custom-domain parameters',async()=>{
  global.fetch=async()=>({ok:true,headers:{get:()=>null},
    text:async()=>JSON.stringify({BNB:'676',SOL:'89',APT:'0.8',SECRET:'999'})});
  for(const uri of ['/api/genesis/prices','/api/genesis/prices?assets=XYZ',
     '/api/genesis/prices?__vercel_protection_bypass=opaque']){
    const r=await call(uri);
    assert.equal(r.statusCode,200);
    assert.deepEqual({...r.body.prices},{BNB:676,SOL:89,APT:0.8});
    assert.equal(Object.hasOwn(r.body.prices,'SECRET'),false);
  }
});
test('default production route quotes the exact bounded Genesis asset universe',async()=>{
  global.fetch=async()=>({ok:true,headers:{get:()=>null},
    text:async()=>JSON.stringify({BNB:'675.50',SOL:'89.20',APT:'0.80',OTHER:'999'})});
  const r=await call('/api/genesis/prices');
  assert.equal(r.statusCode,200);
  assert.deepEqual({...r.body.prices},{BNB:675.5,SOL:89.2,APT:0.8});
  assert.equal(r.body.unavailable.length,0);
  assert.ok(!JSON.stringify(r.body).includes('OTHER'));
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
  const r=await call('/api/genesis/prices');
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
  const r=await call('/api/genesis/prices');
  assert.equal(r.statusCode,200);
  assert.deepEqual({...r.body.prices},{APT:2.8});
  assert.deepEqual(r.body.unavailable,['BNB','SOL']);
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
