'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),express=require('express'),{WebSocketServer}=require('ws');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
(async()=>{
  const app=express(),root=path.resolve(__dirname,'..');let failure=false,nextDelay=0,requests=0;
  const fixture=id=>({id,pallet_id:id,order_id:id,order_num:'QUEUE-QA-'+id,order_status:'בייצור',order_payment_status:'unpaid',order_deleted_at:null,customer_name:'לקוח בדיקת תור',priority:'רגיל',delivery_date:'2026-11-13',machine:'A',status:'ממתין',quantity:10,produced_qty:0,diameter:12,total_length_mm:1000,weight:8.88,shape_name:'מוט ישר',segments:'[{"length_mm":1000,"angle_deg":0}]',shape_svg:'<svg viewBox="0 0 100 50"><path d="M10 25H90" fill="none" stroke="#1f3d5b" stroke-width="3"/></svg>'});
  let rows=[fixture(1),fixture(2)];
  for (const row of rows) row.shape_svg=row.shape_svg.replace('<svg ', '<svg aria-label="צורת ברזל" ');
  app.get(['/nav.js','/help.js'],(_req,res)=>res.type('js').send(''));
  app.get('/api/machines',(_req,res)=>res.json([{id:1,name:'A',label:'A',status:'לא מחובר'}]));
  app.get(['/api/users','/api/downtime-reasons'],(_req,res)=>res.json([]));
  app.get('/api/kpi/tons-today',(_req,res)=>res.json({tons:0}));
  app.get('/api/production-queue',(req,res)=>{
    requests++;const fail=failure,delay=nextDelay;nextDelay=0;
    const items=structuredClone(rows.filter(i=>!req.query.machine||i.machine===req.query.machine));
    const grouped={};for(const item of items)(grouped[item.machine]||=[]).push(item);
    const send=()=>fail?res.status(503).json({error:'fixture unavailable'}):res.json({items,grouped});
    if(delay)setTimeout(send,delay);else send();
  });
  app.use(express.static(path.join(root,'public')));
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const wss=new WebSocketServer({server}),broadcast=type=>{for(const socket of wss.clients)if(socket.readyState===1)socket.send(JSON.stringify({type,data:{id:1}}));};let browser;
  try{
    browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
    page.on('pageerror',e=>errors.push(e.message));await page.addInitScript(()=>{localStorage.setItem('ib_access_token','isolated-queue-fixture');localStorage.setItem('ib_role','production');});
    await page.goto('http://127.0.0.1:'+server.address().port+'/production-queue.html');
    await page.waitForFunction(()=>document.querySelectorAll('.queue-item').length===2);
    assert.equal(await page.locator('#shift-pieces').innerText(),'2');assert.match(await page.locator('#shift-pieces').locator('..').innerText(),/פריטים בתור/);
    await page.locator('button[data-lang="en"]').click();assert.match(await page.locator('#shift-pieces').locator('..').innerText(),/Items in queue/i);
    await page.locator('button[data-lang="he"]').click();assert.match(await page.locator('#shift-pieces').locator('..').innerText(),/פריטים בתור/);
    await page.locator('[data-machine="A"]').click();await page.waitForTimeout(300);
    rows=[fixture(2)];broadcast('order_updated');await page.waitForFunction(()=>document.querySelectorAll('.queue-item').length===1);
    assert.equal(await page.locator('#shift-pieces').innerText(),'1');assert.ok(!(await page.locator('#machines-grid').innerText()).includes('QUEUE-QA-1'));assert.ok((await page.locator('[data-machine="A"]').getAttribute('class')).includes('active'));
    failure=true;broadcast('order_deleted');await page.getByText('לא ניתן לעדכן את תור הייצור מהמערכת.',{exact:false}).waitFor();
    assert.equal(await page.locator('.queue-item').count(),0);assert.equal(await page.locator('#shift-pieces').innerText(),'—');
    failure=false;rows=[];broadcast('order_status');await page.getByText('✅ אין פריטים ממתינים לייצור',{exact:true}).waitFor();assert.equal(await page.locator('#shift-pieces').innerText(),'0');
    // An old slow response must not resurrect a card removed by a newer event.
    rows=[fixture(3)];nextDelay=700;const before=requests;await page.locator('button[onclick="loadQueue()"]').click();
    for(let n=0;n<25&&requests===before;n++)await page.waitForTimeout(20);
    rows=[];broadcast('order_updated');await page.waitForTimeout(1000);
    assert.equal(await page.locator('.queue-item').count(),0);assert.equal(await page.locator('#shift-pieces').innerText(),'0');
    if(process.env.PRODUCTION_QUEUE_QA_OUTPUT){fs.mkdirSync(process.env.PRODUCTION_QUEUE_QA_OUTPUT,{recursive:true});await page.screenshot({path:path.join(process.env.PRODUCTION_QUEUE_QA_OUTPUT,'queue-empty-after-lifecycle-event.png')});}
    assert.deepEqual(errors,[]);console.log('PASS: order lifecycle WebSocket event refreshes and removes cards without reload; selected machine stays selected; fetch failure removes stale actionable cards; empty response resets count to zero; old delayed response cannot restore a closed card. Isolated fixtures only, no machine operations.');
  }finally{await browser?.close();for(const socket of wss.clients)socket.terminate();await new Promise(r=>wss.close(r));server.closeAllConnections();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
