'use strict';
const {hashEvent,canonicalizeEvent}=require('../../machine-monitor/v1');
function fail(code,status=422){throw Object.assign(Error(code),{status});}
function string(value,max=200){return typeof value==='string'&&value.length>0&&value.length<=max&&!/[\x00-\x1f]/.test(value);}
const allowed={MachineIntegration:/^(job\.prepared|transfer\.(prepared|transferring|readback_pending|readback_verified|acceptance_pending|verified|failed|outcome_unknown)|run\.(queued|observing|transferring|active|attention|completed|cancelled|feedback|recipe_confirmed)|recipe\.changed)$/,
 Quality:/^(measurement\.saved|quality\.policy_changed|recipe_memory\.(candidate|approved|withdrawn))$/};
function validateSyncBatch(request){
 if(request?.schemaVersion!=='1.1'||!Array.isArray(request.messages)||!request.messages.length||request.messages.length>100)fail('INVALID_STATION_BATCH');
 if(Buffer.byteLength(JSON.stringify(request))>512*1024)fail('STATION_BATCH_TOO_LARGE',413);
 const seen=new Set();
 return request.messages.map(item=>{
  const m=item?.message;
  if(!m||m.schemaVersion!=='1.1'||!string(m.messageId)||!string(m.machineId,120)||!string(m.sourceId)||!string(m.entityId)||
   !string(String(m.entityRevision))||!string(m.occurredAt)||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(m.occurredAt)||!Number.isFinite(Date.parse(m.occurredAt))||
   !Object.hasOwn(allowed,m.owner)||!allowed[m.owner].test(m.messageType)||!m.payload||typeof m.payload!=='object'||Array.isArray(m.payload)||seen.has(m.messageId))fail('INVALID_STATION_MESSAGE');
  seen.add(m.messageId);
  if(hashEvent(m.payload)!==m.payloadHash||hashEvent(m)!==item.contentHash)fail('STATION_CONTENT_HASH_MISMATCH');
  return {message:m,contentHash:item.contentHash,canonical:canonicalizeEvent(m)};
 });
}
const prepareSchema=require('./prepare.schema.json');
function createPrepareValidator(Ajv){
 const validate=new Ajv({allErrors:true,strictNumbers:true,strictTypes:false}).compile(prepareSchema);
 return value=>{
  if(!validate(value))throw Object.assign(Error('E_SCHEMA'),{status:422,details:{fields:validate.errors.map(e=>({path:e.instancePath,keyword:e.keyword,message:e.message,params:e.params}))}});
  const data=value.shapeSnapshot.data;
  if(data.angles.length!==data.sides.length-1)throw Object.assign(Error('E_SHAPE_GEOMETRY'),{status:422});
  const bends=new Set();for(const b of value.manufacturingIntent.bends||[]){if(b.bendIndex>data.angles.length||bends.has(b.bendIndex))throw Object.assign(Error('E_SCHEMA'),{status:422,details:{field:'bends'}});bends.add(b.bendIndex);}
  const start=value.manufacturingIntent.startSegmentIndex;if(start!=null&&start>data.sides.length)throw Object.assign(Error('E_SCHEMA'),{status:422,details:{field:'startSegmentIndex'}});
  for(const [key,index,limit]of[['lengthAdjustments','segmentIndex',data.sides.length],['angleAdjustments','bendIndex',data.angles.length]]){
   const seen=new Set();for(const a of value.manufacturingIntent.compensation?.[key]||[]){if(a[index]>limit||seen.has(a[index]))throw Object.assign(Error('E_SCHEMA'),{status:422,details:{field:key}});seen.add(a[index]);}
  }
  return value;
 };
}
const geometryHash=snapshot=>hashEvent({family:snapshot.family,shapeType:snapshot.shapeType??null,data:snapshot.data});
module.exports={schemaVersion:'1.1',prepareSchema,createPrepareValidator,geometryHash,validateSyncBatch,hashEvent,canonicalizeEvent,string};
