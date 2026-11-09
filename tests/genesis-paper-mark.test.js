'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const mark=require('../assets/js/genesis-paper-mark.js');
const paper=(side='BUY',extra={})=>({
  stage:'PAPER_OPEN',paper_position_verified:true,trigger:100,side,...extra
});
test('BUY paper gain and loss are direction-aware',()=>{
  assert.deepEqual({...mark.calculate(paper('BUY'),110)},{
    entryPrice:100,currentMid:110,perCoinUsd:10,priceReturnPct:10,
    unit:'one_coin',gross:true,positionTotalAvailable:false});
  assert.equal(mark.calculate(paper('BUY'),90).perCoinUsd,-10);
});
test('SELL paper gain and loss are direction-aware',()=>{
  assert.equal(mark.calculate(paper('SELL'),90).perCoinUsd,10);
  assert.equal(mark.calculate(paper('SELL'),110).perCoinUsd,-10);
  assert.equal(mark.calculate(paper('SELL'),110).priceReturnPct,-10);
});
test('missing price, unverified position or non-paper setup has no PnL',()=>{
  const cases=[
    [paper('BUY'),null],[paper('BUY'),NaN],
    [paper('BUY'),Infinity],[paper('BUY'),0],
    [paper('BUY',{trigger:null}),120],
    [paper('BUY',{paper_position_verified:false}),120],
    [paper('BUY',{stage:'QUALIFIED'}),120],
    [paper('HOLD'),120],
    [paper('BUY',{trigger:0}),120],
    [null,120]
  ];
  for(const [p,quote] of cases)assert.equal(mark.calculate(p,quote),null);
});
test('coin-price movement never manufactures a dollar position total',()=>{
  const r=mark.calculate(paper('SELL',{quantity:9999}),90);
  assert.equal(r.positionTotalAvailable,false);
  assert.equal(r.perCoinUsd,10);
  assert.equal(Object.hasOwn(r,'totalPnl'),false);
  assert.equal(Object.hasOwn(r,'quantity'),false);
});
