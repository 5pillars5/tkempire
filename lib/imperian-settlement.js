'use strict';
/*
 * Imperian settlement policy v1 — pure, offline-checkable and fail-closed.
 * No payment instruction or RPC is authorized from this file.
 * An authenticated server adapter MUST independently fetch receipt data,
 * reconcile an invoice once, and atomically persist it.
 */
const USDC_POLYGON=Object.freeze({
  chain_id:137,
  token:'0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',
  decimals:6,
  confirmations:40
});
const ERC20_TRANSFER='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ADDRESS=/^0x[0-9a-f]{40}$/i;
const TX=/^0x[0-9a-f]{64}$/i;
const XMR_ADDRESS=/^[48][1-9A-HJ-NP-Za-km-z]{94}$/;
function validAddress(v){return typeof v==='string'&&ADDRESS.test(v);}
function lower(v){return v.toLowerCase();}
function positiveInteger(v){return Number.isSafeInteger(v)&&v>0;}
function safeSame(a,b){return validAddress(a)&&validAddress(b)&&lower(a)===lower(b);}
function invoiceAmounts(rate){
  if(![30,49,99,199,300].includes(rate))throw Error('UNAPPROVED_RATE');
  return BigInt(rate)*1000000n;
}
function fixedHexWordAddress(word){
  if(typeof word!=='string'||!/^0x[0-9a-fA-F]{64}$/.test(word))return null;
  if(!/^0{24}$/i.test(word.slice(2,26)))return null;
  return '0x'+word.slice(26).toLowerCase();
}
function parseHexQuantity(value){
  if(typeof value!=='string'||!/^0x[0-9a-f]+$/i.test(value))return null;
  return BigInt(value);
}
/**
 * receipt is the unmodified eth_getTransactionReceipt envelope obtained by
 * server from a pinned trusted Polygon RPC; chainId and tip are fetched
 * independently via eth_chainId and eth_blockNumber.
 */
function verifyUsdcReceipt({invoice,receipt,chainId,tipBlock,treasury}={}){
  if(!invoice||invoice.rail!=='USDC_POLYGON'||!validAddress(invoice.wallet)||
     ![30,49,99,199,300].includes(invoice.rate_usdc)||!TX.test(invoice.tx_hash||'')||
     !validAddress(treasury)||chainId!==137||!receipt||
     !Array.isArray(receipt.logs))
    return {ok:false,reason:'INVALID_CONTEXT'};
  const toBlock=parseHexQuantity(tipBlock),block=parseHexQuantity(receipt.blockNumber);
  if(receipt.status!=='0x1'||!TX.test(receipt.transactionHash||'')||
     lower(receipt.transactionHash)!==lower(invoice.tx_hash)||
     block===null||toBlock===null||toBlock<block||
     toBlock-block+1n<BigInt(USDC_POLYGON.confirmations))
    return {ok:false,reason:'RECEIPT_NOT_FINAL'};
  if(!safeSame(receipt.to,USDC_POLYGON.token))
    return {ok:false,reason:'WRONG_TRANSACTION_TARGET'};
  const matches=[];
  const expected=invoiceAmounts(invoice.rate_usdc);
  for(const log of receipt.logs){
    if(!safeSame(log.address,USDC_POLYGON.token)||
       !Array.isArray(log.topics)||log.topics.length!==3||
       String(log.topics[0]).toLowerCase()!==ERC20_TRANSFER)continue;
    const sender=fixedHexWordAddress(log.topics[1]);
    const receiver=fixedHexWordAddress(log.topics[2]);
    const value=parseHexQuantity(log.data);
    const index=parseHexQuantity(log.logIndex);
    if(sender!==null&&receiver!==null&&index!==null&&
       safeSame(sender,invoice.wallet)&&safeSame(receiver,treasury)&&
       value===expected)matches.push(index.toString(10));
  }
  if(matches.length!==1)return {ok:false,reason:'NO_UNIQUE_PAYMENT_TRANSFER'};
  return {ok:true,rail:'USDC_POLYGON',amount_usdc:invoice.rate_usdc,
    payment_ref:lower(invoice.tx_hash)+':'+matches[0],confirmations:Number(toBlock-block+1n)};
}
/**
 * MoneroPay's authenticated GET /receive/:subaddress response must come
 * from an operator-controlled instance via an authenticated private network.
 * XMR payer is NOT visible and must never be inferred from a public wallet.
 */
function verifyMoneroPay({invoice,receipt}={}){
  if(!invoice||invoice.rail!=='XMR'||typeof invoice.address!=='string'||
      !XMR_ADDRESS.test(invoice.address)||typeof invoice.expected_atomic!=='string'||
      !/^[1-9]\d{0,18}$/.test(invoice.expected_atomic)||!receipt||
      receipt.complete!==true||!receipt.amount||
      !Array.isArray(receipt.transactions))
    return {ok:false,reason:'INVALID_MONERO_CONTEXT'};
  const amount=receipt.amount;
  if(!amount.covered||String(amount.expected)!==invoice.expected_atomic||
     !/^\d+$/.test(String(amount.covered.unlocked))||
     BigInt(amount.covered.unlocked)<BigInt(invoice.expected_atomic))
    return {ok:false,reason:'MONERO_NOT_UNLOCKED'};
  const confirmed=receipt.transactions.filter(t=>{
    return t&&t.locked===false&&t.double_spend_seen===false&&
       Number.isSafeInteger(t.confirmations)&&t.confirmations>=10&&
       typeof t.tx_hash==='string'&&/^[0-9a-f]{64}$/i.test(t.tx_hash);
  });
  if(confirmed.length===0)return {ok:false,reason:'MONERO_CONFIRMATIONS_MISSING'};
  return {ok:true,rail:'XMR',payment_ref:'xmr:'+invoice.address,
    // One subaddress per invoice, not a claimed sender address.
    confirmations:Math.min(...confirmed.map(x=>x.confirmations))};
}
/**
 * Fixed-point XMR quote from a separately authenticated recent USD/XMR feed.
 * Rate represented as whole microdollars per XMR; returns atomic piconero.
 * A quote is frozen only until invoice expiration; late payments are manual.
 */
function quoteXmrAtomic(rateUsdc,priceMicrousd,priceTimeMs,nowMs){
  const micro=invoiceAmounts(rateUsdc);
  if(!Number.isSafeInteger(priceMicrousd)||priceMicrousd<1000000||
     !Number.isSafeInteger(priceTimeMs)||!Number.isSafeInteger(nowMs)||
     priceTimeMs>nowMs+30000||nowMs-priceTimeMs>120000)
    throw Error('XMR_USD_QUOTE_NOT_FRESH');
  const result=(micro*1000000000000n+BigInt(priceMicrousd)-1n)/BigInt(priceMicrousd);
  if(result<=0n||result>9999999999999999999n)throw Error('INVALID_MONERO_AMOUNT');
  return result.toString(10);
}
module.exports={USDC_POLYGON,ERC20_TRANSFER,invoiceAmounts,verifyUsdcReceipt,
 verifyMoneroPay,quoteXmrAtomic};
