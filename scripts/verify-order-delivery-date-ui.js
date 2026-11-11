'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),express=require('express');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {defaultDate}=require('../public/order-delivery-date');
(async()=>{
  const root=path.resolve(__dirname,'..'),app=express(),saved=[];app.use(express.json());
  app.get(['/nav.js','/help.js'],(_req,res)=>res.type('js').send(''));
  app.get('/api/dashboard',(_req,res)=>res.json({next_order_num:1}));
  app.get('/api/shape-definitions',(_req,res)=>res.json({entries:[],archived:[],hiddenBuiltinIds:[],permissions:{canManage:true}}));
  app.get(['/api/customers','/api/inventory'],(_req,res)=>res.json([]));
  app.post('/api/orders/reservation-preview',(_req,res)=>res.json({groups:[],summary:{required_kg:0,available_kg:0,shortage_kg:0}}));
  app.post('/api/orders/price-preview',(_req,res)=>res.json({lines:[],total:0}));
  app.post('/api/orders',(req,res)=>{saved.push(req.body);res.json({success:true,orderId:saved.length,orderNum:'DATE-UI-'+saved.length});});
  for(const [url,file] of Object.entries({shapeSnapshot:'services/shapeSnapshot.js',steelRebarShapes:'modules/steel-rebar/shapes.js',shapeCommercial:'modules/steel-rebar/shape-commercial.js',shapeRecognition:'modules/steel-rebar/shape-recognition.js'}))app.get('/'+url+'.js',(_req,res)=>res.sendFile(path.join(root,file)));
  app.use(express.static(path.join(root,'public')));
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});let browser;
  try{
    browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],dialogs=[];
    page.on('pageerror',error=>errors.push(error.message));page.on('dialog',async dialog=>{dialogs.push(dialog.message());await dialog.dismiss();});
    await page.addInitScript(()=>{localStorage.setItem('ib_access_token','isolated-delivery-date-fixture');localStorage.setItem('ib_role','office');});
    const base='http://127.0.0.1:'+server.address().port;
    for(const date of ['', '2026-12-20']){
      await page.goto(base+'/index.html');assert.equal(await page.locator('#deliveryDate').inputValue(),defaultDate());
      await page.locator('#noCustomerContextCard').click();await page.locator('#customerSearch').fill('בדיקת תאריך');await page.locator('#inspectorEditHost .inspector-close').click();
      await page.locator('#noSiteContextCard').click();await page.locator('#deliverySiteName').fill('אתר בדיקה');await page.locator('#deliveryAddress').fill('כתובת בדיקה');await page.locator('#deliveryDate').fill(date);await page.locator('#inspectorEditHost .inspector-close').click();
      await page.getByRole('button',{name:'+ בחר צורה',exact:true}).click();await page.getByRole('button',{name:'פתח רשימת צורות',exact:true}).click();await page.getByRole('dialog',{name:'קטלוג צורות',exact:true}).getByRole('button',{name:'1 · מוט ישר',exact:true}).click();await page.locator('[data-side="0"]').fill('100');await page.locator('#seDiameterSelect').selectOption('12');await page.locator('#seQuantityInput').fill('2');await page.locator('#seQuantityInput').press('Tab');await page.getByRole('button',{name:'אשר צורה',exact:true}).click();assert.deepEqual(dialogs,[]);await page.locator('#seOverlay.show').waitFor({state:'hidden'});
      await page.getByRole('button',{name:'שמור הזמנה',exact:true}).click();await page.waitForSelector('#successOverlay.show');
      assert.equal(saved.at(-1).order.deliveryDate,date||defaultDate());assert.equal(saved.at(-1).pallets[0].items[0].qty,2);
      if(process.env.DELIVERY_DATE_QA_OUTPUT){fs.mkdirSync(process.env.DELIVERY_DATE_QA_OUTPUT,{recursive:true});await page.screenshot({path:path.join(process.env.DELIVERY_DATE_QA_OUTPUT,date?'explicit-date.png':'blank-date-saved.png')});}
    }
    assert.deepEqual(dialogs,[]);assert.deepEqual(errors,[]);console.log('PASS: actual new-order page initializes +2 factory calendar days, saves a cleared date with +2, preserves an explicit date and saves the edited shape without a missing-date alert. Only isolated fixture orders were submitted.');
  }finally{await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
