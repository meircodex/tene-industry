'use strict';
const express=require('express'),path=require('path'),fs=require('fs'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
// Real page and rendering logic; synthetic API fixtures, no production DB/auth.
(async()=>{
 let mode='gap';const app=express();
 app.get(['/auth-client.js','/nav.js'],(_q,r)=>r.type('js').send(''));
 app.use('/api',(q,r)=>{
   if(q.path==='/inventory/summary')return mode==='offline'?r.sendStatus(503):r.json([{available:10000,total_used:9363.715,batches:24,diameter:12}]);
   if(q.path==='/inventory/metrics')return mode==='error'?r.sendStatus(503):r.json({stocked_lots:1,stocked_diameters:1,baseline:mode==='no_count'?null:{id:1,created_at:'2026-11-08 20:56:41'},recorded_net_kg:mode==='no_count'?null:0,status:mode==='gap'?'needs_reconciliation':mode==='no_count'?'no_baseline':'recorded_only',gaps:{legacy_active_reservations:310}});
   if(q.path==='/procurement/plan')return r.json({groups:[],mesh_groups:[]});return r.json([]);
 });
 app.use(express.static(path.resolve(__dirname,'../public')));
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});let browser;
 try{
  browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const url=`http://127.0.0.1:${server.address().port}/inventory.html`;
  await page.goto(url);await page.waitForFunction(()=>document.getElementById('kpiUsed').textContent==='לא מאומת');
  assert.equal(await page.locator('#kpiBatches').innerText(),'1');assert.match(await page.locator('#kpiUsedPeriod').innerText(),/ספירה #1/);assert.match(await page.locator('#inventoryConsumptionEvidence').innerText(),/אין להסיק/);
  const out=process.env.INVENTORY_QA_OUTPUT;if(out){fs.mkdirSync(out,{recursive:true});await page.screenshot({path:path.join(out,'consumption-not-verified.png'),fullPage:true});}
  mode='recorded';await page.reload();await page.waitForFunction(()=>document.getElementById('kpiUsed').textContent==='0');assert.match(await page.locator('#inventoryConsumptionEvidence').innerText(),/עבודה שלא דווחה/);
  mode='no_count';await page.reload();await page.waitForFunction(()=>document.getElementById('kpiUsedPeriod').textContent==='אין ספירת בסיס מאושרת');assert.equal(await page.locator('#kpiUsed').innerText(),'לא מאומת');
  mode='error';await page.reload();await page.waitForFunction(()=>document.getElementById('kpiUsedPeriod').textContent==='הבדיקה אינה זמינה');assert.equal(await page.locator('#kpiUsed').innerText(),'—');
  mode='offline';await page.reload();await page.waitForFunction(()=>document.getElementById('inventoryConsumptionEvidence').textContent.includes('אינם זמינים'));assert.equal(await page.locator('#kpiTotal').innerText(),'—');
  assert.deepEqual(errors,[]);console.log('PASS: uncertain consumption, explicit count period, stocked lots, recorded zero, no baseline and network failures; no browser errors.');
 }finally{await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1;});
