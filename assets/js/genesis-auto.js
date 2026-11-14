(()=>{'use strict';
const $=id=>document.getElementById(id);
let key='',busy=false;
const set=(id,value)=>{const el=$(id);if(el)el.textContent=String(value)};
const money=v=>typeof v==='number'&&Number.isFinite(v)?new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:6}).format(v):'—';
const quantity=v=>typeof v==='number'&&Number.isFinite(v)?new Intl.NumberFormat('en-US',{maximumFractionDigits:8}).format(v):'—';
const stamp=v=>Number.isFinite(Date.parse(v))?new Date(v).toLocaleString([], {dateStyle:'short',timeStyle:'medium'}):'Unknown';
const node=(tag,value,cls)=>{const el=document.createElement(tag);if(value!==undefined)el.textContent=String(value);if(cls)el.className=cls;return el};
function status(message,mode){set('status-text',message);const e=$('connection');e.textContent=mode==='good'?'EXCHANGE CONNECTED':mode==='bad'?'UNAVAILABLE':'CONNECTING';e.className='tag '+(mode||'warn')}
function render(d){
  set('positions-count',d.positions.length);set('orders-count',d.open_order_count);set('daily-pnl',money(d.today_net_pnl_usd));
  $('daily-pnl').className=d.today_net_pnl_usd>0?'positive':d.today_net_pnl_usd<0?'negative':'';
  set('worker-state',d.worker?.connected===true ? d.worker.service.state : 'Not verified');
  set('worker-freshness',d.worker?.connected===true?'Worker heartbeat '+stamp(d.worker.service.heartbeat_at):'Worker feed: '+String(d.worker?.status||'NOT_CONNECTED'));
  set('worker-entries',d.worker?.connected===true?d.worker.counters.entries_filled:'—');
  set('worker-exits',d.worker?.connected===true?d.worker.counters.exits_reconciled:'—');
  set('worker-errors',d.worker?.connected===true?d.worker.counters.errors:'—');
  const events=$('worker-events');events.replaceChildren();
  if(d.worker?.connected===true){
    for(const e of d.worker.events){
      const tr=node('tr');
      for(const val of [stamp(e.at),e.coin,e.side,e.stage,e.reason_code,e.realized_pnl_usd===undefined?'—':money(e.realized_pnl_usd)])
        tr.append(node('td',val));
      events.append(tr);
    }
  }
  $('worker-events-empty').hidden=d.worker?.connected===true&&d.worker.events.length>0;
  set('updated','Checked '+stamp(d.checked_at));
  const cards=$('position-cards');cards.replaceChildren();
  if(!d.positions.length)cards.append(node('div','No open APT or BNB positions on Hyperliquid testnet.','empty'));
  for(const p of d.positions){
    const card=node('article',undefined,'position');card.append(node('div',p.side+' · TESTNET','tag '+(p.side==='BUY'?'good':'warn')),node('h3',p.coin));
    const two=node('div',undefined,'two');
    for(const [name,value] of [['Size',quantity(p.quantity)],['Entry',money(p.entry_price)],['Unrealized P&L',money(p.unrealized_pnl_usd)],['Exposure',money(p.position_value_usd)]]){const item=node('div');item.append(node('label',name),node('strong',value));two.append(item)}
    card.append(two);cards.append(card);
  }
  set('other-positions',d.other_positions?d.other_positions+' other asset position(s) exist on this account and are not displayed.':'');
  const fills=$('fills');fills.replaceChildren();$('fills-empty').hidden=d.recent_fills.length>0;
  for(const f of d.recent_fills){
    const tr=node('tr');
    for(const [value,cls] of [[stamp(f.at),''],[f.coin,''],[f.direction||f.side,''],[quantity(f.quantity),''],[money(f.price),''],[money(f.realized_pnl_usd),f.realized_pnl_usd>=0?'positive':'negative'],[money(f.fee_usd),'']])tr.append(node('td',value,cls));
    fills.append(tr);
  }
  $('monitor').hidden=false;$('auth-panel').hidden=true;$('refresh').hidden=false;
  // Surface the fail-closed worker status above the fold on mobile. Never hide it behind a generic badge.
  const workerStatus=d.worker?.connected===true?'VERIFIED':String(d.worker?.status||'NOT_CONNECTED').replace(/[^A-Z_]/g,'').slice(0,40);
  status(d.worker?.connected===true?'Exchange and Genesis Auto worker feeds verified.':'Exchange verified; Genesis worker feed: '+workerStatus+'.','good');
}
async function refresh(){
  if(busy||!key||document.hidden)return;busy=true;
  try{
    const response=await fetch('/api/genesis/auto-monitor',{method:'GET',headers:{'X-Genesis-View-Key':key},cache:'no-store',credentials:'same-origin'});
    // Protected Vercel previews require the same-origin deployment-auth cookie.
    // An HTML login response is NOT proof that the independent viewer key failed.
    const contentType=(response.headers.get('content-type')||'').toLowerCase();
    if(!contentType.includes('application/json')){
      status(response.status===401||response.status===403
        ?'Preview session expired. Reopen the protected preview link; your Genesis key has not been checked.'
        :'Monitor API returned an unexpected response.','bad');
      return;
    }
    const data=await response.json();
    if(response.status===401){key='';$('auth-panel').hidden=false;$('monitor').hidden=true;$('refresh').hidden=true;status('Genesis viewer key rejected. Use the current private viewer key.','bad');return}
    if(!response.ok||data.status!=='ok'||data.network!=='TESTNET_ONLY'||!Array.isArray(data.positions)||!Array.isArray(data.recent_fills))throw Error('Unavailable');
    render(data);
  }catch{status('Exchange feed unavailable; last verified snapshot may be stale.','bad')}
  finally{busy=false}
}
$('connect').addEventListener('click',()=>{const candidate=$('access-key').value.trim();$('access-key').value='';if(!candidate){status('Enter your private access key.','bad');return}key=candidate;status('Checking testnet exchange…','warn');refresh()});
$('access-key').addEventListener('keydown',e=>{if(e.key==='Enter')$('connect').click()});
$('refresh').addEventListener('click',refresh);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh()});
setInterval(refresh,8000);
})();