(() => {
  'use strict';
  const tabs = [
    ['Home','/'],['Dashboard','/dashboard.html'],['Results','/results.html'],
    ['Research','/research.html'],['Flow Map','/smart-money-flow.html'],['Smart Money Positions','/smart-money.html'],['Live Signals','/smart-money-signals.html'],
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
    inner.className = 'empire-global-na¶»§q«^