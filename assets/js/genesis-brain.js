(() => {
  'use strict';

  const NODE_LAYOUT = [
    ['funding',       0.50, 0.15],
    ['supertrend_1h', 0.24, 0.28],
    ['supertrend_4h', 0.76, 0.28],
    ['adx',           0.14, 0.52],
    ['ema_ribbon',    0.86, 0.52],
    ['rsi',           0.24, 0.76],
    ['order_book',    0.76, 0.76],
    ['fear_greed',    0.50, 0.88]
  ];

  const state = {
    nodes: [],
    selected: null,
    dragging: null,
    pointerId: null,
    animationId: null,
    lastTime: 0,
    decision: 'WAIT',
    coin: '',
    score: 0,
    thoughts: [],
    reducedMotion: window.matchMedia?.(
      '(prefers-reduced-motion: reduce)'
    )?.matches || false
  };

  const label = value =>
    String(value || '')
      .replaceAll('_', ' ')
      .replace(/\b\w/g, char => char.toUpperCase());

  const safeNumber = (value, fallback = 0) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  const clamp = (value, min, max) =>
    Math.max(min, Math.min(max, value));

  function injectStyles() {
    if (document.getElementById('genesis-bubbles-style')) return;

    const style = document.createElement('style');
    style.id = 'genesis-bubbles-style';
    style.textContent = `
      #genesis-brain-svg {
        width: 100%;
        height: auto;
        min-height: 420px;
        display: block;
        touch-action: none;
        user-select: none;
        overflow: visible;
      }

      .genesis-link-live {
        stroke: rgba(124, 58, 237, .28);
        stroke-linecap: round;
        transition: stroke .25s ease;
      }

      .genesis-bubble {
        cursor: grab;
        filter: drop-shadow(0 0 10px rgba(124, 58, 237, .18));
      }

      .genesis-bubble:active {
        cursor: grabbing;
      }

      .genesis-bubble circle {
        transition: stroke .2s ease, filter .2s ease;
      }

      .genesis-bubble:hover circle,
      .genesis-bubble.selected circle {
        stroke-width: 4;
        filter: brightness(1.16);
      }

      .genesis-bubble text {
        pointer-events: none;
        text-anchor: middle;
        font-family: inherit;
      }

      .genesis-bubble-name {
        fill: #f4f1ff;
        font-size: 15px;
        font-weight: 750;
      }

      .genesis-bubble-weight {
        fill: rgba(238, 234, 255, .72);
        font-size: 12px;
        font-weight: 650;
      }

      .genesis-core-live {
        filter: drop-shadow(0 0 28px rgba(124, 58, 237, .72));
      }

      .genesis-core-ring {
        transform-box: fill-box;
        transform-origin: center;
        animation: genesis-core-spin 18s linear infinite;
      }

      .genesis-core-pulse {
        transform-box: fill-box;
        transform-origin: center;
        animation: genesis-core-pulse 2.8s ease-in-out infinite;
      }

      @keyframes genesis-core-spin {
        to { transform: rotate(360deg); }
      }

      @keyframes genesis-core-pulse {
        0%, 100% { transform: scale(1); opacity: .78; }
        50% { transform: scale(1.08); opacity: 1; }
      }

      .genesis-detail-panel {
        margin-top: 12px;
        padding: 14px 16px;
        border: 1px solid rgba(124, 58, 237, .34);
        border-radius: 14px;
        background:
          linear-gradient(145deg, rgba(18, 20, 40, .96), rgba(8, 10, 24, .98));
        box-shadow: 0 14px 40px rgba(0, 0, 0, .24);
      }

      .genesis-detail-title {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
        color: #f6f3ff;
        font-size: 14px;
        font-weight: 800;
      }

      .genesis-detail-value {
        font-size: 18px;
      }

      .genesis-detail-copy {
        margin-top: 6px;
        color: rgba(225, 222, 240, .68);
        font-size: 12px;
        line-height: 1.5;
      }

      @media (max-width: 640px) {
        #genesis-brain-svg {
          min-height: 360px;
        }

        .genesis-bubble-name {
          font-size: 13px;
        }

        .genesis-bubble-weight {
          font-size: 11px;
        }
      }

      @media (prefers-reduced-motion: reduce) {
        .genesis-core-ring,
        .genesis-core-pulse {
          animation: none !important;
        }
      }
    `;
    document.head.appendChild(style);
  }

  function colorForWeight(weight) {
    if (weight >= 1.08) {
      return {
        fill: 'rgba(18, 138, 88, .82)',
        stroke: '#4ade80',
        glow: 'rgba(74, 222, 128, .42)',
        sentiment: 'Supporting'
      };
    }

    if (weight < 0.86) {
      return {
        fill: 'rgba(150, 44, 71, .78)',
        stroke: '#fb7185',
        glow: 'rgba(251, 113, 133, .38)',
        sentiment: 'Opposing'
      };
    }

    return {
      fill: 'rgba(151, 102, 18, .78)',
      stroke: '#f59e0b',
      glow: 'rgba(245, 158, 11, .36)',
      sentiment: 'Caution'
    };
  }

  function radiusForWeight(weight) {
    const influence = Math.abs(weight - 1);
    return clamp(39 + influence * 62, 38, 68);
  }

  function buildNodes(weights) {
    const weightMap = Object.fromEntries(
      (weights || []).map(row => [
        String(row.name || ''),
        safeNumber(row.weight, 1)
      ])
    );

    state.nodes = NODE_LAYOUT.map(([name, px, py], index) => {
      const existing = state.nodes.find(node => node.name === name);
      const weight = weightMap[name] ?? 1;

      return {
        name,
        weight,
        px,
        py,
        x: existing?.x ?? px * 1000,
        y: existing?.y ?? py * 620,
        vx: existing?.vx ?? (index % 2 ? 0.035 : -0.035),
        vy: existing?.vy ?? (index % 3 ? 0.028 : -0.028),
        phase: existing?.phase ?? Math.random() * Math.PI * 2,
        radius: radiusForWeight(weight)
      };
    });
  }

  function ensureDetailPanel(svg) {
    let panel = document.getElementById('genesisBubbleDetail');

    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'genesisBubbleDetail';
      panel.className = 'genesis-detail-panel';
      panel.innerHTML = `
        <div class="genesis-detail-title">
          <span id="genesisDetailName">Genesis Intelligence</span>
          <span class="genesis-detail-value" id="genesisDetailValue">LIVE</span>
        </div>
        <div class="genesis-detail-copy" id="genesisDetailCopy">
          Tap or drag an evidence bubble to inspect how it influences the current decision.
        </div>
      `;

      svg.insertAdjacentElement('afterend', panel);
    }

    return panel;
  }

  function updateDetail(node) {
    const name = document.getElementById('genesisDetailName');
    const value = document.getElementById('genesisDetailValue');
    const copy = document.getElementById('genesisDetailCopy');

    if (!name || !value || !copy) return;

    if (!node) {
      name.textContent = 'Genesis Intelligence';
      value.textContent = `${Math.round(state.score)}%`;
      copy.textContent =
        `${state.decision}${state.coin ? ` ${state.coin}` : ''}. ` +
        'Tap or drag an evidence bubble to inspect its influence.';
      return;
    }

    const palette = colorForWeight(node.weight);
    const effect = Math.round((node.weight - 1) * 100);

    name.textContent = label(node.name);
    value.textContent = node.weight.toFixed(3);
    value.style.color = palette.stroke;

    copy.textContent =
      `${palette.sentiment} evidence. ` +
      `Relative influence: ${effect >= 0 ? '+' : ''}${effect}%. ` +
      `Current Genesis confidence: ${Math.round(state.score)}%.`;
  }

  function draw(weights, health, thoughts) {
    injectStyles();

    const svg = document.getElementById('genesis-brain-svg');
    if (!svg) return;

    svg.setAttribute('viewBox', '0 0 1000 620');
    svg.setAttribute('role', 'img');
    svg.setAttribute(
      'aria-label',
      'Interactive Genesis neural evidence network'
    );

    buildNodes(weights);
    ensureDetailPanel(svg);

    const engine = health?.engine || health || {};
    const trade =
      engine?.active_trade ||
      engine?.trade ||
      health?.active_trade ||
      null;

    const lastDecision =
      engine?.last_decision ||
      health?.last_decision ||
      thoughts?.last_decision ||
      null;

    const rawScore =
      trade?.confidence ??
      trade?.score ??
      lastDecision?.confidence ??
      lastDecision?.score ??
      engine?.score ??
      engine?.score_min ??
      0;

    state.score = clamp(safeNumber(rawScore), 0, 100);
    state.decision = String(
      trade?.action ??
      lastDecision?.action ??
      (trade ? 'ACTIVE' : 'WAIT')
    ).toUpperCase();

    state.coin = String(
      trade?.coin ??
      lastDecision?.coin ??
      ''
    ).toUpperCase();

    state.thoughts = Array.isArray(thoughts) ? thoughts : [];

    const decisionColor =
      state.decision === 'BUY' ? '#4ade80' :
      state.decision === 'SELL' ? '#f87171' :
      '#c4b5fd';

    svg.innerHTML = `
      <defs>
        <radialGradient id="genesisCoreGradient" cx="40%" cy="35%">
          <stop offset="0%" stop-color="#a78bfa" stop-opacity=".96"/>
          <stop offset="58%" stop-color="#6d28d9" stop-opacity=".86"/>
          <stop offset="100%" stop-color="#27104f" stop-opacity=".98"/>
        </radialGradient>

        <filter id="genesisGlow" x="-80%" y="-80%" width="260%" height="260%">
          <feGaussianBlur stdDeviation="10" result="blur"/>
          <feMerge>
            <feMergeNode in="blur"/>
            <feMergeNode in="SourceGraphic"/>
          </feMerge>
        </filter>
      </defs>

      <g id="genesisLinks"></g>
      <g id="genesisBubbles"></g>

      <g class="genesis-core-live" transform="translate(500 310)">
        <circle
          class="genesis-core-pulse"
          r="95"
          fill="rgba(124,58,237,.14)"
          stroke="rgba(167,139,250,.35)"
          stroke-width="2"
        ></circle>

        <circle
          class="genesis-core-ring"
          r="78"
          fill="none"
          stroke="rgba(196,181,253,.66)"
          stroke-width="3"
          stroke-dasharray="14 10"
        ></circle>

        <circle
          r="67"
          fill="url(#genesisCoreGradient)"
          stroke="#a78bfa"
          stroke-width="3"
          filter="url(#genesisGlow)"
        ></circle>

        <text
          y="-28"
          text-anchor="middle"
          fill="#f5f3ff"
          font-size="17"
          font-weight="850"
          letter-spacing="2"
        >GENESIS</text>

        <text
          y="1"
          text-anchor="middle"
          fill="${decisionColor}"
          font-size="18"
          font-weight="900"
        >${state.decision}${state.coin ? ` ${state.coin}` : ''}</text>

        <text
          y="34"
          text-anchor="middle"
          fill="#ffffff"
          font-size="28"
          font-weight="900"
        >${Math.round(state.score)}%</text>

        <text
          y="53"
          text-anchor="middle"
          fill="rgba(238,234,255,.65)"
          font-size="10"
          font-weight="700"
          letter-spacing="1.5"
        >CONFIDENCE</text>
      </g>
    `;

    renderFrame(svg, 0);
    bindInteractions(svg);
    updateDetail(state.selected);
    updateSummary(engine);
    startAnimation(svg);
  }

  function renderFrame(svg, time) {
    const linksGroup = svg.querySelector('#genesisLinks');
    const bubblesGroup = svg.querySelector('#genesisBubbles');
    if (!linksGroup || !bubblesGroup) return;

    linksGroup.innerHTML = state.nodes.map(node => {
      const width = clamp(1.3 + node.weight * 1.3, 1.5, 4);
      return `
        <line
          class="genesis-link-live"
          x1="500"
          y1="310"
          x2="${node.x.toFixed(2)}"
          y2="${node.y.toFixed(2)}"
          stroke-width="${width.toFixed(2)}"
        ></line>
      `;
    }).join('');

    bubblesGroup.innerHTML = state.nodes.map(node => {
      const palette = colorForWeight(node.weight);
      const selected = state.selected?.name === node.name;
      const pulse = selected ? 1.07 : 1;
      const radius = node.radius * pulse;

      return `
        <g
          class="genesis-bubble${selected ? ' selected' : ''}"
          data-node="${node.name}"
          transform="translate(${node.x.toFixed(2)} ${node.y.toFixed(2)})"
          tabindex="0"
          role="button"
          aria-label="${label(node.name)}, weight ${node.weight.toFixed(3)}"
        >
          <circle
            r="${radius.toFixed(2)}"
            fill="${palette.fill}"
            stroke="${palette.stroke}"
            stroke-width="${selected ? 4 : 2.4}"
            style="filter: drop-shadow(0 0 12px ${palette.glow})"
          ></circle>

          <text class="genesis-bubble-name" y="-4">
            ${label(node.name)}
          </text>

          <text class="genesis-bubble-weight" y="17">
            ${node.weight.toFixed(3)}
          </text>
        </g>
      `;
    }).join('');
  }

  function startAnimation(svg) {
    if (state.animationId) {
      cancelAnimationFrame(state.animationId);
    }

    state.lastTime = performance.now();

    const animate = now => {
      const delta = Math.min(32, now - state.lastTime);
      state.lastTime = now;

      if (!state.reducedMotion) {
        updatePhysics(delta, now);
      }

      renderFrame(svg, now);
      state.animationId = requestAnimationFrame(animate);
    };

    state.animationId = requestAnimationFrame(animate);
  }

  function updatePhysics(delta, now) {
    const centerX = 500;
    const centerY = 310;

    for (const node of state.nodes) {
      if (state.dragging?.name === node.name) continue;

      const targetX = node.px * 1000;
      const targetY = node.py * 620;

      node.vx += (targetX - node.x) * 0.000006 * delta;
      node.vy += (targetY - node.y) * 0.000006 * delta;

      node.vx += Math.sin(now * 0.00045 + node.phase) * 0.0008 * delta;
      node.vy += Math.cos(now * 0.00038 + node.phase) * 0.0008 * delta;

      const dxCore = node.x - centerX;
      const dyCore = node.y - centerY;
      const coreDistance = Math.hypot(dxCore, dyCore) || 1;
      const minimumCoreDistance = node.radius + 112;

      if (coreDistance < minimumCoreDistance) {
        const force = (minimumCoreDistance - coreDistance) * 0.0008;
        node.vx += (dxCore / coreDistance) * force * delta;
        node.vy += (dyCore / coreDistance) * force * delta;
      }

      node.vx *= 0.985;
      node.vy *= 0.985;

      node.x += node.vx * delta;
      node.y += node.vy * delta;

      node.x = clamp(node.x, node.radius + 10, 1000 - node.radius - 10);
      node.y = clamp(node.y, node.radius + 10, 620 - node.radius - 10);
    }

    for (let i = 0; i < state.nodes.length; i++) {
      for (let j = i + 1; j < state.nodes.length; j++) {
        const a = state.nodes[i];
        const b = state.nodes[j];

        if (
          state.dragging?.name === a.name ||
          state.dragging?.name === b.name
        ) continue;

        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const distance = Math.hypot(dx, dy) || 1;
        const minimum = a.radius + b.radius + 12;

        if (distance < minimum) {
          const overlap = minimum - distance;
          const nx = dx / distance;
          const ny = dy / distance;

          a.x -= nx * overlap * 0.5;
          a.y -= ny * overlap * 0.5;
          b.x += nx * overlap * 0.5;
          b.y += ny * overlap * 0.5;
        }
      }
    }
  }

  function svgPoint(svg, event) {
    const point = svg.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;

    const matrix = svg.getScreenCTM();
    return matrix ? point.matrixTransform(matrix.inverse()) : point;
  }

  function bindInteractions(svg) {
    svg.onpointerdown = event => {
      const group = event.target.closest?.('[data-node]');
      if (!group) return;

      const node = state.nodes.find(
        item => item.name === group.dataset.node
      );

      if (!node) return;

      state.selected = node;
      state.dragging = node;
      state.pointerId = event.pointerId;

      svg.setPointerCapture?.(event.pointerId);
      updateDetail(node);
      renderFrame(svg, performance.now());
      event.preventDefault();
    };

    svg.onpointermove = event => {
      if (
        !state.dragging ||
        state.pointerId !== event.pointerId
      ) return;

      const point = svgPoint(svg, event);
      state.dragging.x = clamp(
        point.x,
        state.dragging.radius,
        1000 - state.dragging.radius
      );
      state.dragging.y = clamp(
        point.y,
        state.dragging.radius,
        620 - state.dragging.radius
      );
      state.dragging.vx = 0;
      state.dragging.vy = 0;
      event.preventDefault();
    };

    const release = event => {
      if (state.pointerId !== event.pointerId) return;

      svg.releasePointerCapture?.(event.pointerId);
      state.dragging = null;
      state.pointerId = null;
    };

    svg.onpointerup = release;
    svg.onpointercancel = release;

    svg.onclick = event => {
      const group = event.target.closest?.('[data-node]');

      if (!group) {
        state.selected = null;
        updateDetail(null);
        return;
      }

      const node = state.nodes.find(
        item => item.name === group.dataset.node
      );

      if (node) {
        state.selected = node;
        updateDetail(node);
      }
    };

    svg.onkeydown = event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;

      const group = event.target.closest?.('[data-node]');
      if (!group) return;

      const node = state.nodes.find(
        item => item.name === group.dataset.node
      );

      if (node) {
        state.selected = node;
        updateDetail(node);
        event.preventDefault();
      }
    };
  }

  function updateSummary(engine) {
    const set = (id, value) => {
      const element = document.getElementById(id);
      if (element) element.textContent = value;
    };

    set(
      'genesis-brain-regime',
      String(engine?.regime || '--').toUpperCase()
    );

    set(
      'genesis-brain-mode',
      String(engine?.mode || 'PAPER').toUpperCase()
    );

    set(
      'genesis-brain-health',
      engine?.health_percent != null
        ? `${Math.round(safeNumber(engine.health_percent))}%`
        : '100%'
    );

    set(
      'genesis-brain-mission',
      `${state.decision}${state.coin ? ` ${state.coin}` : ''}`
    );
  }

  async function refreshGenesisBrain() {
    try {
      const stamp = Date.now();

      const [
        weightsResponse,
        healthResponse,
        thoughtsResponse
      ] = await Promise.all([
        fetch(`/api/genesis-weights?cache=${stamp}`, {
          cache: 'no-store'
        }),
        fetch(`/api/health?cache=${stamp}`, {
          cache: 'no-store'
        }),
        fetch(`/api/genesis-thoughts?cache=${stamp}`, {
          cache: 'no-store'
        })
      ]);

      if (
        !weightsResponse.ok ||
        !healthResponse.ok ||
        !thoughtsResponse.ok
      ) {
        throw new Error('Genesis API unavailable');
      }

      const [weights, health, thoughts] = await Promise.all([
        weightsResponse.json(),
        healthResponse.json(),
        thoughtsResponse.json()
      ]);

      draw(
        weights?.weights || [],
        health || {},
        thoughts?.thoughts || thoughts || []
      );

      const badge = document.getElementById('genesis-brain-status');
      if (badge) {
        badge.textContent = 'NEURAL CORE LIVE';
        badge.style.color = '#4ade80';
      }
    } catch (error) {
      console.error('Genesis brain refresh failed:', error);

      const badge = document.getElementById('genesis-brain-status');
      if (badge) {
        badge.textContent = 'CONNECTION DEGRADED';
        badge.style.color = '#f87171';
      }
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    refreshGenesisBrain();
    window.setInterval(refreshGenesisBrain, 15000);
  });

  window.addEventListener('beforeunload', () => {
    if (state.animationId) {
      cancelAnimationFrame(state.animationId);
    }
  });
})();
