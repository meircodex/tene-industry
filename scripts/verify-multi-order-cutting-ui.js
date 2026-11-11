'use strict';
const express=require('express'),path=require('node:path'),fs=require('node:fs'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..');
(async()=>{
  const app=express();let writes=0,detailCalls=0,stockCalls=0,stockFail=false,previewCalls=0;
  const make=(id,customer,length,qty=1)=>({id,order_num:'ORD-'+id,customer_id:customer,customer_name:'לקוח '+customer,status:'בייצור',delivery_address:'אתר א',total_weight:10,priority:'normal',
    pallets:[{id,pallet_num:1,items:[{id:100+id,diameter:12,quantity:qty,total_length_mm:length,shape_name:'straight',segments:JSON.stringify([{length_mm:length,angle_deg:180}]),total_weight:10,status:'ממתין'}]}]});
  const orders=[make(1,10,7000),make(2,20,5000),make(3,10,4000,2)];
  let sources=[{id:101,diameter:12,nominal_length_mm:12000,physical_kg:10.656,allocated_to_other_orders_kg:0,available_kg:10.656,calculated_bar_count:1,kg_per_meter:.888,unit_weight_kg:10.656,grade:'B500B',lot_number:'12M'},
    {id:102,diameter:12,nominal_length_mm:6000,physical_kg:5.328,allocated_to_other_orders_kg:0,available_kg:5.328,calculated_bar_count:1,kg_per_meter:.888,unit_weight_kg:5.328,grade:'B500B',lot_number:'6M'}];
  app.use(express.json());app.use('/api',(req,_res,next)=>{if(req.method!=='GET')writes++;next();});
  app.get(['/nav.js','/help.js'],(_req,res)=>res.type('js').send(''));
  app.get('/api/portal-requests',(_req,res)=>res.json({pendingCount:0,unreadCount:0}));
  app.get('/api/orders',(_req,res)=>res.json(orders));
  app.get('/api/orders/:id',(req,res)=>{detailCalls++;const order=orders.find(o=>o.id===Number(req.params.id));order?res.json(order):res.status(404).json({error:'הזמנה לא נמצאה'});});
  app.get('/api/inventory/cutting-stock',(_req,res)=>{stockCalls++;stockFail?res.status(503).json({error:'המלאי אינו זמין לבדיקה כרגע'}):res.json({captured_at:new Date().toISOString(),sources});});
  app.get('/api/operations/orders',(_req,res)=>res.json({orders}));app.get('/api/operations/order-drafts',(_req,res)=>res.json([]));
  app.post('/api/operations/delivery-preview',(_req,res)=>{previewCalls++;res.status(400).json({error:'לא אמור להיקרא במצב זה'});});
  for(const [url,file] of Object.entries({shapeSnapshot:'services/shapeSnapshot.js',steelRebarShapes:'modules/steel-rebar/shapes.js',shapeCommercial:'modules/steel-rebar/shape-commercial.js',shapeRecognition:'modules/steel-rebar/shape-recognition.js'}))app.get('/'+url+'.js',(_req,res)=>res.sendFile(path.join(root,file)));
  app.use(express.static(path.join(root,'public')));
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});let browser;
  try{
    browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
    page.on('pageerror',e=>errors.push(e.message));await page.addInitScript(()=>{localStorage.setItem('ib_access_token','isolated-ui-fixture');localStorage.setItem('ib_role','manager');});
    const base=`http://127.0.0.1:${server.address().port}`;await page.goto(base+'/orders.html');await page.waitForSelector('#ordersBody [data-batch-order="3"]');
    assert.equal(await page.locator('#orderBatchToolbar').isVisible(),false);
    const orderIds=()=>page.locator('#ordersBody [data-batch-order]').evaluateAll(inputs=>inputs.map(el=>Number(el.dataset.batchOrder)));
    await page.locator('[data-sort-key="order_num"]').click();assert.deepEqual(await orderIds(),[1,2,3]);
    assert.equal(await page.locator('[data-sort-key="order_num"]').evaluate(el=>el.closest('th').getAttribute('aria-sort')),'ascending');
    await page.locator('[data-sort-key="order_num"]').click();assert.deepEqual(await orderIds(),[3,2,1]);
    assert.equal(await page.locator('[data-sort-key="order_num"]').evaluate(el=>el.closest('th').getAttribute('aria-sort')),'descending');
    for(const key of ['customer_name','delivery_date','priority','total_weight','status','notes']){await page.locator('[data-sort-key="'+key+'"]').click();await page.locator('[data-sort-key="'+key+'"]').click();}
    await page.locator('#ordersBody [data-batch-order="1"]').check();await page.locator('#ordersBody [data-batch-order="2"]').check();
    assert.equal(detailCalls,0,'selection cannot open order details');assert.match(await page.locator('#orderBatchCount').innerText(),/^2 /);
    await page.locator('[data-sort-key="order_num"]').click();assert.match(await page.locator('#orderBatchCount').innerText(),/^2 /);assert.equal(await page.locator('#ordersBody input[data-batch-order]:checked').count(),2);
    assert.equal(await page.locator('#orderBatchDelivery').evaluate(el=>el.classList.contains('is-unavailable')),true);
    assert.equal(await page.getByText('לא ניתן לעשות תעודת משלוח אחת ללקוחות שונים',{exact:true}).count(),0,'no permanent explanation');
    const dialogPromise=page.waitForEvent('dialog').then(async dialog=>{assert.equal(dialog.message(),'לא ניתן לעשות תעודת משלוח אחת ללקוחות שונים');await dialog.dismiss();});await page.locator('#orderBatchDelivery').click();await dialogPromise;assert.match(page.url(),/orders.html$/);
    await page.locator('#orderBatchCutting').click();await page.waitForSelector('#straightStockInventory [data-cut-stock="101"]');
    assert.match(await page.locator('#straightStockMeta').innerText(),/ORD-1.*ORD-2/);
    assert.equal(await page.locator('#straightStockInventory input[type=number]').count(),0,'length separation is read from Inventory, never edited here');
    await page.locator('#straightStockCalculate').click();await page.waitForSelector('#straightStockResults .cut-group');
    assert.ok(await page.locator('#straightStockItems').evaluate(el=>el.closest('.straight-stock-table-wrap').getBoundingClientRect().height>80),'selected items remain visible after results grow');
    assert.match(await page.locator('.cut-summary-card').first().innerText(),/1 PCS/);assert.match(await page.locator('.cut-bar-mixed').innerText(),/ORD-1.*ORD-2/);assert.equal(await page.locator('.cut-bar-row').count(),1);
    assert.ok(stockCalls>=2,'calculation refreshes current Inventory');
    const shots=process.env.CUTTING_QA_OUTPUT;if(shots){fs.mkdirSync(shots,{recursive:true});await page.screenshot({path:path.join(shots,'combined-orders.png')});}
    await page.locator('#straightStockSeparateOrders').check();await page.locator('#straightStockCalculate').click();await page.waitForFunction(()=>document.querySelectorAll('.cut-bar-row').length===2);assert.match(await page.locator('.cut-summary-card').first().innerText(),/2 PCS/);
    sources[0]={...sources[0],available_kg:0,physical_kg:0,calculated_bar_count:0};await page.locator('#straightStockSeparateOrders').uncheck();await page.locator('#straightStockCalculate').click();await page.waitForSelector('#straightStockResults .cut-warning');assert.match(await page.locator('#straightStockResults .cut-warning').innerText(),/תוכנית חלקית[\s\S]*ORD-1/);assert.equal(await page.locator('.cut-bar-row').count(),1);
    sources[1]={...sources[1],nominal_length_mm:null,calculated_bar_count:null,unit_weight_kg:null};await page.locator('#straightStockCalculate').click();await page.waitForFunction(()=>document.getElementById('straightStockResults').textContent.includes('חסר אורך במלאי'));assert.equal(await page.locator('.cut-group').count(),0);
    stockFail=true;await page.locator('#straightStockCalculate').click();await page.waitForFunction(()=>document.getElementById('straightStockResults').textContent.includes('המלאי אינו זמין'));assert.equal(await page.locator('.cut-group').count(),0);
    await page.locator('#straightStockOverlay .detail-close').click();await page.getByRole('button',{name:'נקה בחירה',exact:true}).click();
    await page.locator('#searchBox').fill('ORD-1');await page.locator('#orderBatchMaster').check();assert.match(await page.locator('#orderBatchCount').innerText(),/^1 /);await page.locator('#searchBox').fill('');
    await page.locator('#ordersBody [data-batch-order="3"]').check();assert.equal(await page.locator('#orderBatchDelivery').evaluate(el=>el.classList.contains('is-unavailable')),false);
    if(shots)await page.screenshot({path:path.join(shots,'mail-selection.png')});
    await page.locator('#orderBatchDelivery').click();await page.waitForURL('**/order-operations.html?orders=1,3');await page.waitForSelector('#order-list [data-order="1"]');assert.equal(await page.locator('#order-list input:checked').count(),2);assert.equal(writes,0,'navigation cannot issue documents or write orders');
    await page.goto(base+'/order-operations.html?orders=1,2');await page.waitForSelector('#order-list input:checked');await page.locator('#build-preview').click();await page.waitForFunction(()=>document.getElementById('feedback').textContent==='לא ניתן לעשות תעודת משלוח אחת ללקוחות שונים');assert.equal(previewCalls,0);
    const mobile=await browser.newPage({viewport:{width:390,height:844}});await mobile.goto(base+'/orders.html');await mobile.waitForSelector('#mobileCards [data-batch-order="1"]');await mobile.locator('#mobileCards [data-batch-order="1"]').check();await mobile.locator('#mobileCards [data-batch-order="2"]').check();assert.match(await mobile.locator('#orderBatchCount').innerText(),/^2 /);
    if(shots)await mobile.screenshot({path:path.join(shots,'mobile-selection.png')});await mobile.close();assert.deepEqual(errors,[]);
    console.log('PASS: mail selection, exact click-only cross-customer message and red slash, same-customer preselection without issuance, stock-limited worker planning, preserved order identities, separate-orders option, refresh/shortage/missing length/failure, no length editing or production writes.');
  }finally{await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
