(() => {
  'use strict';
  const targets = ['genesis-connection-badge', 'genesis-nav-status'];
  function show(label, connected, detail) {
    for (const id of targets) {
      const el = document.getElementById(id);
      if (!el) continue;
      el.textContent = label;
      el.title = detail;
      el.style.color = connected ? '#4ade80' : '#f5c542';
      el.style.borderColor = connected ? '#166534' : '#854d0e';
      el.setAttribute('data-connection-state', connected ? 'connected' : 'disconnected');
    }
  }
  async function refresh() {
    try {
      const response = await fetch('/api/genesis/connection', { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok || data.connected !== true) {
        show('GENESIS: NOT VERIFIED', false, 'Read-only connection: ' + (data.state || 'UNAVAILABLE'));
        return;
      }
      const mode = String(data.mode || 'UNKNOWN');
      show('GENESIS: CONNECTED (' + mode + ')', true,
        'Engine ' + data.engine_state + '. Verified: ' + data.observed_at + '. No execution controls.');
    } catch {
      show('GENESIS: NOT VERIFIED', false, 'Read-only connection could not be reached.');
    }
  }
  document.addEventListener('DOMContentLoaded', () => {
    refresh();
    setInterval(refresh, 30000);
  });
})();