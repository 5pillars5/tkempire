'use strict';
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const zlib=require('node:zlib');
const origin='https://www.tkempire.io',raw='https://raw.githubusercontent.com/5pillars5/tkempire/main/data/smart-money-history-v1/';
async function load(url,max=1500000){
 const r=await fetch(url,{redirect:'error',cache:'no-store',
  headers:{'Accept':'application/json, application/octet-stream'},
  signal:AbortSignal.timeout(18000)});
 if(!r.ok)throw Error('HTTP_'+r.status+' '+new URL(url).pathname);
 const b=Buffer.from(await r.arrayBuffer());
 if(b.length>max)throw Error('RESPONSE_TOO_LARGE');
 return b;
}
(async()=>{
 const [headBytes,page,summaryBytes]=await Promise.all([
  load(raw+'LATEST.json?check='+Date.now()),
  load(origin+'/smart-money-flow.html'),
  load(origin+'/api/smart-money-history?view=summary&days=3')
 ]);
 const head=JSON.parse(headBytes.toString('utf8'));
 assert.equal(head.schema_version,1);
 assert.equal(head.source,'GITHUB_PUBLIC_OBSERVATION_MIRROR');
 assert.equal(head.trading_authority,'none');
 assert.equal(head.legacy_vps_sqlite_import,'NOT_YET_CONNECTED');
 assert.match(head.archive_path,/^data\/smart-money-history-v1\/\d{4}-\d\d-\d\d\.json\.gz$/);
 assert.match(head.archive_sha256,/^[a-f0-9]{64}$/);
 const stored=await load('https://raw.githubusercontent.com/5pillars5/tkempire/main/'+head.archive_path+'?check='+Date.now());
 const digest=crypto.createHash('sha256').update(stored).digest('hex');
 assert.equal(digest,head.archive_sha256,'Compressed archive not correlated with durable head');
 const day=JSON.parse(zlib.gunzipSync(stored,{maxOutputLength:15000000}).toString('utf8'));
 assert.equal(day.schema_version,1);assert.equal(day.day,head.latest_day);
 assert.ok(day.flow_snapshots.length>=1);assert.ok(day.signal_events.length>=1);
 assert.ok(day.signal_events.every(s=>/^[a-f0-9]{24}$/.test(s.id)));
 assert.ok(day.flow_snapshots.every(s=>s.source==='PUBLIC_FLOW_API_V1'));
 assert.ok(day.flow_snapshots.every(s=>s.markets.every(m=>/^0x[a-f0-9]{64}$/.test(m.condition_id)&&/^\d+$/.test(m.token_id))));
 const html=page.toString('utf8');
 assert.ok(html.includes('DURABLE OBSERVATION HISTORY'));
 assert.ok(html.includes('smart-money-flow-map.js?v=2'));
 const summary=JSON.parse(summaryBytes.toString('utf8'));
 assert.equal(summary.status,'ok');
 assert.equal(summary.source,'GITHUB_PUBLIC_OBSERVATION_MIRROR');
 assert.equal(summary.legacy_vps_sqlite_import,'NOT_YET_CONNECTED');
 assert.equal(summary.calibrated_probability,'NOT_VERIFIED');
 assert.equal(summary.trading_authority,'none');
 assert.ok(summary.observation_snapshots>=day.flow_snapshots.length);
 assert.ok(summary.signal_events>=day.signal_events.length);
 const latest=day.flow_snapshots[day.flow_snapshots.length-1];
 const first=latest.markets[0];assert.ok(first,'No archived outcome to inspect');
 const api=JSON.parse((await load(origin+'/api/smart-money-history?view=market&days=3&condition='+
  encodeURIComponent(first.condition_id)+'&token='+encodeURIComponent(first.token_id))).toString('utf8'));
 assert.equal(api.status,'ok');assert.equal(api.score,null);assert.equal(api.probability,null);
 assert.equal(api.trade_profit,null);assert.equal(api.execution_authority,'none');
 assert.ok(api.trend.length>=1);
 assert.ok(api.trend.some(p=>p.net_24h_usdc===first.net_usdc));
 console.log('HISTORY_SITE_READBACK=PASS '+JSON.stringify({
  day:head.latest_day,sha256:digest,archived_snapshots:day.flow_snapshots.length,
  archived_signals:day.signal_events.length,verified_outcomes:summary.verified_outcomes,
  market_history_points:api.trend.length,live_site:origin,
  legacy_import:'NOT_YET_CONNECTED',wallet_quality:'WITHHELD'}));
})().catch(e=>{console.error('HISTORY_SITE_READBACK=FAIL '+String(e.stack||e));process.exitCode=1});
