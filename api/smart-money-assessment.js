'use strict';
// Public, read-only order-book assessment. Never signs or submits orders.
const CONDITION=/^0x[0-9a-f]{64}$/i, TOKEN=/^[0-9]{1,100}$/, SLUG=/^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_AGE=60000;
function number(v){return (typeof v==='number'||typeof v==='string'&&/^\d+(?:\.\d+)?$/.test(v))&&Number.isFinite(Number(v))?Number(v):null;}
function array(v){try{return Array.isArray(v)?v:JSON.parse(v);}catch{return null;}}
async function read(url){
 const r=await fetch(url,{method:'GET',redirect:'error',cache:'no-store',headers:{Accept:'application/json'},signal:AbortSignal.timeout(6000)});
 if(!r.ok)throw Error('upstream');
 if(Number(r.headers.get('content-length'))>2400000)throw Error('size');
 const text=await r.text();if(Buffer.byteLength(text)>2400000)throw Error('size');return JSON.parse(text);
}
function summarize(raw,token,condition,quantity,now){
 if(!raw||raw.asset_id!==token||String(raw.market).toLowerCase()!==condition)throw Error('identity');
 function levels(rows){
  if(!Array.isArray(rows)||rows.length>10000)throw Error('levels');
  return rows.map(x=>{const price=number(x.price),size=number(x.size);if(price===null||price<=0||price>=1||size===null||size<=0||size>1e12)throw Error('level');return {price,size};});
 }
 const asks=levels(raw.asks).sort((a,b)=>a.price-b.price),bids=levels(raw.bids).sort((a,b)=>b.price-a.price);
 const bestAsk=asks[0]?.price??null,bestBid=bids[0]?.price??null;
 const ts=number(raw.timestamp),time=ts===null?NaN:(ts<1e12?ts*1000:ts);
 const minimum=number(raw.min_order_size);
 let left=quantity,cost=0;
 for(const a of asks){const fill=Math.min(left,a.size);cost+=fill*a.price;left-=fill;if(left<=1e-8)break;}
 return {best_ask:bestAsk,best_bid:bestBid,bid_ask_spread:bestAsk!==null&&bestBid!==null?bestAsk-bestBid:null,
  ask_size_at_best:asks.filter(a=>a.price===bestAsk).reduce((n,a)=>n+a.size,0),
  ask_depth_shares:asks.reduce((n,a)=>n+a.size,0),minimum_shares:minimum,
  sufficient_depth:left<=1e-8,minimum_met:minimum!==null&&quantity>=minimum,
  buy_cost:left<=1e-8?cost:null,buy_average:left<=1e-8?cost/quantity:null,
  book_at:Number.isFinite(time)?new Date(time).toISOString():null,
  fresh:Number.isFinite(time)&&time<=now+5000&&now-time<=MAX_AGE,
  crossed:bestBid!==null&&bestAsk!==null&&bestBid>=bestAsk};
}
function assess(yes,no,fees,quantity){
 const cost=yes.buy_cost!==null&&no.buy_cost!==null?yes.buy_cost+no.buy_cost:null;
 const gross=cost===null?null:quantity-cost;
 const zeroFees=fees.every(f=>f===0);
 let status='insufficient_evidence';
 if(!yes.fresh||!no.fresh)status='stale_quotes';
 else if(yes.crossed||no.crossed)status='inconsistent_book';
 else if(!yes.sufficient_depth||!no.sufficient_depth)status='insufficient_liquidity';
 else if(!yes.minimum_met||!no.minimum_met)status='below_minimum_size';
 else if(gross<=0.000001)status='no_pair_gap';
 else if(!zeroFees)status='fees_unverified';
 else status='potential_pair_gap';
 return {status,quantity_shares_each:quantity,pair_cost:cost,pair_cost_per_share:cost===null?null:cost/quantity,
  gross_gap:gross,fee_status:zeroFees?'zero_trading_fee_reported':'nonzero_or_unavailable_not_estimated',
  gap_after_reported_trading_fees:zeroFees?gross:null,
  caveat:'Snapshot only. Both legs may move or fail to fill. Network, conversion and redemption costs are excluded. End date is not a guaranteed settlement time. No profit is verified.'};
}
module.exports=async(req,res)=>{
 res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
 const send=(code,body)=>res.status(code).json({schema_version:1,execution_enabled:false,...body});
 if(req.method!=='GET'){res.setHeader('Allow','GET');return send(405,{status:'method_not_allowed'});}
 const {event,condition,shares='10'}=req.query||{},q=number(shares);
 if(typeof event!=='string'||event.length>160||!SLUG.test(event)||typeof condition!=='string'||!CONDITION.test(condition)||q===null||q<1||q>10000)return send(400,{status:'invalid_request'});
 try{
  const e=await read('https://gamma-api.polymarket.com/events/slug/'+encodeURIComponent(event));
  if(!e||e.slug!==event||!Array.isArray(e.markets))throw Error('event');
  const m=e.markets.slice(0,160).find(m=>String(m.conditionId).toLowerCase()===condition.toLowerCase());
  if(!m)return send(404,{status:'market_not_found'});
  const end=typeof m.endDate==='string'&&Number.isFinite(Date.parse(m.endDate))?m.endDate:null;
  const metadata={question:String(m.question||'').slice(0,230),end_at:end,rules:typeof m.description==='string'?m.description.slice(0,6000):null};
  if(e.closed===true||e.active===false||m.closed===true||m.active!==true||m.acceptingOrders!==true||m.enableOrderBook!==true||end&&Date.parse(end)<=Date.now())return send(200,{status:'market_unavailable',...metadata});
  const names=array(m.outcomes),tokens=array(m.clobTokenIds);
  if(!Array.isArray(names)||names.length!==2||!Array.isArray(tokens)||tokens.length!==2)throw Error('binary');
  const yi=names.findIndex(x=>String(x).toLowerCase()==='yes'),ni=names.findIndex(x=>String(x).toLowerCase()==='no');
  if(yi<0||ni<0||tokens.some(t=>typeof t!=='string'||!TOKEN.test(t))||tokens[0]===tokens[1])throw Error('tokens');
  const ids=[tokens[yi],tokens[ni]],start=Date.now();
  const books=await Promise.all(ids.map(t=>read('https://clob.polymarket.com/book?token_id='+t)));
  const feeResults=await Promise.allSettled(ids.map(t=>read('https://clob.polymarket.com/fee-rate?token_id='+t)));
  const fees=feeResults.map(r=>r.status==='fulfilled'?number(r.value.base_fee??r.value.fee_rate_bps):null);
  const now=Date.now(),yes=summarize(books[0],ids[0],condition.toLowerCase(),q,now),no=summarize(books[1],ids[1],condition.toLowerCase(),q,now);
  return send(200,{...metadata,...assess(yes,no,fees,q),yes,no,checked_at:new Date(now).toISOString(),collection_ms:now-start,source:'Polymarket Gamma metadata and CLOB books / fee-rate',quote_max_age_seconds:60});
 }catch{return send(503,{status:'insufficient_evidence',error:'Current order books could not be verified. No prices inferred.'});}
};
module.exports._test={number,summarize,assess};
