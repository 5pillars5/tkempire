'use strict';

/* Read-only Polymarket Data API v2 smart-money signal snapshot.
   No signing keys, no execution, no persistence, no notification credentials.
   Every request reads public observations. */
const { normalizeWallets, buildSignals } = require('./smart-money-core');
const ORIGIN = 'https://data-api.polymarket.com';
const FETCH_CAP = 400000;
const WALLET_LIMIT = 8;
function respond(res, code, data) {
  res.setHeader('Cache-Control', code === 200
    ? 'public, s-maxage=35, max-age=0, stale-while-revalidate=10'
    : 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return res.status(code).json(data);
}
async function readData(path, params) {
  const url = new URL(path, ORIGIN);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  const response = await fetch(url, {
    method: 'GET', redirect: 'error', cache: 'no-store',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(6800)
  });
  if (!response.ok) throw new Error('upstream_http_' + response.status);
  const len = Number(response.headers.get('content-length'));
  if (Number.isFinite(len) && len > FETCH_CAP) throw new Error('upstream_large');
  const body = await response.text();
  if (Buffer.byteLength(body, 'utf8') > FETCH_CAP) throw new Error('upstream_large');
  const parsed = JSON.parse(body);
  if (!parsed || !Array.isArray(parsed.data)) throw new Error('invalid_upstream_schema');
  return parsed.data;
}
module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return respond(res, 405, { status: 'method_not_allowed' });
  }
  const generated = new Date().toISOString();
  try {
    const leaderboard = await readData('/v2/leaderboard', {
      time_period: 'week', category: 'crypto', sort_by: 'PNL', limit: 16
    });
    const wallets = normalizeWallets(leaderboard, WALLET_LIMIT);
    if (!wallets.length) throw new Error('no_qualified_wallets');
    const end = Math.floor(Date.now() / 1000);
    const start = end - 86400;
    const responses = await Promise.allSettled(wallets.map(w =>
      readData('/v2/activity', {
        user: w.wallet, type: 'TRADE', limit: 70,
        start, end, sort_by: 'TIMESTAMP', sort_direction: 'DESC'
      })
    ));
    const activity = {};
    const failed = [];
    const successful = [];
    for (let i = 0; i < responses.length; i++) {
      const w = wallets[i];
      if (responses[i].status === 'fulfilled') {
        activity[w.wallet] = responses[i].value;
        successful.push(w.wallet);
      } else {
        failed.push(w.wallet);
      }
    }
    if (!successful.length) throw new Error('activity_feeds_unavailable');
    const result = buildSignals(wallets, activity, end);
    const signals = result.signals.map(s => ({
      ...s,
      wallet_count: s.wallet_count,
      // Explicitly identify signal as observed, not executed.
      signal_mode: 'OBSERVATION_ONLY', paper_trade: false
    }));
    return respond(res, 200, {
      status: failed.length ? 'degraded' : 'ok',
      schema_version: 1, generated_at: generated,
      source: 'Polymarket public Data API v2',
      scope: 'crypto_week_top_profit_sample',
      selection: 'positive_pnl_and_volume_from_current_leaderboard',
      execution_enabled: false, genesis_execution_authority: 'none',
      signals, monitored_wallets: wallets.length,
      successful_wallets: successful.length,
      failed_wallets: failed.length, failed_wallet_addresses: failed,
      qualifying_signals: signals.length, trades_scanned: result.trades_seen,
      newest_trade_at: result.newest_trade_at,
      alert_freshness_seconds: 900,
      discovery_limitations: [
        'sampling top weekly wallets; not all profitable traders',
        'up to 70 recent activities per wallet; pagination not exhausted',
        'zero signals may mean no eligible recent trades',
        'cannot prove future profitability or that trades can be copied',
        'no historical state; not a persistent 24/7 scanner'
      ]
    });
  } catch (err) {
    return respond(res, 503, {
      status: 'unavailable', schema_version: 1,
      generated_at: generated, execution_enabled: false,
      error: 'Public signal data unavailable; no signals inferred.',
      signals: [], monitored_wallets: 0, trades_scanned: 0
    });
  }
};