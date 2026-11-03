(()=>{"use strict";
const tabs=[
  ["Home","/"],
  ["Dashboard","/dashboard.html"],
  ["Results","/results.html"],
  ["Research","/research.html"],
  ["Learn","/learn.html"],
  ["Portfolio","/portfolio.html"],
  ["Recovery","/recovery.html"],
  ["About","/about.html"],
  ["Community","/community.html"],
  ["App","/app.html"],
  ["Private Beta","/join.html","cta"]
];
const file=p=>{const n=(p||"").split("/").filter(Boolean).pop();return n||"index.html"};
function build(){
  const current=file(location.pathname);
  let nav=document.querySelector("nav");
  if(!nav){nav=document.createElement("nav");document.body.prepend(nav)}
  nav.className="empire-global-nav";
  nav.innerHTML="";
  const inner=document.createElement("div");inner.className="empire-global-nav__inner";
  const brand=document.createElement("a");brand.href="/";brand.className="empire-global-nav__brand";
  brand.innerHTML='<img src="https://i.imgur.com/Kf99eJt.jpeg" alt="TK Empire"><span>TK EMPIRE<small>BUILT FOR LEGACY</small></span>';
  const links=document.createElement("div");links.className="empire-global-nav__links";
  tabs.forEach(([label,href,kind])=>{
    const a=document.createElement("a");a.href=href;a.textContent=label;
    const target=href==="/"?"index.html":file(href);
    a.className="empire-global-nav__link"+(kind==="cta"?" empire-global-nav__cta":"")+(target===current?" is-active":"");
    if(target===current)a.setAttribute("aria-current","page");
    links.appendChild(a);
  });
  inner.append(brand,links);nav.appendChild(inner);
  document.querySelectorAll("#empire-site-tabs").forEach(x=>x.remove());
  if(!document.querySelector('script[src="/assets/js/genesis-live.js"]')){
    const s=document.createElement("script");s.src="/assets/js/genesis-live.js?v=1";s.defer=true;document.head.appendChild(s);
  }
}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",build,{once:true});else build();
})();