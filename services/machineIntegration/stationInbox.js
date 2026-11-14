'use strict';
const {randomBytes,timingSafeEqual,createHash}=require('node:crypto');
const {validateSyncBatch,string,geometryHash,hashEvent,createPrepareValidator}=require('../../contracts/machine-station/v1');
const digest=value=>createHash('sha256').update(value).digest('hex');
const fail=(code,status)=>{throw Object.assign(Error(code),{status});};

class StationInbox{
 constructor({db,now=()=>new Date().toISOString()}){
  if(!db)throw Error('STATION_INBOX_DB_REQUIRED');this.db=db;this.now=now;
  db.exec(`CREATE TABLE IF NOT EXISTS mi_station_bindings(source_id TEXT PRIMARY KEY,logical_machine_id TEXT NOT NULL,
   central_machine_id INTEGER NOT NULL,credential_hash TEXT NOT NULL,registered_by TEXT NOT NULL,registered_at TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1);
   CREATE TABLE IF NOT EXISTS mi_station_messages(message_id TEXT PRIMARY KEY,source_id TEXT NOT NULL,central_machine_id INTEGER NOT NULL,
    message_type TEXT NOT NULL,entity_id TEXT NOT NULL,entity_revision TEXT NOT NULL,occurred_at TEXT NOT NULL,received_at TEXT NOT NULL,
    content_hash TEXT NOT NULL,body TEXT NOT NULL,received_by TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS mi_station_messages_source ON mi_station_messages(source_id,occurred_at);
   CREATE TABLE IF NOT EXISTS mi_manufacturing_intents(id INTEGER PRIMARY KEY AUTOINCREMENT,shape_id TEXT NOT NULL,shape_version INTEGER NOT NULL,geometry_hash TEXT NOT NULL,
    central_machine_id INTEGER NOT NULL,revision INTEGER NOT NULL,content_hash TEXT NOT NULL,body TEXT NOT NULL,created_by TEXT NOT NULL,created_at TEXT NOT NULL,
    UNIQUE(shape_id,shape_version,geometry_hash,central_machine_id,revision));`);
 }
 register(principal,{sourceId,logicalMachineId,machineId}){
  if(!principal?.id)fail('AUTHENTICATION_REQUIRED',401);
  if(!string(sourceId)||!string(logicalMachineId,120)||!Number.isSafeInteger(machineId)||machineId<1)fail('INVALID_STATION_BINDING',422);
  if(!this.db.prepare('SELECT id FROM machines WHERE id=?').get(machineId))fail('MACHINE_NOT_FOUND',404);
  const old=this.db.prepare('SELECT * FROM mi_station_bindings WHERE source_id=?').get(sourceId);
  if(old&&(old.central_machine_id!==machineId||old.logical_machine_id!==logicalMachineId))fail('STATION_MACHINE_BINDING_CONFLICT',409);
  const credential=randomBytes(32).toString('hex'),at=this.now();
  this.db.prepare(`INSERT INTO mi_station_bindings VALUES(?,?,?,?,?,?,1)
   ON CONFLICT(source_id) DO UPDATE SET credential_hash=excluded.credential_hash,registered_by=excluded.registered_by,registered_at=excluded.registered_at,active=1`)
   .run(sourceId,logicalMachineId,machineId,digest(credential),String(principal.id),at);
  return {sourceId,logicalMachineId,machineId,credential,registeredAt:at};
 }
 authorize(message,credential){
  if(typeof credential!=='string'||!/^[a-f0-9]{64}$/.test(credential))return null;
  const b=this.db.prepare('SELECT * FROM mi_station_bindings WHERE source_id=? AND active=1').get(message.sourceId);
  if(!b||b.logical_machine_id!==message.machineId)return null;
  return timingSafeEqual(Buffer.from(b.credential_hash,'hex'),Buffer.from(digest(credential),'hex'))?b:null;
 }
 ingest(principal,request,credential){
  if(!principal?.id)fail('AUTHENTICATION_REQUIRED',401);
  const prepared=validateSyncBatch(request).map(item=>{const binding=this.authorize(item.message,credential);if(!binding)fail('STATION_SCOPE_FORBIDDEN',403);return {...item,binding};});
  const at=this.now();
  const results=this.db.transaction(()=>prepared.map(({message,contentHash,canonical,binding})=>{
   const old=this.db.prepare('SELECT content_hash,body FROM mi_station_messages WHERE message_id=?').get(message.messageId);
   if(old){if(old.content_hash!==contentHash||old.body!==canonical)fail('STATION_MESSAGE_ID_CONFLICT',409);return {messageId:message.messageId,contentHash,status:'duplicate'};}
   this.db.prepare('INSERT INTO mi_station_messages VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(message.messageId,message.sourceId,binding.central_machine_id,message.messageType,
    message.entityId,String(message.entityRevision),message.occurredAt,at,contentHash,canonical,String(principal.id));
   return {messageId:message.messageId,contentHash,status:'accepted'};
  }))();
  return {schemaVersion:'1.1',ackScope:'stored_station_reports_only',receivedAt:at,results};
 }
 list({machineId=null,sourceId='',limit=50,offset=0}={}){
  if(!Number.isInteger(limit)||limit<1||limit>200||!Number.isInteger(offset)||offset<0||sourceId&&!string(sourceId))fail('INVALID_STATION_EVENT_PAGE',422);
  const where=[],args=[];if(machineId!=null){if(!Number.isSafeInteger(machineId)||machineId<1)fail('INVALID_MACHINE',422);where.push('central_machine_id=?');args.push(machineId);}
  if(sourceId){where.push('source_id=?');args.push(sourceId);}const sql=where.length?' WHERE '+where.join(' AND '):'';
  return {total:this.db.prepare('SELECT count(*) n FROM mi_station_messages'+sql).get(...args).n,limit,offset,
   items:this.db.prepare('SELECT message_id,source_id,central_machine_id,message_type,occurred_at,received_at,body FROM mi_station_messages'+sql+' ORDER BY rowid DESC LIMIT ? OFFSET ?').all(...args,limit,offset)
    .map(r=>({id:r.message_id,sourceId:r.source_id,machineId:r.central_machine_id,messageType:r.message_type,occurredAt:r.occurred_at,receivedAt:r.received_at,message:JSON.parse(r.body),authority:'station_report_not_source_shape_mutation'}))};
 }
 getIntent({shapeId,shapeVersion,geometryHash:hash,machineId}){
  if(!string(String(shapeId))||!Number.isSafeInteger(shapeVersion)||shapeVersion<1||!/^[a-f0-9]{64}$/.test(hash||'')||!Number.isSafeInteger(machineId)||machineId<1)fail('INVALID_INTENT_LOOKUP',422);
  const row=this.db.prepare('SELECT body FROM mi_manufacturing_intents WHERE shape_id=? AND shape_version=? AND geometry_hash=? AND central_machine_id=? ORDER BY revision DESC LIMIT 1')
   .get(String(shapeId),shapeVersion,hash,machineId);
  return row?JSON.parse(row.body):null;
 }
 saveIntent(principal,input){
  if(!principal?.id)fail('AUTHENTICATION_REQUIRED',401);
  if(!input||Object.keys(input).some(k=>!['shapeSnapshot','machineId','expectedRevision','manufacturingIntent'].includes(k))||!Number.isSafeInteger(input.machineId)||input.machineId<1||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0)fail('INVALID_INTENT_REQUEST',422);
  this.prepareValidator ||= createPrepareValidator(require('ajv'));
  this.prepareValidator({card:{id:'intent-authoring',revision:1,quantityUnits:1,strandsPerCycle:1},shapeSnapshot:input.shapeSnapshot,
   manufacturingIntent:input.manufacturingIntent,profileRef:{id:'not-resolved-at-authoring',revision:'not-resolved-at-authoring'}});
  if(!this.db.prepare('SELECT id FROM machines WHERE id=?').get(input.machineId))fail('MACHINE_NOT_FOUND',404);
  const shape=input.shapeSnapshot,hash=geometryHash(shape);
  return this.db.transaction(()=>{
   const previous=this.getIntent({shapeId:shape.shapeId,shapeVersion:shape.shapeVersion,geometryHash:hash,machineId:input.machineId});
   if((previous?.revision||0)!==input.expectedRevision)fail('INTENT_REVISION_CONFLICT',409);
   const revision=(previous?.revision||0)+1,manufacturingIntent={...input.manufacturingIntent,revision};
   const record={shapeId:String(shape.shapeId),shapeVersion:shape.shapeVersion,geometryHash:hash,machineId:input.machineId,revision,manufacturingIntent,
    status:'requested_not_machine_qualified',createdBy:String(principal.id),createdAt:this.now()};record.contentHash=hashEvent(record);
   this.db.prepare('INSERT INTO mi_manufacturing_intents(shape_id,shape_version,geometry_hash,central_machine_id,revision,content_hash,body,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(record.shapeId,record.shapeVersion,hash,input.machineId,revision,record.contentHash,JSON.stringify(record),record.createdBy,record.createdAt);
   return record;
  })();
 }
}
module.exports={StationInbox};
