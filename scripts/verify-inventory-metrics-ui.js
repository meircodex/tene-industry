'use strict';
const express=require('express'),path=require('path'),fs=require('fs'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
// Real page and rendering logic; synthetic API fixtures, no production DB/auth.
(async()=>{
 let mode='normal',metricCalls=0;const app=express();
 app.get(['/auth-client.js','/nav.js'],(_q,r)=>r.type('js').send(''));
 app.use('/api',(q,r)=>{
   if(q.path==='/inventory/summary')return mode==='offline'?r.sendStatus(503):r.json([{available:10000,total_used:9363.715,batches:24,diameter:12},{available:0,total_used:0,batches:1,diameter:16}]);
   if(q.path==='/inventory/metrics'){metricCalls++;return r.sendStatus(503);}
   if(q.path==='/inventory/stocktakes')return mode==='error'?r.sendStatus(503):r.json(mode==='no_count'?[]:[{id:1,created_at:'2026-11-08 20:56:41'}]);
   if(q.path==='/procurement/plan')return r.json({groups:[],mesh_groups:[]});return r.json([]);
 });
 app.use(express.static(path.resolve(__dirname,'../public')));
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});let browser;
 try{
  browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const url=`http://127.0.0.1:${server.address().port}/inventory.html`;
  await page.goto(url);await page.waitForFunction(()=>document.getElementById('inventoryStockBasis').textContent.includes('22:56:41'));
  assert.equal(await page.locator('#kpiDiam').innerText(),'1');assert.equal(await page.locator('#kpiTotal').innerText(),'10,000');
  assert.equal(await page.locator('#kpiUsed,#kpiBatches,#inventoryConsumptionEvidence').count(),0);
  assert.doesNotMatch(await page.locator('body').innerText(),/לא מאומת|9,363|310 שריוני/);
  assert.match(await page.locator('#inventoryStockBasis').innerText(),/שריון להזמנה.*אינו יציאת חומר/);
  const out=process.env.INVENTORY_QA_OUTPUT;if(out){fs.mkdirSync(out,{recursive:true});await page.screenshot({path:path.join(out,'stock-count-basis.png'),fullPage:true});}
  mode='no_count';await page.reload();await page.waitForFunction(()=>document.getElementById('kpiTotal').textContent==='10,000');assert.doesNotMatch(await page.locator('#inventoryStockBasis').innerText(),/הספירה שאושרה ב/);
  mode='error';await page.reload();await page.waitForFunction(()=>document.getElementById('kpiTotal').textContent==='10,000');assert.equal(await page.locator('#kpiDiam').innerText(),'1');
  mode='offline';await page.reload();await page.waitForFunction(()=>document.getElementById('inventoryStockBasis').textContent.includes('אינם זמינים'));assert.equal(await page.locator('#kpiTotal').innerText(),'—');
  assert.equal(metricCalls,0);assert.deepEqual(errors,[]);console.log('PASS: declared count balance, positive-stock diameters, no consumption or uncertain counters, independent audit endpoint, no invented zero on network failure.');
 }finally{await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1;});
