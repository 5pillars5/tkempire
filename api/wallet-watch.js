'use strict';

/*
 * TK Empire Wallet Watch: public observation only.
 * No exchange authentication, wallet signing, VPS access, or order submission.
 * Source: Polymarket public Data API v2. Same current positive-PnL
 * weekly crypto-leader sample used by Smart Money Signals.
 */
const crypto = require('node:crypto');
const { normalizeWallets } = require('./smart-money-core');

const ORIGIN = 'https://data-api.polymarket.com';
const WALLET_RE = /^0x[a-f0-9]{40}$/i;
const TX_RE = /^0x[a-f0-9]{64}$/i;
const SLUG_RE = /^[a-z0-9-]{1,180}$/;
const MAX_BYTES = 550000;
const SAMPLE_LIMIT = 8;
const HOURS_24 = 86400;

function number(x) {
  return typeof x === 'number' && Number.isFinite(x) ? x : null;
}
function string(x, cap) {
  return typeof x === 'string' ? x.trim().slice(0, cap) : '';
}
function respond(res, code, data) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', code === 200
    ? 'public, max-age=0, s-maxage=25, stale-while-revalidate=10'
    : 'no-store');
  return res.status(code).json(data);
}
async function upstream(path, params) {
  const url = new URL(path, ORIGIN);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const r = await fetch(url, {
    method: 'GET',
    redirect: 'error',
    cache: 'no-store',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(7200)
  });
  if (!r.ok) throw new Error('UPSTREAM_HTTP_' + r.status);
  const len = Number(r.headers.get('content-length'));
  if (Number.isFinite(len) && len > MAX_BYTES) throw new Error('UPSTREAM_LARGE');
  const body = await r.text();
  if (Buffer.byteLength(body, 'utf8') > MAX_BYTES) throw new Error('UPSTREAM_LARGE');
  const parsed = JSON.parse(body);
  if (!parsed || !Array.isArray(parsed.data)) throw new Error('UPSTREAM_SCHEMA');
  return parsed.data;
}

function selectWallets(leaderRows) {
  return normalizeWallets(leaderRows, SAMPLE_LIMIT).map(row => ({
    wallet: row.wallet,
    name: row.name,
    selection: 'weekly_crypto',
    rank: row.rank,
    window_pnl_usdc: row.window_pnl_usdc
  }));
}

function normalizeTrade(row, wallet, now) {
  if (!row || row.type !== 'TRADE') return null;
  if (string(row.proxy_wallet, 42).toLowerCase() !== wallet) return null;
  const side = string(row.side, 8).toUpperCase();
  const size = number(row.usdc_size);
  const timestamp = number(row.timestamp);
  const tx = string(row.transaction_hash, 66).toLowerCase();
  if (!['BUY', 'SELL'].includes(side) || size === null || size <= 0 ||
      timestamp === null || !Number.isInteger(timestamp) ||
      timestamp < now - HOURS_24 || timestamp > now + 90 ||
      !TX_RE.test(tx)) return null;
  const tokenId = string(row.token_id, 120);
  const slug = string(row.event_slug || row.slug, 180);
  const condition = string(row.condition_id, 66).toLowerCase();
  const shares = number(row.size);
  const price = number(row.price);
  return {
    id: crypto.createHash('sha256').update([
      wallet, tx, condition, side, tokenId, timestamp, size, shares
    ].join('|')).digest('hex').slice(0, 24),
    wallet,
    side,
    market: string(row.title, 200) || 'Unlabeled public market',
    outcome: string(row.outcome, 75) || 'Unlabeled outcome',
    amount_usdc: size,
    shares: shares !== null && shares > 0 ? shares : null,
    price: price !== null && price >= 0 && price <= 1 ? price : null,
    timestamp,
    event_slug: SLUG_RE.test(slug) ? slug : null,
    tx_hash: tx
  };
}

async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return respond(res, 405, { schema_version: 1, status: 'method_not_allowed' });
  }
  const fetched = new Date().toISOString();
  const now = Math.floor(Date.now() / 1000);
  let leaderboard;
  try {
    leaderboard = await upstream('/v2/leaderboard', {
      time_period: 'week', category: 'crypto', sort_by: 'PNL', limit: 20
    });
  } catch (_) {
    return respond(res, 503, {
      schema_version: 1, status: 'unavailable', fetched_at: fetched,
      source: 'Polymarket public Data API v2',
      scope: 'current_weekly_crypto_leader_sample',
      execution_authority: 'none', wallets: [], trades: [],
      message: 'Current monitored wallets could not be verified. No transactions inferred.'
    });
  }
  const wallets = selectWallets(leaderboard);
  if (!wallets.length) {
    return respond(res, 503, {
      schema_version: 1, status: 'unavailable', fetched_at: fetched,
      source: 'Polymarket public Data API v2',
      scope: 'current_weekly_crypto_leader_sample',
      execution_authority: 'none', wallets: [], trades: [],
      message: 'No qualifying current weekly crypto wallets could be verified.'
    });
  }
  const reads = await Promise.allSettled(wallets.map(w => upstream('/v2/activity', {
    user: w.wallet,
    type: 'TRADE',
    start: now - HOURS_24,
    end: now + 90,
    limit: 40,
    sort_direction: 'DESC'
  })));
  const trades = [];
  const seen = new Set();
  let successful = 0;
  let failed = 0;
  for (let i = 0; i < wallets.length; i++) {
    const w = wallets[i];
    w.latest_trade_at = null;
    w.feed_status = reads[i].status === 'fulfilled' ? 'ok' : 'unavailable';
    if (reads[i].status !== 'fulfilled') {
      failed++;
      continue;
    }
    successful++;
    for (const raw of reads[i].value) {
      const item = normalizeTrade(raw, w.wallet, now);
      if (!item || seen.has(item.id)) continue;
      seen.add(item.id);
      trades.push(item);
      w.latest_trade_at = w.latest_trade_at === null
        ? item.timestamp : Math.max(w.latest_trade_at, item.timestamp);
    }
  }
  trades.sort((a, b) => b.timestamp - a.timestamp || a.id.localeCompare(b.id));
  if (!successful) {
    return respond(res, 503, {
      schema_version: 1, status: 'unavailable', fetched_at: fetched,
      source: 'Polymarket public Data API v2',
      scope: 'current_weekly_crypto_leader_sample',
      execution_authority: 'none',
      wallets: [], trades: [],
      message: 'Public activity could not be verified. No transactions inferred.'
    });
  }
  return respond(res, 200, {
    schema_version: 1,
    status: failed ? 'degraded' : 'ok',
    fetched_at: fetched,
    source: 'Polymarket public Data API v2',
    scope: 'current_weekly_crypto_leader_sample',
    selection: 'Current positive-PnL 7-day crypto leaderboard sample; membership can change.',
    market_scope: 'Public Polymarket trades across all market categories for the selected wallets',
    execution_authority: 'none',
    refresh_seconds: 30,
    window_hours: 24,
    leaderboard_available: true,
    monitored_wallets: wallets.length,
    successful_wallets: successful,
    failed_wallets: failed,
    observed_sample_size: trades.length,
    newest_trade_at: trades.length ? new Date(trades[0].timestamp * 1000).toISOString() : null,
    wallets,
    trades: trades.slice(0, 72),
    limitations: 'Recent observed fills only, capped at 40 activities per wallet and 72 displayed trades. This is polling, not a tick-by-tick stream or guaranteed full trade history.'
  });
}

module.exports = handler;
module.exports._test = { selectWallets, normalizeTrade };
