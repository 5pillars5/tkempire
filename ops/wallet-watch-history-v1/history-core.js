'use strict';

/*
 * TK Empire Wallet Watch: deterministic, public-data-only history primitives.
 * No exchange keys, VPS access, trade execution, or Telegram credentials.
 */
const crypto = require('node:crypto');
const { normalizeTrade } = require('../../api/wallet-watch')._test;
const ADDRESS = /^0x[a-f0-9]{40}$/i;
const ID = /^[a-f0-9]{24}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_EVENT_PER_DAY = 15000;
const MAX_DELIVERY_TRACKED = 10000;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function obj(x) { return x!==null && typeof x==='object' && !Array.isArray(x); }
function iso(x) { const n=Date.parse(x); return typeof x==='string' && Number.isFinite(n) && x.includes('T') ? n : null; }
function dayOf(timestamp) { return new Date(timestamp*1000).toISOString().slice(0,10); }
function recordHash(r) {
  return hash(JSON.stringify([
    r.id,r.wallet,r.side,r.market,r.outcome,r.amount_usdc,r.shares,
    r.price,r.timestamp,r.event_slug,r.tx_hash
  ]));
}
function sanitizeBatch(rows,wallet,now) {
  if (!ADDRESS.test(wallet)||!Array.isArray(rows)||rows.length>2000) throw Error('INVALID_SOURCE_BATCH');
  const byId=new Map();
  for(const raw of rows) {
    const r=normalizeTrade(raw,wallet,now);
    if(!r)continue; // malformed, non-trade or outside source window: never inferred
    const prev=byId.get(r.id);
    if(prev && recordHash(prev)!==recordHash(r))throw Error('SOURCE_ID_COLLISION');
    byId.set(r.id,r);
  }
  return [...byId.values()].sort((a,b)=>b.timestamp-a.timestamp||a.id.localeCompare(b.id));
}
function validateArchive(archive,day) {
  if (!DAY.test(day)) throw Error('INVALID_DAY');
  if (archive===null) return {schema_version:1,day,source:'PUBLIC_POLYMARKET_WALLET_WATCH',execution_authority:'none',events:[]};
  if (!obj(archive)||archive.schema_version!==1||archive.day!==day||
      archive.source!=='PUBLIC_POLYMARKET_WALLET_WATCH'||archive.execution_authority!=='none'||
      !Array.isArray(archive.events)||archive.events.length>MAX_EVENT_PER_DAY)throw Error('INVALID_ARCHIVE');
  const ids=new Set();
  for(const r of archive.events) {
    if (!obj(r)||!ID.test(r.id)||!ADDRESS.test(r.wallet)||!['BUY','SELL'].includes(r.side)||
        !Number.isInteger(r.timestamp)||dayOf(r.timestamp)!==day||
        typeof r.amount_usdc!=='number'||!Number.isFinite(r.amount_usdc)||r.amount_usdc<=0||
        typeof r.first_observed_at!=='string'||iso(r.first_observed_at)===null||
        !HASH.test(r.record_sha256)||r.record_sha256!==recordHash(r)||ids.has(r.id))throw Error('CORRUPT_ARCHIVE_EVENT');
    ids.add(r.id);
  }
  return archive;
}
function mergeArchive(current,day,trades,capturedAt) {
  const archive=validateArchive(current,day);
  if(iso(capturedAt)===null)throw Error('BAD_CAPTURE_CLOCK');
  const all=new Map(archive.events.map(x=>[x.id,x])), added=[];
  for(const t of trades) {
    if (!obj(t)||!ID.test(t.id)||!ADDRESS.test(t.wallet)||
        !Number.isInteger(t.timestamp)||dayOf(t.timestamp)!==day)throw Error('BAD_TRADE_DAY');
    const record={...t,first_observed_at:capturedAt,record_sha256:recordHash(t)};
    const prior=all.get(t.id);
    if(prior) {
      if(prior.record_sha256!==record.record_sha256)throw Error('HISTORICAL_ID_COLLISION');
    }else {all.set(t.id,record);added.push(record);}
  }
  if(all.size>MAX_EVENT_PER_DAY)throw Error('DAILY_ARCHIVE_CAP_REACHED');
  const merged={...archive,events:[...all.values()].sort((a,b)=>b.timestamp-a.timestamp||a.id.localeCompare(b.id))};
  return {archive:merged,added};
}
function initialDeliveryLedger(startedAt) {
  if(iso(startedAt)===null)throw Error('INVALID_ACTIVATION_TIME');
  return {schema_version:1,started_at:startedAt,acknowledged:{}};
}
function validateDeliveryLedger(d) {
  if(!obj(d)||d.schema_version!==1||iso(d.started_at)===null||
     !obj(d.acknowledged)||Object.keys(d.acknowledged).length>MAX_DELIVERY_TRACKED)throw Error('INVALID_DELIVERY_LEDGER');
  for(const [id,at] of Object.entries(d.acknowledged)){
    if(!ID.test(id)||iso(at)===null)throw Error('INVALID_DELIVERY_ACK');
  }
  return d;
}
function planDelivery(events,ledger,now,{minAmount=250,maxAgeSeconds=1800}={}) {
  if(!Array.isArray(events)||!Number.isInteger(now)||now<=0||
     !Number.isFinite(minAmount)||minAmount<1||
     !Number.isInteger(maxAgeSeconds)||maxAgeSeconds<60||maxAgeSeconds>86400)throw Error('INVALID_DELIVERY_POLICY');
  if(!ledger) return {bootstrap:true,ledger:initialDeliveryLedger(new Date(now*1000).toISOString()),candidates:[]};
  const state=validateDeliveryLedger(ledger),start=iso(state.started_at);
  const candidates=events.filter(e=>
    obj(e)&&ID.test(e.id)&&!Object.hasOwn(state.acknowledged,e.id)&&
    e.amount_usdc>=minAmount&&
    Number.isInteger(e.timestamp)&&e.timestamp>=now-maxAgeSeconds&&e.timestamp<=now+90&&
    iso(e.first_observed_at)!==null&&iso(e.first_observed_at)>start
  ).sort((a,b)=>a.timestamp-b.timestamp||a.id.localeCompare(b.id));
  return {bootstrap:false,ledger:state,candidates};
}
function acknowledge(ledger,ids,now) {
  const before=validateDeliveryLedger(ledger);
  const acknowledged={...before.acknowledged};
  const stamp=new Date(now*1000).toISOString();
  for(const id of ids){if(!ID.test(id))throw Error('BAD_ACK_ID');acknowledged[id]=stamp;}
  // Old ids only need to be retained through the maximum alert window.
  for(const [id,at] of Object.entries(acknowledged)){
    if(Date.parse(at)<now*1000-3*86400000)delete acknowledged[id];
  }
  if(Object.keys(acknowledged).length>MAX_DELIVERY_TRACKED)throw Error('DELIVERY_LEDGER_CAP');
  return {schema_version:1,started_at:before.started_at,acknowledged};
}
function safeHtml(str) {return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function telegramDigest(events,{minAmount=250,limit=10}={}) {
  if(!events.length)throw Error('EMPTY_DIGEST');
  const sorted=[...events].sort((a,b)=>b.timestamp-a.timestamp||a.id.localeCompare(b.id));
  const lines=['<b>TK EMPIRE · WALLET WATCH</b>','<b>'+sorted.length+' newly observed trades ≥ $'+minAmount+'</b>',''];
  for(const e of sorted.slice(0,limit)) {
    const name=e.name||e.wallet.slice(0,8)+'…'+e.wallet.slice(-4);
    const amount='$'+Number(e.amount_usdc).toLocaleString('en-US',{maximumFractionDigits:2});
    lines.push((e.side==='BUY'?'🟢 BUY':'🔴 SELL')+' <b>'+safeHtml(name.slice(0,70))+'</b> · '+safeHtml(amount));
    lines.push(safeHtml((e.market||'Public market').slice(0,125))+' · '+safeHtml((e.outcome||'').slice(0,45)));
  }
  if(sorted.length>limit) lines.push('… and '+(sorted.length-limit)+' more observed in this scan.');
  lines.push('','<a href="https://www.tkempire.io/wallet-watch.html">Open Wallet Watch</a>',
    '<i>Public observations, not trading signals or instructions. Source reporting may lag.</i>');
  const message=lines.join('\n');
  if(message.length>3900)throw Error('DIGEST_LENGTH_CAP');
  return message;
}
module.exports={hash,recordHash,sanitizeBatch,validateArchive,mergeArchive,initialDeliveryLedger,validateDeliveryLedger,planDelivery,acknowledge,telegramDigest};
