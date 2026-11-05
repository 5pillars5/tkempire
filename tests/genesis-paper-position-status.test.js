'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'dashboard.html'), 'utf8');
const allScripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
const statusScript = allScripts.find(s => s.includes('PAPER POSITION STATUS V2'));
assert.ok(statusScript, 'PAPER status view must exist');

async function viewWith({count=2, servedAt=new Date().toISOString(), source='GENESIS_PAPER_PUBLIC_SUMMARY', mode='paper', status=200, fail=false} = {}) {
  const elements = {};
  for (const id of ['v3PaperTradeState','v3PaperTradeFreshness','openTradeCount','openTradeCards']) {
    elements[id] = {textContent: '', style: {}};
  }
  const document = {getElementById: id => elements[id] || null};
  const payload = {source, served_at: servedAt, engine: {mode, running: true},
    open_trades: {count, trades: [], details_public: false}};
  const fetch = async () => {
    if (fail) throw new Error('offline');
    return {ok: status === 200, status, json: async () => payload};
  };
  const context = {document, fetch, Date, Number, String, setInterval(){}};
  vm.runInNewContext(statusScript, context, {filename:'dashboard-paper-status'});
  await context.loadOpenTradeStatus();
  return elements;
}

test('reports OPEN from source count when individual trades are private', async () => {
  const e = await viewWith({count:2});
  assert.equal(e.v3PaperTradeState.textContent,'2 OPEN');
  assert.equal(e.openTradeCount.textContent,'2');
  assert.match(e.openTradeCards.textContent,/2 PAPER positions reported OPEN/);
  assert.doesNotMatch(e.openTradeCards.textContent,/No open trades/);
});

test('shows zero only for fresh verified zero count', async () => {
  const e = await viewWith({count:0});
  assert.equal(e.v3PaperTradeState.textContent,'0 OPEN');
  assert.match(e.openTradeCards.textContent,/Zero open PAPER positions reported/);
});

test('stale snapshots are UNVERIFIED, never zero', async () => {
  const e = await viewWith({count:0,servedAt:'2020-01-01T00:00:00Z'});
  assert.equal(e.v3PaperTradeState.textContent,'UNVERIFIED');
  assert.equal(e.openTradeCount.textContent,'—');
  assert.match(e.openTradeCards.textContent,/cannot be verified/);
});

test('unverified source and invalid counts fail closed', async () => {
  for (const options of [{source:'UNVERIFIED'},{count:null},{count:-1},{mode:'live'}]) {
    const e = await viewWith(options);
    assert.equal(e.v3PaperTradeState.textContent,'UNVERIFIED');
  }
});

test('network failure is UNVERIFIED and clears stale status', async () => {
  const e = await viewWith({fail:true});
  assert.equal(e.v3PaperTradeState.textContent,'UNVERIFIED');
  assert.equal(e.openTradeCount.textContent,'—');
});

test('mobile app has explicit PAPER open/zero/unverified labels', () => {
  const app = fs.readFileSync(path.join(root,'app.html'),'utf8');
  assert.match(app,/OPEN PAPER POSITIONS/);
  assert.match(app,/ZERO OPEN PAPER POSITIONS/);
  assert.match(app,/UNVERIFIED · data unavailable/);
  assert.doesNotMatch(app,/fetch\('\/api\/portfolio/);
});
