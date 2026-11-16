'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
test('worker portal uses its own registered device while a system account is signed in on the same browser',async()=>{
 const source=fs.readFileSync('public/worker-portal.js','utf8');
 const functions=source.slice(source.indexOf(' function portalPasswordSession'),source.indexOf(' function applyLanguage'));
 assert.ok(functions.includes('async function api'));
 let token='header.'+Buffer.from(JSON.stringify({system_link_id:12,role:'manager'})).toString('base64url')+'.signature',device='registered-worker-device';const calls=[];
 const response=async (kind,path,options)=>{calls.push({kind,path,options});return {ok:true,json:async()=>({ok:true})};};
 const context={window:{IronBendAuth:{accessToken:()=>token,deviceCredential:()=>device,nativeFetch:(...args)=>response('device',...args)}},fetch:(...args)=>response('password',...args),Headers,AbortController,setTimeout,clearTimeout,atob};
 vm.createContext(context);vm.runInContext(functions,context);
 await context.api('/api/worker-portal/me');assert.equal(calls[0].kind,'device');assert.equal(calls[0].options.headers.get('X-IronBend-Device'),device);assert.equal(calls[0].options.headers.get('Authorization'),null);
 device='';await context.api('/api/worker-portal/me');assert.equal(calls[1].kind,'device','cookie-only activation must also avoid the main system identity');
 token='header.'+Buffer.from(JSON.stringify({portal_only:true})).toString('base64url')+'.signature';await context.api('/api/worker-portal/me');assert.equal(calls[2].kind,'password','explicit personal password login retains its own worker identity');
 await context.api('/api/auth/worker-login',{method:'POST'});assert.equal(calls[3].kind,'password');
});
