'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const folder=fs.mkdtempSync(path.join(os.tmpdir(),'tene-certificate-cancel-'));
process.env.NODE_ENV='test';process.env.JWT_SECRET='local-document-cancel-test';process.env.BCRYPT_ROUNDS='4';
process.env.DB_PATH=path.join(folder,'qa.db');process.env.BACKUP_DIR=path.join(folder,'backups');
const {db,server,closeServer}=require('../server');const {hashPin}=require('../auth-core');
const {buildDeliveryCertificateProgress}=require('../services/deliveryCertificateProgress');
const {buildDeliveryNoteExportPayload}=require('../services/exportEngine');
test('document cancellation, replacement and cumulative status remain auditable and stale-safe',async t=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>closeServer(resolve));db.close();fs.rmSync(folder,{recursive:true,force:true});});
  const base='http://127.0.0.1:'+server.address().port;
  const tokens={};
  for(const role of ['office','warehouse','production','admin']) {
    db.prepare('INSERT INTO users(username,display_name,role,pin_hash,active,password_changed_at) VALUES(?,?,?,?,1,?)').run('qa-'+role,role,role,hashPin('1234',4),new Date().toISOString());
    const response=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'qa-'+role,pin:'1234'})});
    tokens[role]=(await response.json()).access_token;
  }
  const request=(url,method='GET',body,role='office')=>fetch(base+'/api'+url,{method,headers:{Authorization:'Bearer '+tokens[role],'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
  const customer=db.prepare("INSERT INTO customers(name) VALUES('TEST only')").run().lastInsertRowid;
  let serial=0;
  function fixture(status='הועמס') {
    const order=db.prepare("INSERT INTO orders(order_num,customer_id,status,total_weight) VALUES(?,?,'בייצור',20)").run('CANCEL-QA-'+ ++serial,customer).lastInsertRowid;
    const pallet=db.prepare('INSERT INTO pallets(order_id,pallet_num) VALUES(?,1)').run(order).lastInsertRowid;
    const item=db.prepare("INSERT INTO items(pallet_id,order_id,quantity,diameter,total_length_mm,total_weight,segments,status,produced_qty,started_at,completed_at) VALUES(?,?,10,12,2000,20,'[]',?,10,'2026-10-14 08:00','2026-10-14 09:00')").run(pallet,order,status).lastInsertRowid;
    return {order,item};
  }
  const endpoint=f=>`/orders/${f.order}/delivery-certificate`;
  async function issue(f) {
    const p=await(await request(endpoint(f)+'-preview')).json();
    const url=endpoint(f)+'?certificate_mode=source&issue_key='+p.issue_key+'&selection_fingerprint='+p.selection_fingerprint;
    const result=await request(url);assert.equal(result.status,200,await result.clone().text());
    const note=db.prepare('SELECT * FROM delivery_notes WHERE order_id=? ORDER BY id DESC').get(f.order);
    return {note,url,html:await result.text()};
  }
  async function preview(f,note) {const response=await request(`/orders/${f.order}/delivery-certificates/${note.id}/cancel-preview`);assert.equal(response.status,200,await response.clone().text());return response.json();}
  const cancel=(f,note,p,reason='כמות שגויה — תיקון מסמך')=>request(`/orders/${f.order}/delivery-certificates/${note.id}/cancel`,'POST',{reason,expected_fingerprint:p.fingerprint});

  await t.test('cancel frees quantities without deleting original, production or inventory; new full source replaces it',async()=>{
    const f=fixture();const {note,url}=await issue(f);
    const itemBefore=db.prepare('SELECT * FROM items WHERE id=?').get(f.item);
    const p=await preview(f,note);assert.equal(p.items[0].status,'הועמס');
    assert.equal((await cancel(f,note,p,'x')).status,400);
    assert.equal((await cancel(f,note,p)).status,200);
    const after=db.prepare('SELECT * FROM items WHERE id=?').get(f.item);
    assert.deepEqual({...after,status:itemBefore.status},itemBefore,'only item status may change');
    assert.equal(after.status,'הועמס');
    assert.deepEqual(db.prepare('SELECT * FROM delivery_notes WHERE id=?').get(note.id),note,'original remains byte-for-byte immutable');
    const progress=buildDeliveryCertificateProgress(db,f.order,[after]);
    assert.equal(progress.loaded_unit_count,10);assert.equal(progress.remaining_unit_count,10);
    assert.equal((await cancel(f,note,p)).status,409,'repeat cancellation must not free quantities twice');
    assert.equal((await request(url)).status,409,'old issuance URL must not reactivate void document');
    assert.match(await(await request(endpoint(f)+'?note_id='+note.id)).text(),/מבוטלת — אינה תעודת משלוח תקפה/);
    assert.match(await(await request('/delivery-notes/'+note.id+'/print')).text(),/מבוטלת — אינה תעודת משלוח תקפה/);
    assert.throws(()=>buildDeliveryNoteExportPayload(db,{delivery_note_id:note.id}),/delivery_note_cancelled/);
    const newItem=db.prepare("INSERT INTO items(pallet_id,order_id,quantity,diameter,total_length_mm,total_weight,segments,status) SELECT pallet_id,order_id,2,12,2000,4,'[]','הועמס' FROM items WHERE id=?").run(f.item).lastInsertRowid;
    const replacement=await issue(f);assert.doesNotMatch(replacement.html,/מחליפה תעודות מבוטלות|כמות שגויה — תיקון מסמך/,'correction notes stay inside the software only');
    const rows=JSON.parse(replacement.note.items_json);assert.equal(rows.length,2);assert.equal(rows.reduce((n,r)=>n+r.quantity,0),12);
    assert.equal(db.prepare('SELECT cancelled_note_id FROM delivery_note_replacements WHERE new_note_id=?').get(replacement.note.id).cancelled_note_id,note.id);
    assert.equal((await(await request(endpoint(f)+'-preview')).json()).loaded_item_count,0,'no double shipment');
    assert.ok(newItem>0);
  });
  await t.test('delivered implies all stages and permits first certificate, without downgrading delivery',async()=>{
    const f=fixture('ממתין');
    const patch=await request('/items/'+f.item+'/status','PATCH',{status:'סופק'});assert.equal(patch.status,200);
    const p=await(await request(endpoint(f)+'-preview')).json();
    assert.equal(p.loaded_unit_count,10);assert.equal(p.stage_counts.produced,1);assert.equal(p.stage_counts.loaded,1);assert.equal(p.stage_counts.sent,1);assert.equal(p.stage_counts.delivered,1);
    const {note}=await issue(f);assert.equal(db.prepare('SELECT status FROM items WHERE id=?').get(f.item).status,'סופק');
    assert.equal((await(await request(endpoint(f)+'-preview')).json()).loaded_unit_count,0);
    assert.equal((await cancel(f,note,await preview(f,note))).status,200);
    assert.equal(db.prepare('SELECT status FROM items WHERE id=?').get(f.item).status,'סופק');
    assert.equal((await(await request(endpoint(f)+'-preview')).json()).loaded_unit_count,10);
  });
  await t.test('stale preview rejected and deliberate later status correction preserved',async()=>{
    const f=fixture();const {note}=await issue(f);const p=await preview(f,note);
    const response=await request('/items/'+f.item+'/status','PATCH',{status:'הושלם',correction_reason:'לא היה מועמס בפועל'});assert.equal(response.status,200);
    assert.equal((await cancel(f,note,p)).status,409);
    const fresh=await preview(f,note);assert.equal(fresh.items[0].status,'הושלם');
    assert.equal((await cancel(f,note,fresh)).status,200);assert.equal(db.prepare('SELECT status FROM items WHERE id=?').get(f.item).status,'הושלם');
    assert.equal((await(await request(endpoint(f)+'-preview')).json()).loaded_unit_count,0,'not loaded is not automatically made ready');
  });
  await t.test('permissions, cross-order, invoices, signed/truck and concurrent-loading safeguards',async()=>{
    const f=fixture();const {note}=await issue(f);const path=`/orders/${f.order}/delivery-certificates/${note.id}/cancel-preview`;
    assert.equal((await fetch(base+'/api'+path)).status,401);
    assert.equal((await request(path,'GET',undefined,'warehouse')).status,403);
    assert.equal((await request(path,'GET',undefined,'production')).status,403);
    const other=fixture();assert.equal((await request(`/orders/${other.order}/delivery-certificates/${note.id}/cancel-preview`)).status,404);
    db.prepare("INSERT INTO invoices(order_id,invoice_num) VALUES(?,'QA-INVOICE')").run(f.order);assert.equal((await request(path)).status,409);
    const signed=fixture();const signedNote=(await issue(signed)).note;db.prepare("UPDATE delivery_notes SET signed_by='QA' WHERE id=?").run(signedNote.id);
    assert.equal((await request(`/orders/${signed.order}/delivery-certificates/${signedNote.id}/cancel-preview`)).status,409);
    const truck=fixture();const truckNote=(await issue(truck)).note;db.prepare("UPDATE delivery_notes SET note_num='DN-TRUCK-QA' WHERE id=?").run(truckNote.id);
    assert.equal((await request(`/orders/${truck.order}/delivery-certificates/${truckNote.id}/cancel-preview`)).status,409);
    const loading=fixture();const loadingNote=(await issue(loading)).note;
    db.prepare("INSERT INTO order_loading_sessions(session_uid,order_id,order_num,status) VALUES('CANCEL-LOADING',?,'QA','active')").run(loading.order);
    assert.equal((await request(`/orders/${loading.order}/delivery-certificates/${loadingNote.id}/cancel-preview`)).status,409);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM delivery_note_cancellations WHERE note_id IN (?,?,?,?)').get(note.id,signedNote.id,truckNote.id,loadingNote.id).n,0);
  });
});
