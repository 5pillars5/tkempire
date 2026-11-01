'use strict';

const { isIP } = require('node:net');

function send(res, code, data) {
  return res.status(code).json({
    schema_version: 1,
    checked_at: new Date().toISOString(),
    ...data,
  });
}

function isSecureEndpoint(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' &&
      url.hostname.includes('.') &&
      !isIP(url.hostname) &&
      !url.port &&
      !url.username && !url.password &&
      !url.search && !url.hash &&
      !url.hostname.endsWith('.local');
  } catch {
    return false;
  }
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
  const token = process.env.GENESIS_STATUS_TOKEN;
  if (!endpoint || !token) {
    return send(res, 503, { connected: false, state: 'NOT_CONFIGURED' });
  }
  if (!isSecureEndpoint(endpoint)) {
    return send(res, 503, { connected: false, state: 'INVALID_CONFIGURATION' });
  }

  try {
    const upstream = await fetch(endpoint, {
      method: 'GET',
      redirect: 'error',
      cache: 'no-store',
      headers: { Accept: 'application/json', Authorization: 'Bearer ' + token },
      signal: AbortSignal.timeout(4000),
    });
    if (!upstream.ok) {
      return send(res, 502, { connected: false, state: 'UPSTREAM_UNAVAILABLE' });
    }
    const declaredLength = Number(upstream.headers.get('content-length'));
    if (declaredLength > 8192) throw new Error('Response too large');
    const raw = await upstream.text();
    if (raw.length > 8192) throw new Error('Response too large');
    const data = JSON.parse(raw);
    if (data?.schema_version !== 1 || data?.source !== 'genesis' ||
        !data.engine || typeof data.engine !== 'object' ||
        typeof data.engine.mode !== 'string' ||
        typeof data.engine.state !== 'string') {
      return send(res, 502, { connected: false, state: 'INVALID_RESPONSE' });
    }
    const observed = Date.parse(data.observed_at);
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
    const mode = data.engine.mode.toUpperCase();
    const engineState = data.engine.state.toUpperCase();
    const allowedModes = ['PAPER', 'TESTNET', 'MAINNET_DISABLED', 'LIVE'];
    const allowedStates = ['RUNNING', 'PAUSED', 'STOPPED', 'DEGRADED', 'IDLE'];
    if (!allowedModes.includes(mode) || !allowedStates.includes(engineState)) {
      return send(res, 502, { connected: false, state: 'INVALID_RESPONSE' });
    }
    return send(res, 200, {
      connected: true,
      state: 'CONNECTED',
      mode,
      engine_state: engineState,
      observed_at: new Date(observed).toISOString(),
    });
  } catch {
    return send(res, 502, { connected: false, state: 'UPSTREAM_UNAVAILABLE' });
  }
};
