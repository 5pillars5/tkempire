(() => {
  'use strict';

  const NODES = [
    ['funding', 50, 12],
    ['supertrend_1h', 25, 25],
    ['supertrend_4h', 75, 25],
    ['adx', 13, 50],
    ['ema_ribbon', 87, 50],
    ['rsi', 25, 75],
    ['order_book', 75, 75],
    ['fear_greed', 50, 88]
  ];

  const label = name =>
    String(name).replaceAll('_',' ').replace(/\b\w/g,c=>c.toUpperCase());

  const escapeHtml = value => String(value ?? '')
    .replaceAll('&','&amp;')
    .replaceAll('<','&lt;')
    .replaceAll('>','&gt;')
    .replaceAll('"','&quot;')
    .replaceAll("'",'&#039;');

  function nodeClass(weight) {
    if (weight >= 1.1) return 'genesis-node--strong';
    if (weight < .85) return 'genesis-node--weak';
    return 'genesis-node--neutral';
  }

  function draw(weights, health, thoughts) {
    const svg = document.getElementById('genesis-brain-svg');
    if (!svg) return;

    const map = Object.fromEntries(
      (weights || []).map(row => [row.name, Number(row.weight || 0)])
    );

    const lines = NODES.map(([,x,y]) => {
      const weight = map[NODES.find(n => n[1] === x && n[2] === y)?.[0]] || 1;
      return `<line class="genesis-link" x1="50%" y1="50%" x2="${x}%" y2="${y}%"
        style="stroke-width:${Math.max(1.5,weight*2.2)}" />`;
    }).join('');

    const nodes = NODES.map(([name,x,y]) => {
      const weight = map[name] ?? 1;
      const radius = Math.max(25,Math.min(36,26 + weight*5));
      return `
        <g class="genesis-node ${nodeClass(weight)}" transform="translate(${x * 10},${y * 6})">
          <circle r="${radius}"></circle>
          <text y="-2">${escapeHtml(label(name))}</text>
          <text class="node-weight" y="14">${weight.toFixed(3)}</text>
        </g>`;
    }).join('');

    const trade = health?.open_trades?.trades?.[0];
    const engine = health?.engine || {};
    const lastDecision = [...(thoughts || [])].reverse()
      .find(t => ['fired','decision','rejected','mission'].includes(t.type));

    const score = Number(trade?.score ?? lastDecision?.score ?? engine.score_min ?? 0);
    const decision = String(trade?.action ?? (trade ? 'ACTIVE' : 'WAIT')).toUpperCase();
    const coin = trade?.coin ?? lastDecision?.coin ?? '';

    const decisionColor =
      decision === 'BUY' ? '#4ade80' :
      decision === 'SELL' ? '#f87171' : '#f59e0b';

    svg.innerHTML = `
      <g>${lines}</g>
      <g>${nodes}</g>
      <g class="genesis-core" transform="translate(500,300)">
        <circle r="74"></circle>
        <text class="core-title" y="-30">GENESIS</text>
        <text class="core-decision" y="-7" fill="${decisionColor}">
          ${escapeHtml(decision)} ${escapeHtml(coin)}
        </text>
        <text class="core-score" y="25">${Math.round(score)}%</text>
        <text class="node-weight" y="44">CONFIDENCE</text>
      </g>`;

    const set = (id,value) => {
      const el = document.getElementById(id);
      if (el) el.textContent = value;
    };

    set('genesis-brain-regime', String(engine.regime || '--').toUpperCase());
    set('genesis-brain-mode', String(engine.mode || '--').toUpperCase());
    set('genesis-brain-health', `${Math.round(Number(health?.health_score || 0))}%`);
    set('genesis-brain-mission', trade ? `${trade.coin} ${trade.action}` : 'SCANNING');

    const badge = document.getElementById('genesis-brain-status');
    if (badge) {
      badge.textContent = health?.checks?.engine ? 'NEURAL CORE LIVE' : 'CORE OFFLINE';
      badge.style.color = health?.checks?.engine ? '#4ade80' : '#f87171';
    }
  }

  async function refreshGenesisBrain() {
    try {
      const stamp = Date.now();
      const [weightsResponse,healthResponse,thoughtsResponse] = await Promise.all([
        fetch(`/api/genesis-weights?cache=${stamp}`),
        fetch(`/api/health?cache=${stamp}`),
        fetch(`/api/genesis-thoughts?cache=${stamp}`)
      ]);

      if (!weightsResponse.ok || !healthResponse.ok || !thoughtsResponse.ok) {
        throw new Error('Genesis API unavailable');
      }

      const [weights,health,thoughts] = await Promise.all([
        weightsResponse.json(),
        healthResponse.json(),
        thoughtsResponse.json()
      ]);

      draw(weights.weights || [],health,thoughts.thoughts || []);
    } catch (error) {
      const badge = document.getElementById('genesis-brain-status');
      if (badge) {
        badge.textContent = 'CONNECTION DEGRADED';
        badge.style.color = '#f87171';
      }
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    refreshGenesisBrain();
    setInterval(refreshGenesisBrain,15000);
  });
})();
