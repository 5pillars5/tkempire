'use strict';
// Allowlisted, read-only bridge from the private VPS Genesis Auto worker publisher.
// This file has NO exchange order, signing, approval, or wallet-writing methods.
const UPSTREAM='https://api.tkempire.io/internal/genesis/auto-monitor';
// The upstream HTTPS host and exact read-only path are pinned in UPSTREAM above.
// Legacy health URL env configuration is unrelated to this fixed monitor route.
const MAX_BYTES=32768;
const COINS=new Set(['APT','BNB']);
const SIDES=new Set(['BUY','SELL']);
const STATES=new Set(['RUNNING','DEGRADED','STOPPED','UNKNOWN']);
const STAGES=new Set(['QUALIFIED','REJECTED','AUTHORIZED','BLOCKED','ORDER_SUBMITTED','ENTRY_FILLED','PROTECTED','EXIT_FILLED','CLOSED','ERROR']);
const REASONS=new Set(['NONE','STALE_SIGNAL','ASSET_BLOCKED','RISK_LIMIT','INSUFFICIENT_MARGIN','DUPLICATE','EMERGENCY_STOP','EXCHANGE_UNAVAILABLE','PROTECTION_FAILED','UNRECONCILED','OTHER']);
const COUNT_KEYS=['signals_eligible','signals_blocked','entries_submitted','entries_filled','exits_reconciled','errors'];
function unavailable(status){return {connected:false,status,service:null,counters:null,events:[],observed_at:null};}
function iso(value,now,age=60000) {
  if(typeof value!=='string'||value.length>40||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(value))return null;
  const t=Date.parse(value);if(!Number.isFinite(t)||t>now+10000||now-t>age)return null;
  return new Date(t).toISOString();
}
function eventTime(value,now){
  if(typeof value!=='string'||value.length>40)return null;
  const t=Date.parse(value);
  return Number.isFinite(t)&&t<=now+10000&&t>=now-30*86400000?new Date(t).toISOString():null;
}
function integer(v){return Number.isSafeInteger(v)&&v>=0&&v<=10000000?v:null;}
function amount(v,allowNegative=false){
  if(v===null||v===undefined)return null;
  if(typeof v!=='number'||!Number.isFinite(v)||Math.abs(v)>1000000||(allowNegative?false:v<0))return null;
  return v;
}
function event(row,now){
  if(!row||typeof row!=='object'||Array.isArray(row)||!(/^[a-f0-9]{16,64}$/.test(row.id)))return null;
  const at=eventTime(row.at,now);
  if(!at||!COINS.has(row.coin)||!SIDES.has(row.side)||!STAGES.has(row.stage))return null;
  const reason=REASONS.has(row.reason_code)?row.reason_code:'OTHER';
  const e={id:row.id,at,coin:row.coin,side:row.side,stage:row.stage,reason_code:reason};
  for(const [target,key,neg] of [['entry_price','entry_price',false],['exit_price','exit_price',false],['size','size',false],['realized_pnl_usd','realized_pnl_usd',true],['fees_usd','fees_usd',false]]){
    const n=amount(row[key],neg);
    if(n!==null)e[target]=n;
  }
  return e;
}
function parseSnapshot(data,now=Date.now()){
  if(!data||typeof data!=='object'||Array.isArray(data)||data.schema_version!==1||
    data.source!=='GENESIS_AUTO_TESTNET_MONITOR'||data.publication_scope!=='PRIVATE_READ_ONLY'||
    data.execution_authority!=='none'||data.network!=='TESTNET_ONLY')return unavailable('INVALID_SOURCE');
  const observed=iso(data.generated_at,now);
  if(!observed)return unavailable('STALE_OR_INVALID');
  const s=data.service;
  if(!s||typeof s!=='object'||!STATES.has(s.state)||s.production_mode!=='PAPER'||
     s.mainnet_authorized!==false||typeof s.auto_testnet_enabled!=='boolean')return unavailable('INVALID_SERVICE');
  const hb=iso(s.heartbeat_at,now);
  if(s.state==='RUNNING'&&!hb)return unavailable('HEARTBEAT_STALE');
  const restarts=integer(s.restarts);
  if(restarts===null)return unavailable('INVALID_SERVICE');
  if(!data.counters||typeof data.counters!=='object'||!Array.isArray(data.events)||data.events.length>50)
    return unavailable('INVALID_PAYLOAD');
  const counters={};
  for(const key of COUNT_KEYS){const n=integer(data.counters[key]);if(n===null)return unavailable('INVALID_COUNTERS');counters[key]=n;}
  const events=[],seen=new Set();
  for(const raw of data.events){
    const row=event(raw,now);
    if(!row)return unavailable('INVALID_EVENTS');
    if(!seen.has(row.id)){seen.add(row.id);events.push(row);}
  }
  events.sort((a,b)=>b.at.localeCompare(a.at));
  return {connected:true,status:'OK',observed_at:observed,
    service:{state:s.state,heartbeat_at:hb,restarts,production_mode:'PAPER',
      mainnet_authorized:false,auto_testnet_enabled:s.auto_testnet_enabled},
    counters,events:events.slice(0,30)};
}
async function fetchWorkerFeed(){
  if(process.env.GENESIS_AUTO_WORKER_FEED_ENABLED!=='true')return unavailable('DISABLED');
  // Independent monitor-only credential; legacy health gateway secrets are untouched.
  const token=process.env.GENESIS_AUTO_MONITOR_TOKEN;
  const username='tkempire-auto-monitor';
  if(typeof token!=='string'||token.length<32||token.length>256||/[\r\n]/.test(token))
    return unavailable('CONFIG_MONITOR_TOKEN');
  try{
    const auth='Basic '+Buffer.from(username+':'+token,'utf8').toString('base64');
    const r=await fetch(UPSTREAM,{method:'GET',redirect:'error',cache:'no-store',
      headers:{Accept:'application/json',Authorization:auth},signal:AbortSignal.timeout(4000)});
    if(r.status===401||r.status===403)return unavailable('UPSTREAM_AUTH_FAILED');
    if(!r.ok||Number(r.headers.get('content-length'))>MAX_BYTES)return unavailable('UPSTREAM_UNAVAILABLE');
    const body=await r.text();
    if(Buffer.byteLength(body,'utf8')>MAX_BYTES)return unavailable('INVALID_PAYLOAD');
    return parseSnapshot(JSON.parse(body));
  }catch{return unavailable('UPSTREAM_UNAVAILABLE');}
}
module.exports={fetchWorkerFeed,parseSnapshot,unavailable};
