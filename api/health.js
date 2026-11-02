'use strict';

// Public health summary. Do not expose the upstream trade list, admission
// fingerprints, strategy settings, runtime files, account data, or raw payload.
function send(res, code, body) {
  res.setHeader('Cache-Control', 'public, max-age=0, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return res.status(code).json({ schema_version: 1, ...body });
}

function safeAge(section, key) {
  const seconds = section?.[key]?.age_seconds;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) ||
      seconds < 0 || seconds > 31536000) return null;
  return { age_seconds: Math.round(seconds) };
}

async function readHealth() {
  if (process.env.GENESIS_STATUS_URL !==
      'https://api.tkempire.io/internal/genesis/health') {
    throw new Error('NOT_CONFIGURED');
  }
  const password = process.env.GENESIS_STATUS_TOKEN;
  if (typeof password !== 'string' || password.length < 32 ||
      password.length > 256 || /[\r\n]/.test(password)) {
    throw new Error('NOT_CONFIGURED');
  }
  const username = process.env.GENESIS_STATUS_USERNAME || 'tkempire-site';
  if (username !== 'tkempire-site' && username !== 'tkempire-prod') {
    throw new Error('NOT_CONFIGURED');
  }
  const authorization = 'Basic ' +
    Buffer.from(username + ':' + password, 'utf8').toString('base64');
  const response = await fetch(process.env.GENESIS_STATUS_URL, {
    method: 'GET',
    redirect: 'error',
    cache: 'no-store',
    headers: { Accept: 'application/json', Authorization: authorization },
    signal: AbortSignal.timeout(4000),
  });
  if (!response.ok) throw new Error('UPSTREAM_ERROR');
  const length = Number(response.headers.get('content-length'));
  if (length > 65536) throw new Error('TOO_LARGE');
  const body = await response.text();
  if (Buffer.byteLength(body, 'utf8') > 65536) throw new Error('TOO_LARGE');
  return JSON.parse(body);
}

module.exports = async function health(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return send(res, 405, { status: 'method_not_allowed' });
  }
  try {
    const data = await readHealth();
    const engine = data?.engine;
    if (!engine || String(engine.mode).toLowerCase() !== 'paper' ||
        typeof engine.running !== 'boolean') {
      return send(res, 503, { status: 'publication_disabled' });
    }
    const observed = Date.parse(data.served_at);
    const age = Date.now() - observed;
    if (!Number.isFinite(observed) || age < -30000 || age > 120000) {
      return send(res, 503, { status: 'stale' });
    }

    const allowedChecks = [
      'engine', 'runtime_fresh', 'altfins_parser_fresh', 'coingecko_fresh',
      'memory_loaded', 'telegram_listener', 'api_service', 'nginx_service',
      'genesis_service',
    ];
    const checks = {};
    for (const key of allowedChecks) {
      checks[key] = data.checks?.[key] === true;
    }

    const openCount = data.open_trades?.count;
    const count = Number.isSafeInteger(openCount) &&
      openCount >= 0 && openCount <= 100000 ? openCount : null;
    const score = data.health_score;
    const healthScore = typeof score === 'number' && Number.isFinite(score) &&
      score >= 0 && score <= 100 ? score : null;
    const regime = String(engine.regime || 'unknown').trim().toUpperCase();
    const safeRegime = /^[A-Z_]{1,24}$/.test(regime) ? regime : 'UNKNOWN';
    const reportedStatus = String(data.status || '').toLowerCase();
    const status = ['healthy', 'degraded', 'unhealthy', 'warning'].includes(reportedStatus)
      ? reportedStatus : 'unknown';

    return send(res, 200, {
      status,
      source: 'GENESIS_PAPER_PUBLIC_SUMMARY',
      served_at: new Date(observed).toISOString(),
      health_score: healthScore,
      engine: {
        mode: 'paper',
        running: engine.running,
        regime: safeRegime,
      },
      checks,
      feeds: {
        altfins_parsed: safeAge(data.feeds, 'altfins_parsed'),
        altfins_raw: safeAge(data.feeds, 'altfins_raw'),
        coingecko: safeAge(data.feeds, 'coingecko'),
      },
      memory: { brain_state: safeAge(data.memory, 'brain_state') },
      open_trades: {
        count,
        trades: [],
        details_public: false,
      },
    });
  } catch {
    return send(res, 502, { status: 'upstream_unavailable' });
  }
};
