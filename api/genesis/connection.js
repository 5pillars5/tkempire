'use strict';

/**
 * Status-only, fail-closed bridge. This endpoint intentionally never returns
 * the raw /health payload, positions, trades, accounts, or upstream credentials.
 */
function send(res, code, data) {
  return res.status(code).json({
    schema_version: 1,
    checked_at: new Date().toISOString(),
    ...data,
  });
}

function isApprovedEndpoint(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' &&
      url.hostname === 'api.tkempire.io' &&
      url.pathname === '/internal/genesis/health' &&
      !url.port && !url.username && !url.password &&
      !url.search && !url.hash;
  } catch {
    return false;
  }
}

function normalizeUpstream(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const engine = data.engine;
  if (!engine || typeof engine !== 'object' || Array.isArray(engine) ||
      typeof engine.mode !== 'string') return null;

  // Gateway may eventually serve a dedicated filtered v1 response.
  if (data.schema_version === 1 && data.source === 'genesis') {
    if (typeof engine.state !== 'string' || typeof data.observed_at !== 'string') return null;
    return { mode: engine.mode, state: engine.state, observedAt: data.observed_at,
      source: 'GENESIS_GATEWAY' };
  }

  // Existing Genesis /health response, examined on 2026-11-01.
  // served_at is API freshness, NOT independently verified execution activity.
  if (typeof data.served_at !== 'string' || typeof engine.running !== 'boolean') return null;
  return { mode: engine.mode, state: engine.running ? 'RUNNING' : 'STOPPED',
    observedAt: data.served_at, source: 'GENESIS_API_HEALTH' };
}

module.exports = async function connection(req, res) {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return send(res, 405, { connected: false, state: 'METHOD_NOT_ALLOWED' });
  }

  const endpoint = process.env.GENESIS_STATUS_URL;
  const password = process.env.GENESIS_STATUS_TOKEN;
  if (!endpoint || !password) {
    return send(res, 503, { connected: false, state: 'NOT_CONFIGURED' });
  }
  if (!isApprovedEndpoint(endpoint) || password.length < 32 ||
      password.length > 256 || /[\r\n]/.test(password)) {
    return send(res, 503, { connected: false, state: 'INVALID_CONFIGURATION' });
  }

  try {
    const basic = Buffer.from('tkempire-site:' + password, 'utf8').toString('base64');
    const upstream = await fetch(endpoint, {
      method: 'GET',
      redirect: 'error',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        Authorization: 'Basic ' + basic,
      },
      signal: AbortSignal.timeout(4000),
    });
    if (!upstream.ok) {
      return send(res, 502, { connected: false, state: 'UPSTREAM_UNAVAILABLE' });
    }
    const declaredLength = Number(upstream.headers.get('content-length'));
    if (declaredLength > 65536) {
      return send(res, 502, { connected: false, state: 'INVALID_RESPONSE' });
    }
    const raw = await upstream.text();
    if (Buffer.byteLength(raw, 'utf8') > 65536) {
      return send(res, 502, { connected: false, state: 'INVALID_RESPONSE' });
    }
    const data = normalizeUpstream(JSON.parse(raw));
    if (!data) {
      return send(res, 502, { connected: false, state: 'INVALID_RESPONSE' });
    }
    const observed = Date.parse(data.observedAt);
    if (!Number.isFinite(observed)) {
      return send(res, 502, { connected: false, state: 'INVALID_RESPONSE' });
    }
    const ageMs = Date.now() - observed;
    if (ageMs < -30000 || ageMs > 120000) {
      return send(res, 503, {
        connected: false,
        state: 'STALE_SNAPSHOT',
        observed_at: new Date(observed).toISOString(),
      });
    }

    const mode = data.mode.trim().toUpperCase();
    const engineState = data.state.trim().toUpperCase();
    const allowedModes = ['PAPER', 'TESTNET', 'MAINNET_DISABLED', 'LIVE'];
    const allowedStates = ['RUNNING', 'PAUSED', 'STOPPED', 'DEGRADED', 'IDLE'];
    if (!allowedModes.includes(mode) || !allowedStates.includes(engineState)) {
      return send(res, 502, { connected: false, state: 'INVALID_RESPONSE' });
    }
    return send(res, 200, {
      connected: true,
      state: 'API_REACHABLE',
      mode,
      engine_state: engineState,
      observed_at: new Date(observed).toISOString(),
      freshness_source: data.source,
    });
  } catch {
    return send(res, 502, { connected: false, state: 'UPSTREAM_UNAVAILABLE' });
  }
};
