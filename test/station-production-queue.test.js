'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'SYNTHETIC-station-queue-'));process.env.NODE_ENV='test';process.env.JWT_SECRET='SYNTHETIC-station-queue-test';process.env.BCRYPT_ROUNDS='4';process.env.DB_PATH=path.join(root,'test.db');process.env.BACKUP_DIR=path.join(root,'backups');
const {db,server,closeServer}=require('../server'),{hashPin}=require('../auth-core'),{ORDER_STATUS,ITEM_STATUS}=require('../status-contracts');
const {StationInbox}=require('../services/machineIntegration/stationInbox'),{StationProductionQueue}=require('../services/machineIntegration/productionQueue');
const cards=require('../services/productionCards');let base,headers,admin,binding,machine,other,order,ids={};
const shape={contractVersion:2,shapeId:'SYNTHETIC-shape',shapeVersion:1,family:'bars',data:{sides:[300,500,300],angles:[90,90],diameter:8}};
test.before(async()=>{
 if(!server.listening)await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;
 db.prepare('INSERT INTO users(username,display_name,role,pin,pin_hash,active,password_changed_at) VALUES(?,?,?,?,?,1,?)').run('SYNTHETIC-queue','SYNTHETIC','admin','1234',hashPin('1234',4),new Date().toISOString());
 const auth=await(await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'SYNTHETIC-queue',pin:'1234'})})).json();admin={Authorization:'Bearer '+auth.access_token};
 if(!db.prepare("SELECT id FROM machines WHERE name='6' AND retired_at IS NULL").get())db.prepare("INSERT INTO machines(name,label,status) VALUES('6','6','לא מחובר')").run();
 machine=db.prepare("SELECT * FROM machines WHERE name='6' AND retired_at IS NULL").get();
 db.prepare("INSERT INTO machines(name,label,status) VALUES('SYNTHETIC-other','SYNTHETIC-other','לא מחובר')").run();other=db.prepare("SELECT * FROM machines WHERE name='SYNTHETIC-other'").get();
 binding=new StationInbox({db}).register({id:1},{sourceId:'SYNTHETIC-queue-source',logicalMachineId:'machine6',machineId:machine.id});headers={'X-Station-Credential':binding.credential,'X-Station-Source':binding.sourceId};
 const customer=Number(db.prepare('INSERT INTO customers(name) VALUES(?)').run('SYNTHETIC לקוח').lastInsertRowid);
 const makeOrder=(number,status=ORDER_STATUS.PRODUCTION_QUEUE)=>Number(db.prepare('INSERT INTO orders(order_num,customer_id,status,priority,delivery_date) VALUES(?,?,?,?,?)').run(number,customer,status,'רגיל','2026-11-16').lastInsertRowid);
 order=makeOrder('SYNTHETIC-QUEUE');const pallet=Number(db.prepare('INSERT INTO pallets(order_id,pallet_num) VALUES(?,1)').run(order).lastInsertRowid);
 const item=(name,values={})=>{const row={machine_id:machine.id,machine:machine.name,quantity:100,produced_qty:0,status:ITEM_STATUS.WAITING,diameter:8,shape_snapshot_json:JSON.stringify(shape),...values};
  const result=db.prepare('INSERT INTO items(pallet_id,shape_id,shape_name,machine_id,machine,quantity,produced_qty,status,diameter,shape_snapshot_json) VALUES(?,?,?,?,?,?,?,?,?,?)').run(pallet,'SYNTHETIC-shape',name,row.machine_id,row.machine,row.quantity,row.produced_qty,row.status,row.diameter,row.shape_snapshot_json);return Number(result.lastInsertRowid);};
 ids.waiting=item('SYNTHETIC waiting');ids.running=item('SYNTHETIC running',{status:ITEM_STATUS.IN_PRODUCTION,produced_qty:17,diameter:10});ids.other=item('SYNTHETIC other',{machine_id:other.id,machine:other.name});
 ids.cancelled=item('SYNTHETIC cancelled');db.prepare('UPDATE items SET cancelled_at=? WHERE id=?').run(new Date().toISOString(),ids.cancelled);
 ids.stopped=item('SYNTHETIC stopped');db.prepare('UPDATE items SET production_stopped_at=? WHERE id=?').run(new Date().toISOString(),ids.stopped);
 ids.done=item('SYNTHETIC done',{status:ITEM_STATUS.DONE});ids.conflict=item('SYNTHETIC conflicting',{machine:other.name});
 ids.noShape=item('SYNTHETIC missing shape',{shape_snapshot_json:null});
});
test.after(async()=>{await new Promise(resolve=>closeServer(resolve));});
const get=async(route,auth=headers)=>{const response=await fetch(base+route,{headers:auth});return{status:response.status,body:await response.json()};};
const queue=extra=>get('/api/machine-integration/station-queue?sourceId='+binding.sourceId+(extra||''));
test('station queue uses the original Production queue, order and machine assignment without a worker account',async()=>{
 const station=await queue(),original=await get('/api/production-queue?machine='+encodeURIComponent(machine.name),admin);assert.equal(station.status,200);assert.equal(original.status,200);
 assert.deepEqual(station.body.items.map(i=>i.itemId),original.body.items.map(i=>i.id));assert.equal(station.body.machine.id,machine.id);assert.equal(station.body.logicalMachineId,'machine6');
 for(const id of [ids.other,ids.cancelled,ids.stopped,ids.done])assert.equal(station.body.items.some(i=>i.itemId===id),false);
 assert.equal(station.body.items.find(i=>i.itemId===ids.conflict).canOpen,false);assert.equal(station.body.items.find(i=>i.itemId===ids.noShape).canOpen,false);
});
test('filters and pagination retain source order, totals and piece quantities',async()=>{
 const all=(await queue()).body,first=(await queue('&limit=1')).body,second=(await queue('&limit=1&offset=1')).body;
 assert.equal(first.total,all.total);assert.equal(first.items[0].itemId,all.items[0].itemId);assert.equal(second.items[0].itemId,all.items[1].itemId);
 const running=(await queue('&status=running&diameter=10')).body;assert.equal(running.total,1);assert.equal(running.items[0].remainingPieces,83);
 const found=(await queue('&q='+encodeURIComponent('SYNTHETIC running'))).body;assert.deepEqual(found.items.map(i=>i.itemId),[ids.running]);
 assert.equal((await queue('&limit=1000')).status,422);assert.equal((await queue('&machineId='+other.id)).status,422);
 assert.equal((await get('/api/machine-integration/station-queue?sourceId=another',headers)).status,403);
 assert.notEqual((await get('/api/production-queue',headers)).status,200);
});
test('queue opening revalidates membership and the exact card definition without creating a scan event',async()=>{
 const entry=(await queue()).body.items.find(i=>i.itemId===ids.waiting),before=db.prepare('SELECT count(*) n FROM worker_card_activity').get().n;
 const snapshot=()=>get('/api/machine-feedback/snapshot?'+new URLSearchParams({sourceId:binding.sourceId,card:entry.scanToken,queueOnly:'1',queueRevision:entry.revision}));
 const opened=await snapshot();assert.equal(opened.status,200);assert.equal(opened.body.original_card.card_quantity,100);assert.equal(opened.body.activityFree,true);
 assert.equal(db.prepare('SELECT count(*) n FROM worker_card_activity').get().n,before);
 db.prepare('UPDATE items SET produced_qty=11 WHERE id=?').run(ids.waiting);assert.equal((await snapshot()).status,200);
 db.prepare('UPDATE items SET quantity=101 WHERE id=?').run(ids.waiting);assert.equal((await snapshot()).body.error,'STATION_QUEUE_ITEM_CHANGED');
 db.prepare('UPDATE items SET quantity=100,status=? WHERE id=?').run(ITEM_STATUS.DONE,ids.waiting);assert.equal((await snapshot()).body.error,'STATION_QUEUE_ITEM_NO_LONGER_AVAILABLE');
 db.prepare('UPDATE items SET status=? WHERE id=?').run(ITEM_STATUS.WAITING,ids.waiting);
});
test('a split barcode keeps its printed suffix and quantity instead of borrowing the full queue row quantity',async()=>{
 const entry=(await queue()).body.items.find(i=>i.itemId===ids.waiting),token=entry.scanToken+'-C2OF3';
 const result=await get('/api/machine-feedback/snapshot?'+new URLSearchParams({sourceId:binding.sourceId,card:token}));
 assert.equal(result.status,200);assert.equal(result.body.original_card.card_quantity,33);assert.equal(result.body.original_card.card_index,2);
 assert.equal(entry.quantityScope,'whole_item');assert.equal(entry.quantityPieces,100);assert.equal(entry.scanToken,cards.itemScanCode({id:ids.waiting},'SYNTHETIC-QUEUE'));
});
test('an order leaving the real production gate disappears from the station queue',async()=>{
 db.prepare('UPDATE orders SET status=? WHERE id=?').run(ORDER_STATUS.PENDING_APPROVAL,order);assert.equal((await queue()).body.total,0);
 db.prepare('UPDATE orders SET status=? WHERE id=?').run(ORDER_STATUS.PRODUCTION_QUEUE,order);assert.ok((await queue()).body.total>0);
 db.prepare('UPDATE orders SET deleted_at=? WHERE id=?').run(new Date().toISOString(),order);assert.equal((await queue()).body.total,0);db.prepare('UPDATE orders SET deleted_at=NULL WHERE id=?').run(order);
});
test('progress reads never mutate the item quantities or production status',async()=>{
 const before=db.prepare('SELECT id,status,quantity,produced_qty FROM items ORDER BY id').all();await queue();await queue('&q=no-match');
 assert.deepEqual(db.prepare('SELECT id,status,quantity,produced_qty FROM items ORDER BY id').all(),before);
});
