'use strict';

// Safe, offline tests for the public read-only Genesis endpoints.
// Never depend on real credentials or live engine access.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const health = require('../api/health.js');
const status = require('../api/genesis/status.js');
const connection = require('../api/genesis/connection.js');

const original = {
  fetch: global.fetch,
  url: process.env.GENESIS_STATUS_URL,
  token: process.env.GENESIS_STATUS_TOKEN,
  username: process.env.GENESIS_STATUS_USERNAME,
};
const credential = 't'.repeat(48);
const now = () => new Date().toISOString();

test.after(() => {
  global.fetch = original.fetch;
  for (const [name, key] of [
    ['url', 'GENESIS_STATUS_URL'],
    ['token', 'GENESIS_STATUS_TOKEN'],
    ['username', 'GENESIS_STATUS_USERNAME'],
  ]) {
    if (original[name] === undefined) delete process.env[key];
    else process.env[key] = original[name];
  }
});
function configure(username = 'tkempire-site') {
  process.env.GENESIS_STATUS_URL = 'https://api.tkempire.io/internal/genesis/health';
  process.env.GENESIS_STATUS_TOKEN = credential;
  process.env.GENESIS_STATUS_USERNAME = username;
}
function response() {
  return {
    statusCode: 200,
    headers: {},
    setHeader(k,v) { this.headers[k] = v; return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}
async function run(handler, method = 'GET') {
  const res = response();
  await handler({method}, res);
  return res;
}
function stub(payload, code = 200, onFetch = () => {}) {
  global.fetch = async (url, opts) => {
    onFetch(url, opts);
    return {
      ok: code === 200,
      headers: {get: () => null},
      text: async () => JSON.stringify(payload),
    };
  };
}
function healthPayload(overrides = {}) {
  return {
    served_at: now(),
    engine: {mode:'paper', running:true, regime:'BEAR', score_min:99},
    status: 'healthy',
    health_score: 92,
    checks: {engine:true, runtime_fresh:true, api_service:true},
    open_trades: {
      count: 1, trades: [{
        asset:'RESTRICTED', entry:123, stop:120,
        strategy_fingerprint:'PRIVATE_FINGERPRINT',
        reason:'PRIVATE_THOUGHT',
      }],
    },
    personal_account: {balance:998877},
    feeds: {coingecko:{age_seconds:9}},
    ...overrides,
  };
}
function statusPayload(overrides = {}) {
  return {
    updated_at: now(),
    source: 'signals.json',
    engine: {mode:'paper', running:true, regime:'BEAR'},
    performance: {trades:145, wins:75, losses:70, win_rate:51.72, total_pnl:-2.125},
    positions: {open:14, detail:'PRIVATE_POSITION'},
    internal_strategy: 'PRIVATE_STRATEGY',
    ...overrides,
  };
}

test('health returns only allowlisted fields and no private trade records', async () => {
  configure();
  stub(healthPayload(), 200, (_, opts) => {
    assert.equal(opts.method,'GET');
    assert.equal(opts.redirect,'error');
    assert.equal(opts.headers.Authorization, 'Basic '+Buffer.from('tkempire-site:'+credential).toString('base64'));
  });
  const r = await run(health);
  assert.equal(r.statusCode,200);
  assert.equal(r.body.source,'GENESIS_PAPER_PUBLIC_SUMMARY');
  assert.equal(r.body.engine.mode,'paper');
  assert.equal(r.body.open_trades.count,1);
  assert.deepEqual(r.body.open_trades.trades,[]);
  assert.equal(r.body.open_trades.details_public,false);
  assert.equal(r.body.checks.runtime_fresh,true);
  assert.equal(r.headers['Cache-Control'].includes('no-store'),true);
  for (const secret of ['PRIVATE_FINGERPRINT','PRIVATE_THOUGHT','RESTRICTED','PRIVATE_STRATEGY','998877']) {
    assert.equal(JSON.stringify(r.body).includes(secret),false);
  }
});
test('health accepts distinct production username', async () => {
  configure('tkempire-prod');
  stub(healthPayload(),200,(_,opts)=>{
    assert.equal(opts.headers.Authorization,'Basic '+Buffer.from('tkempire-prod:'+credential).toString('base64'));
  });
  assert.equal((await run(health)).statusCode,200);
});
test('health refuses unapproved username and non-paper engine', async () => {
  configure('bad-user');
  assert.equal((await run(health)).statusCode,502);
  configure();
  stub(healthPayload({engine:{mode:'live',running:true}}));
  const r = await run(health);
  assert.equal(r.statusCode,503);
  assert.equal(r.body.status,'publication_disabled');
});
test('health rejects stale and future timestamps', async () => {
  configure();
  for(const served_at of [
    new Date(Date.now()-3600000).toISOString(),
    new Date(Date.now()+3600000).toISOString()
  ]){
    stub(healthPayload({served_at}));
    assert.equal((await run(health)).body.status,'stale');
  }
});
test('performance does not publish private positions or strategy payload', async () => {
  configure('tkempire-prod');
  stub(statusPayload(),200,(url,opts)=>{
    assert.equal(url,'https://api.tkempire.io/internal/genesis/status');
    assert.equal(opts.headers.Authorization,'Basic '+Buffer.from('tkempire-prod:'+credential).toString('base64'));
  });
  const r = await run(status);
  assert.equal(r.statusCode,200);
  assert.equal(r.body.source,'GENESIS_PAPER_AGGREGATE');
  assert.equal(r.body.performance.trades,145);
  assert.equal(r.body.positions.open,null);
  assert.equal(r.body.positions.comparable_with_health,false);
  assert.equal(JSON.stringify(r.body).includes('PRIVATE_POSITION'),false);
  assert.equal(JSON.stringify(r.body).includes('PRIVATE_STRATEGY'),false);
});
test('performance rejects malformed, stale or non-paper data', async () => {
  configure();
  stub(statusPayload({performance:{trades:100,wins:120,losses:0,win_rate:80,total_pnl:10}}));
  assert.equal((await run(status)).statusCode,502);
  stub(statusPayload({updated_at:new Date(Date.now()-3600000).toISOString()}));
  assert.equal((await run(status)).body.status,'stale');
  stub(statusPayload({engine:{mode:'live',running:true}}));
  assert.equal((await run(status)).body.status,'publication_disabled');
});
test('read-only endpoints refuse POST', async () => {
  configure();
  for(const handler of [health,status,connection]){
    const r = await run(handler,'POST');
    assert.equal(r.statusCode,405);
  }
});
test('static release removes old public account files and plaintext proxy rewrites', () => {
  const root = path.join(__dirname,'..');
  for(const rel of ['data/dashboard.json','data/portfolio.json','data/signals.json','stats.json']) {
    assert.equal(fs.existsSync(path.join(root,rel)),false,rel);
  }
  const vercel = JSON.parse(fs.readFileSync(path.join(root,'vercel.json'),'utf8'));
  assert.deepEqual(vercel.rewrites,[]);
  assert.equal(JSON.stringify(vercel).includes('143.244.155.109:5000'),false);
  const dashboard = fs.readFileSync(path.join(root,'dashboard.html'),'utf8');
  assert.equal(dashboard.includes('id="pinInput"'),false);
  assert.equal(dashboard.includes('<span>Mode</span><strong>Beta</strong>'),false);
  assert.equal(dashboard.includes('<div class="v3-radar-row">'),false);
});
