'use strict';
(function(root){
 function normalize(raw,depth=0){
  let value=String(raw||'').trim();if(!value||value.length>1024||depth>3)return'';
  if(/^(?:https?:|web\+ironbend:|\/)/i.test(value)||value.includes('?')){
   try{const url=new URL(value,'https://ironbend.invalid');
    if(url.protocol==='web+ironbend:'&&url.hostname==='open'&&url.pathname.startsWith('/card/'))return normalize(decodeURIComponent(url.pathname.slice(6)),depth+1);
    const code=url.searchParams.get('card')||url.searchParams.get('item')||url.searchParams.get('code');return code?normalize(code,depth+1):'';
   }catch{return'';}
  }
  return /^\d{1,12}$/.test(value)||/\|\d{1,12}(?:\||$)/.test(value)||/-\d{1,12}(?:-[A-Z0-9]+)*$/i.test(value)?value:'';
 }
 root.WorkerCardCode={normalize};
 if(typeof module==='object'&&module.exports)module.exports={normalize};
})(typeof window==='object'?window:globalThis);
