const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
test('all worker interface labels and errors exist in each language',()=>{
 const context={window:{}};vm.runInNewContext(fs.readFileSync('public/worker-portal-i18n.js','utf8'),context);
 const d=context.window.WorkerPortalI18n;for(const lang of ['en','th'])for(const key of Object.keys(d.he))assert.ok(typeof d[lang][key]==='string'&&d[lang][key].length>0,lang+':'+key);
});
test('portal has only its own shell, settings language selector, no machine selector or generic dashboard',()=>{
 const html=fs.readFileSync('public/worker-portal.html','utf8'),js=fs.readFileSync('public/worker-portal.js','utf8');
 assert.doesNotMatch(html,/nav\.js|machineSelect|machineId|machine_id|ib-drawer/);assert.match(html,/id="settingsPanel"[^>]*hidden/);assert.equal((html.match(/id="language"/g)||[]).length,1);
 assert.match(js,/worker-portal\/card/);assert.match(js,/request_id:requestId\(\)/);assert.doesNotMatch(js,/\/api\/items|\/api\/orders/);
});
