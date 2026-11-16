(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.WorkerInviteBrowser=api;})(typeof window==='undefined'?null:window,function(){
 'use strict';
 function embedded(ua){return /;\s*wv\b|\bWhatsApp\b|FBAN|FBAV|Instagram|Line\//i.test(ua)||(/iPhone|iPad|iPod/i.test(ua)&&/AppleWebKit/i.test(ua)&&!/Safari|CriOS|FxiOS|EdgiOS/i.test(ua));}
 function activationUrl(origin,token){const url=new URL('/worker-invite.html',origin);if(!/^https?:$/.test(url.protocol)||!token)throw Error('invalid_activation_url');url.searchParams.set('token',token);return url.href;}
 function chromeIntent(url){const parsed=new URL(url);if(!/^https?:$/.test(parsed.protocol)||parsed.username||parsed.password)throw Error('invalid_activation_url');parsed.hash='';return 'intent://'+parsed.host+parsed.pathname+parsed.search+'#Intent;scheme='+parsed.protocol.slice(0,-1)+';package=com.android.chrome;S.browser_fallback_url='+encodeURIComponent(parsed.href)+';end';}
 async function currentPortal(fetcher,credential){
  try{const response=await fetcher('/api/worker-portal/me',{credentials:'same-origin',cache:'no-store',headers:credential?{'X-IronBend-Device':credential}:{}});if(!response.ok)return null;const {worker}=await response.json();return worker?.active&&worker.access_mode==='device'&&Number(worker.user_id)>0?worker:null;}catch{return null;}
 }
 return {embedded,activationUrl,chromeIntent,currentPortal};
});
