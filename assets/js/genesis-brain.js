(() => {
  'use strict';

  // Only source-bound, public PAPER aggregates are displayed. Private weights,
  // decisions, scores, entries and accounts are intentionally not requested.
  const $ = id => document.getElementById(id);
  const text = (id, value) => {
    const node = $(id);
    if (node) node.textContent = String(value);
  };
  const fresh = timestamp => {
    const time = Date.parse(timestamp || '');
    const age = Date.now() - time;
    return Number.isFinite(time) && age >= -30000 && age <= 120000;
  };
  const num = value => typeof value === 'number' && Number.isFinite(value) ? value : null;

  function stage(name, value, detail, state) {
    const element = $('genesis-stage-' + name);
    if (!element) return;
    element.dataset.state = state;
    text('genesis-stage-' + name + '-value', value);
    text('genesis-stage-' + name + '-detail', detail);
  }

  function status(label, state) {
    const badge = $('genesis-brain-status');
    if (badge) {
      badge.textContent = label;
      badge.dataset.state = state;
    }
  }

  function relativeTime(stamp) {
    if (!fresh(stamp)) return 'Unverified';
    return new Date(stamp).toLocaleTimeString([], {hour:'numeric', minute:'2-digit'});
  }

  function renderHealth(health) {
    if (!health || !fresh(health.served_at) || health.engine?.mode !== 'paper') {
      throw new Error('stale_or_unsupported_health');
    }
    const engine = health.engine || {};
    const checks = health.checks || {};
    const count = health.open_trades?.count;
    const openCount = Number.isSafeInteger(count) && count >= 0 ? count : null;
    const score = num(health.health_score);
    const running = engine.running === true && checks.engine === true;

    stage('feeds', checks.runtime_fresh === true ? 'FRESH' : 'UNVERIFIED',
      'Runtime source check', checks.runtime_fresh === true ? 'ok' : 'warn');
    stage('engine', running ? 'RUNNING' : 'NOT VERIFIED',
      'Evaluation details private', running ? 'ok' : 'warn');
    stage('gate', 'PAPER ONLY', 'No real-money authority', 'safe');
    stage('positions', openCount === null ? 'WITHHELD' : String(openCount) + ' OPEN',
      'Individual positions private', openCount === null ? 'warn' : 'ok');

    text('genesis-brain-regime', String(engine.regime || 'UNKNOWN').toUpperCase());
    text('genesis-brain-mode', 'PAPER');
    text('genesis-brain-health', score === null ? '—' : Math.round(score) + '/100');
    text('genesis-brain-open', openCount === null ? '—' : openCount);
    text('genesis-core-source-time', 'Health ' + relativeTime(health.served_at));
    status(running ? 'PAPER · CONNECTED' : 'PAPER · LIMITED', running ? 'ok' : 'warn');
  }

  function renderPerformance(performance) {
    if (!performance || !fresh(performance.updated_at) ||
        performance.engine?.mode !== 'paper') {
      text('genesis-brain-winrate', '—');
      text('genesis-core-performance-time', 'Aggregate unavailable');
      return;
    }
    const p = performance.performance || {};
    const winRate = num(p.win_rate);
    const trades = p.trades;
    text('genesis-brain-winrate', winRate === null || winRate < 0 || winRate > 100
      ? '—' : winRate.toFixed(2) + '%');
    text('genesis-core-performance-time', 'Results ' + relativeTime(performance.updated_at) +
      (Number.isSafeInteger(trades) ? ' · ' + trades + ' completed' : ''));
  }

  async function getJSON(url) {
    const response = await fetch(url + '?refresh=' + Date.now(), {cache:'no-store'});
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return response.json();
  }

  async function refresh() {
    try {
      const health = await getJSON('/api/health');
      renderHealth(health);
      try {
        renderPerformance(await getJSON('/api/genesis/status'));
      } catch {
        renderPerformance(null);
        status('PAPER · PARTIAL DATA', 'warn');
      }
    } catch {
      status('STATUS UNAVAILABLE', 'warn');
      for (const key of ['feeds','engine','gate','positions']) {
        stage(key, 'UNVERIFIED', 'Live snapshot unavailable', 'warn');
      }
      for (const id of ['genesis-brain-regime','genesis-brain-mode',
        'genesis-brain-health','genesis-brain-open','genesis-brain-winrate']) text(id, '—');
      text('genesis-core-source-time', 'No fresh health timestamp');
      text('genesis-core-performance-time', 'Not verified');
    }
  }

  const start = () => {
    refresh();
    setInterval(refresh, 15000);
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, {once:true});
  } else start();
})();