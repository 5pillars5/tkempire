'use strict';
// Safe gross mark-to-entry math for canonical Genesis PAPER_OPEN positions.
// This never computes whole-position P&L without a verified position quantity.
// Quotes are indicative Hyperliquid perpetual mid-prices, not exchange fills.
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.GenesisPaperMark=api;
})(typeof window==='object'?window:globalThis,function(){
  function validPrice(n){
    return typeof n==='number'&&Number.isFinite(n)&&n>0&&n<=1e9;
  }
  function calculate(position,currentMid){
    if(!position||position.stage!=='PAPER_OPEN'||
      position.paper_position_verified!==true||
      !['BUY','SELL'].includes(position.side)||
      !validPrice(position.trigger)||!validPrice(currentMid))return null;
    const entry=position.trigger;
    // SELL benefits when the market declines; BUY benefits when it rises.
    const perCoin=(position.side==='BUY'?currentMid-entry:entry-currentMid);
    const pct=(perCoin/entry)*100;
    if(!Number.isFinite(perCoin)||!Number.isFinite(pct))return null;
    return Object.freeze({
      entryPrice:entry,currentMid,perCoinUsd:perCoin,
      priceReturnPct:pct,unit:'one_coin',gross:true,
      positionTotalAvailable:false
    });
  }
  return Object.freeze({calculate});
});
