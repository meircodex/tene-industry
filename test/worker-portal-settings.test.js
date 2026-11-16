'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const createSettings=require('../public/worker-portal-settings');
function fixture(){
 const doc={activeElement:null,listeners:{},documentElement:{lang:'he',dir:'rtl'},addEventListener(key,fn){this.listeners[key]=fn;}};
 const el=()=>({hidden:false,attrs:{},listeners:{},setAttribute(key,value){this.attrs[key]=value;},addEventListener(key,fn){this.listeners[key]=fn;},focus(){doc.activeElement=this;}});
 const button=el(),panel=el(),backdrop=el(),closeButton=el(),language=el(),install=el();const controls=[closeButton,language,install];panel.querySelectorAll=()=>controls;panel.contains=target=>controls.includes(target);
 const controller=createSettings({document:doc,button,panel,backdrop,closeButton});
 return {doc,button,panel,backdrop,closeButton,language,install,controller};
}
test('settings close button, backdrop and Escape work after switching to every supported language',()=>{
 for(const lang of ['he','en','th']){
  const f=fixture();assert.equal(f.panel.hidden,true);assert.equal(f.backdrop.hidden,true);
  f.button.listeners.click();assert.equal(f.panel.hidden,false);assert.equal(f.button.attrs['aria-expanded'],'true');assert.equal(f.doc.activeElement,f.closeButton);
  f.doc.documentElement.lang=lang;f.doc.documentElement.dir=lang==='he'?'rtl':'ltr';f.language.focus();
  f.closeButton.listeners.click();assert.equal(f.panel.hidden,true);assert.equal(f.backdrop.hidden,true);assert.equal(f.doc.activeElement,f.button);
  f.controller.open();f.backdrop.listeners.click();assert.equal(f.panel.hidden,true);
  let prevented=false;f.controller.open();f.doc.listeners.keydown({key:'Escape',preventDefault(){prevented=true;}});assert.equal(prevented,true);assert.equal(f.panel.hidden,true);assert.equal(f.button.attrs['aria-expanded'],'false');
 }
});
test('settings keyboard focus stays in the dialog and route navigation can close it without stealing focus',()=>{
 const f=fixture();f.controller.open();let prevented=0;
 f.doc.listeners.keydown({key:'Tab',shiftKey:true,preventDefault(){prevented++;}});assert.equal(f.doc.activeElement,f.install);
 f.doc.listeners.keydown({key:'Tab',shiftKey:false,preventDefault(){prevented++;}});assert.equal(f.doc.activeElement,f.closeButton);assert.equal(prevented,2);
 f.language.focus();f.controller.close(false);assert.equal(f.doc.activeElement,f.language);assert.equal(f.backdrop.hidden,true);
});
test('worker portal has only activation guidance, keeps device proof and has no credential or logout controls',()=>{
 const html=fs.readFileSync('public/worker-portal.html','utf8'),js=fs.readFileSync('public/worker-portal.js','utf8');
 assert.doesNotMatch(html,/id="(?:logout|username|password|loginForm|loginSubmit)"|password-fallback/);
 assert.match(html,/id="retryAccess"/);assert.match(html,/id="closeSettings"/);assert.match(html,/id="settingsBackdrop"/);
 assert.doesNotMatch(js,/worker-portal\/logout|auth\/worker-login|finishLogout|setItem\('workerPortalSignedOut'|removeItem\('ironbend_device_credential_v1'/);
 assert.match(js,/show\('login'\);boot\(\)/);
});
