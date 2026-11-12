(()=>{'use strict';
  // A light page guide; intentionally no API calls, private state, or trading actions.
  const views={
   index:['Home','overview',[['Command overview','/app.html'],['Genesis Signals','/genesis-signals.html'],['Smart Money','/smart-money-signals.html']]],
   dashboard:['Command Center','paper',[['Paper signals','/genesis-signals.html'],['Results','/results.html'],['Research','/research.html']]],
   results:['Paper Results','paper',[['Genesis Signals','/genesis-signals.html'],['Trade history','/genesis-signals.html#history'],['Overview','/app.html']]],
   research:['Research','research',[['Smart Money','/smart-money-signals.html'],['Flow Map','/smart-money-flow.html'],['Learn','/learn.html']]],
   'genesis-signals':['Genesis Signals','paper',[['Paper Results','/results.html'],['Testnet Portfolio','/testnet.html'],['Smart Money','/smart-money-signals.html']]],
   'smart-money':['Wallet Positions','research',[['Wallet signals','/smart-money-signals.html'],['Flow Map','/smart-money-flow.html'],['Market outcomes','/smart-money-market.html']]],
   'smart-money-signals':['Wallet Signals','research',[['Wallet Positions','/smart-money.html'],['Flow Map','/smart-money-flow.html'],['Market outcomes','/smart-money-market.html']]],
   'smart-money-flow':['Flow Map','research',[['Wallet signals','/smart-money-signals.html'],['Wallet Positions','/smart-money.html'],['Market outcomes','/smart-money-market.html']]],
   'smart-money-market':['Market Outcomes','research',[['Wallet signals','/smart-money-signals.html'],['Wallet Positions','/smart-money.html']]],
   testnet:['Testnet Portfolio','testnet',[['Paper signals','/genesis-signals.html'],['Paper results','/results.html']]],
   portfolio:['Portfolio Lab','paper',[['Paper signals','/genesis-signals.html'],['Results','/results.html']]],
   learn:['Learning Center','research',[['Research','/research.html'],['Overview','/app.html']]],
   recovery:['Recovery Lab','research',[['Learn','/learn.html'],['Results','/results.html']]],
   about:['About TK Empire','research',[['Overview','/app.html'],['Community','/community.html']]],
   community:['Community','research',[['Learn','/learn.html'],['Private Beta','/join.html']]],
   join:['Private Beta','research',[['Overview','/app.html'],['About','/about.html']]]
  };
  function build(){
    const file=(location.pathname.split('/').pop()||'index.html').replace(/\.html$/,'').replace(/^index$/,'index');
    if(file==='app'||!views[file])return;
    const [title,mode,related]=views[file];
    document.body.classList.add('empire-modern');
    document.body.dataset.empirePage=file;
    const shell=document.createElement('div');shell.className='empire-section-rail';shell.setAttribute('aria-label','Page context');
    const context=document.createElement('div');context.className='empire-rail-context';
    const home=document.createElement('a');home.href='/app.html';home.textContent='Command overview';
    const sep=document.createElement('span');sep.className='empire-rail-divider';sep.textContent='/';
    const current=document.createElement('strong');current.className='empire-rail-title';current.textContent=title;
    const chip=document.createElement('span');chip.className='empire-rail-mode';chip.dataset.type=mode;
    chip.textContent=mode==='paper'?'PAPER · NO LIVE ORDERS':mode==='testnet'?'HYPERLIQUID TESTNET':mode==='research'?'PUBLIC RESEARCH':'TK EMPIRE';
    context.append(home,sep,current,chip);
    const near=document.createElement('div');near.className='empire-rail-near';
    related.forEach(([label,href])=>{const a=document.createElement('a');a.href=href;a.textContent=label;near.appendChild(a)});
    shell.append(context,near);
    const target=document.querySelector('body > main,body > header,body > section,body > .layout');
    const nav=document.querySelector('body > nav.empire-global-nav');
    if(target)target.before(shell);
    else if(nav)nav.after(shell);
    else document.body.prepend(shell);
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',build,{once:true});
  else build();
})();