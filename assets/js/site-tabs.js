(() => {
  'use strict';
  const tabs = [
    ['Home','/'],['Dashboard','/dashboard.html'],['Results','/results.html'],
    ['Research','/research.html'],['Market Outcomes','/smart-money-market.html'],['Flow Map','/smart-money-flow.html'],['Smart Money Positions','/smart-money.html'],['Live Signals','/smart-money-signals.html'],
    ['Learn','/learn.html'],['Portfolio','/portfolio.html'],['TESTNET P&L','/testnet.html'],
    ['Recovery','/recovery.html'],['About','/about.html'],
    ['Community','/community.html'],['App','/app.html'],
    ['Private Beta','/join.html','cta']
  ];
  const file = p => (p || '').split('/').filter(Boolean).pop() || 'index.html';
  function build() {
    const current = file(location.pathname);
    let nav = document.querySelector('nav');
    if (!nav) { nav = document.createElement('nav'); document.body.prepend(nav); }
    nav.className = 'empire-global-nav';
    nav.setAttribute('aria-label','Main navigation');
    // Preserve live command-center status nodes before replacing its legacy nav.
    // Other dashboard scripts update these same DOM nodes by ID.
    const statusNodes = [...nav.querySelectorAll('#genesis-nav-status, #modePill, #lastUpdated')];
    nav.replaceChildren();
    // Keep the skip link first, but make navigation the first visible site landmark.
    const skipLink = document.body.querySelector(':scope > .skip');
    if (skipLink) skipLink.after(nav);
    else document.body.prepend(nav);

    const inner = document.createElement('div');
    inner.className = 'empire-global-nav__inner';
    const brand = document.createElement('a');
    brand.className = 'empire-global-nav__brand';
    brand.href = '/';
    brand.innerHTML = '<img src="https://i.imgur.com/Kf99eJt.jpeg" alt="TK Empire crest"><span>TK EMPIRE<small>BUILT FOR LEGACY</small></span>';

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'empire-global-nav__toggle';
    toggle.textContent = '☰ Menu';
    toggle.setAttribute('aria-expanded','false');
    toggle.setAttribute('aria-controls','empire-nav-links');

    const links = document.createElement('div');
    links.id = 'empire-nav-links';
    links.className = 'empire-global-nav__links';
    tabs.forEach(([label,href,kind]) => {
      const link = document.createElement('a');
      link.href = href;
      link.textContent = label;
      const target = href === '/' ? 'index.html' : file(href);
      link.className = 'empire-global-nav__link' +
        (kind === 'cta' ? ' empire-global-nav__cta' : '') +
        (target === current ? ' is-active' : '');
      if (target === current) link.setAttribute('aria-current','page');
      links.appendChild(link);
    });
    const closeMenu = () => {
      toggle.setAttribute('aria-expanded', 'false');
      links.classList.remove('is-open');
    };
    toggle.addEventListener('click', () => {
      const expanded = toggle.getAttribute('aria-expanded') === 'true';
      if (expanded) closeMenu();
      else { toggle.setAttribute('aria-expanded', 'true'); links.classList.add('is-open'); }
    });
    document.addEventListener('click', event => {
      if (!nav.contains(event.target)) closeMenu();
    });
    nav.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        const wasOpen = toggle.getAttribute('aria-expanded') === 'true';
        closeMenu();
        if (wasOpen) toggle.focus();
      }
    });
    inner.append(brand,toggle,links);
    nav.appendChild(inner);
    if (statusNodes.length) {
      const status = document.createElement('div');
      status.className = 'empire-global-nav__status';
      status.setAttribute('aria-label', 'Genesis live status');
      statusNodes.forEach(node => status.appendChild(node));
      nav.appendChild(status);
    }
    document.querySelectorAll('#empire-site-tabs').forEach(x => x.remove());
    if (!document.querySelector('script[src*="/assets/js/genesis-live.js"]')) {
      const live = document.createElement('script');
      live.src = '/assets/js/genesis-live.js?v=1';
      live.defer = true;
      document.head.appendChild(live);
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded',build,{once:true});
  } else build();
})();