'use strict';
const wallets=[
 ['Papeasy','0x111f73e91f85b6fe4de1ddec3de2fe32122e355b'],
 ['Spirit of Ukraine>UMA','0x0c0e270cf879583d6a0142fc817e05b768d0434e']
];
const hosts=['https://polygon.blockscout.com','https://polygon.blockscout.io'];
async function req(url){
 const res=await fetch(url,{method:'GET',redirect:'error',headers:{accept:'application/json'},signal:AbortSignal.timeout(16000)});
 if(!res.ok)throw Error('HTTP_'+res.status);
 const txt=await res.text();
 if(txt.length>3000000)throw Error('oversized');
 const d=JSON.parse(txt);if(!d||!Array.isArray(d.items))throw Error('bad_items');
 return d;
}
async function main(){
 for(const [name,wallet] of wallets){
  let ok=false;
  for(const root of hosts){
   try{
    const u=new URL('/api/v2/addresses/'+wallet+'/token-transfers',root);
    u.searchParams.set('type','ERC-1155');
    u.searchParams.set('token','0x4D97DCd97eC945f40cF65F87097ACe5EA0476045');
    const d=await req(u);
    const item=d.items[0]||null;
    console.log('BLOCKSCOUT_SHAPE '+JSON.stringify({name,host:root,count:d.items.length,next:d.next_page_params,
       example:item,keys:item?Object.keys(item):[]}));
    ok=true;break;
   }catch(e){console.log('BLOCKSCOUT_ERROR '+JSON.stringify({name,host:root,error:String(e.message||e)}))}
  }
  if(!ok)process.exitCode=2;
 }
}
main().catch(e=>{console.error('BLOCKSCOUT_PROBE_FATAL '+String(e));process.exitCode=1});
