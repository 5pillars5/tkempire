(()=>{"use strict";
const listeners=new Set();
let state={health:null,status:null,openTrades:[],updatedAt:null,error:null};
async function getJSON(url){const r=await fetch(url+(url.includes("?")?"&":"?")+"_="+Date.now(),{cache:"no-store"});if(!r.ok)throw new Error(url+" HTTP "+r.status);return r.json();}
function normalize(health,status){
  const open=(health&&health.open_trades)||{};
  const trades=Array.isArray(open.trades)?open.trades:[];
  return {health,status,openTrades:trades,updatedAt:new Date().toISOString(),error:null};
}
function emit(){listeners.forEach(fn=>{try{fn(state)}catch(e){console.error("GenesisLive listener",e)}});window.dispatchEvent(new CustomEvent("genesis:live",{detail:state}));renderStrip();}
function renderStrip(){
  let el=document.getElementById("genesis-live-strip");
  if(!el){el=document.createElement("div");el.id="genesis-live-strip";el.className="genesis-live-strip";const nav=document.querySelector(".empire-global-nav,nav");if(nav)nav.insertAdjacentElement("afterend",el);else document.body.prepend(el);}
  const trades=state.openTrades||[];
  if(!state.health){el.innerHTML='<div class="genesis-live-strip__inner"><b>GENESIS</b><span>Connecting to canonical live state…</span></div>';return;}
  if(!trades.length){el.innerHTML='<div class="genesis-live-strip__inner"><b>GENESIS LIVE</b><span class="gls-dot"></span><strong>NO ACTIVE TRADE</strong><span>Scanning for a qualified setup</span></div>';return;}
  const summary=trades.map(t=>`${String(t.coin||"ASSET").toUpperCase()} ${String(t.action||"").toUpperCase()} · Entry ${t.entry??"—"} · Score ${t.score??"—"}`).join("  |  ");
  el.innerHTML='<div class="genesis-live-strip__inner"><b>GENESIS LIVE</b><span class="gls-dot"></span><strong>'+trades.length+' ACTIVE</strong><span>'+summary+'</span></div>';
}
async function refresh(){
  try{const [health,status]=await Promise.all([getJSON("/api/health"),getJSON("/api/genesis/status")]);state=normalize(health,status);emit();}
  catch(e){state={...state,error:String(e),updatedAt:new Date().toISOString()};emit();}
}
window.GenesisLive={getState:()=>state,refresh,subscribe(fn){listeners.add(fn);if(state.health)fn(state);return()=>listeners.delete(fn)}};
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",()=>{refresh();setInterval(refresh,5000)},{once:true});else{refresh();setInterval(refresh,5000)}
})();