'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),express=require('express');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const Database=require('better-sqlite3');
const {createEditorDraftService}=require('../services/editorDrafts');
(async()=>{
  const root=path.resolve(__dirname,'..'),app=express(),db=new Database(':memory:');
  db.exec('CREATE TABLE orders(id INTEGER PRIMARY KEY,order_num TEXT,deleted_at TEXT); CREATE TABLE audit_log(id INTEGER PRIMARY KEY,entity_type,entity_id,entity_ref,action,notes,user_id,user_name);');
  const service=createEditorDraftService(db),actor={id:1,name:'Isolated QA'};let saved=0;
  app.use(express.json({limit:'3mb'}));
  app.get(['/nav.js','/help.js'],(_req,res)=>res.type('js').send(''));
  app.get('/api/dashboard',(_req,res)=>res.json({next_order_num:1}));
  app.get('/api/shape-definitions',(_req,res)=>res.json({entries:[],archived:[],hiddenBuiltinIds:[],permissions:{canManage:true}}));
  app.get('/api/customers/13',(_req,res)=>res.json({id:13,name:'לקוח בדיקת טיוטות',address:'כתובת ברירת מחדל אחרת'}));
  app.get('/api/customers/13/portal-sites',(_req,res)=>res.json({sites:[{id:90,name:'אתר אחר שלא נבחר',address:'כתובת אחרת'}]}));
  app.get(['/api/customers','/api/inventory'],(_req,res)=>res.json([]));
  app.post('/api/orders/reservation-preview',(_req,res)=>res.json({groups:[],summary:{required_kg:0,available_kg:0,shortage_kg:0}}));
  app.post('/api/orders/price-preview',(_req,res)=>res.json({lines:[],total:0}));
  app.get('/api/operations/editor-drafts',(req,res)=>res.json(service.list(req.query.before)));
  const run=fn=>(req,res)=>{try{res.json(fn(req));}catch(e){res.status(e.statusCode||500).json({error:e.message});}};
  app.put('/api/operations/editor-drafts/:id',run(req=>service.save(req.params.id,req.body,actor)));
  app.post('/api/operations/editor-drafts/:id/close',run(req=>service.close(req.params.id,req.body,actor)));
  app.post('/api/orders',(req,res)=>{saved++;db.prepare('INSERT INTO orders(id,order_num) VALUES(?,?)').run(saved,'DRAFT-UI-'+saved);res.json({success:true,orderId:saved,orderNum:'DRAFT-UI-'+saved});});
  for(const [url,file] of Object.entries({shapeSnapshot:'services/shapeSnapshot.js',steelRebarShapes:'modules/steel-rebar/shapes.js',shapeCommercial:'modules/steel-rebar/shape-commercial.js',shapeRecognition:'modules/steel-rebar/shape-recognition.js'}))app.get('/'+url+'.js',(_req,res)=>res.sendFile(path.join(root,file)));
  app.use(express.static(path.join(root,'public')));
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});let browser;
  try{
    browser=await chromium.launch({headless:true});
    const contexts=await Promise.all([browser.newContext({viewport:{width:1440,height:1000}}),browser.newContext({viewport:{width:1440,height:1000}})]);
    for(const context of contexts)await context.addInitScript(()=>{localStorage.setItem('ib_access_token','isolated-draft-fixture');localStorage.setItem('ib_role','office');});
    const [one,two]=await Promise.all(contexts.map(c=>c.newPage())),errors=[];
    for(const page of [one,two])page.on('pageerror',e=>errors.push(e.message));
    const base='http://127.0.0.1:'+server.address().port;
    await one.goto(base+'/index.html');await one.waitForTimeout(2700);
    assert.equal(service.list().drafts.length,0,'blank startup must not create local/cloud draft');
    assert.equal(await one.locator('#orderDraftsCount').innerText(),'0');
    // A real snapshot in the shared service is visible in a different browser
    // without copying its localStorage or saving an official order.
    const id='draft_fixture_shared_20261111';
    service.save(id,{record:{draftId:id,status:'active',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),payload:{customer:{id:13,name:'לקוח בדיקת טיוטות',phone:'',taxId:'',contactName:'איש קשר שמור',contactPhone:''},delivery:{siteId:'',siteName:'בית ספר — האתר שבטיוטה',address:'כתובת שמורה בטיוטה',date:'2026-11-13',priority:'רגיל',driverNotes:'הערת נהג שמורה'},notes:'טיוטת בדיקה משותפת לפני יצירת הזמנה',pallets:[{id:500,maxWeight:500,items:[{id:501,shapeId:'s1',shapeName:'מוט ישר',shapeSides:[1000],shapeAngles:[],length:1000,qty:2,diameter:12,structElement:'קורה שמורה'}]}],savedAt:new Date().toISOString()}}},actor);
    await two.goto(base+'/index.html');await two.locator('#orderDraftsButton').click();
    await two.locator('[data-draft-id="'+id+'"]').waitFor();
    assert.match(await two.locator('[data-draft-id="'+id+'"]').innerText(),/לקוח בדיקת טיוטות/);
    if(process.env.DRAFT_QA_OUTPUT){fs.mkdirSync(process.env.DRAFT_QA_OUTPUT,{recursive:true});await two.screenshot({path:path.join(process.env.DRAFT_QA_OUTPUT,'shared-draft-list.png')});}
    await two.locator('[data-draft-id="'+id+'"]').getByRole('button',{name:'המשך',exact:true}).click();
    await two.waitForTimeout(900);
    assert.equal(await two.locator('#deliverySiteName').inputValue(),'בית ספר — האתר שבטיוטה');
    assert.equal(await two.locator('#deliveryAddress').inputValue(),'כתובת שמורה בטיוטה');
    assert.equal(await two.locator('#contactName').inputValue(),'איש קשר שמור');
    assert.equal(await two.locator('.order-line-row').count(),1);
    await two.locator('.line-element').fill('קורה נערכה בחלון השני');await two.locator('.line-element').press('Tab');
    await two.waitForTimeout(2300);
    assert.equal(service.list().drafts.find(d=>d.draftId===id).payload.pallets[0].items[0].structElement,'קורה נערכה בחלון השני');
    await one.locator('#orderDraftsButton').click();await one.locator('[data-draft-id="'+id+'"]').waitFor();
    assert.match(await one.locator('[data-draft-id="'+id+'"]').innerText(),/קורה נערכה בחלון השני/);
    await one.locator('[data-draft-id="'+id+'"]').getByRole('button',{name:'המשך',exact:true}).click();await one.waitForTimeout(900);
    await two.locator('.line-element').fill('העריכה המעודכנת בחלון השני');await two.locator('.line-element').press('Tab');await two.waitForTimeout(2300);
    await one.locator('.line-element').fill('שינוי מקומי שלא יידרס');await one.locator('.line-element').press('Tab');await one.waitForTimeout(2300);
    assert.match(await one.locator('#orderDraftAutosaveState').innerText(),/נערכה בחלון אחר/);
    assert.equal(service.list().drafts.find(d=>d.draftId===id).payload.pallets[0].items[0].structElement,'העריכה המעודכנת בחלון השני');
    await one.locator('#orderDraftsButton').click();await one.waitForTimeout(700);
    const fork=service.list().drafts.find(d=>d.draftId!==id);
    assert.ok(fork,'conflicting local edits are preserved as a separate shared snapshot');
    assert.equal(fork.payload.pallets[0].items[0].structElement,'שינוי מקומי שלא יידרס');
    // Submit while another autosave is still pending; its timer must never
    // recreate the completed draft after the success overlay is displayed.
    await two.locator('.line-element').fill('קורה לפני שמירת ההזמנה');await two.locator('.line-element').press('Tab');
    await two.getByRole('button',{name:'שמור הזמנה',exact:true}).click();
    await two.waitForSelector('#successOverlay.show');await two.waitForTimeout(2800);
    assert.equal(saved,1);
    assert.equal(service.list().drafts.find(d=>d.draftId===id).status,'submitted');
    await one.locator('#orderDraftsButton').click();await one.locator('#orderDraftsButton').click();await one.waitForTimeout(300);
    assert.equal(await one.locator('[data-draft-id="'+id+'"]').count(),0);
    await one.locator('[data-draft-id="'+fork.draftId+'"]').getByRole('button',{name:'המשך',exact:true}).click();await one.waitForTimeout(300);
    await contexts[0].setOffline(true);await one.locator('.line-element').fill('שינוי שנשמר בזמן ניתוק');await one.locator('.line-element').press('Tab');await one.waitForTimeout(2300);
    assert.match(await one.locator('#orderDraftAutosaveState').innerText(),/השינויים נשמרו במחשב/);
    assert.equal(service.list().drafts.find(d=>d.draftId===fork.draftId).payload.pallets[0].items[0].structElement,'שינוי מקומי שלא יידרס');
    await contexts[0].setOffline(false);await one.waitForTimeout(1000);
    assert.equal(service.list().drafts.find(d=>d.draftId===fork.draftId).payload.pallets[0].items[0].structElement,'שינוי שנשמר בזמן ניתוק');
    assert.deepEqual(errors,[]);console.log('PASS: empty form produces no drafts; independent browsers share draft data before any order exists; restore preserves manual site/address/contact; edits sync; conflicting edits fork without data loss; offline edits stay local with Hebrew status and sync on reconnect; successful submission closes shared draft and pending autosave cannot recreate it. Only isolated fixture orders were created.');
  }finally{await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));db.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
