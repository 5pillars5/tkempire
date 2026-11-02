'use strict';

// Public PAPER-mode aggregate performance only.
// Detailed positions, internal performance records, and strategy are private.
function send(res, code, body) {
  res.setHeader('Cache-Control', 'public, max-age=0, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return res.status(code).json({ schema_version: 1, ...body });
}

function bounded(v, min, max) {
  return typeof v === 'number' && Number.isFinite(v) &&
    v >= min && v <= max ? v : null;
}

function count(v) {
  return Number.isSafeInteger(v) && v >= 0 && v <= 100000000 ? v : null;
}

module.exports = async function publicPerformance(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return send(res, 405, { status: 'method_not_allowed' });
  }
  if (process.env.GENESIS_STATUS_URL !==
      'https://api.tkempire.io/internal/genesis/health') {
    return send(res, 503, { status: 'not_configured' });
  }
  const secret = process.env.GENESIS_STATUS_TOKEN;
  if (typeof secret !== 'string' || secret.length < 32 || secret.length > 256 ||
      /[\r\n]/.test(secret)) {
    return send(res, 503, { status: 'not_configured' });
  }

  try {
    const auth = 'Basic ' + Buffer.from('tkempire-site:' + secret, 'utf8').toString('base64');
    const response = await fetch('https://api.tkempire.io/internal/genesis/status', {
      method: 'GET',
      redirect: 'error',
      cache: 'no-store',
      headers: { Accept: 'application/json', Authorization: auth },
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) return send(res, 502, { status: 'upstream_unavailable' });
    const length = Number(response.headers.get('content-length'));
    if (length > 32768) return send(res, 502, { status: 'invalid_response' });
    const body = await response.text();
    if (Buffer.byteLength(body, 'utf8') > 32768) {
      return send(res, 502, { status: 'invalid_response' });
    }
    const data = JSON.parse(body);
    const engine = data?.engine;
    if (!engine || String(engine.mode).toLowerCase() !== 'paper' ||
        typeof engine.running !== 'boolean') {
      return send(res, 503, { status: 'publication_disabled' });
    }
    const observed = Date.parse(data.updated_at);
    const age = Date.now() - observed;
    if (!Number.isFinite(observed) || age < -30000 || age > 120000) {
      return send(res, 503, { status: 'stale' });
    }
    const p = data.performance || {};
    const trades = count(p.trades);
    const wins = count(p.wins);
    const losses = count(p.losses);
    const winRate = bounded(p.win_rate, 0, 100);
    const pnl = bounded(p.total_pnl, -1e9, 1e9);
    if ([trades, wins, losses, winRate, pnl].some(v => v === null) ||
        wins + losses > trades) {
      return send(res, 502, { status: 'invalid_response' });
    }

    const regime = String(engine.regime || 'unknown').trim().toUpperCase();
    return send(res, 200, {
      status: 'paper_validation',
      source: 'GENESIS_PAPER_AGGREGATE',
      updated_at: new Date(observed).toISOString(),
      engine: {
        mode: 'paper',
        running: engine.running,
        regime: /^[A-Z_]{1,24}$/.test(regime) ? regime : 'UNKNOWN',
      },
      performance: {
        trades, wins, losses, win_rate: winRate, total_pnl: pnl,
      },
      // /api/genesis/status and /health represent different underlying datasets;
      // the old API's positions.open is not an execution-position count.
      positions: { open: null, comparable_with_health: false },
      performance_source: data.source === 'signals.json' ? 'signals.json' : 'unverified_aggregate',
      disclosure: 'PAPER_RESEARCH_ONLY_NOT_LIVE_EXECUTION',
    });
  } catch {
    return send(res, 502, { status: 'upstream_unavailable' });
  }
};
