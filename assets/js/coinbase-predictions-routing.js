'use strict';
/* Navigation only: Polymarket wallet-flow observations are not Coinbase/Kalshi contracts. */
(function(root){
 const BASE='https://www.coinbase.com/predictions';
 const CATEGORIES=Object.freeze([
  {name:'BTC',pattern:/(?:^|[^a-z])(?:btc|bitcoin)(?=[^a-z]|$)/i,url:BASE+'/crypto/BTC'},
  {name:'ETH',pattern:/(?:^|[^a-z])(?:eth|ethereum)(?=[^a-z]|$)/i,url:BASE+'/crypto/ETH'},
  {name:'SOL',pattern:/(?:^|[^a-z])(?:sol|solana)(?=[^a-z]|$)/i,url:BASE+'/crypto/SOL'}
 ]);
 const OTHER_CRYPTO=/(?:^|[^a-z])(?:bnb|doge|dogecoin|xrp|ripple|avax|avalanche|chainlink|link|cardano|ada|litecoin|ltc|crypto)(?=[^a-z]|$)/i;
 function route(title){
  const label=typeof title==='string'?title.slice(0,500):'';
  for(const entry of CATEGORIES)if(entry.pattern.test(label)){
   return {url:entry.url,label:'Browse Coinbase '+entry.name+' predictions',matched_contract:false,category:entry.name};
  }
  if(OTHER_CRYPTO.test(label))return {url:BASE+'/crypto',label:'Browse Coinbase crypto predictions',matched_contract:false,category:'crypto'};
  return {url:BASE,label:'Browse Coinbase predictions',matched_contract:false,category:'all'};
 }
 if(root)root.empireCoinbasePredictionsRoute=route;
 if(typeof module!=='undefined'&&module.exports)module.exports={route};
})(typeof window==='object'?window:null);
