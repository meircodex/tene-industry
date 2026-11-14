'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Database=require('better-sqlite3');
const {StationInbox}=require('../services/machineIntegration/stationInbox');
const {hashEvent}=require('../contracts/machine-station/v1');
function fixture(t){const db=new Database(':memory:');t.after(()=>db.close());db.exec('CREATE TABLE machines(id INTEGER PRIMARY KEY,name TEXT);INSERT INTO machines VALUES(1,\'SYNTHETIC-machine\');');const inbox=new StationInbox({db}),principal={id:1},binding=inbox.register(principal,{sourceId:'SYNTHETIC-station',logicalMachineId:'machine6',machineId:1});return{db,inbox,principal,binding};}
function message(id='test-message-1'){
 const payload={shapeSnapshot:{shapeId:'SYNTHETIC-shape',data:{sides:[300,500,300],angles:[90,90]}},planStatus:'BLOCKED'};
 const message={messageId:id,schemaVersion:'1.1',messageType:'job.prepared',owner:'MachineIntegration',machineId:'machine6',sourceId:'SYNTHETIC-station',entityId:'job1',entityRevision:1,occurredAt:'2026-11-13T10:00:00.000Z',payloadHash:hashEvent(payload),payload};
 return{message,contentHash:hashEvent(message)};
}
test('station reports are stored exactly once and acknowledge only committed original content',t=>{
 const{inbox,principal,binding}=fixture(t),batch={schemaVersion:'1.1',messages:[message()]};
 const first=inbox.ingest(principal,batch,binding.credential);assert.equal(first.results[0].status,'accepted');
 assert.equal(inbox.ingest(principal,batch,binding.credential).results[0].status,'duplicate');
 assert.equal(inbox.list().total,1);assert.deepEqual(inbox.list().items[0].message,batch.messages[0].message);
 assert.equal(inbox.list().items[0].machineId,1);assert.equal(inbox.list().items[0].authority,'station_report_not_source_shape_mutation');
});
test('binding credential, source and logical machine must all match',t=>{
 const{inbox,principal,binding}=fixture(t),item=message();
 assert.throws(()=>inbox.ingest(null,{schemaVersion:'1.1',messages:[item]},binding.credential),/AUTHENTICATION_REQUIRED/);
 assert.throws(()=>inbox.ingest(principal,{schemaVersion:'1.1',messages:[item]},'0'.repeat(64)),/STATION_SCOPE_FORBIDDEN/);
 item.message.machineId='another';item.contentHash=hashEvent(item.message);
 assert.throws(()=>inbox.ingest(principal,{schemaVersion:'1.1',messages:[item]},binding.credential),/STATION_SCOPE_FORBIDDEN/);
 assert.equal(inbox.list().total,0);
});
test('hash changes and message identity conflicts never overwrite the first station report',t=>{
 const{inbox,principal,binding}=fixture(t),item=message(),batch={schemaVersion:'1.1',messages:[item]};inbox.ingest(principal,batch,binding.credential);
 item.message.payload.planStatus='RESOLVED';assert.throws(()=>inbox.ingest(principal,batch,binding.credential),/STATION_CONTENT_HASH_MISMATCH/);
 item.message.payloadHash=hashEvent(item.message.payload);item.contentHash=hashEvent(item.message);
 assert.throws(()=>inbox.ingest(principal,batch,binding.credential),/STATION_MESSAGE_ID_CONFLICT/);
 assert.equal(inbox.list().items[0].message.payload.planStatus,'BLOCKED');
});
test('one conflicting report rolls back the entire new batch and station binding cannot change machine silently',t=>{
 const{inbox,principal,binding,db}=fixture(t);db.exec('INSERT INTO machines VALUES(2,\'SYNTHETIC-other\');');
 assert.throws(()=>inbox.register(principal,{sourceId:'SYNTHETIC-station',logicalMachineId:'machine6',machineId:2}),/STATION_MACHINE_BINDING_CONFLICT/);
 const old=message('existing');inbox.ingest(principal,{schemaVersion:'1.1',messages:[old]},binding.credential);
 old.message.entityRevision=2;old.contentHash=hashEvent(old.message);
 assert.throws(()=>inbox.ingest(principal,{schemaVersion:'1.1',messages:[message('new'),old]},binding.credential),/STATION_MESSAGE_ID_CONFLICT/);
 assert.equal(inbox.list().total,1);
});
test('manufacturing intent is versioned by full geometry and machine, independently from original shape',t=>{
 const{inbox,principal}=fixture(t),shape={shapeId:'SYNTHETIC-template',shapeVersion:1,family:'bars',data:{sides:[300,500,300],angles:[90,90],diameter:8}};
 const original=JSON.stringify(shape),intent={revision:1,dimensionReference:'outside',bends:[{bendIndex:1,plate:'REQUIRE',approach:'BELOW'}]};
 const record=inbox.saveIntent(principal,{shapeSnapshot:shape,machineId:1,expectedRevision:0,manufacturingIntent:intent});
 assert.equal(record.revision,1);assert.equal(record.status,'requested_not_machine_qualified');assert.equal(JSON.stringify(shape),original);
 const other={...shape,data:{...shape.data,sides:[200,700,200]}};
 const {geometryHash}=require('../contracts/machine-station/v1');
 assert.equal(inbox.getIntent({shapeId:shape.shapeId,shapeVersion:1,geometryHash:geometryHash(other),machineId:1}),null);
 assert.equal(inbox.getIntent({shapeId:shape.shapeId,shapeVersion:1,geometryHash:geometryHash(shape),machineId:1}).manufacturingIntent.bends[0].plate,'REQUIRE');
 assert.throws(()=>inbox.saveIntent(principal,{shapeSnapshot:shape,machineId:1,expectedRevision:0,manufacturingIntent:intent}),/INTENT_REVISION_CONFLICT/);
});
