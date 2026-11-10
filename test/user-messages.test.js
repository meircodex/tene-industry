'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');
const messages = require('../public/user-messages');
const { attachResponseMessages, apiErrorHandler } = require('../services/httpUserMessages');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('known failures explain the cause and next action without exposing technical text', () => {
  const samples = [
    ['invalid_diameter', /קוטר.*מילימטרים/],
    ['order_not_found', /הזמנה.*לבחור/],
    ['invalid_preferred_raw_material', /מנת המלאי.*לבחור/],
    ['stocktake_preview_stale', /השתנו.*לחשב מחדש/],
    ['produced_qty_exceeds_quantity', /גדולה מהכמות.*לבדוק/],
    ['multi_order_customer_mismatch', /לקוחות שונים.*אותו לקוח/],
    ['customer.name is required', /שם לקוח.*להזין/],
    ['actual_weight_kg must be a non-negative number', /שאינו שלילי.*בקילוגרמים/],
    ['sku_exists', /המק״ט.*קיים.*מספר אחר/],
  ];
  for (const [code, expected] of samples) {
    const text = messages.text(code);
    assert.match(text, expected, code);
    assert.doesNotMatch(text, /[a-z]+_[a-z]+/i);
  }
  assert.match(messages.text('FOREIGN KEY constraint failed', { path:'/api/orders', method:'POST', requestId:'abc123' }), /ההזמנה.*רשומה שאינה קיימת.*מספר פנייה: abc123/);
  assert.match(messages.text('UNIQUE constraint failed: orders.order_num'), /אותו מספר או קוד.*כבר נשמרה/);
  assert.match(messages.text('database or disk is full',{path:'/api/admin/database/download',method:'GET'}),/הכנת גיבוי להורדה.*אין מספיק שטח פנוי/);
});

test('network ambiguity never claims the operation failed to save or retries a mutation', () => {
  for (const raw of ['Failed to fetch','The operation was aborted.','NetworkError','request timed out']) {
    const text = messages.text(raw);
    assert.match(text, /לא התקבל אישור.*אם הפעולה נקלטה.*לפני ניסיון נוסף/);
    assert.doesNotMatch(text, /לא נשמר|נשמרה בהצלחה/);
  }
});

test('the actual auth and permission error strings have specific Hebrew explanations', () => {
  for (const file of ['auth-core.js','permissions.js','server.js','middleware/auth.js']) {
    for (const match of read(file).matchAll(/error\s*:\s*(['"])([^'"\n]+)\1/g)) {
      if (/[\u0590-\u05ff]/.test(match[2])) continue;
      assert.ok(messages.isKnownCode(match[2]),file+': '+match[2]);
      assert.doesNotMatch(messages.text(match[2]),/^לא ניתן היה להשלים/);
    }
  }
});

test('internal errors are honest, hide internals and include an available reference', () => {
  for (const raw of ['Cannot read properties of null (reading id)', 'SQLITE_ERROR secret_table', '<html>private server page</html>', 'C:\\private\\secret.db', 'unrecognized_machine_failure']) {
    const text = messages.text(raw, { requestId:'ref-42' });
    assert.match(text, /מנהל המערכת.*מספר פנייה: ref-42/);
    assert.doesNotMatch(text, /secret|private|SQLITE|Cannot read|<html>|unrecognized_machine/);
  }
  assert.doesNotMatch(messages.text('unknown', {requestId:'<script>private</script>'}), /script|private/);
});

test('Hebrew success, exact field errors and user identifiers retain their meaning', () => {
  for (const text of ['הטיוטה נשמרה','פריט ABC_12 נשמר','שורת פריט 2. מנת מלאי שנבחרה: 999. יש לבחור מקור חדש.']) assert.equal(messages.text(text), text);
  assert.equal(messages.text(''), '');
  assert.equal(messages.text('Draft saved for review'), 'הטיוטה נשמרה לבדיקה.');
  assert.match(messages.text('שגיאה: FOREIGN KEY constraint failed'), /רשומה שאינה קיימת/);
  assert.equal(messages.isFailure('הטיוטה נשמרה'),false);
  assert.equal(messages.isFailure(messages.text('invalid_diameter')),true);
  assert.ok(messages.duration(messages.text('Failed to fetch'))>8000);
});

test('legacy response helper reads the exact server diagnosis without consuming the response', async () => {
  const response=new Response(JSON.stringify({error:'produced_qty_exceeds_quantity',user_message:'פריט מספר 17. הכמות המותרת בפריט: 8 יחידות. הוזנה כמות גדולה יותר.'}),{status:400});
  const error=await messages.responseError(response,'שגיאה כללית');
  assert.match(error.message,/פריט מספר 17.*8 יחידות/);
  assert.equal(error.code,'produced_qty_exceeds_quantity');
  assert.equal(response.bodyUsed,false);
  assert.equal((await response.json()).error,error.code);
});

test('browser dialogs translate once and preserve confirm/prompt return values and defaults', () => {
  const calls = [];
  const window = { document:{}, alert:(...args)=>calls.push(['alert',...args]), confirm:(...args)=>{calls.push(['confirm',...args]);return false;}, prompt:(...args)=>{calls.push(['prompt',...args]);return '123';} };
  const context = vm.createContext({window});
  vm.runInContext(read('public/user-messages.js'), context);
  const original = window.alert;
  vm.runInContext(read('public/user-messages.js'), context);
  assert.equal(window.alert, original);
  window.alert('FOREIGN KEY constraint failed');
  assert.equal(window.confirm('למחוק את הפריט?'), false);
  assert.equal(window.prompt('הזן מספר פריט', '17'), '123');
  assert.match(calls[0][1], /רשומה שאינה קיימת/);
  assert.deepEqual(calls.slice(1), [['confirm','למחוק את הפריט?'],['prompt','הזן מספר פריט','17']]);
});

function browser(fetchImpl) {
  const storage = {getItem:()=>null,setItem:()=>{},removeItem:()=>{}};
  const window = {document:{},fetch:fetchImpl,dispatchEvent:()=>{}};
  const context = vm.createContext({window,document:window.document,localStorage:storage,sessionStorage:storage,Headers,URL,location:{protocol:'http:',host:'localhost'},CustomEvent:class {}});
  vm.runInContext(read('public/user-messages.js'), context);
  vm.runInContext(read('public/auth-client.js'), context);
  return window;
}

test('API clients retain exact error codes, response status and single-send behavior', async () => {
  let count = 0;
  const window = browser(async () => { count++;return new Response(JSON.stringify({error:'stocktake_preview_stale',_requestId:'ref1'}),{status:409}); });
  const response = await window.fetch('/api/inventory/stocktakes/1/approve', {method:'POST'});
  const body = await response.json();
  assert.equal(response.status,409);
  assert.equal(body.error,'stocktake_preview_stale');
  assert.match(body.user_message,/השתנו.*מחדש/);
  assert.equal(count,1);
});

test('offline API write and invalid JSON produce Hebrew without repeating writes', async () => {
  let count = 0;
  const window = browser(async () => { count++;throw new TypeError('Failed to fetch'); });
  await assert.rejects(window.fetch('/api/orders',{method:'POST'}), /לא התקבל אישור.*אם הפעולה נקלטה/);
  assert.equal(count,1);
  const html = browser(async () => new Response('<html>secret</html>',{status:502,headers:{'X-Request-Id':'ref-9'}}));
  await assert.rejects((await html.fetch('/api/orders')).json(), error => /מספר פנייה: ref-9/.test(error.message) && !/secret|<html>/.test(error.message));
});

test('HTTP error middleware adds Hebrew with the actual affected item and selected lot', async t => {
  const app = express();
  app.use((req,res,next)=>{req.requestId='test-request';next();});
  app.use(attachResponseMessages);
  app.use(express.json({limit:'1kb'}));
  app.post('/api/orders/:id', (req,res)=>res.status(400).json({error:'invalid_preferred_raw_material',details:{item_sequence:2,field:'preferred_raw_material_id',value:999}}));
  app.get('/api/unique',(req,res)=>res.status(409).json({error:'UNIQUE constraint failed: orders.order_num'}));
  app.get('/api/unexpected',()=>{throw new Error('private stack or SQL');});
  app.use(apiErrorHandler);
  const server = await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const base=`http://127.0.0.1:${server.address().port}`;
  const response=await fetch(base+'/api/orders/17',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  const body=await response.json();
  assert.equal(response.status,400);
  assert.equal(body.error,'invalid_preferred_raw_material');
  assert.match(body.user_message,/הזמנה מספר 17.*שורת פריט 2.*מנת מלאי שנבחרה: 999.*לבחור/);
  for (const [payload,status,pattern] of [['{',400,/מבנה תקין/],[JSON.stringify({long:'a'.repeat(1200)}),413,/גדולים מהמותר/]]) {
    const r=await fetch(base+'/api/orders/17',{method:'POST',headers:{'Content-Type':'application/json'},body:payload});
    assert.equal(r.status,status);assert.match((await r.json()).user_message,pattern);
  }
  const error=await (await fetch(base+'/api/unexpected')).json();
  assert.match(error.user_message,/מספר פנייה: test-request/);
  assert.doesNotMatch(error.user_message,/private|stack|SQL/);
});

test('all application pages load the shared messages before their first executable script and remain syntactically valid', () => {
  const publicDir=path.join(__dirname,'../public');
  for (const name of fs.readdirSync(publicDir).filter(n=>n.endsWith('.html'))) {
    const source=fs.readFileSync(path.join(publicDir,name),'utf8');
    assert.match(source, /<head[^>]*>\s*<script src="\/user-messages.js\?v=1"><\/script>/i, name);
    for (const match of source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      if (/\bsrc\s*=|type\s*=\s*["'](?:application\/(?:ld\+)?json|module)/i.test(match[1])) continue;
      new vm.Script(match[2], {filename:name});
    }
  }
});
