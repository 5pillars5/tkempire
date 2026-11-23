'use strict';
// Never accepts payment, returns treasury address or grants member permissions.
const {LADDER}=require('../../lib/imperian-pricing-policy.js');
module.exports=async function availability(req,res){
 res.setHeader('Cache-Control','no-store');
 res.setHeader('X-Content-Type-Options','nosniff');
 if(req.method!=='GET'){res.setHeader('Allow','GET');return res.status(405).json({status:'method_not_allowed'});}
 return res.status(200).json({
   status:'DESIGN_PREVIEW_NO_PAYMENTS',
   wallet_authentication:'CONFIG_REQUIRED',
   billing_enabled:false,
   paid_access_enabled:false,
   access_disclosure:'Genesis validation mode. No subscription payment required or accepted.',
   settlement_options:[
    {rail:'USDC_POLYGON',name:'Native USDC on Polygon',public_ledger:true,ready:false},
    {rail:'XMR',name:'Monero XMR',public_ledger:false,ready:false,
     privacy_disclosure:'Shields ordinary on-chain transfer details, not website identity or IP.'}
   ],
   currency:'USDC',ladder:LADDER,
   member_price_rule:'minimum of locked maximum and verified public rate',
   pricing_source:'VERIFIED_ONLY_NOT_CONNECTED'
 });
};
