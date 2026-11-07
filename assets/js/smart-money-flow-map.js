'use strict';
(() => {
 const $=id=>document.getElementById(id);
 const fmt=new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0,notation:'compact'});
 const exact=new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:2});
 const ui={markets:[],selected:null,window:86400,loading:false,lastHistoryMarket:null,historyRequest:0};
 const number=x=>typeof x==='number'&&Number.isFinite(x)?x:null;
 const usd=x=>number(x)===null?'—':fmt.format(x);
 const fullUsd=x=>number(x)===null?'—':exact.format(x);
 const signed=x=>number(x)===null?'—':(x>0?'+':'')+usd(x);
 const time=x=>{try{return new Date(x).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})}catch{return '—'}};
 const el=(tag,cls='',content)=>{
  const node=document.createElement(tag);
  if(cls)node.className=cls;
  if(content!==undefined)node.textContent=String(content);
  return node;
 };
 const v=(tag,attrs={})=>{
  const node=document.createElementNS('http://www.w3.org/2000/svg',tag);
  for(const [key,val] of Object.entries(attrs))node.setAttribute(key,String(val));
  return node;
 };
 const modeKey=()=>ui.window===900?'net_15m_usdc':ui.window===3600?'net_60m_usdc':'observed_net_usdc';
 const net=m=>number(m[modeKey()])??0;
 function setStatus(kind,text){
  const tag=$('healthTag');
  tag.textContent=kind;tag.className='tag '+(kind==='DEGRADED'?'warn':kind==='UNAVAILABLE'?'bad':'');
  $('lastSeen').textContent=text;
 }
 function selectMarket(id){ui.selected=id;renderList();renderDetail();loadSelectedHistory()}
 function renderList(){
  const target=$('flowRows');target.replaceChildren();
  let markets=[...ui.markets];
  const direction=$('directionFilter').value;
  if(direction==='buy')markets=markets.filter(m=>net(m)>0);
  if(direction==='sell')markets=markets.filter(m=>net(m)<0);
  markets.sort((a,b)=>Math.abs(net(b))-Math.abs(net(a))||b.observed_gross_usdc-a.observed_gross_usdc||a.market_id.localeCompare(b.market_id));
  if(!markets.length){target.append(el('div','empty',ui.markets.length?'No observed markets match this filter.':'No verified sampled market activity available.'));return}
  for(const m of markets.slice(0,25)){
   const row=el('button','flowrow'+(ui.selected===m.market_id?' active':''));
   row.type='button';row.setAttribute('aria-pressed',ui.selected===m.market_id?'true':'false');
   const top=el('div','flowtop'),label=el('div'),title=el('div','flowtitle',m.title);
   const subtitle=el('div','flowsub',m.outcome+' · '+m.participating_wallets+' participating wallets · '+m.activity_count+' fills');
   label.append(title,subtitle);
   const flow=net(m),amount=el('span','flowvalue '+(flow>=0?'buy':'sell'),signed(flow));
   top.append(label,amount);
   const track=el('div','track');
   const share=Math.max(0,Math.min(100,number(m.buy_share_of_observed_flow_pct)??0));
   const fill=el('span');fill.style.width=share+'%';track.append(fill);
   const mini=el('div','minirow');
   mini.append(el('span','',Math.round(share)+'% sampled BUY share · 24h'),el('span','',
    m.wallets_net_buying+' net buyers / '+m.wallets_net_selling+' net sellers'));
   row.append(top,track,mini);
   row.addEventListener('click',()=>selectMarket(m.market_id));
   target.append(row);
  }
  $('listNote').textContent='Showing '+Math.min(markets.length,25)+' of '+markets.length+
   ' sampled outcomes, sorted by absolute '+(ui.window===900?'15-minute':ui.window===3600?'60-minute':'24-hour')+
   ' net flow. Bar length always shows the 24-hour BUY share, not implied odds.';
 }
 function graph(m){
  const node=$('flowChart');node.replaceChildren();
  const points=Array.isArray(m?.cumulative_flow_15m)?m.cumulative_flow_15m.filter(p=>
   number(p.t)!==null&&number(p.v)!==null):[];
  if(!points.length){const t=v('text',{x:25,y:150,fill:'#99aabf','font-size':16});t.textContent='No chart data available';node.append(t);return}
  const W=600,H=300,left=61,right=16,top=22,bottom=44;
  const w=W-left-right,h=H-top-bottom;
  const raw=points.map(p=>p.v),max=Math.max(0,...raw),min=Math.min(0,...raw);
  const extent=Math.max(20,max-min);
  const upper=max+extent*.15,lower=min-extent*.15;
  const x=i=>left+(i/Math.max(1,points.length-1))*w;
  const y=value=>top+(upper-value)/(upper-lower)*h;
  for(let i=0;i<=4;i++){
   const yy=top+i*h/4,grid=v('line',{x1:left,y1:yy,x2:W-right,y2:yy,stroke:'#34465c','stroke-opacity':'.55','stroke-dasharray':'3 6'});
   node.append(grid);
   const value=upper-i*(upper-lower)/4;
   const t=v('text',{x:left-9,y:yy+4,'text-anchor':'end',fill:'#91a4ba','font-size':'12'});
   t.textContent=usd(value);node.append(t);
  }
  node.append(v('line',{x1:left,y1:y(0),x2:W-right,y2:y(0),stroke:'#8e9bb0','stroke-width':'1.5'}));
  const d=points.map((p,i)=>(i?'L':'M')+x(i).toFixed(2)+','+y(p.v).toFixed(2)).join(' ');
  const color=points[points.length-1].v>=0?'#58ddb2':'#ff8ba1';
  node.append(v('path',{d,fill:'none',stroke:color,'stroke-width':3.5,'stroke-linecap':'round','stroke-linejoin':'round'}));
  const last=points.at(-1);
  node.append(v('circle',{cx:x(points.length-1),cy:y(last.v),r:5,fill:color,stroke:'#07101b','stroke-width':2}));
  for(const [i,text] of [[0,'24h ago'],[Math.floor((points.length-1)/2),'12h'],[points.length-1,'Now']]){
   const label=v('text',{x:x(i),y:H-14,'text-anchor':i===0?'start':i===points.length-1?'end':'middle',fill:'#91a4ba','font-size':'13'});
   label.textContent=text;node.append(label);
  }
 }
 function renderDetail(){
  const m=ui.markets.find(x=>x.market_id===ui.selected)||ui.markets[0];
  if(!m){
   $('detailLabel').textContent='NO MARKET DATA';
   $('detailTitle').textContent='No outcome selected';
   $('detailMeta').textContent='Select an outcome when the public feed becomes available.';
   for(const id of ['buySell','participants','acceleration','marketPrice'])$(id).textContent='—';
   $('detailCaveat').textContent='No probabilities or synthetic data are generated.';
   $('flowChart').replaceChildren();return;
  }
  ui.selected=m.market_id;
  $('detailLabel').textContent=m.consensus_level==='OBSERVED_3_PLUS_NET_BUYERS'?'MULTI-WALLET NET BUYING':
   m.consensus_level==='OBSERVED_3_PLUS_NET_SELLERS'?'MULTI-WALLET NET SELLING':'SAMPLED OUTCOME ACTIVITY';
  $('detailTitle').textContent=m.title;
  $('detailMeta').textContent=m.outcome+' · '+m.activity_count+' fills · Last observed '+time(m.last_observed_at);
  $('buySell').textContent=usd(m.observed_buy_usdc)+' / '+usd(m.observed_sell_usdc);
  $('participants').textContent=m.wallets_net_buying+' / '+m.wallets_net_selling;
  $('acceleration').textContent=signed(m.flow_change_15m_usdc);
  $('marketPrice').textContent=number(m.last_sampled_trade_price)===null?'—':
   (m.last_sampled_trade_price*100).toFixed(1)+'¢';
  $('detailCaveat').textContent='The line traces cumulative 24-hour observed net USDC for this exact outcome. '
   +'The latest sampled fill is not a quote. Participation does not imply reliable future outcomes or a positive entry edge.';
  graph(m);
 }
 async function loadHistorySummary(){
  try{
   const res=await fetch('/api/smart-money-history?view=summary&days=3',{cache:'no-store'});
   const data=await res.json();
   if(!res.ok||data.status!=='ok'||data.trading_authority!=='none')throw Error('history unavailable');
   $('archivedSnapshots').textContent=String(data.observation_snapshots);
   $('archivedSignals').textContent=String(data.signal_events);
   $('verifiedOutcomes').textContent=String(data.verified_outcomes);
   $('pendingOutcomes').textContent=String(data.pending_outcomes);
   $('historyHealth').textContent='ARCHIVE READING';$('historyHealth').className='tag';
   $('historyStamp').textContent='Last stored sample: '+(data.latest_snapshot_at?new Date(data.latest_snapshot_at).toLocaleString():'unknown')+
     ' · Legacy VPS database import remains separate · Results are not calibrated probabilities.';
  }catch(e){
   $('historyHealth').textContent='NOT YET VERIFIED';$('historyHealth').className='tag warn';
   for(const id of ['archivedSnapshots','archivedSignals','verifiedOutcomes','pendingOutcomes'])$(id).textContent='—';
   $('historyStamp').textContent='History archive has not produced a verified public readback yet; live rolling flow remains separate.';
  }
 }
 async function loadSelectedHistory(){
  const m=ui.markets.find(x=>x.market_id===ui.selected);
  if(!m){
   $('historicalTrend').replaceChildren();
   $('historicalEvidenceNote').textContent='No selected outcome; no historical readings are inferred.';
   ui.lastHistoryMarket=null;return;
  }
  if(ui.lastHistoryMarket===m.market_id)return;
  ui.lastHistoryMarket=m.market_id;
  const sequence=++ui.historyRequest;
  try{
   const url='/api/smart-money-history?view=market&days=3&condition='+encodeURIComponent(m.condition_id)+
    '&token='+encodeURIComponent(m.token_id);
   const res=await fetch(url,{cache:'no-store'});
   const data=await res.json();
   if(sequence!==ui.historyRequest)return;
   if(!res.ok||data.execution_authority!=='none'||!Array.isArray(data.trend))throw Error('archive unavailable');
   const points=data.trend.slice(-96).filter(p=>number(p.net_24h_usdc)!==null);
   const target=$('historicalTrend');target.replaceChildren();
   if(!points.length){target.append(el('div','empty','No stored observations for this outcome yet.'));return}
   const maximum=Math.max(1,...points.map(p=>Math.abs(p.net_24h_usdc)));
   for(const p of points){
    const bar=el('span','histbar'+(p.net_24h_usdc<0?' negative':''));
    bar.style.height=Math.max(4,Math.round(70*Math.abs(p.net_24h_usdc)/maximum))+'px';
    bar.title=new Date(p.at).toLocaleString()+': '+fullUsd(p.net_24h_usdc)+
     ' · 24h sampled net flow'+(p.coverage_incomplete?' · incomplete coverage':'');
    bar.setAttribute('aria-label',bar.title);target.append(bar);
   }
   $('historicalEvidenceNote').textContent=points.length+' saved samples for '+m.outcome+
    ' over the most recent three days. Each bar represents rolling 24h sampled net buying/selling at a recorded timestamp; not cumulative profit, and gaps are omitted.';
  }catch(e){
   if(sequence!==ui.historyRequest)return;
   $('historicalTrend').replaceChildren(el('div','empty','Archived outcome history unavailable.'));
   $('historicalEvidenceNote').textContent='No artificial historical line or backfilled profitability is generated when the source is unavailable.';
  }
 }
 function render(){
  renderList();renderDetail();loadSelectedHistory();
 }
 async function load(){
  if(ui.loading)return;ui.loading=true;$('refreshBtn').disabled=true;
  try{
   const response=await fetch('/api/smart-money-flow',{cache:'no-store',headers:{Accept:'application/json'}});
   const raw=await response.json();
   if(!response.ok||!['ok','degraded'].includes(raw.status)||!Array.isArray(raw.markets)||
     raw.execution_enabled!==false||raw.market_pressure_is_win_probability!==false||
     raw.prediction_model_status!=='NOT_TRAINED_OR_CALIBRATED')throw Error('Incomplete or invalid public evidence');
   ui.markets=raw.markets;
   if(!ui.markets.some(x=>x.market_id===ui.selected))ui.selected=ui.markets[0]?.market_id||null;
   $('grossFlow').textContent=usd(raw.total_observed_buy_usdc+raw.total_observed_sell_usdc);
   $('netFlow').textContent=signed(raw.total_observed_net_usdc);
   $('marketCount').textContent=String(raw.market_count);
   $('walletCoverage').textContent=raw.wallets_returned+'/'+raw.wallets_selected;
   $('coverageText').textContent=raw.wallets_failed+' unavailable · '+raw.wallets_truncated+' at 70-fill cap';
   setStatus(raw.status.toUpperCase(),'Fetched '+time(raw.generated_at)+' · '+raw.events_sampled+' validated fills in 24h');
   $('dataLimit').textContent='Scope: current weekly crypto-profit leaderboard wallet sample, across their trades in all market categories. '
    +'At most 70 recent fills per wallet; '+raw.wallets_failed+' feeds unavailable, '+raw.wallets_truncated+
    ' feeds at retrieval cap. No complete historical probability calibration. Refresh every 60 seconds while open.';
   render();loadHistorySummary();
  }catch(err){
   ui.markets=[];ui.selected=null;
   for(const id of ['grossFlow','netFlow','marketCount','walletCoverage'])$(id).textContent='—';
   $('coverageText').textContent='Source unavailable';
   $('dataLimit').textContent='The public feed could not be verified. Market readings are withheld, rather than replaced with simulated values.';
   setStatus('UNAVAILABLE','No verified flow data; refresh to retry.');render();loadHistorySummary();
  }finally{ui.loading=false;$('refreshBtn').disabled=false}
 }
 $('refreshBtn').addEventListener('click',load);
 $('windowFilter').addEventListener('change',e=>{ui.window=Number(e.target.value)||86400;renderList()});
 $('directionFilter').addEventListener('change',renderList);
 load();
 setInterval(()=>{if(!document.hidden)load()},60000);
})();