'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const browser=require('../public/worker-invite-browser');
const chrome='Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36';
const webview='Mozilla/5.0 (Linux; Android 14; wv) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36';
test('embedded browser detection preserves ordinary Chrome/Safari and generates a same-target Chrome handoff',()=>{
 assert.equal(browser.embedded(chrome),false);assert.equal(browser.embedded(webview),true);assert.equal(browser.embedded(chrome+' WhatsApp/2.0'),true);
 assert.equal(browser.embedded('Mozilla/5.0 (iPhone) AppleWebKit/605.1 Mobile/15 Safari/604.1'),false);
 assert.equal(browser.embedded('Mozilla/5.0 (iPhone) AppleWebKit/605.1 Mobile/15'),true);
 const url=browser.activationUrl('https://factory.example','WINV-test.a+b?#value'),intent=browser.chromeIntent(url);
 assert.equal(new URL(url).searchParams.get('token'),'WINV-test.a+b?#value');assert.ok(intent.startsWith('intent://factory.example/worker-invite.html?token='));
 assert.ok(intent.includes(';scheme=https;package=com.android.chrome;'));assert.ok(intent.includes('S.browser_fallback_url='+encodeURIComponent(url)));
 assert.throws(()=>browser.chromeIntent('javascript:alert(1)'));assert.throws(()=>browser.chromeIntent('https://user:password@factory.example/'));assert.throws(()=>browser.activationUrl('file:///tmp','token'));
});
function storage(initial={}){const map=new Map(Object.entries(initial));return {getItem:key=>map.get(key)||null,setItem:(key,value)=>map.set(key,String(value)),removeItem:key=>map.delete(key)};}
async function harness({ua=chrome,used=false,ownWorker=null,token='WINV-test.secret'}={}){
 const elements=new Map(),calls=[],history=[],listeners={};
 function el(id){if(!elements.has(id))elements.set(id,{hidden:true,disabled:false,value:'',textContent:'',className:'',attrs:{},addEventListener(name,fn){this[name]=fn;},removeAttribute(name){delete this.attrs[name];delete this[name];}});return elements.get(id);}
 const localStorage=storage(ownWorker?{ironbend_device_credential_v1:'DEV-A.own-proof'}:{}),sessionStorage=storage();
 const response=(status,data)=>({status,ok:status<400,json:async()=>data});
 const fetch=async(path,options={})=>{calls.push({path,options});if(path.startsWith('/api/worker-invitations/activation')){
  if(used)return response(409,{error:'invitation_already_used'});
  if(options.method==='POST')return response(201,{device_credential:'DEV-B.new-proof',portal_available:true,portal_url:'/worker-portal.html?activated=1'});
  return response(200,{worker_name:'Invited Worker',language:'he',portal_available:true,expires_at:'2099-01-01T00:00:00Z'});
 }if(path==='/api/worker-portal/me')return ownWorker?response(200,{worker:ownWorker}):response(401,{});throw Error('unexpected request');};
 const context={window:{WorkerInviteBrowser:browser,fetch,addEventListener:(name,fn)=>listeners[name]=fn},document:{getElementById:el,documentElement:{},querySelectorAll:()=>[],querySelector:()=>el('manifest')},navigator:{userAgent:ua,platform:'Android'},location:new URL('https://factory.example/worker-invite.html'+(token?'?token='+encodeURIComponent(token):'')),history:{replaceState:(_a,_b,url)=>history.push(url)},URLSearchParams,localStorage,sessionStorage,fetch};
 vm.createContext(context);vm.runInContext(fs.readFileSync('public/worker-portal-i18n.js','utf8'),context);
 const html=fs.readFileSync('public/worker-invite.html','utf8'),inline=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match=>match[1]).join('\n');vm.runInContext(inline,context);await new Promise(setImmediate);
 return {context,el,calls,history,localStorage};
}
test('known embedded browser explains the handoff and cannot consume the invitation through the form',async()=>{
 const h=await harness({ua:webview});assert.equal(h.el('activateButton').disabled,true);assert.equal(h.el('browserGuide').hidden,false);assert.equal(h.el('openInChrome').hidden,false);assert.match(h.el('openInChrome').href,/package=com.google.chrome|package=com.android.chrome/);
 await h.context.activateWorker({preventDefault(){}});assert.equal(h.calls.filter(c=>c.options.method==='POST').length,0);assert.match(h.el('browserAdvice').textContent,/Chrome/);
 assert.ok(!h.history.some(url=>url.includes('token')));
});
test('normal browser activates once and clears the handoff link after success',async()=>{
 const h=await harness();assert.equal(h.el('activateButton').disabled,false);await h.context.activateWorker({preventDefault(){}});
 assert.equal(h.calls.filter(c=>c.options.method==='POST').length,1);assert.equal(h.localStorage.getItem('ironbend_device_credential_v1'),'DEV-B.new-proof');assert.equal(h.el('browserGuide').hidden,true);assert.equal(h.el('openInChrome').href,undefined);assert.equal(h.el('activationDestinations').hidden,false);
});
test('copy handoff retains the pending capability after history cleanup and localizes the live expiry notice',async()=>{
 const h=await harness({ua:webview});let copied='';h.context.navigator.clipboard={writeText:async value=>{copied=value;}};
 await h.el('copyBrowserLink').click();assert.equal(new URL(copied).origin,'https://factory.example');assert.equal(new URL(copied).searchParams.get('token'),'WINV-test.secret');assert.deepEqual(h.history,['/worker-invite.html']);assert.equal(h.calls.filter(c=>c.options.method==='POST').length,0);
 h.context.applyInviteLanguage('en');assert.ok(h.el('notice').textContent.startsWith(h.context.window.WorkerPortalI18n.en.linkExpires));
 h.context.navigator.clipboard={writeText:async()=>{throw Error('blocked');}};await h.el('copyBrowserLink').click();assert.match(h.el('browserFeedback').textContent,/press and hold/i);
});
test('used link resumes only the browser own authenticated worker without claiming again',async()=>{
 const worker={active:true,access_mode:'device',user_id:17,worker_name:'Current Worker',language:'he'};
 const h=await harness({used:true,ownWorker:worker});assert.equal(h.el('activationDestinations').hidden,false);assert.equal(h.el('openActivatedPortal').href,'/worker-portal.html');assert.equal(h.el('inviteInfo').textContent,'Current Worker');assert.equal(h.el('registrationForm').hidden,true);assert.equal(h.calls.filter(c=>c.options.method==='POST').length,0);
 assert.equal(h.calls.find(c=>c.path==='/api/worker-portal/me').options.headers['X-IronBend-Device'],'DEV-A.own-proof');
 const freshBrowser=await harness({used:true});assert.equal(freshBrowser.el('activationDestinations').hidden,true);assert.equal(freshBrowser.el('registrationForm').hidden,true);assert.equal(freshBrowser.el('browserGuide').hidden,true);assert.match(freshBrowser.el('notice').textContent,/WhatsApp/);assert.equal(freshBrowser.calls.filter(c=>c.options.method==='POST').length,0);
});
test('reload without a link can open an existing device session but password/system identity cannot restore it',async()=>{
 const worker={active:true,access_mode:'device',user_id:17,worker_name:'Current Worker',language:'en'};
 const h=await harness({token:'',ownWorker:worker});assert.equal(h.el('activationDestinations').hidden,false);assert.equal(h.el('title').textContent,'The portal is already active here');
 assert.equal(await browser.currentPortal(async()=>({ok:true,json:async()=>({worker:{...worker,access_mode:'password'}})}),''),null);
 assert.equal(await browser.currentPortal(async()=>({ok:false}),''),null);
});
