'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const route=require('../api/genesis/auto-monitor.js');
const originalFetch=global.fetch;
const env={key:process.env.GENESIS_AUTO_VIEW_KEY,address:process.env.GENESIS_AUTO_TESTNET_ACCOUNT};
const key='v'.repeat(48),address='0x'+'9'.repeat(40);
test.after(()=>{global.fetch=originalFetch;for(const [name,variable] of [['key','GENESIS_AUTO_VIEW_KEY'],['address','GENESIS_AUTO_TESTNET_ACCOUNT']]){if(env[name]===undefined)delete process.env[variable];else process.env[variable]=env[name]}});
function setup(){process.env.GENESIS_AUTO_VIEW_KEY=key;process.env.GENESIS_AUTO_TESTNET_ACCOUNT=address}
function response(){return{headers:{},setHeader(k,v){this.headers[k]=v;return this},status(n){this.statusCode=n;return this},json(x){this.body=x;return this}}}
async function run(method='GET',provided=key){const res=response();await route({method,headers:{'x-genesis-view-key':provided}},res);return res}
function fixture(type){if(type==='clearinghouseState')return{assetPositions:[{position:{coin:'BNB',szi:'0.017',entryPx:'675.67',unrealizedPnl:'1.23',positionValue:'11.49'}},{position:{coin:'SOL',szi:'1',entryPx:'100',unrealizedPnl:'2'}}]};if(type==='frontendOpenOrders')return[{coin:'BNB',reduceOnly:true,isTrigger:true,triggerPx:'680',orderType:'Stop Market',sz:'0.017'}];if(type==='userFills')return[{coin:'BNB',dir:'Open Long',side:'B',px:'675.67',sz:'0.017',fee:'0.01',feeToken:'USDC',closedPnl:'0',time:Date.now()-1000,hash:'privatehash',tid:1234}];throw Error('unknown')}
function mock(){global.fetch=async(url,opts)=>{assert.equal(url,'https://api.hyperliquid-testnet.xyz/info');assert.equal(opts.method,'POST');assert.equal(opts.redirect,'error');const body=JSON.parse(opts.body);assert.equal(body.user,address);return{ok:true,headers:{get:()=>null},text:async()=>JSON.stringify(fixture(body.type))}}}
test('POST is rejected and missing configuration fails closed',async()=>{setup();assert.equal((await run('POST')).statusCode,405);delete process.env.GENESIS_AUTO_VIEW_KEY;assert.equal((await run()).statusCode,503)});
test('wrong viewer key rejects before exchange fetch',async()=>{setup();global.fetch=async()=>{throw Error('must not call')};assert.equal((await run('GET','wrong')).statusCode,401)});
test('testnet exchange data are allowlisted; sensitive fields omitted',async()=>{setup();mock();const res=await run();assert.equal(res.statusCode,200);assert.equal(res.body.network,'TESTNET_ONLY');assert.equal(res.body.positions.length,1);assert.equal(res.body.other_positions,1);assert.equal(res.body.open_order_count,1);assert.equal(res.body.recent_fills.length,1);assert.equal(res.body.service_state,'NOT_VERIFIED');assert.equal(res.headers['Cache-Control'],'private, no-store, max-age=0');for(const s of [address,'privatehash','1234'])assert.equal(JSON.stringify(res.body).includes(s),false)});
test('malformed exchange response is rejected',async()=>{setup();global.fetch=async()=>({ok:true,headers:{get:()=>null},text:async()=>JSON.stringify({})});assert.equal((await run()).statusCode,502)});
test('unreachable exchange is rejected',async()=>{setup();global.fetch=async()=>{throw Error('offline')};assert.equal((await run()).statusCode,502)});
