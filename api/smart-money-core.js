'use strict';

/*
 * Genesis Smart Money signals - pure, read-only evidence classifier.
 * No order submission, wallet authentication, secrets, VPS access or trades.
 */
const crypto = require('node:crypto');
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const CONDITION = /^0x[0-9a-f]{62,64}$/i;
const TX = /^0x[0-9a-f]{64}$/i;
const DAY = 86400;
const MIN_SIGNAL_USDC = 250;
const ALERT_AGE_SECONDS = 900;
const MARKET_GROUP_WINDOW_SECONDS = 1800;
const SIGNAL_TYPES = Object.freeze([
  'SMART_MONEY_BUY', 'SMART_MONEY_SELL', 'WHALE_CONSENSUS',
  'UNUSUAL_ACTIVITY', 'POSSIBLE_WALLET_REVERSAL'
]);

function number(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function text(v, cap = 180) {
  return typeof v === 'string' ? v.trim().slice(0, cap) : '';
}
function idFor(v) {
  return crypto.createHash('sha256').update(v.join('|')).digest('hex').slice(0, 24);
}
function slug(v) {
  const x = text(v, 180);
  return /^[a-z0-9-]+$/.test(x) ? x : '';
}
function normalizeWallets(rows, limit = 10) {
  if (!Array.isArray(rows)) throw new Error('INVALID_LEADERBOARD');
  const seen = new Set();
  const out = [];
  for (const item of rows) {
    if (!item || typeof item !== 'object') continue;
    const wallet = text(item.user_id, 42).toLowerCase();
    const pnl = number(item.pnl);
    const volume = number(item.volume);
    if (!ADDRESS.test(wallet) || pnl === null || pnl <= 0 ||
        volume === null || volume <= 100 || seen.has(wallet)) continue;
    seen.add(wallet);
    out.push({
      wallet, name: text(item.user_name, 70) || wallet.slice(0, 9),
      window_pnl_usdc: pnl, volume_shares: volume,
      rank: number(item.rank)
    });
    if (out.length >= limit) break;
  }
  return out;
}
function normalizeActivity(raw, watchWallet, nowSeconds) {
  if (!raw || raw.type !== 'TRADE' || !ADDRESS.test(watchWallet)) return null;
  const wallet = text(raw.proxy_wallet, 42).toLowerCase();
  const condition = text(raw.condition_id, 66).toLowerCase();
  const side = text(raw.side, 6).toUpperCase();
  const amount = number(raw.usdc_size);
  const price = number(raw.price);
  const size = number(raw.size);
  const timestamp = number(raw.timestamp);
  const outcomeIndex = number(raw.outcome_index);
  const tokenId = text(raw.token_id, 100);
  const tx = text(raw.transaction_hash, 66).toLowerCase();
  if (wallet !== watchWallet.toLowerCase() ||
      !CONDITION.test(condition) || !['BUY', 'SELL'].includes(side) ||
      amount === null || amount < 1 ||
      price === null || price < 0 || price > 1 ||
      size === null || size <= 0 ||
      timestamp === null || !Number.isInteger(timestamp) ||
      timestamp > nowSeconds + 90 || timestamp < nowSeconds - DAY ||
      outcomeIndex === null || !Number.isInteger(outcomeIndex) ||
      outcomeIndex < 0 || outcomeIndex > 998 ||
      !TX.test(tx)) return null;
  return {
    id: idFor([wallet, tx, condition, side, outcomeIndex,
      timestamp, String(size), String(price)]),
    wallet, condition_id: condition,
    title: text(raw.title, 190) || 'Unlabeled market',
    outcome: text(raw.outcome, 80) || 'Unlabeled outcome',
    outcome_index: outcomeIndex,
    token_id: tokenId, event_slug: slug(raw.event_slug || raw.slug),
    side, usdc_size: amount, size_shares: size, price,
    timestamp, tx_hash: tx
  };
}
function median(a) {
  const sorted = a.filter(x => Number.isFinite(x) && x > 0)
    .sort((x, y) => x - y);
  if (!sorted.length) return null;
  const i = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[i] : (sorted[i - 1] + sorted[i]) / 2;
}
function signal(type, trade, now, extra = {}) {
  return {
    id: idFor([type, trade.id]),
    type, market: trade.title, outcome: trade.outcome,
    side: trade.side, event_slug: trade.event_slug,
    token_id: trade.token_id,
    condition_id: trade.condition_id,
    representative_price: trade.price,
    amount_usdc: Math.round(trade.usdc_size * 100) / 100,
    wallets: [trade.wallet], wallet_count: 1,
    observed_at: new Date(trade.timestamp * 1000).toISOString(),
    age_seconds: Math.max(0, now - trade.timestamp),
    alert_fresh: now - trade.timestamp <= ALERT_AGE_SECONDS,
    evidence: 'public_on_chain_activity',
    execution_authority: 'none',
    ...extra
  };
}
function buildSignals(wallets, rawByWallet, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!Array.isArray(wallets) || !rawByWallet || typeof rawByWallet !== 'object') {
    throw new Error('INVALID_INPUT');
  }
  const seen = new Set();
  const trades = [];
  const monitored = new Set(wallets.map(x => x.wallet));
  for (const [wallet, rows] of Object.entries(rawByWallet)) {
    if (!monitored.has(wallet) || !Array.isArray(rows)) continue;
    for (const raw of rows) {
      const trade = normalizeActivity(raw, wallet, nowSeconds);
      if (trade && !seen.has(trade.id)) {
        seen.add(trade.id);
        trades.push(trade);
      }
    }
  }
  trades.sort((a, b) => b.timestamp - a.timestamp || a.id.localeCompare(b.id));
  const alerts = [];
  // Every qualifying BUY/SELL is an observed activity notice, not a trade recommendation.
  for (const trade of trades) {
    if (trade.usdc_size < MIN_SIGNAL_USDC) continue;
    alerts.push(signal(trade.side === 'BUY' ? 'SMART_MONEY_BUY' : 'SMART_MONEY_SELL',
      trade, nowSeconds));
  }
  // Large relative to the same wallet's sampled fill distribution. Not a claim of insider knowledge.
  const byWallet = new Map();
  for (const t of trades) {
    if (!byWallet.has(t.wallet)) byWallet.set(t.wallet, []);
    byWallet.get(t.wallet).push(t);
  }
  for (const arr of byWallet.values()) {
    for (const t of arr) {
      if (t.usdc_size < 2000) continue;
      const baseline = arr.filter(x => x.id !== t.id).map(x => x.usdc_size);
      if (baseline.length < 6) continue;
      const base = median(baseline);
      if (base !== null && base >= 1 && t.usdc_size >= 4 * base) {
        alerts.push(signal('UNUSUAL_ACTIVITY', t, nowSeconds, {
          baseline_median_usdc: Math.round(base * 100) / 100,
          multiple_of_sample_median: Math.round((t.usdc_size / base) * 10) / 10
        }));
      }
    }
  }
  // Potential reversal: wallet visibly SELLS outcome A then BUYS opposing
  // outcome B on the *same* market in the next hour. Hedging remains possible.
  for (const arr of byWallet.values()) {
    const asc = [...arr].sort((a, b) => a.timestamp - b.timestamp);
    for (let i = 0; i < asc.length; i++) {
      const t = asc[i];
      if (t.side !== 'BUY' || t.usdc_size < MIN_SIGNAL_USDC ||
          t.outcome_index === 999) continue;
      const previous = asc.slice(0, i).reverse().find(x =>
        x.condition_id === t.condition_id && x.side === 'SELL' &&
        x.outcome_index !== t.outcome_index &&
        x.outcome_index !== 999 &&
        x.usdc_size >= MIN_SIGNAL_USDC &&
        t.timestamp - x.timestamp >= 0 &&
        t.timestamp - x.timestamp <= 3600
      );
      if (previous) {
        alerts.push(signal('POSSIBLE_WALLET_REVERSAL', t, nowSeconds, {
          previous_outcome: previous.outcome, previous_sell_at:
            new Date(previous.timestamp * 1000).toISOString(),
          evidence: 'sell_opposing_outcome_then_buy'
        }));
      }
    }
  }
  // Same market + same outcome BUY by 3 distinct tracked wallets within
  // a 30-minute rolling window. Never group by ambiguous title text.
  const buys = new Map();
  for (const t of trades) {
    if (t.side !== 'BUY' || t.usdc_size < MIN_SIGNAL_USDC ||
        t.outcome_index === 999) continue;
    const key = t.condition_id + '|' + t.outcome_index;
    if (!buys.has(key)) buys.set(key, []);
    buys.get(key).push(t);
  }
  for (const group of buys.values()) {
    group.sort((a, b) => a.timestamp - b.timestamp);
    let best = null;
    for (let end = 0; end < group.length; end++) {
      const latest = group[end];
      const recent = group.filter(x => x.timestamp >= latest.timestamp -
        MARKET_GROUP_WINDOW_SECONDS && x.timestamp <= latest.timestamp);
      const unique = new Map();
      for (const item of recent) unique.set(item.wallet, item);
      if (unique.size >= 3 && (!best || latest.timestamp > best.latest.timestamp)) {
        best = { latest, trades: [...unique.values()] };
      }
    }
    if (best) {
      const aligned = [...new Set(best.trades.map(t => t.wallet))].sort();
      const total = best.trades.reduce((sum, x) => sum + x.usdc_size, 0);
      const representative = best.latest;
      alerts.push(signal('WHALE_CONSENSUS', representative, nowSeconds, {
        id: idFor(['WHALE_CONSENSUS', representative.condition_id,
          representative.outcome_index, ...aligned,
          Math.floor(representative.timestamp / 900)]),
        wallets: aligned, wallet_count: aligned.length,
        amount_usdc: Math.round(total * 100) / 100,
        evidence: 'three_distinct_watched_buyers_within_30m',
        consensus_window_seconds: MARKET_GROUP_WINDOW_SECONDS
      }));
    }
  }
  // Idempotence across duplicate API response rows and overlapping scans.
  const uniqueAlerts = new Map();
  for (const a of alerts) uniqueAlerts.set(a.id, a);
  const ranked = [...uniqueAlerts.values()].sort((a, b) =>
    Date.parse(b.observed_at) - Date.parse(a.observed_at) ||
    a.id.localeCompare(b.id));
  return {
    signals: ranked.slice(0, 60), trades_seen: trades.length,
    oldest_trade_at: trades.length ? new Date(trades[trades.length - 1].timestamp * 1000).toISOString() : null,
    newest_trade_at: trades.length ? new Date(trades[0].timestamp * 1000).toISOString() : null
  };
}
module.exports = { SIGNAL_TYPES, normalizeWallets, normalizeActivity, buildSignals };