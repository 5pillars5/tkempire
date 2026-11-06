'use strict';

/*
 * TK Empire Smart Money Watch v1
 * PUBLIC Polymarket Data API v2 only. Read-only GETs, no wallets, keys,
 * Genesis/VPS access, order routing, exchange credentials, or trade actions.
 */
const BASE = 'https://data-api.polymarket.com';
const ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const WINDOWS = new Set(['day', 'week', 'month', 'all']);
const CATEGORIES = new Set(['crypto', 'overall', 'sports', 'politics']);
const VIEWS = new Set(['board', 'trades', 'positions']);

function num(x) {
  return typeof x === 'number' && Number.isFinite(x) ? x : null;
}
function txt(x, max) {
  return typeof x === 'string' ? x.slice(0, max) : '';
}
function safe(res, status, data) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', status === 200
    ? 'public, max-age=0, s-maxage=20, stale-while-revalidate=20'
    : 'no-store');
  return res.status(status).json(data);
}
async function upstream(path, params) {
  const url = new URL(path, BASE);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const response = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    redirect: 'error',
    cache: 'no-store',
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) {
    const e = new Error('UPSTREAM_UNAVAILABLE');
    e.status = response.status;
    throw e;
  }
  const max = 350000;
  const len = Number(response.headers.get('content-length'));
  if (Number.isFinite(len) && len > max) throw new Error('UPSTREAM_TOO_LARGE');
  const raw = await response.text();
  if (Buffer.byteLength(raw, 'utf8') > max) throw new Error('UPSTREAM_TOO_LARGE');
  const parsed = JSON.parse(raw);
  if (!parsed || !Array.isArray(parsed.data)) throw new Error('UPSTREAM_SCHEMA');
  return parsed.data;
}
module.exports = async function smartMoneyWatch(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return safe(res, 405, { status: 'method_not_allowed' });
  }
  const view = typeof req.query.view === 'string' ? req.query.view : 'board';
  if (!VIEWS.has(view)) return safe(res, 400, { status: 'invalid_view' });
  let path, params, wallet, period, category;
  if (view === 'board') {
    period = typeof req.query.period === 'string' ? req.query.period : 'week';
    category = typeof req.query.category === 'string' ? req.query.category : 'crypto';
    if (!WINDOWS.has(period) || !CATEGORIES.has(category)) {
      return safe(res, 400, { status: 'invalid_filter' });
    }
    path = '/v2/leaderboard';
    params = { time_period: period, category, sort_by: 'PNL', limit: 20 };
  } else {
    wallet = req.query.wallet;
    if (typeof wallet !== 'string' || !ADDRESS.test(wallet)) {
      return safe(res, 400, { status: 'invalid_wallet' });
    }
    path = view === 'trades' ? '/v2/trades' : '/v2/positions';
    params = { user: wallet, limit: 20 };
    if (view === 'positions') params.status = 'OPEN';
  }
  try {
    const raw = await upstream(path, params);
    let rows;
    if (view === 'board') {
      rows = raw.slice(0, 20).map(r => ({
        wallet: txt(r.user_id, 42),
        name: txt(r.user_name, 100),
        rank: num(r.rank),
        pnl_usdc: num(r.pnl),
        volume_shares: num(r.volume),
        verified: r.verified === true
      })).filter(r => ADDRESS.test(r.wallet));
    } else if (view === 'trades') {
      rows = raw.slice(0, 20).map(r => ({
        title: txt(r.title || r.market_title || r.question, 180),
        outcome: txt(r.outcome || r.outcome_name, 70),
        side: txt(r.side, 12),
        size_shares: num(r.size ?? r.shares),
        price: num(r.price),
        timestamp: num(r.timestamp ?? r.executed_at ?? r.trade_timestamp ?? r.block_timestamp),
        event_slug: txt(r.event_slug || r.slug, 180)
      }));
    } else {
      rows = raw.slice(0, 20).map(r => ({
        title: txt(r.title, 180),
        outcome: txt(r.outcome, 70),
        current_size: num(r.current_size),
        current_value: num(r.current_value),
        avg_price: num(r.avg_price),
        current_price: num(r.current_price),
        total_pnl: num(r.total_pnl),
        status: txt(r.status, 30),
        event_slug: txt(r.event_slug || r.slug, 180)
      }));
    }
    return safe(res, 200, {
      schema_version: 1, status: 'ok', source: 'Polymarket Data API v2',
      fetched_at: new Date().toISOString(), view, period: period || null,
      category: category || null, wallet: wallet || null, rows
    });
  } catch (e) {
    return safe(res, 503, {
      schema_version: 1, status: 'upstream_unavailable',
      source: 'Polymarket Data API v2',
      upstream_status: Number.isInteger(e.status) ? e.status : null,
      rows: [], fetched_at: new Date().toISOString()
    });
  }
};