'use strict';

/*
 * Read-only Hyperliquid TESTNET Info API adapter.
 * Never accepts a URL, auth header, exchange endpoint, or signing material.
 * It does not know the user's wallet unless the browser explicitly submits
 * a public address. Returned records are public exchange-account information.
 */
const TESTNET_INFO = 'https://api.hyperliquid-testnet.xyz/info';
const ALLOWED_ORIGIN = 'https://www.tkempire.io';
const WALLET = /^0x[a-fA-F0-9]{40}$/;

function respond(res, code, value) {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.status(code).json(value);
}

async function info(type, user, maxBytes) {
  const response = await fetch(TESTNET_INFO, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    redirect: 'error',
    cache: 'no-store',
    body: JSON.stringify({ type, user }),
    signal: AbortSignal.timeout(8500),
  });
  if (!response.ok) throw new Error('EXCHANGE_REQUEST_FAILED');
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > maxBytes) throw new Error('EXCHANGE_RESPONSE_TOO_LARGE');
  const raw = await response.text();
  if (Buffer.byteLength(raw, 'utf8') > maxBytes) throw new Error('EXCHANGE_RESPONSE_TOO_LARGE');
  return JSON.parse(raw);
}

function cleanNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function cleanText(value, maxLength = 80) {
  return typeof value === 'string' ? value.slice(0, maxLength) : '';
}

function normalizePositions(data) {
  if (!data || !Array.isArray(data.assetPositions)) throw new Error('POSITION_SCHEMA_INVALID');
  return data.assetPositions.map(item => {
    const p = item && item.position;
    if (!p || typeof p !== 'object') return null;
    const size = cleanNumber(p.szi);
    if (size === null || size === 0) return null;
    return {
      coin: cleanText(p.coin, 32),
      size,
      direction: size < 0 ? 'SHORT' : 'LONG',
      entry_price: cleanNumber(p.entryPx),
      position_value: cleanNumber(p.positionValue),
      unrealized_pnl: cleanNumber(p.unrealizedPnl),
      return_on_equity: cleanNumber(p.returnOnEquity),
      liquidation_price: cleanNumber(p.liquidationPx),
      leverage: cleanNumber(p.leverage?.value),
      margin_used: cleanNumber(p.marginUsed),
    };
  }).filter(Boolean).slice(0, 100);
}

function normalizeSpot(data) {
  if (!data || !Array.isArray(data.balances)) throw new Error('SPOT_SCHEMA_INVALID');
  return data.balances.map(b => ({
    coin: cleanText(b.coin, 32),
    total: cleanNumber(b.total),
    hold: cleanNumber(b.hold),
  })).filter(b => b.coin && b.total !== null && b.total !== 0).slice(0, 100);
}

function normalizeOrders(data) {
  if (!Array.isArray(data)) throw new Error('ORDERS_SCHEMA_INVALID');
  return data.slice(0, 150).map(o => ({
    coin: cleanText(o.coin, 32),
    side: o.side === 'B' ? 'BUY' : o.side === 'A' ? 'SELL' : 'UNKNOWN',
    price: cleanNumber(o.limitPx),
    size: cleanNumber(o.sz),
    timestamp: cleanNumber(o.timestamp),
    oid: String(o.oid || '').slice(0, 40),
  }));
}

function normalizeFills(data) {
  if (!Array.isArray(data)) throw new Error('FILLS_SCHEMA_INVALID');
  return data.slice(0, 2000).map(f => ({
    coin: cleanText(f.coin, 32),
    direction: cleanText(f.dir, 50),
    side: f.side === 'B' ? 'BUY' : f.side === 'A' ? 'SELL' : 'UNKNOWN',
    price: cleanNumber(f.px),
    size: cleanNumber(f.sz),
    closed_pnl: cleanNumber(f.closedPnl),
    fee: cleanNumber(f.fee),
    fee_token: cleanText(f.feeToken, 20),
    timestamp: cleanNumber(f.time),
    oid: String(f.oid || '').slice(0, 40),
  }));
}

module.exports = async function testnetAccount(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return respond(res, 405, { status: 'METHOD_NOT_ALLOWED' });
  }
  const origin = req.headers.origin;
  if (origin && origin !== ALLOWED_ORIGIN && origin !== 'https://tkempire.io') {
    return respond(res, 403, { status: 'ORIGIN_NOT_ALLOWED' });
  }
  if (Number(req.headers['content-length']) > 256) {
    return respond(res, 413, { status: 'REQUEST_TOO_LARGE' });
  }
  const payload = req.body;
  const user = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload.user : null;
  if (typeof user !== 'string' || !WALLET.test(user)) {
    return respond(res, 400, { status: 'INVALID_PUBLIC_WALLET_ADDRESS' });
  }
  try {
    const requestTypes = [
      ['perps', 'clearinghouseState', 524288],
      ['spot', 'spotClearinghouseState', 524288],
      ['orders', 'openOrders', 524288],
      ['fills', 'userFills', 2097152],
    ];
    const settled = await Promise.allSettled(
      requestTypes.map(x => info(x[1], user, x[2]))
    );
    const result = { schema_version: 1, status: 'PARTIAL', source: 'HYPERLIQUID_TESTNET_INFO',
      network: 'TESTNET', fetched_at: new Date().toISOString(),
      address: user.toLowerCase(), sections: {}, errors: [] };
    for (let i = 0; i < settled.length; i++) {
      const [key] = requestTypes[i];
      const item = settled[i];
      if (item.status !== 'fulfilled') {
        result.sections[key] = null;
        result.errors.push(key.toUpperCase() + '_UNAVAILABLE');
        continue;
      }
      try {
        const data = item.value;
        if (key === 'perps') {
          if (!data || typeof data !== 'object' || !data.marginSummary) {
            throw new Error('PERPS_SCHEMA_INVALID');
          }
          result.sections.perps = {
            account_value: cleanNumber(data.marginSummary.accountValue),
            total_margin_used: cleanNumber(data.marginSummary.totalMarginUsed),
            withdrawable: cleanNumber(data.withdrawable),
            positions: normalizePositions(data),
          };
        }
        if (key === 'spot') result.sections.spot = normalizeSpot(data);
        if (key === 'orders') result.sections.orders = normalizeOrders(data);
        if (key === 'fills') result.sections.fills = normalizeFills(data);
      } catch {
        result.sections[key] = null;
        result.errors.push(key.toUpperCase() + '_INVALID');
      }
    }
    if (result.errors.length === requestTypes.length) {
      return respond(res, 502, { ...result, status: 'UPSTREAM_UNAVAILABLE' });
    }
    result.status = result.errors.length ? 'PARTIAL' : 'OK';
    result.fill_history_limit = 2000;
    return respond(res, 200, result);
  } catch {
    return respond(res, 502, { status: 'UPSTREAM_UNAVAILABLE' });
  }
};
