'use strict';

/* Read-only market-outcome board. Public Gamma event prices only.
 * No user credentials, wallet connections, execution, VPS access, or orders. */
const ORIGIN = 'https://gamma-api.polymarket.com';
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CONDITION = /^0x[0-9a-f]{64}$/i;
const MAX_BYTES = 2400000;
const MAX_MARKETS = 160;
function send(res,status,body){
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Cache-Control',status===200?'public, max-age=0, s-maxage=20, stale-while-revalidate=10':'no-store');
  return res.status(status).json(body);
}
function shortText(v,max=180){
  return typeof v==='string'?v.trim().slice(0,max):'';
}
function binaryPrices(market){
  function arr(value){
    if(Array.isArray(value)) return value;
    if(typeof value!=='string'||value.length>500) return null;
    try{const result=JSON.parse(value);return Array.isArray(result)?result:null;}catch{return null;}
  }
  const outcomes=arr(market.outcomes);
  const prices=arr(market.outcomePrices);
  if(!outcomes||!prices||outcomes.length!==prices.length||outcomes.length!==2)return null;
  const yi=outcomes.findIndex(x=>String(x).toLowerCase()==='yes');
  const ni=outcomes.findIndex(x=>String(x).toLowerCase()==='no');
  if(yi<0||ni<0)return null;
  function price(index){
    const value=prices[index];
    if(typeof value!=='string'&&typeof value!=='number')return null;
    if(typeof value==='string'&&!/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(value))return null;
    const n=Number(value);
    return Number.isFinite(n)&&n>=0&&n<=1?n:null;
  }
  return {yes_price:price(yi),no_price:price(ni)};
}
function numericValue(v){
  if(typeof v!=='string'&&typeof v!=='number')return null;
  const n=Number(v);
  return Number.isFinite(n)&&n>=0&&n<1e14?n:null;
}
module.exports=async function handler(req,res){
  if(req.method!=='GET'){
    res.setHeader('Allow','GET');
    return send(res,405,{status:'method_not_allowed'});
  }
  const slug=req.query&&req.query.event;
  if(typeof slug!=='string'||slug.length>160||!SLUG.test(slug))return send(res,400,{status:'invalid_event'});
  try{
    const response=await fetch(ORIGIN+'/events/slug/'+encodeURIComponent(slug),{
      method:'GET',headers:{Accept:'application/json'},redirect:'error',
      cache:'no-store',signal:AbortSignal.timeout(8500)
    });
    if(response.status===404)return send(res,404,{status:'not_found'});
    if(!response.ok)throw new Error('upstream_http');
    const size=Number(response.headers.get('content-length'));
    if(Number.isFinite(size)&&size>MAX_BYTES)throw new Error('upstream_oversize');
    const body=await response.text();
    if(Buffer.byteLength(body,'utf8')>MAX_BYTES)throw new Error('upstream_oversize');
    const event=JSON.parse(body);
    if(!event||typeof event!=='object'||Array.isArray(event)||!Array.isArray(event.markets))throw new Error('upstream_schema');
    if(event.slug!==slug)throw new Error('upstream_event_mismatch');
    const markets=[];
    for(const item of event.markets.slice(0,MAX_MARKETS)){
      if(!item||typeof item!=='object'||!CONDITION.test(item.conditionId||''))continue;
      const prices=binaryPrices(item);
      if(!prices)continue;
      markets.push({
        condition_id:item.conditionId.toLowerCase(),
        label:shortText(item.groupItemTitle||item.question,160)||'Market outcome',
        question:shortText(item.question,230)||'Market outcome',
        market_slug:SLUG.test(item.slug||'')?shortText(item.slug,160):null,
        ...prices,closed:item.closed===true,active:item.active===true,
        volume_usdc:numericValue(item.volumeNum??item.volume)
      });
    }
    if(!markets.length)throw new Error('empty_binary_markets');
    return send(res,200,{
      schema_version:1,status:'ok',source:'Polymarket Gamma public market data',
      snapshot_fetched_at:new Date().toISOString(),
      event:{slug,title:shortText(event.title,220)||slug,
        closed:event.closed===true,active:event.active===true,
        market_count: event.markets.length,
        markets_truncated:event.markets.length>MAX_MARKETS},
      markets,execution_enabled:false,quote_type:'gamma_reported_outcome_price',
      caveat:'Price indicators are source-reported and may lag the order book; not executable quotes, guaranteed probabilities, or Genesis trading positions.'
    });
  }catch{
    return send(res,503,{schema_version:1,status:'upstream_unavailable',markets:[],
      error:'Verified market prices unavailable; no values inferred.'});
  }
};
module.exports._test={binaryPrices};
