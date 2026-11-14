'use strict';
// Wallet login proof only, not a paid account. No subscription entitlement is granted.
const crypto=require('node:crypto');
const HMAC_LABEL='imperian-wallet-login-v1';
const ADDRESS=/^0x[0-9a-fA-F]{40}$/;
function key(){const s=process.env.IMPERIAN_SESSION_SECRET;return typeof s==='string'&&s.length>=64?s:null;}
function b64(x){return Buffer.from(typeof x==='string'?x:JSON.stringify(x),'utf8').toString('base64url');}
function unb64(s){return Buffer.from(s,'base64url').toString('utf8');}
function sign(obj,secret){
 const payload=b64(obj),hash=crypto.createHmac('sha256',secret).update(HMAC_LABEL+'.'+payload).digest('base64url');
 return payload+'.'+hash;
}
function read(token,secret,now=Date.now()){
 if(typeof token!=='string'||token.length>1500)return null;
 const parts=token.split('.');if(parts.length!==2||!parts[0]||!parts[1])return null;
 const expected=crypto.createHmac('sha256',secret).update(HMAC_LABEL+'.'+parts[0]).digest();
 const mac=Buffer.from(parts[1],'base64url');if(mac.length!==expected.length||
    !crypto.timingSafeEqual(mac,expected))return null;
 try{
  const v=JSON.parse(unb64(parts[0]));
  return v&&Number.isSafeInteger(v.exp)&&v.exp>=now&&v.exp<=now+8*86400000?v:null;
 }catch{return null;}
}
function headers(req){
 const host=String(req.headers?.host||'').toLowerCase();
 const allowed=String(process.env.IMPERIAN_ALLOWED_HOSTS||'tkempire.io,www.tkempire.io')
  .split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);
 return allowed.includes(host)?host:null;
}
function originOk(req,host){return req.headers?.origin==='https://'+host;}
function cookies(req){
 return Object.fromEntries(String(req.headers?.cookie||'').split(';').map(x=>x.trim()).filter(x=>x.includes('=')).map(x=>{
  const i=x.indexOf('=');return [x.slice(0,i),x.slice(i+1)];
 }));
}
function putCookie(res,name,value,maxAge){
 res.setHeader('Set-Cookie',name+'='+value+'; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age='+maxAge);
}
function clearCookie(res,name){
 res.setHeader('Set-Cookie',name+'=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0');
}
function send(res,code,obj){
 res.setHeader('Cache-Control','no-store');
 res.setHeader('X-Content-Type-Options','nosniff');
 return res.status(code).json(obj);
}
function challengeData(host,now=Date.now()){
 const nonce=crypto.randomBytes(16).toString('hex');
 const expiration=new Date(now+5*60*1000).toISOString();
 return {nonce,domain:host,uri:'https://'+host+'/imperian.html',
  issuedAt:new Date(now).toISOString(),expirationTime:expiration,chainId:137};
}
function message(data,address){
 return data.domain+' wants you to sign in with your Ethereum account:\n'+address+
  '\n\nSign in to Imperian. This signature does not authorize a payment or trade.'+
  '\n\nURI: '+data.uri+'\nVersion: 1\nChain ID: 137\nNonce: '+data.nonce+
  '\nIssued At: '+data.issuedAt+'\nExpiration Time: '+data.expirationTime;
}
function verifyMessageFields(messageValue,challenge,address){
 if(typeof messageValue!=='string'||messageValue.length>1100||
    !ADDRESS.test(address)||messageValue!==message(challenge,address))return false;
 return true;
}
module.exports={key,sign,read,headers,originOk,cookies,putCookie,clearCookie,send,challengeData,message,verifyMessageFields};
