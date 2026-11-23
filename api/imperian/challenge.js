'use strict';
const a=require('../../lib/imperian-auth.js');
module.exports=async function challenge(req,res){
 if(req.method!=='POST'){res.setHeader('Allow','POST');return a.send(res,405,{status:'method_not_allowed'});}
 const host=a.headers(req),secret=a.key();
 if(!secret||!host)return a.send(res,503,{status:'wallet_auth_unavailable'});
 if(!a.originOk(req,host))return a.send(res,403,{status:'origin_rejected'});
 const d=a.challengeData(host);
 a.putCookie(res,'imperian_challenge',a.sign({...d,exp:Date.now()+5*60000},secret),300);
 return a.send(res,200,{status:'challenge',challenge:d});
};
