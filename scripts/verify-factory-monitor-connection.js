'use strict';
// Isolated synthetic UI acceptance. Never attach to a user's browser or machine.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),express=require('express');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
(async()=>{
 const output=path.resolve(process.env.FACTORY_CONNECTION_QA_OUTPUT||'outputs/factory-connection-qa');fs.mkdirSync(output,{recursive:true});
 const app=express();app.use(express.json());const trace=[],patches=[],errors=[];let failOnce=true,recorded=false,stationOnline=true;
 const card='SYNTHETIC-000009',item={id:9,machine:'6',machine_id:7,quantity:10,status:'בייצור',diameter:8,weight:3.95,can_start_production:true,shape_name:'Synthetic',order_num:'SYNTHETIC',customer_name:'בדיקה מבודדת'};
 const mirror={sourceId:'synthetic-station',machineId:'machine6',card,runId:'synthetic-run',live:true,observedAtUtc:new Date().toISOString(),mappingQualified:false,expected:{sidesMm:[300,200],diameterMm:8},special:{diameter:8,strands:1,plate:0},rows:[{slot:1,length:300,angle:90,lengthCompensation:0,angleCompensation:2,direction:1}]};
 app.get('/auth-client.js',(_req,res)=>res.type('js').send('window.IronBendAuth={deviceCredential:()=>"SYNTHETIC-DEVICE",accessToken:()=>"",nativeFetch:fetch.bind(window)};'));
 app.get(['/nav.js','/help.js','/user-messages.js'],(_req,res)=>res.type('js').send(''));
 app.get('/sw.js',(_req,res)=>res.status(404).send(''));
 app.get('/api/worker-portal/me',(_req,res)=>res.json({worker:{user_id:1,worker_name:'בדיקה מבודדת',language:'he',permissions:['start','complete','weigh']}}));
 app.get('/api/worker-portal/card',(_req,res)=>res.json({items:[item],original_card:{whole_item:true,html:'<div style="padding:20px;text-align:center"><b>כרטיס בדיקה מבודד</b><p>30 × 20 ס״מ · Ø8</p></div>'},scan_receipt:{id:1}}));
 app.get('/api/worker-portal/history',(_req,res)=>res.json({rows:[],total:0}));
 app.get('/api/worker-portal/summary',(_req,res)=>res.json({weight_kg:0,completed_cards:0}));
 app.get('/api/worker-portal/zones',(_req,res)=>res.json({zones:[]}));app.get('/api/worker-portal/help',(_req,res)=>res.json({documents:[]}));
 const station={sourceId:'synthetic-station',logicalMachineId:'machine6',machineId:7,label:'6',online:true,controller:'live',mirror};
 app.get('/api/worker-portal/machine-feedback/stations',(_req,res)=>res.json({items:stationOnline?[station]:[],total:stationOnline?1:0}));
 app.post('/api/worker-portal/machine-feedback/requests',(req,res)=>{
  assert.equal(req.headers['x-ironbend-device'],'SYNTHETIC-DEVICE');const body=req.body;trace.push(body.action);
  let data={sourceId:mirror.sourceId,card,runId:mirror.runId};
  if(body.action==='mirror.read')data=mirror;
  if(body.action==='completion.prepare')data={...data,proposal:{id:'synthetic-proposal',requiresParameterConfirmation:true,changes:[{key:'angleCompensation',before:0,after:2}]}};
  if(body.action==='completion.record'){assert.equal(item.status,'הושלם');assert.equal(body.payload.receiptId,2);assert.equal(body.payload.saveRecipe,true);recorded=true;data={approvalSaved:true};}
  res.json({id:body.requestId,state:'done',result:{ok:true,data}});
 });
 app.patch('/api/worker-portal/card/9/status',(req,res)=>{
  patches.push(req.body);trace.push('business-completion');assert.ok(!Object.hasOwn(req.body,'feedback'));
  if(failOnce){failOnce=false;return res.status(503).json({error:'offline'});}
  item.status='הושלם';res.json({ok:true,item,receipt:{id:2,item_id:9,action:'status_changed',occurred_at:new Date().toISOString()}});
 });
 app.get('/api/machine-integration/station-state',(_req,res)=>res.json({items:[station],total:1,limit:100,offset:0}));
 app.get('/api/production-queue',(_req,res)=>res.json({items:[],grouped:{}}));app.get('/api/machines',(_req,res)=>res.json([{id:7,name:'6',label:'6',status:'לא מחובר'}]));
 app.get(['/api/users','/api/downtime-reasons'],(_req,res)=>res.json([]));app.get('/api/kpi/tons-today',(_req,res)=>res.json({tons:0}));
 app.use(express.static(path.join(__dirname,'../public')));
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));let browser;
 try{
  browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:980},serviceWorkers:'block'});page.on('pageerror',e=>errors.push(e.message));
  const url='http://127.0.0.1:'+server.address().port;
  await page.goto(url+'/worker-portal.html');await page.locator('#homeView').waitFor({state:'visible'});await page.locator('#navScan').click();await page.locator('#scanCode').fill(card);await page.locator('#openCode').click();
  await page.locator('#workerMachineFeedback table').waitFor();assert.match(await page.locator('#workerMachineFeedback').innerText(),/300/);
  await page.screenshot({path:path.join(output,'worker-card-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:path.join(output,'worker-card-mobile.png'),fullPage:true});
  await page.locator('button[data-status="הושלם"]').click();await page.locator('#saveUpdate').click();await page.locator('#machineRecipeChoice').waitFor({state:'visible'});
  assert.equal(await page.locator('dialog[open]').count(),1);await page.locator('#machineRecipeApprove').check();await page.locator('#statusConfirmYes').click();
  await page.locator('#retrySave').waitFor({state:'visible'});assert.equal(recorded,false);await page.locator('#retrySave').click();await page.waitForFunction(()=>document.querySelector('#cardStatus').textContent==='הושלם');
  await new Promise(resolve=>setTimeout(resolve,200));assert.equal(recorded,true);assert.equal(patches.length,2);assert.equal(patches[0].request_id,patches[1].request_id);assert.equal(trace.filter(v=>v==='completion.prepare').length,1);assert.ok(trace.indexOf('completion.record')>trace.lastIndexOf('business-completion'));
  const queue=await browser.newPage({viewport:{width:1440,height:980},serviceWorkers:'block'});queue.on('pageerror',e=>errors.push(e.message));await queue.goto(url+'/production-queue.html');await queue.locator('.fss-station').waitFor();await queue.locator('.fss-station summary').click();assert.match(await queue.locator('#factoryStationStatus').innerText(),/300/);await queue.screenshot({path:path.join(output,'factory-queue.png'),fullPage:true});
  stationOnline=false;item.status='בייצור';const offline=await browser.newPage({viewport:{width:390,height:844},serviceWorkers:'block'});offline.on('pageerror',e=>errors.push(e.message));await offline.goto(url+'/worker-portal.html');await offline.locator('#homeView').waitFor({state:'visible'});await offline.locator('#navScan').click();await offline.locator('#scanCode').fill(card);await offline.locator('#openCode').click();await offline.locator('#cardView').waitFor({state:'visible'});await offline.locator('button[data-status="הושלם"]').click();await offline.locator('#saveUpdate').click();await offline.locator('#statusConfirm[open]').waitFor();assert.equal(await offline.locator('#machineRecipeChoice').isVisible(),false);await offline.locator('#statusConfirmYes').click();await offline.waitForFunction(()=>document.querySelector('#cardStatus').textContent==='הושלם');assert.equal(trace.filter(v=>v==='completion.record').length,1,'offline monitoring must not fabricate a recipe or a second feedback receipt');
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'acceptance.json'),JSON.stringify({passed:true,syntheticOnly:true,productionMutations:false,checks:['existing scanner','matching PLC mirror','one combined DONE dialog','same receipt retry','recipe after accepted DONE','mobile overflow','existing queue integration','ordinary completion without a monitor'],trace},null,2));console.log('Factory connection UI acceptance passed');
 }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1;});
