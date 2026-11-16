(function(root,factory){const create=factory();if(typeof module==='object'&&module.exports)module.exports=create;if(root)root.createWorkerPortalSettings=create;})(typeof window==='undefined'?null:window,function(){
 'use strict';
 return function({document:doc,button,panel,backdrop,closeButton}){
  function close(restoreFocus=true){panel.hidden=true;backdrop.hidden=true;button.setAttribute('aria-expanded','false');if(restoreFocus)button.focus();}
  function open(){panel.hidden=false;backdrop.hidden=false;button.setAttribute('aria-expanded','true');closeButton.focus();}
  button.addEventListener('click',()=>panel.hidden?open():close());
  closeButton.addEventListener('click',()=>close());backdrop.addEventListener('click',()=>close());
  doc.addEventListener('keydown',event=>{
   if(panel.hidden)return;
   if(event.key==='Escape'){event.preventDefault();close();return;}
   if(event.key!=='Tab')return;
   const controls=[...panel.querySelectorAll('button:not([disabled]),select:not([disabled])')].filter(el=>!el.hidden);
   if(!controls.length)return;const first=controls[0],last=controls[controls.length-1];
   if(!panel.contains(doc.activeElement)){event.preventDefault();first.focus();}
   else if(event.shiftKey&&doc.activeElement===first){event.preventDefault();last.focus();}
   else if(!event.shiftKey&&doc.activeElement===last){event.preventDefault();first.focus();}
  });
  close(false);return {open,close};
 };
});
