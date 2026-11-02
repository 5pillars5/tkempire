'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const handler = require('../api/genesis/connection');
const prior = { fetch: global.fetch, url: process.env.GENESIS_STATUS_URL, token: process.env.GENESIS_STATUS_TOKEN, username: process.env.GENESIS_STATUS_USERNAME };
function res() { return {code:200,headers:{},setHeader(k,v){this.headers[k]=v;return this},status(c){this.code=c;return this},json(v){this.body=v;return this}} }
async function call(method='GET'){const r=res();await handler({method},r);return r}
function configured(){
 process.env.GENESIS_STATUS_URL='https://api.tkempire.io/internal/genesis/health';
 process.env.GENESIS_STATUS_TOKEN='a'.repeat(40);
 delete process.env.GENESIS_STATUS_USERNAME;
}
function stub(value){
 global.fetch=async(_url,opts)=>({
 ok:true,
 headers:{get:()=>null},
 text:async()=>JSON.stringify(value)
 });
}
test.after(()=>{
 global.fetch=prior.fetch;
 if(prior.url===undefined)delete process.env.GENESIS_STATUS_URL;else process.env.GENESIS_STATUS_URL=prior.url;
 if(prior.token===undefined)delete process.env.GENESIS_STATUS_TOKEN;else process.env.GENESIS_STATUS_TOKEN=prior.token;
 if(prior.username===undefined)delete process.env.GENESIS_STATUS_USERNAME;else process.env.GENESIS_STATUS_USERNAME=prior.username;
});
test('unconfigured fails closed',async()=>{delete process.env.GENESIS_STATUS_URL;delete process.env.GENESIS_STATUS_TOKEN;let r=await call();assert.equal(r.code,503);assert.equal(r.body.state,'NOT_CONFIGURED')});
test('rejects writes',async()=>{let r=await call('POST');assert.equal(r.code,405)});
test('rejects arbitrary origin',async()=>{configured();process.env.GENESIS_STATUS_URL='https://attacker.example/status';let r=await call();assert.equal(r.code,503)});
test('accepts real /health structure and strips sensitive fields',async()=>{
 configured();stub({served_at:new Date().toISOString(),engine:{mode:'paper',running:true},open_trades:{secrets:'hidden'},private_key:'hidden'});
 let r=await call();assert.equal(r.code,200);assert.equal(r.body.state,'API_REACHABLE');assert.equal(r.body.engine_state,'RUNNING');assert.equal(r.body.mode,'PAPER');assert.ok(!JSON.stringify(r.body).includes('hidden'));
});
test('production username is used for Basic authentication',async()=>{
 configured();process.env.GENESIS_STATUS_USERNAME='tkempire-prod';
 global.fetch=async(_url,opts)=>{
  const raw=Buffer.from(opts.headers.Authorization.split(' ')[1],'base64').toString('utf8');
  assert.equal(raw,'tkempire-prod:'+('a'.repeat(40)));
  return {ok:true,headers:{get:()=>null},text:async()=>JSON.stringify({
   served_at:new Date().toISOString(),engine:{mode:'paper',running:true}
  })};
 };
 let r=await call();assert.equal(r.code,200);
});
test('unapproved username rejected',async()=>{
 configured();process.env.GENESIS_STATUS_USERNAME='unknown-user';
 let r=await call();assert.equal(r.code,503);assert.equal(r.body.state,'INVALID_CONFIGURATION');
});
test('stale /health response rejected',async()=>{
 configured();stub({served_at:new Date(Date.now()-3600000).toISOString(),engine:{mode:'paper',running:true}});
 let r=await call();assert.equal(r.code,503);assert.equal(r.body.state,'STALE_SNAPSHOT');
});
test('invalid response rejected',async()=>{configured();stub({engine:{running:true}});let r=await call();assert.equal(r.code,502)});
test('upstream failure fails closed without leaking error',async()=>{
 configured();global.fetch=async()=>{throw new Error('secret')};let r=await call();assert.equal(r.code,502);assert.ok(!JSON.stringify(r.body).includes('secret'));
});
