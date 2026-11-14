'use strict';
const crypto=require('node:crypto');
function canonicalizeEvent(value){
 const active=new Set();
 function normalize(v){
  if(v===null||typeof v==='string'||typeof v==='boolean')return v;
  if(typeof v==='number'){if(!Number.isFinite(v)||(Number.isInteger(v)&&!Number.isSafeInteger(v)))throw Error('INVALID_NUMBER');return v;}
  if(typeof v!=='object'||active.has(v))throw Error('INVALID_JSON');
  if(Object.getOwnPropertySymbols(v).length)throw Error('SYMBOL_KEY');
  active.add(v);let result;
  if(Array.isArray(v)){
   if(Object.keys(v).length!==v.length)throw Error('SPARSE_OR_CUSTOM_ARRAY');
   result=Array.from({length:v.length},(_,i)=>{if(!Object.hasOwn(v,i))throw Error('SPARSE_ARRAY');return normalize(v[i]);});
  }else{
   if(Object.getPrototypeOf(v)!==Object.prototype&&Object.getPrototypeOf(v)!==null)throw Error('CUSTOM_PROTOTYPE');
   result=Object.create(null);
   for(const k of Object.keys(v).sort()){
    const d=Object.getOwnPropertyDescriptor(v,k);if(!d||!Object.hasOwn(d,'value')||k==='toJSON')throw Error('CUSTOM_PROPERTY');
    result[k]=normalize(d.value);
   }
  }
  active.delete(v);return result;
 }
 return JSON.stringify(normalize(value));
}
const hashEvent=e=>crypto.createHash('sha256').update(canonicalizeEvent(e),'utf8').digest('hex');
function createValidator(Ajv,addFormats,schema){
 const ajv=new Ajv({strict:true,allErrors:true});addFormats(ajv);const envelope=ajv.compile(schema);
 const required={
  'observation.sample':['pollGroupId','profileRevision','samples'],
  'observation.parameter_change':['fieldId','beforeRaw','afterRaw','beforeValue','afterValue','unit','changeWindow','origin','evidenceEventIds','effectiveFromCycleId'],
  'monitor.health':['state','lastSuccessfulReadAtUtc','pendingCount','oldestPendingAtUtc','storageStatus','adapterStatus'],
  'monitor.gap':['reason','lastDurableSequence','fromUtc','toUtc','estimatedLostCount']
 };
 return function validateEvent(e){
  canonicalizeEvent(e);
  if(!envelope(e))throw Error('INVALID_ENVELOPE:'+ajv.errorsText(envelope.errors));
  const t=e.timestamps;
  for(const [a,b] of [['observedFromUtc','observedToUtc'],['monotonicFromMs','monotonicToMs']]){
   if((t[a]===null)!==(t[b]===null))throw Error('INCOMPLETE_TIME_WINDOW');
   if(t[a]!==null&&(a==='observedFromUtc'?Date.parse(t[a])>Date.parse(t[b]):t[a]>t[b]))throw Error('INVERTED_TIME_WINDOW');
  }
  const keys=required[e.eventType];if(!keys)throw Error('UNSUPPORTED_PAYLOAD_TYPE');
  if(keys.some(k=>!Object.hasOwn(e.payload,k)))throw Error('INCOMPLETE_PAYLOAD');
  const p=e.payload;
  if(e.eventType==='observation.sample'){
   if(typeof p.pollGroupId!=='string'||typeof p.profileRevision!=='string'||!Array.isArray(p.samples)||!p.samples.length)throw Error('INVALID_SAMPLES');
   for(const s of p.samples)if(typeof s.tagId!=='string'||!s.tagId||!Object.hasOwn(s,'rawValue')||!Object.hasOwn(s,'value')||!Object.hasOwn(s,'unit')||!s.quality||!['good','uncertain','bad'].includes(s.quality.status))throw Error('INVALID_SAMPLE');
  }
  if(e.eventType==='observation.parameter_change'){
   if(typeof p.fieldId!=='string'||!['gateway_request','local_unattributed','plc_internal','recipe_transition','unknown'].includes(p.origin)||!Array.isArray(p.evidenceEventIds)||!p.evidenceEventIds.length)throw Error('INVALID_CHANGE');
  }
  if(e.eventType==='monitor.health'&&(!Number.isSafeInteger(p.pendingCount)||p.pendingCount<0))throw Error('INVALID_HEALTH');
  if(e.eventType==='monitor.gap'&&(!Number.isSafeInteger(p.lastDurableSequence)||p.lastDurableSequence<0||!(p.estimatedLostCount===null||(Number.isSafeInteger(p.estimatedLostCount)&&p.estimatedLostCount>=0))))throw Error('INVALID_GAP');
  return e;
 };
}
module.exports={canonicalizeEvent,hashEvent,createValidator};
