'use strict';
const a=require('../../lib/imperian-auth.js');
const crypto=require('node:crypto');
function validMethod(req,res){return req.method==='GET'||req.method==='POST'||req.method==='DELETE';}
module.exports=async function session(req,res){
 if(!validMethod(req,res)){res.setHeader('Allow','GET, POST, DELETE');return a.send(res,405,{status:'method_not_allowed'});}
 const secret=a.key(),host=a.headers(req);
 if(!secret||!host)return a.send(res,503,{status:'wallet_auth_unavailable'});
 const cookies=a.cookies(req);
 if(req.method==='GET'){
   const s=a.read(cookies.imperian_session,secret);
   return a.send(res,200,s&&s.kind==='session'?
    {status:'wallet_authenticated',address:s.address,entitlement:'NOT_ENABLED'}:
    {status:'not_authenticated'});
 }
 if(!a.originOk(req,host))return a.send(res,403,{status:'origin_rejected'});
 if(req.method==='DELETE'){
   a.clearCookie(res,'imperian_session');
   return a.send(res,200,{status:'signed_out'});
 }
 const token=a.read(cookies.imperian_challenge,secret);
 if(!token||token.domain!==host||!token.nonce||token.chainId!==137||
    Date.parse(token.expirationTime)<Date.now())
    return a.send(res,403,{status:'challenge_expired'});
 const body=req.body;
 if(!body||typeof body!=='object'||Array.isArray(body)||
    !a.verifyMessageFields(body.message,token,body.address)||
    typeof body.signature!=='string'||!/^0x[0-9a-f]{130}$/i.test(body.signature))
    return a.send(res,400,{status:'invalid_signature_payload'});
 let recovered;
 try{
  const ethers=require('ethers');
  recovered=ethers.verifyMessage(body.message,body.signature);
 }catch{return a.send(res,403,{status:'invalid_signature'});}
 if(recovered.toLowerCase()!==body.address.toLowerCase())
   return a.send(res,403,{status:'wallet_mismatch'});
 // Preview authentication only. Before production, replace stateless challenge
 // with a persistent, single-use nonce table and EIP-1271 contract support.
 const expiry=Date.now()+24*3600000;
 const sessionToken=a.sign({kind:'session',address:body.address.toLowerCase(),
   id:crypto.randomBytes(16).toString('hex'),exp:expiry},secret);
 a.clearCookie(res,'imperian_challenge');
 // Last Set-Cookie wins in Node unless an array is used.
 res.setHeader('Set-Cookie',[
   'imperian_challenge=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0',
   'imperian_session='+sessionToken+'; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=86400'
 ]);
 return a.send(res,200,{status:'wallet_authenticated',
   address:body.address.toLowerCase(),entitlement:'NOT_ENABLED'});
};
