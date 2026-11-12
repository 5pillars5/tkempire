(()=>{"use strict";
const listeners=new Set();
let state={health:null,status:null,openTrades:[],updatedAt:null,error:null};
function fresh(v){const t=typeof v==='string'?Date.parse(v):NaN,age=Date.now()-t;return Number.isFinite(t)&&age>=-30000&&age<=120000;}
function validHealth(h){return h&&h.schema_version===1&&h.source==='GENESIS_PAPER_PUBLIC_SUMMARY'&&h.engine?.mode==='paper'&&fresh(h.served_at)&&h.open_trades?.details_public===false;}
function validStatus(s){return s&&s.schema_version===1&&s.source==='GENESIS_PAPER_AGGREGATE'&&s.engine?.mode==='paper'&&fresh(s.updated_at);}
async function getJSON(url){const r=await fetch(url+(url.includes("?")?"&":"?")+"_="+Date.now(),{cache:"no-store"});if(!r.ok)throw new Error('PAPER_API_UNAVAILABLE');return r.json();}
function normalize(health,status){return {health:validHealth(health)?health:null,status:validStatus(status)?status:null,openTrades:[],updatedAt:new Date().toISOString(),error:null};}
function emit(){listeners.forEach(fn=>{try{fn(state)}catch(e){console.error("GenesisLive listener",e)}});window.dispatchEvent(new CustomEvent("genesis:live",{detail:state}));renderStrip();}
function renderStrip(){
 let el=document.getElementById("genesis-live-strip");
 if(!el){el=document.createElement("div");el.id="genesis-live-strip";el.className="genesis-live-strip";const nav=document.querySelector(".empire-global-nav,nav");if(nav)nav.insertAdjacentElement("afterend",el);else document.body.prepend(el);}
 const inner=document.createElement('div');inner.className='genesis-live-strip__inner';
 const label=document.createElement('b');label.textContent='GENESIS PAPER';inner.appendChild(label);
 const status=document.createElement('span');
 if(!validHealth(state.health)){status.textContent='Paper status unavailable or stale; no live execution inferred.';}
 else{
  const count=state.health.open_trades?.count;
  const verified=Number.isSafeInteger(count)&&count>=0&&count<=100000;
  status.textContent=verified?(count+' reported open PAPER position'+(count===1?'':'s')+' · details private'):'Position count unavailable · details private';
 }
 inner.appendChild(status);el.replaceChildren(inner);
}
async function refresh(){
 try{const [health,status]=await Promise.all([getJSON("/api/health"),getJSON("/api/genesis/status")]);state=normalize(health,status);emit();}
 catch(e){state={health:null,status:null,openTrades:[],error:'API_UNAVAILABLE',updatedAt:new Date().toISOString()};emit();}
}
window.GenesisLive={getState:()=>state,refresh,subscribe(fn){listeners.add(fn);if(state.health)fn(state);return()=>listeners.delete(fn)}};
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",()=>{refresh();setInterval(refresh,5000)},{once:true});
else{refresh();setInterval(refresh,5000)}
})();