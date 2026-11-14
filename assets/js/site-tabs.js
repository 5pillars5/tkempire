(() => {
  'use strict';
  // One navigation system for all public TK Empire pages.
  // Detailed destinations remain accessible, but no longer compete in the top row.
  const tabs = [
    ['Home','/','primary'],
    ['Overview','/app.html','primary'],
    ['Genesis Signals','/genesis-signals.html','primary'],
    ['Market Pulse','/genesis-market-pulse.html','genesis'],
    ['Live Signals','/smart-money-signals.html','primary'],
    ['Results','/results.html','primary'],
    ['Dashboard','/dashboard.html','genesis'],
    ['TESTNET P&L','/testnet.html','genesis'],
    ['Portfolio','/portfolio.html','genesis'],
    ['Smart Money Positions','/smart-money.html','smart'],
    ['Flow Map','/smart-money-flow.html','smart'],
    ['Market Outcomes','/smart-money-market.html','smart'],
    ['Research','/research.html','learn'],
    ['Learn','/learn.html','learn'],
    ['Recovery','/recovery.html','learn'],
    ['About','/about.html','learn'],
    ['Community','/community.html','connect'],
    ['Private Beta','/join.html','connect']
  ];
  const groups = [
    ['Start here','primary'],
    ['Genesis & tools','genesis'],
    ['Smart Money','smart'],
    ['Research & learning','learn'],
    ['Community & access','connect']
  ];
  const file = p => (p || '').split('/').filter(Boolean).pop() || 'index.html';

  function build() {
    const current = file(location.pathname);
    let nav = document.querySelector('body > nav.empire-global-nav, body > nav');
    if (!nav) { nav = document.createElement('nav'); document.body.prepend(nav); }
    nav.className = 'empire-global-nav';
    nav.setAttribute('aria-label','Main navigation');
    // Never replace an in-page navigation such as the Smart Money Flow Map links.
    // Command-center scripts update these existing status nodes by ID.
    const statusNodes = [...nav.querySelectorAll('#genesis-nav-status, #modePill, #lastUpdated')];
    nav.replaceChildren();
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
    toggle.textContent = 'Explore menu';
    toggle.setAttribute('aria-expanded','false');
    toggle.setAttribute('aria-controls','empire-nav-links');
    toggle.setAttribute('aria-label','Explore menu: all TK Empire pages');

    const links = document.createElement('div');
    links.id = 'empire-nav-links';
    links.className = 'empire-global-nav__links';
    groups.forEach(([heading,kind]) => {
      const group = document.createElement('div');
      group.className = 'empire-global-nav__group' + (kind === 'primary' ? ' is-primary' : '');
      const title = document.createElement('div');
      title.className = 'empire-global-nav__group-title';
      title.textContent = heading;
      group.appendChild(title);
      tabs.filter(tab => tab[2] === kind).forEach(([label,href]) => {
        const link = document.createElement('a');
        link.href = href;
        link.textContent = label;
        const target = href === '/' ? 'index.html' : file(href);
        link.className = 'empire-global-nav__link' + (target === current ? ' is-active' : '');
        if (target === current) link.setAttribute('aria-current','page');
        group.appendChild(link);
      });
      links.appendChild(group);
    });
    const closeMenu = () => {
      toggle.setAttribute('aria-expanded','false');
      links.classList.remove('is-open');
    };
    toggle.addEventListener('click', () => {
      const expanded = toggle.getAttribute('aria-expanded') === 'true';
      if (expanded) closeMenu();
      else {
        toggle.setAttribute('aria-expanded','true');
        links.classList.add('is-open');
      }
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
    links.addEventListener('click', event => {
      if (event.target.closest('a')) closeMenu();
    });

    // A single PAPER-signal shortcut remains visible on mobile.
    const genesisShortcut = document.createElement('a');
    genesisShortcut.className = 'empire-global-nav__shortcut';
    genesisShortcut.href = '/genesis-signals.html';
    genesisShortcut.textContent = 'Genesis Signals';
    genesisShortcut.setAttribute('aria-label','Open Genesis Signals — paper positions');
    if (current === 'genesis-signals.html') genesisShortcut.setAttribute('aria-current','page');
    inner.append(brand,genesisShortcut,toggle,links);
    nav.appendChild(inner);
    if (statusNodes.length) {
      const status = document.createElement('div');
      status.className = 'empire-global-nav__status';
      status.setAttribute('aria-label','Genesis live status');
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