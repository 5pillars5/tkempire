'use strict';
// Public, read-only, indicative Hyperliquid perpetual midpoint quotes.
// This route has NO wallet credentials, no private Genesis access, and no order methods.
const UPSTREAM='https://api.hyperliquid.xyz/info';
const SOURCE='HYPERLIQUID_PERP_MID';
const MAX_ASSETS=20;
const ASSET=/^[A-Z0-9]{2,15}$/;
const MAX_RESPONSE_BYTES=250000;
function send(res,code,body){
  res.setHeader('Cache-Control','no-store, max-age=0');
  res.setHeader('X-Content-Type-Options','nosniff');
  return res.status(code).json({schema_version:1,...body});
}
const SUPPORTED_GENESIS_ASSETS=Object.freeze(['BNB','SOL','APT']);

function finitePrice(value){
  if(typeof value!=='string'||!/^(?:[0-9]+)(?:\.[0-9]+)?$/.test(value))return null;
  const number=Number(value);
  return Number.isFinite(number)&&number>0&&number<=1e9?number:null;
}
module.exports=async function indicativePrices(req,res){
  if(req.method!=='GET'){
    res.setHeader('Allow','GET');
    return send(res,405,{status:'method_not_allowed',source:SOURCE,prices:{}});
  }
  // Ignore URL query entirely: quote only the fixed vetted Genesis universe.
  // No caller-provided symbol is ever fetched or used.
  const assets=SUPPORTED_GENESIS_ASSETS;
  try{
    const response=await fetch(UPSTREAM,{
      method:'POST',redirect:'error',cache:'no-store',
      headers:{'Content-Type':'application/json',Accept:'application/json'},
      body:JSON.stringify({type:'allMids',dex:''}),
      signal:AbortSignal.timeout(4500)
    });
    if(!response.ok)return send(res,502,{status:'market_data_unavailable',source:SOURCE,prices:{}});
    const size=Number(response.headers.get('content-length'));
    if(Number.isFinite(size)&&size>MAX_RESPONSE_BYTES)
      return send(res,502,{status:'market_data_unavailable',source:SOURCE,prices:{}});
    const raw=await response.text();
    if(Buffer.byteLength(raw,'utf8')>MAX_RESPONSE_BYTES)
      return send(res,502,{status:'market_data_unavailable',source:SOURCE,prices:{}});
    const mids=JSON.parse(raw);
    if(!mids||typeof mids!=='object'||Array.isArray(mids))
      return send(res,502,{status:'market_data_unavailable',source:SOURCE,prices:{}});
    const prices=Object.create(null),unavailable=[];
    for(const asset of assets){
      if(!Object.prototype.hasOwnProperty.call(mids,asset)){
        unavailable.push(asset);
        continue;
      }
      const p=finitePrice(mids[asset]);
      if(p===null)unavailable.push(asset);
      else prices[asset]=p;
    }
    return send(res,200,{status:'ok',source:SOURCE,market:'hyperliquid_mainnet_perpetuals',
      quote_type:'indicative_mid_usd',retrieved_at:new Date().toISOString(),
      prices,unavailable,disclosure:'MARKET_INDICATION_NOT_EXECUTABLE_PRICE'});
  }catch{
    return send(res,502,{status:'market_data_unavailable',source:SOURCE,prices:{}});
  }
};
