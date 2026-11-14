'use strict';
// Private read-only Hyperliquid TESTNET observation, never an execution API.
const {createHash,timingSafeEqual}=require('node:crypto');
const {fetchWorkerFeed}=require('./auto-worker-feed');
const API='https://api.hyperliquid-testnet.xyz/info';
const COINS=new Set(['APT','BNB']);
const LIMIT=131072;
function send(res,code,body){res.setHeader('Cache-Control','private, no-store, max-age=0');res.setHeader('Pragma','no-cache');res.setHeader('Vary','X-Genesis-View-Key');res.setHeader('X-Content-Type-Options','nosniff');return res.status(code).json({schema_version:1,...body});}
function authorized(candidate,secret){
  if(typeof candidate!=='string'||typeof secret!=='string'||candidate.length>256||secret.length<32||secret.length>256)return false;
  return timingSafeEqual(createHash('sha256').update(candidate).digest(),createHash('sha256').update(secret).digest());
}
function number(v){if(v===null||v===undefined||v==='')return null;const n=Number(v);return Number.isFinite(n)&&Math.abs(n)<1e12?n:null;}
function positive(v){const n=number(v);return n!==null&&n>=0?n:null;}
function iso(ms){const n=Number(ms);return Number.isSafeInteger(n)&&n>1600000000000&&n<Date.now()+30000?new Date(n).toISOString():null;}
async function info(type,user){
  const response=await fetch(API,{method:'POST',redirect:'error',cache:'no-store',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({type,user}),signal:AbortSignal.timeout(5000)});
  if(!response.ok||Number(response.headers.get('content-length'))>LIMIT)throw Error('exchange_response');
  const text=await response.text();if(Buffer.byteLength(text,'utf8')>LIMIT)throw Error('oversize');
  return JSON.parse(text);
}
function project(state,orders,fills){
  if(!state||!Array.isArray(state.assetPositions)||!Array.isArray(orders)||!Array.isArray(fills))throw Error('invalid_data');
  const positions=[];let otherPositions=0;
  for(const x of state.assetPositions){
    const p=x&&(x.position||x);if(!p||typeof p!=='object')throw Error('invalid_position');
    const size=number(p.szi);if(size===null)throw Error('invalid_size');
    if(Math.abs(size)<1e-12)continue;
    const coin=String(p.coin||'').toUpperCase();
    if(!COINS.has(coin)){otherPositions++;continue;}
    const entry=positive(p.entryPx),unrealized=number(p.unrealizedPnl);
    if(entry===null||unrealized===null)throw Error('invalid_values');
    positions.push({coin,side:size>0?'BUY':'SELL',quantity:Math.abs(size),entry_price:entry,unrealized_pnl_usd:unrealized,position_value_usd:positive(p.positionValue)});
  }
  const protection={APT:{stop:0,take_profit:0},BNB:{stop:0,take_profit:0}};
  for(const o of orders){
    if(!o||typeof o!=='object')throw Error('invalid_order');
    const coin=String(o.coin||'').toUpperCase();if(!COINS.has(coin))continue;
    const label=(String(o.orderType||'')+' '+String(o.triggerCondition||'')).toLowerCase();
    if(o.reduceOnly===true&&o.isTrigger===true&&positive(o.triggerPx)>0){
      if(/stop|sl/.test(label))protection[coin].stop++;
      else if(/profit|tp/.test(label))protection[coin].take_profit++;
    }
  }
  const recent_fills=[];let dailyClosed=0,dailyFees=0;
  const start=new Date();start.setUTCHours(0,0,0,0);
  for(const f of fills){
    if(!f||typeof f!=='object'||!COINS.has(String(f.coin||'').toUpperCase()))continue;
    const at=iso(f.time),price=positive(f.px),quantity=positive(f.sz),pnl=number(f.closedPnl),fee=positive(f.fee);
    if(!at||price===null||quantity===null||pnl===null||fee===null||String(f.feeToken||'USDC').toUpperCase()!=='USDC')continue;
    if(Date.parse(at)>=start.getTime()){dailyClosed+=pnl;dailyFees+=fee;}
    recent_fills.push({coin:String(f.coin).toUpperCase(),direction:String(f.dir||'').slice(0,32),side:f.side==='B'?'BUY':f.side==='A'?'SELL':'UNKNOWN',quantity,price,realized_pnl_usd:pnl,fee_usd:fee,at});
  }
  recent_fills.sort((a,b)=>b.at.localeCompare(a.at));
  return {positions,other_positions:otherPositions,open_order_count:orders.length,protection_counts:protection,recent_fills:recent_fills.slice(0,20),today_closed_pnl_usd:Number(dailyClosed.toFixed(8)),today_fees_usd:Number(dailyFees.toFixed(8)),today_net_pnl_usd:Number((dailyClosed-dailyFees).toFixed(8)),daily_pnl_scope:'APT_BNB_RETRIEVED_USDC_FILLS_UTC'};
}
module.exports=async function autoMonitor(req,res){
  if(req.method!=='GET'){res.setHeader('Allow','GET');return send(res,405,{status:'method_not_allowed'});}
  const key=process.env.GENESIS_AUTO_VIEW_KEY,address=process.env.GENESIS_AUTO_TESTNET_ACCOUNT;
  if(typeof key!=='string'||key.length<32||key.length>256||!/^0x[0-9a-fA-F]{40}$/.test(address||''))return send(res,503,{status:'not_configured'});
  if(!authorized(req.headers['x-genesis-view-key'],key))return send(res,401,{status:'unauthorized'});
  try{
    const [state,orders,fills,worker]=await Promise.all([info('clearinghouseState',address),info('frontendOpenOrders',address),info('userFills',address),fetchWorkerFeed()]);
    return send(res,200,{status:'ok',source:'HYPERLIQUID_TESTNET_EXCHANGE',network:'TESTNET_ONLY',checked_at:new Date().toISOString(),
      service_state:worker.connected?worker.service.state:'NOT_VERIFIED',
      execution_attribution:worker.connected?'WORKER_EVENTS_SEPARATE_FROM_EXCHANGE_FILLS':'UNVERIFIED_WORKER_SOURCE',
      worker,risk_policy:{target_notional_usd:12,max_exposure_usd:15,maximum_positions:1,leverage:1},...project(state,orders,fills)});
  }catch{return send(res,502,{status:'exchange_unavailable'});}
};
module.exports._test={authorized,project,number};