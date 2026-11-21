'use strict';
/* Read-only market telemetry. The observed numbers are NOT trade predictions. */
(function(root,factory){
  const core=factory();
  if(typeof module==='object'&&module.exports)module.exports=core;
  if(root)root.GenesisMarketPulse=core;
})(typeof globalThis!=='undefined'?globalThis:null,function(){
  const ASSETS=Object.freeze(['BNB','SOL','APT']);
  const SOURCE='HYPERLIQUID_PERP_MID';
  const MARKET='hyperliquid_mainnet_perpetuals';
  const DISCLOSURE='MARKET_INDICATION_NOT_EXECUTABLE_PRICE';
  const MAX_QUOTE_AGE_MS=15000;
  const MAX_SAMPLE_AGE_MS=90000;
  const MAX_RENDER_AGE_MS=20000;
  function validPrice(p){return typeof p==='number'&&Number.isFinite(p)&&p>0&&p<=1e9;}
  function parseQuote(data,now){
    if(!data||typeof data!=='object'||Array.isArray(data)||data.schema_version!==1||
      data.status!=='ok'||data.source!==SOURCE||data.market!==MARKET||
      data.quote_type!=='indicative_mid_usd'||data.disclosure!==DISCLOSURE||
      !data.prices||typeof data.prices!=='object'||Array.isArray(data.prices)||
      typeof data.retrieved_at!=='string'||!/^\d{4}-\d\d-\d\dT/.test(data.retrieved_at))return null;
    const t=Date.parse(data.retrieved_at),age=now-t;
    if(!Number.isFinite(t)||!Number.isFinite(age)||age<0||age>MAX_QUOTE_AGE_MS)return null;
    const prices={};
    for(const asset of ASSETS){
      const p=data.prices[asset];
      if(validPrice(p))prices[asset]=p;
    }
    return {timestamp:t,prices,source:SOURCE};
  }
  function addQuote(series,quote){
    // One chronological watermark across the whole snapshot. A late or repeated
    // response must never erase newer observations or backfill missing assets.
    const previous=series&&typeof series==='object'&&!Array.isArray(series)?series:{};
    if(!quote||!Number.isFinite(quote.timestamp)||!quote.prices||
      typeof quote.prices!=='object'||Array.isArray(quote.prices))return previous;
    let watermark=-Infinity;
    for(const asset of ASSETS){
      const samples=Array.isArray(previous[asset])?previous[asset]:[];
      for(const sample of samples){
        if(sample&&Number.isFinite(sample.t))watermark=Math.max(watermark,sample.t);
      }
    }
    // Ignore too-soon off-cycle clicks: they otherwise displace the last valid
    // 10-second sample trio and force READY back to COLLECTING.
    if(quote.timestamp<=watermark||quote.timestamp-watermark<6000)return previous;
    // Every third sample must span at least 18 seconds, even after an
    // off-cycle manual refresh. Reject too-short windows rather than publish
    // an irregular trio or lose a previously READY result.
    for(const asset of ASSETS){
      if(!validPrice(quote.prices[asset]))continue;
      const existing=Array.isArray(previous[asset])?previous[asset]:[];
      if(existing.length>=2&&quote.timestamp-existing[existing.length-2].t<18000)
        return previous;
    }
    const next={};
    for(const asset of ASSETS){
      const prev=Array.isArray(previous[asset])?previous[asset]:[];
      let history=prev.filter(x=>x&&Number.isFinite(x.t)&&validPrice(x.p)&&
        x.t<=quote.timestamp&&quote.timestamp-x.t<=MAX_SAMPLE_AGE_MS);
      if(validPrice(quote.prices[asset])&&(!history.length||history[history.length-1].t<quote.timestamp)){
        history=history.concat({t:quote.timestamp,p:quote.prices[asset]});
      }
      next[asset]=history.slice(-12);
    }
    return next;
  }
  function metrics(series,now){
    const arr=Array.isArray(series)?series:[];
    if(!arr.length)return {state:'COLLECTING'};
    const latest=arr[arr.length-1];
    if(!latest||!validPrice(latest.p)||!Number.isFinite(latest.t)||
      now<latest.t||now-latest.t>MAX_RENDER_AGE_MS)return {state:'STALE'};
    if(arr.length<3)return {state:'COLLECTING',last:latest.p,samples:arr.length};
    const [a,b,c]=arr.slice(-3);
    const x=(b.t-a.t)/1000,y=(c.t-b.t)/1000,span=x+y;
    if(x<6||x>16||y<6||y>16||span<18||span>30)
      return {state:'COLLECTING',last:latest.p,samples:arr.length};
    if(!validPrice(a.p)||!validPrice(b.p)||!validPrice(c.p))return {state:'STALE'};
    const moveBps=10000*Math.log(c.p/a.p);
    const earlierSpeed=10000*Math.log(b.p/a.p)/x;
    const speedBpsPerSec=10000*Math.log(c.p/b.p)/y;
    const accelerationBpsPerSec2=(speedBpsPerSec-earlierSpeed)/(span/2);
    if(![moveBps,speedBpsPerSec,accelerationBpsPerSec2].every(Number.isFinite))return {state:'STALE'};
    const direction=Math.abs(moveBps)<1?'FLAT':moveBps>0?'RISING':'FALLING';
    return {state:'READY',last:c.p,samples:arr.length,windowSeconds:span,
      moveBps,speedBpsPerSec,accelerationBpsPerSec2,direction};
  }
  return Object.freeze({ASSETS,SOURCE,parseQuote,addQuote,metrics});
});
