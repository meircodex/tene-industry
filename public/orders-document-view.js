(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.IronBendOrderDocumentView=api;
})(typeof window==='undefined'?this:window,function(){
  'use strict';
  const kinds=new Set(['print-cards','print-a4','delivery-certificate']);
  function documentUrl(id,kind,language,nonce,options={}){
    if(!Number.isSafeInteger(Number(id))||Number(id)<=0||!kinds.has(kind))throw new Error('מסמך לא תקין');
    const params=new URLSearchParams({id:String(id),kind,workspace_embed:'1',workspace_nonce:String(nonce)});
    if(kind==='print-a4')params.set('lang',language==='th'?'th':'he');
    if(kind==='delivery-certificate'&&options.noteId){
      if(!Number.isSafeInteger(Number(options.noteId))||Number(options.noteId)<=0)throw new Error('תעודה לא תקינה');
      params.set('note_id',String(options.noteId));
    }
    return '/order-print.html?'+params;
  }
  function acceptsReady(event,frame,origin,id,kind,nonce){
    return event.origin===origin&&event.source===frame?.contentWindow&&event.data?.type==='ironbend-order-document-ready'
      &&String(event.data.id)===String(id)&&event.data.kind===kind&&String(event.data.nonce)===String(nonce);
  }
  let cleanup=null,sequence=0;
  function reset(){cleanup?.();cleanup=null;}
  function mount(root,id){
    reset();
    const view=root.ownerDocument.defaultView,kindSelect=root.querySelector('[data-document-kind]'),language=root.querySelector('[data-document-language]');
    if(!kindSelect)return;
    const items=root.querySelector('[data-order-items]'),host=root.querySelector('[data-order-document]');
    const buttons=Array.from(root.querySelectorAll('[data-document-action]'));
    let kind='',nonce='',frame=null,ready=false;
    const update=()=>{buttons.forEach(button=>button.disabled=!ready);language.disabled=kind!=='print-a4';root.querySelector('[data-document-back]').hidden=!kind;};
    try{language.value=view.localStorage.getItem('ironbend.order-document-language')==='th'?'th':'he';}catch{}
    const show=(next,options={})=>{
      kind=next;ready=false;kindSelect.value=next;items.hidden=Boolean(next);host.hidden=!next;
      host.replaceChildren();frame=null;
      if(next){
        nonce=String(++sequence);frame=root.ownerDocument.createElement('iframe');
        frame.title=kindSelect.selectedOptions[0]?.textContent||'מסמך ההזמנה';frame.className='order-document-frame';
        frame.src=documentUrl(id,next,language.value,nonce,options);host.appendChild(frame);
      }
      update();
    };
    const change=event=>{
      if(event.target===kindSelect)show(kindSelect.value);
      if(event.target===language){try{view.localStorage.setItem('ironbend.order-document-language',language.value);}catch{}if(kind==='print-a4')show(kind);}
    };
    const click=event=>{
      if(event.target.closest('[data-document-back]')){show('');return;}
      const saved=event.target.closest('[data-saved-document]');
      if(saved){event.preventDefault();show('delivery-certificate',{noteId:saved.dataset.savedDocument});return;}
      const button=event.target.closest('[data-document-action]');if(!button||!ready)return;
      const action=button.dataset.documentAction;
      const selector=action==='print'?'button[onclick="window.print()"],button[onclick="printCards()"]':`.btn-print[onclick*="IronBendDocExport.${action}"]`;
      const target=frame.contentDocument?.querySelector(selector);
      if(target&&!target.disabled)target.click();
    };
    const message=event=>{if(acceptsReady(event,frame,view.location.origin,id,kind,nonce)){ready=true;update();}};
    root.addEventListener('change',change);root.addEventListener('click',click);view.addEventListener('message',message);
    cleanup=()=>{root.removeEventListener('change',change);root.removeEventListener('click',click);view.removeEventListener('message',message);host.replaceChildren();};
    update();
  }
  return{documentUrl,acceptsReady,mount,reset};
});
