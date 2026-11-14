'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const settlement=require('../lib/imperian-settlement.js');
const auth=require('../lib/imperian-auth.js');
const web=require('../api/imperian/availability.js');
const challenge=require('../api/imperian/challenge.js');
const session=require('../api/imperian/session.js');
const fs=require('node:fs'),path=require('node:path');
function res(){return{headers:{},setHeader(k,v){this.headers[k]=v;return this},
 status(n){this.code=n;return this},json(v){this.data=v;return this}};}
const wallet='0x'+'a1'.repeat(20),treasury='0x'+'b2'.repeat(20);
function word(a){return '0x'+'0'.repeat(24)+a.slice(2);}
const tx='0x'+'1c'.repeat(32);
function receipt({asset=settlement.USDC_POLYGON.token,to=treasury,from=wallet,amount=30000000n,block='0x20',end='0x48',status='0x1',logsExtra=[]}={}){
 return {invoice:{rail:'USDC_POLYGON',wallet,rate_usdc:30,tx_hash:tx},
   chainId:137,tipBlock:end,treasury,
   receipt:{transactionHash:tx,status,blockNumber:block,to:settlement.USDC_POLYGON.token,
    logs:[{address:asset,topics:[settlement.ERC20_TRANSFER,word(from),word(to)],
      data:'0x'+amount.toString(16).padStart(64,'0'),logIndex:'0x0'},...logsExtra]}};
}
test('unique native USDC transfer with enough confirmations is accepted',()=>{
 const r=settlement.verifyUsdcReceipt(receipt());
 assert.equal(r.ok,true);assert.equal(r.amount_usdc,30);
 assert.equal(r.payment_ref,tx+':0');
});
test('replay identifiers, wrong token, amount, sender, recipient, chain, confirmation reject',()=>{
 const samples=[
 receipt({asset:'0x'+'dd'.repeat(20)}),
 receipt({from:treasury}),
 receipt({to:wallet}),
 receipt({amount:29999999n}),
 receipt({end:'0x21'}),
 receipt({status:'0x0'})
 ];
 let r=receipt();r.chainId=1;samples.push(r);
 r=receipt();r.invoice.rate_usdc=55;samples.push(r);
 r=receipt();r.receipt.transactionHash='0x'+'00'.repeat(32);samples.push(r);
 r=receipt();r.receipt.logs.push({...r.receipt.logs[0],logIndex:'0x1'});samples.push(r);
 for(const v of samples)assert.equal(settlement.verifyUsdcReceipt(v).ok,false);
});
test('XMR unlocked invoice requires sufficient unique subaddress payment with confirmations',()=>{
 const address='8'+'A'.repeat(94);
 const invoice={rail:'XMR',address,expected_atomic:'10000000000'};
 const receipt={complete:true,amount:{expected:10000000000,covered:{total:10000000000,unlocked:10000000000}},
 transactions:[{locked:false,double_spend_seen:false,confirmations:12,tx_hash:'a'.repeat(64)}]};
 const ok=settlement.verifyMoneroPay({invoice,receipt});
 assert.equal(ok.ok,true);assert.equal(ok.payment_ref,'xmr:'+address);
 assert.equal(settlement.verifyMoneroPay({invoice,receipt:{...receipt,complete:false}}).ok,false);
 assert.equal(settlement.verifyMoneroPay({invoice,receipt:{...receipt,transactions:[{...receipt.transactions[0],locked:true}]}}).ok,false);
});
test('XMR fixed point quote requires fresh price and valid rate',()=>{
 assert.equal(settlement.quoteXmrAtomic(30,150000000,100000,180000),'200000000000');
 assert.throws(()=>settlement.quoteXmrAtomic(30,150000000,100000,300000));
 assert.throws(()=>settlement.quoteXmrAtomic(55,150000000,100000,180000));
});
test('signed auth token validates expiry, tampering and domain-bound SIWE',()=>{
 const k='a'.repeat(64),data=auth.challengeData('tkempire.io',100000);
 const signed=auth.sign({...data,exp:100000+300000},k);
 assert.equal(auth.read(signed,k,110000).nonce,data.nonce);
 assert.equal(auth.read(signed,k,999999),null);
 assert.equal(auth.read(signed+'broken',k,110000),null);
 const msg=auth.message(data,wallet);
 assert.equal(auth.verifyMessageFields(msg,data,wallet),true);
 assert.equal(auth.verifyMessageFields(msg.replace('tkempire.io','evil.test'),data,wallet),false);
});
test('payment availability endpoint reports disabled and refuses writes',async()=>{
 const get=res();await web({method:'GET'},get);
 assert.equal(get.code,200);assert.equal(get.data.billing_enabled,false);
 assert.equal(get.data.paid_access_enabled,false);
 assert.deepEqual(get.data.settlement_options.map(x=>x.rail),['USDC_POLYGON','XMR']);
 const post=res();await web({method:'POST'},post);assert.equal(post.code,405);
});
test('auth API fails closed without session configuration',async()=>{
 const prev=process.env.IMPERIAN_SESSION_SECRET;
 try{
  delete process.env.IMPERIAN_SESSION_SECRET;
  const request={method:'POST',headers:{host:'tkempire.io',origin:'https://tkempire.io'}};
  const x=res();await challenge(request,x);assert.equal(x.code,503);
  const y=res();await session({...request,method:'GET'},y);assert.equal(y.code,503);
 }finally{if(prev!==undefined)process.env.IMPERIAN_SESSION_SECRET=prev;}
});
test('preview has no payable address, active purchase or trading execution',()=>{
 const html=fs.readFileSync(path.join(__dirname,'../imperian.html'),'utf8');
 const script=fs.readFileSync(path.join(__dirname,'../assets/js/imperian-portal.js'),'utf8');
 assert.match(html,/no payment required or accepted/i);
 assert.match(html,/Checkout opens after verification/);
 assert.match(html,/disabled aria-disabled="true"/);
 assert.doesNotMatch(script,/eth_sendTransaction|wallet_sendCalls|placeOrder|sendRawTransaction/);
 assert.doesNotMatch(html,/0x3c499c542cef|BEGIN PRIVATE KEY/);
});


test('EOA login verifies exact signed challenge and never grants paid access',async()=>{
 const {Wallet}=require('ethers');
 const prev={secret:process.env.IMPERIAN_SESSION_SECRET,hosts:process.env.IMPERIAN_ALLOWED_HOSTS};
 process.env.IMPERIAN_SESSION_SECRET='z'.repeat(72);
 process.env.IMPERIAN_ALLOWED_HOSTS='tkempire.io';
 try{
  const w=Wallet.createRandom();
  const ch=res();
  await challenge({method:'POST',headers:{host:'tkempire.io',origin:'https://tkempire.io'}},ch);
  assert.equal(ch.code,200);
  const token=ch.headers['Set-Cookie'].split(';')[0];
  const payload={address:w.address,message:auth.message(ch.data.challenge,w.address)};
  payload.signature=await w.signMessage(payload.message);
  const result=res();
  await session({method:'POST',headers:{host:'tkempire.io',origin:'https://tkempire.io',cookie:token},body:payload},result);
  assert.equal(result.code,200);
  assert.equal(result.data.entitlement,'NOT_ENABLED');
  assert.equal(result.data.address,w.address.toLowerCase());
  const cookie=result.headers['Set-Cookie'].find(s=>s.startsWith('imperian_session=')).split(';')[0];
  const readback=res();
  await session({method:'GET',headers:{host:'tkempire.io',cookie}},readback);
  assert.equal(readback.data.status,'wallet_authenticated');
  assert.equal(readback.data.entitlement,'NOT_ENABLED');
  const wrong=res();
  await session({method:'POST',headers:{host:'tkempire.io',origin:'https://tkempire.io',cookie:token},
    body:{...payload,address:'0x'+'1'.repeat(40)}},wrong);
  assert.notEqual(wrong.code,200);
 }finally{
  if(prev.secret===undefined)delete process.env.IMPERIAN_SESSION_SECRET;else process.env.IMPERIAN_SESSION_SECRET=prev.secret;
  if(prev.hosts===undefined)delete process.env.IMPERIAN_ALLOWED_HOSTS;else process.env.IMPERIAN_ALLOWED_HOSTS=prev.hosts;
 }
});


test('pricing explanation distinguishes new joiner bands from an existing member ceiling',()=>{
 const page=fs.readFileSync(path.join(__dirname,'../imperian.html'),'utf8');
 const rule=fs.readFileSync(path.join(__dirname,'../lib/imperian-pricing-policy.js'),'utf8');
 for(const token of ['What NEW members would pay','Your original rate becomes your ceiling',
   'Your renewal may drop','99 USDC ceiling never increases','future renewals only',
   'EXAMPLE · NOT A LIVE PRICE','not</strong> been activated']){
   assert.ok(page.includes(token),'Missing pricing explanation: '+token);
 }
 for(const [floor,rate] of [[0,30],[55,49],[60,99],[65,199],[70,300]]){
   assert.equal(require('../lib/imperian-pricing-policy.js').rateForWinRate(floor),rate);
 }
 for(const exact of [
  '<td>Genesis improves</td><td>199 USDC</td><td>99 USDC</td>',
  '<td>Genesis declines</td><td>49 USDC</td><td>49 USDC</td>',
  '<td>Genesis later recovers</td><td>300 USDC</td><td>99 USDC</td>'
 ])assert.ok(page.includes(exact),'Missing renewal example '+exact);
 assert.ok(page.includes('No payment required or accepted')||
           page.includes('no payment required or accepted'));
 assert.ok(!page.includes('id="checkout-pay"'));
 assert.match(rule,/Math\.min\(member\.locked_max_rate_usdc/);
});
