'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const origin='https://factory.example';
const manifest=name=>JSON.parse(fs.readFileSync('public/'+name,'utf8'));
test('installed worker and management apps retain distinct identities, icons and launch pages',()=>{
 const worker=manifest('worker-portal-manifest.json'),system=manifest('manifest.json');
 // Keep existing installed identities: changing this would create another app.
 assert.equal(worker.id,'/worker-portal');assert.equal(system.id,undefined);
 assert.notEqual(new URL(worker.id,origin).href,new URL(system.start_url,origin).href);
 assert.equal(worker.start_url,'/worker-portal.html');assert.equal(system.start_url,'/dashboard.html');
 assert.ok(new URL(worker.start_url,origin).pathname.startsWith(new URL(worker.scope,origin).pathname));
 for(const page of ['/dashboard.html','/orders.html','/admin.html','/scan.html'])assert.ok(!page.startsWith(worker.scope),'worker app must not capture '+page);
 assert.notEqual(worker.short_name,system.short_name);
 for(const icon of worker.icons){
  assert.ok(!system.icons.some(other=>other.src===icon.src));
  const bytes=fs.readFileSync('public'+icon.src),size=Number(icon.sizes.split('x')[0]);
  assert.equal(bytes.subarray(1,4).toString(),'PNG');assert.equal(bytes.readUInt32BE(16),size);assert.equal(bytes.readUInt32BE(20),size);
  assert.notDeepEqual(bytes,fs.readFileSync('public'+system.icons[0].src));
 }
 const html=fs.readFileSync('public/worker-portal.html','utf8');
 assert.match(html,/rel="apple-touch-icon" href="\/worker-icon-180-v1.png"/);
 const apple=fs.readFileSync('public/worker-icon-180-v1.png');assert.equal(apple.readUInt32BE(16),180);
});
