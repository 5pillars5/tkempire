'use strict';
(()=>{
const connect=document.getElementById('connect');
const disconnect=document.getElementById('disconnect');
const status=document.getElementById('status');
const account=document.getElementById('account');
const usdc=document.getElementById('usdc');
const xmr=document.getElementById('xmr');
const details=document.getElementById('privacy-details');
function report(message){status.textContent=String(message);}
function short(a){return a.slice(0,6)+'…'+a.slice(-4);}
function setAuth(address){
 account.textContent=address?short(address):'Not connected';
 if(address)account.title=address;else account.removeAttribute('title');
 disconnect.disabled=!address;
}
function select(rail){
 const isXmr=rail==='xmr';
 usdc.classList.toggle('selected',!isXmr);
 xmr.classList.toggle('selected',isXmr);
 usdc.setAttribute('aria-pressed',String(!isXmr));
 xmr.setAttribute('aria-pressed',String(isXmr));
 details.textContent=isXmr
  ? 'XMR payments will use a unique merchant invoice subaddress. Public Monero transfers do not expose the sending wallet, recipient or amount in the way transparent blockchains do. Imperian still knows the wallet used to sign in, and payment must be privately associated with an account.'
  : 'USDC is traceable on Polygon. For better separation, consider using a dedicated membership wallet instead of your main trading wallet.';
}
usdc.addEventListener('click',()=>select('usdc'));
xmr.addEventListener('click',()=>select('xmr'));
async function json(url,method='GET',body){
 const response=await fetch(url,{method,credentials:'same-origin',
  headers:body?{'Content-Type':'application/json'}:{},
  body:body?JSON.stringify(body):undefined,cache:'no-store'});
 const result=await response.json();
 if(!response.ok)throw Error(result.status||'service_unavailable');
 return result;
}
async function existing(){
 try{
  const result=await json('/api/imperian/session');
  if(result.status==='wallet_authenticated'&&/^0x[0-9a-fA-F]{40}$/.test(result.address)){
   setAuth(result.address);report('Wallet proof accepted. Paid member access is not active.');
  }
 }catch{report('Wallet login service not enabled yet. Payments remain disabled.');}
}
connect.addEventListener('click',async()=>{
 if(!window.ethereum||!window.ethereum.request){
  report('Install a compatible EVM browser wallet to use sign-in. Payments are not yet open.');return;
 }
 connect.disabled=true;
 try{
  const list=await window.ethereum.request({method:'eth_requestAccounts'});
  const address=Array.isArray(list)?list[0]:null;
  if(typeof address!=='string'||!/^0x[0-9a-fA-F]{40}$/.test(address))
   throw Error('WALLET_ADDRESS_INVALID');
  const challenge=await json('/api/imperian/challenge','POST');
  const d=challenge.challenge;
  if(!d||d.domain!==location.host||d.chainId!==137||typeof d.nonce!=='string')
   throw Error('INVALID_LOGIN_CHALLENGE');
  const message=d.domain+' wants you to sign in with your Ethereum account:\n'+address+
  '\n\nSign in to Imperian. This signature does not authorize a payment or trade.'+
  '\n\nURI: '+d.uri+'\nVersion: 1\nChain ID: 137\nNonce: '+d.nonce+
  '\nIssued At: '+d.issuedAt+'\nExpiration Time: '+d.expirationTime;
  const signature=await window.ethereum.request({method:'personal_sign',params:[message,address]});
  const result=await json('/api/imperian/session','POST',{address,message,signature});
  if(result.status!=='wallet_authenticated')throw Error('LOGIN_NOT_VERIFIED');
  setAuth(result.address);
  report('Wallet signature verified. Paid member access is not active.');
 }catch(err){
  const known={'wallet_auth_unavailable':'Wallet login is not enabled on this deployment.',
    'origin_rejected':'Login security policy blocked this request.',
    'User rejected the request.':'Wallet request canceled.',
    '4001':'Wallet request canceled.'};
  report(known[err.message]||'Sign-in not completed. No payment was attempted.');
 }finally{connect.disabled=false;}
});
disconnect.addEventListener('click',async()=>{
 try{await json('/api/imperian/session','DELETE');}catch{}
 setAuth(null);report('Signed out of Imperian website session.');
});
if(window.ethereum&&window.ethereum.on){
 window.ethereum.on('accountsChanged',()=>{setAuth(null);report('Wallet changed. Sign in again to verify control.');});
}
existing();
})();
