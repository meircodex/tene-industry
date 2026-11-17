'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const view=require('../public/orders-document-view');
test('embedded documents use existing endpoints, one A4 language and no automatic issuance or export',()=>{
  const url=new URL(view.documentUrl(133,'print-a4','th',7),'https://example.invalid');
  assert.equal(url.pathname,'/order-print.html');assert.equal(url.searchParams.get('lang'),'th');
  assert.equal(url.searchParams.get('workspace_embed'),'1');assert.equal(url.searchParams.get('workspace_nonce'),'7');
  for(const kind of ['print-cards','delivery-certificate']){
    const target=new URL(view.documentUrl(133,kind,'th',8),'https://example.invalid');
    for(const key of ['lang','certificate_mode','issue_key','auto_print','auto_send'])assert.equal(target.searchParams.has(key),false);
  }
  const saved=new URL(view.documentUrl(133,'delivery-certificate','he',9,{noteId:12}),'https://example.invalid');
  assert.equal(saved.searchParams.get('note_id'),'12');assert.equal(saved.searchParams.has('certificate_mode'),false);
  for(const id of [0,-1,1.2,'x',Infinity])assert.throws(()=>view.documentUrl(id,'print-a4','he',1));
  assert.throws(()=>view.documentUrl(1,'unknown','he',1));
  assert.throws(()=>view.documentUrl(1,'delivery-certificate','he',1,{noteId:'x'}));
});
test('ready messages reject foreign origins, other frames and stale order/document/language loads',()=>{
  const contentWindow={},frame={contentWindow},origin='https://example.invalid';
  const event={origin,source:contentWindow,data:{type:'ironbend-order-document-ready',id:'133',kind:'print-a4',nonce:'4'}};
  assert.equal(view.acceptsReady(event,frame,origin,133,'print-a4',4),true);
  assert.equal(view.acceptsReady({...event,origin:'https://evil.invalid'},frame,origin,133,'print-a4',4),false);
  assert.equal(view.acceptsReady({...event,source:{}},frame,origin,133,'print-a4',4),false);
  assert.equal(view.acceptsReady(event,frame,origin,132,'print-a4',4),false);
  assert.equal(view.acceptsReady(event,frame,origin,133,'print-cards',4),false);
  assert.equal(view.acceptsReady(event,frame,origin,133,'print-a4',5),false);
});
test('switching documents keeps exports disabled until ready, delegates existing export once and tears down on return',()=>{
  const rootEvents=new Map(),windowEvents=new Map(),storage=new Map(),clicks=[];
  const kind={value:'',selectedOptions:[{textContent:'גיליון הזמנה'}]},language={value:'he'},back={hidden:true};
  const buttons=['print','download','send'].map(action=>({disabled:true,dataset:{documentAction:action}}));
  const items={hidden:false},host={hidden:true,children:[],replaceChildren(){this.children=[];},appendChild(frame){this.children.push(frame);}};
  const win={location:{origin:'https://example.invalid'},localStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value)},addEventListener:(key,fn)=>windowEvents.set(key,fn),removeEventListener:key=>windowEvents.delete(key)};
  const root={ownerDocument:{defaultView:win,createElement:()=>({contentWindow:{},contentDocument:{querySelector:selector=>({click:()=>clicks.push(selector)})}})},
    querySelector:selector=>({'[data-document-kind]':kind,'[data-document-language]':language,'[data-order-items]':items,'[data-order-document]':host,'[data-document-back]':back}[selector]),
    querySelectorAll:()=>buttons,addEventListener:(key,fn)=>rootEvents.set(key,fn),removeEventListener:key=>rootEvents.delete(key)};
  view.mount(root,133);kind.value='print-a4';rootEvents.get('change')({target:kind});
  const first=host.children[0];assert.equal(items.hidden,true);assert.ok(buttons.every(b=>b.disabled));
  language.value='th';rootEvents.get('change')({target:language});const second=host.children[0];
  const ready=frame=>({origin:win.location.origin,source:frame.contentWindow,data:{type:'ironbend-order-document-ready',id:133,kind:'print-a4',nonce:new URL(frame.src,'https://example.invalid').searchParams.get('workspace_nonce')}});
  windowEvents.get('message')(ready(first));assert.ok(buttons.every(b=>b.disabled));
  windowEvents.get('message')(ready(second));assert.ok(buttons.every(b=>!b.disabled));
  assert.equal(new URL(second.src,'https://example.invalid').searchParams.get('lang'),'th');
  rootEvents.get('click')({target:{closest:selector=>selector==='[data-document-action]'?buttons[1]:null}});
  assert.equal(clicks.length,1);assert.match(clicks[0],/IronBendDocExport.download/);
  rootEvents.get('click')({target:{closest:selector=>selector==='[data-document-back]'?back:null}});
  assert.equal(items.hidden,false);assert.equal(host.children.length,0);assert.ok(buttons.every(b=>b.disabled));
  view.reset();assert.equal(rootEvents.size,0);assert.equal(windowEvents.size,0);
});
