'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const handler = require('../api/genesis/connection');
function makeRes() {
  return { code: 200, headers: {}, setHeader(k,v) { this.headers[k]=v;return this; }, status(c) { this.code=c; return this; }, json(v) { this.body=v; return this; } };
}
async function run(method='GET') { const res=makeRes(); await handler({method},res); return res; }
const fetchBefore=global.fetch;
const urlBefore=process.env.GENESIS_STATUS_URL;
const tokenBefore=process.env.GENESIS_STATUS_TOKEN;
test.after(()=>{
  global.fetch=fetchBefore;
  if(urlBefore===undefined) delete process.env.GENESIS_STATUS_URL; else process.env.GENESIS_STATUS_URL=urlBefore;
  if(tokenBefore===undefined) delete process.env.GENESIS_STATUS_TOKEN; else process.env.GENESIS_STATUS_TOKEN=tokenBefore;
});
test('missing configuration fails closed',async()=>{
  delete process.env.GENESIS_STATUS_URL; delete process.env.GENESIS_STATUS_TOKEN;
  const res=await run(); assert.equal(res.code,503); assert.equal(res.body.state,'NOT_CONFIGURED');
});
test('non-GET rejected',async()=>{
  const res=await run('POST'); assert.equal(res.code,405);
});
test('insecure gateway rejected',async()=>{
  process.env.GENESIS_STATUS_URL='http://example.com:5000/status';
  process.env.GENESIS_STATUS_TOKEN='test-secret';
  const res=await run(); assert.equal(res.code,503); assert.equal(res.body.state,'INVALID_CONFIGURATION');
});
test('valid fresh response only returns allowed fields',async()=>{
  process.env.GENESIS_STATUS_URL='https://gateway.example.com/status';
  process.env.GENESIS_STATUS_TOKEN='test-secret';
  global.fetch=async()=>({ok:true,headers:{get:()=>null},text:async()=>JSON.stringify({
    schema_version:1,source:'genesis',observed_at:new Date().toISOString(),
    engine:{mode:'PAPER',state:'RUNNING',private_key:'NEVER_LEAK'},account:{balance:900}
  })});
  const res=await run();
  assert.equal(res.code,200); assert.equal(res.body.mode,'PAPER');
  assert.equal(res.body.connected,true);
  assert.ok(!JSON.stringify(res.body).includes('NEVER_LEAK'));
  assert.ok(!JSON.stringify(res.body).includes('test-secret'));
});
test('stale snapshot rejected',async()=>{
  global.fetch=async()=>({ok:true,headers:{get:()=>null},text:async()=>JSON.stringify({
    schema_version:1,source:'genesis',observed_at:new Date(Date.now()-3600000).toISOString(),
    engine:{mode:'PAPER',state:'RUNNING'}
  })});
  const res=await run(); assert.equal(res.code,503); assert.equal(res.body.state,'STALE_SNAPSHOT');
});
test('upstream failure fails closed',async()=>{
  global.fetch=async()=>{throw new Error('backend secret')};
  const res=await run(); assert.equal(res.code,502); assert.equal(res.body.state,'UPSTREAM_UNAVAILABLE');
});
