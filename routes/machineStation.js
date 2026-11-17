'use strict';
const express=require('express');
const {StationInbox}=require('../services/machineIntegration/stationInbox');
const {WorkerFeedback}=require('../services/machineIntegration/workerFeedback');
const {AutomaticConnection,stationOrRole}=require('../services/machineIntegration/automaticConnection');
const {StationProductionQueue}=require('../services/machineIntegration/productionQueue');
function required(name,value){if(!value)throw Error('routes/machineStation missing dependency: '+name);return value;}
function principal(req){if(req.stationBinding)return{id:'station:'+req.stationBinding.source_id,displayName:'תחנת מכונה'};const id=req.auth?.sub??req.user?.id;return id==null?null:{id,displayName:req.auth?.display_name||req.user?.name||''};}
module.exports=function createMachineStationRouter(deps){
 const db=required('db',deps.db),requireAnyRole=required('requireAnyRole',deps.requireAnyRole),auditLog=required('auditLog',deps.auditLog),wsBroadcast=required('wsBroadcast',deps.wsBroadcast);
 const router=express.Router(),service=new StationInbox({db});
 const workerFeedback=new WorkerFeedback({db,inbox:service});
 const automatic=new AutomaticConnection({db,inbox:service,...(deps.automaticConnection||{})});
 const stationAccess=roles=>stationOrRole(workerFeedback,requireAnyRole(roles));
 const productionQueue=new StationProductionQueue({db});
 router.get('/machine-integration/station-queue',stationAccess(['production','maintenance','manager','admin']),(req,res)=>{
  try{if(Object.keys(req.query).some(k=>!['sourceId','limit','offset','q','diameter','status'].includes(k)))return res.status(422).json({error:'INVALID_STATION_QUEUE_FILTER'});
   const binding=workerFeedback.authorize(req.query.sourceId||req.headers['x-station-source'],req.headers['x-station-credential']);
   res.set('Cache-Control','no-store');res.json(productionQueue.page(binding,{limit:Number(req.query.limit||20),offset:Number(req.query.offset||0),q:req.query.q||'',diameter:req.query.diameter||'',status:req.query.status||''}));
  }catch(error){res.status(error.status||400).json({error:error.message});}
 });
 router.post('/machine-integration/automatic/challenge',(req,res)=>{
  try{res.set('Cache-Control','no-store');res.json(automatic.begin(req.body));}catch(error){res.status(error.status||400).json({error:error.message});}
 });
 router.post('/machine-integration/automatic/connect',(req,res)=>{
  try{const result=automatic.finish(req.body);auditLog('machine_station',result.sourceId,result.sourceId,'register','machine_id',null,result.machineId,'חיבור אוטומטי של התקנה מורשית',null,'מערכת');
   wsBroadcast('machine_station_registered',{sourceId:result.sourceId,machineId:result.machineId});res.set('Cache-Control','no-store');res.status(201).json(result);
  }catch(error){res.status(error.status||400).json({error:error.message});}
 });
 router.get('/machine-integration/station-identity',stationAccess(['manager','admin']),(req,res)=>{
  try{const b=workerFeedback.authorize(req.query.sourceId,req.headers['x-station-credential']);const m=db.prepare('SELECT * FROM machines WHERE id=?').get(b.central_machine_id);
   res.set('Cache-Control','no-store');res.json({sourceId:b.source_id,logicalMachineId:b.logical_machine_id,machineId:b.central_machine_id,label:m?.label||m?.name||'',connected:true});
  }catch(error){res.status(error.status||403).json({error:error.message});}
 });
 router.post('/machine-integration/station-current',stationAccess(['production','maintenance','manager','admin']),(req,res)=>{
  try{res.json(workerFeedback.publish(req.query.sourceId,req.headers['x-station-credential'],req.body));}
  catch(error){res.status(error.status||400).json({error:error.message});}
 });
 router.get('/machine-integration/station-requests',stationAccess(['production','maintenance','manager','admin']),(req,res)=>{
  try{res.set('Cache-Control','no-store');res.json(workerFeedback.pending(req.query.sourceId,req.headers['x-station-credential'],{limit:Number(req.query.limit||10),offset:Number(req.query.offset||0)}));}
  catch(error){res.status(error.status||400).json({error:error.message});}
 });
 router.post('/machine-integration/station-requests/result',stationAccess(['production','maintenance','manager','admin']),(req,res)=>{
  try{const result=workerFeedback.respond(req.query.sourceId,req.headers['x-station-credential'],req.body);
   wsBroadcast('worker_machine_result',{sourceId:req.query.sourceId,requestId:result.id});res.json(result);}
  catch(error){res.status(error.status||400).json({error:error.message});}
 });
 router.post('/machine-integration/stations/register',requireAnyRole(['manager','admin']),(req,res)=>{
  try{const actor=principal(req),result=service.register(actor,req.body||{});
   auditLog('machine_station',result.sourceId,result.sourceId,'register','machine_id',null,result.machineId,'רישום תחנת מכונה',actor.id,actor.displayName);
   wsBroadcast('machine_station_registered',{sourceId:result.sourceId,machineId:result.machineId});res.status(201).json(result);
  }catch(error){res.status(error.status||400).json({error:error.message});}
 });
 router.post('/machine-integration/station-events',stationAccess(['production','maintenance','manager','admin']),(req,res)=>{
  try{const result=service.ingest(principal(req),req.body,req.headers['x-station-credential']);
   const accepted=result.results.filter(r=>r.status==='accepted').length;if(accepted)wsBroadcast('machine_station_events',{accepted});res.json(result);
  }catch(error){res.status(error.status||400).json({error:error.message});}
 });
 router.get('/machine-integration/station-events',requireAnyRole(['office','production','maintenance','manager','admin']),(req,res)=>{
  try{res.json(service.list({machineId:req.query.machineId?Number(req.query.machineId):null,sourceId:req.query.sourceId||'',limit:Number(req.query.limit||50),offset:Number(req.query.offset||0)}));}
  catch(error){res.status(error.status||400).json({error:error.message});}
 });
 router.get('/machine-integration/manufacturing-intent',stationAccess(['office','production','maintenance','manager','admin']),(req,res)=>{
  try{if(req.stationBinding&&Number(req.query.machineId)!==req.stationBinding.central_machine_id)return res.status(403).json({error:'STATION_SCOPE_FORBIDDEN'});const record=service.getIntent({shapeId:req.query.shapeId,shapeVersion:Number(req.query.shapeVersion),geometryHash:req.query.geometryHash,machineId:Number(req.query.machineId)});res.json({found:!!record,record});}
  catch(error){res.status(error.status||400).json({error:error.message});}
 });
 router.post('/machine-integration/manufacturing-intents',requireAnyRole(['office','manager','admin']),(req,res)=>{
  try{const actor=principal(req),record=service.saveIntent(actor,req.body);
   auditLog('manufacturing_intent',record.shapeId,record.shapeId,'create','revision',null,record.revision,'כוונת ייצור לצורה',actor.id,actor.displayName);
   wsBroadcast('manufacturing_intent_saved',{shapeId:record.shapeId,machineId:record.machineId,revision:record.revision});res.status(201).json(record);
  }catch(error){res.status(error.status||400).json({error:error.message,...(error.details?{details:error.details}:{})});}
 });
 return router;
};
module.exports.manifest = {id:'machine-station-bridge',label:'תחנות מכונה',screens:[],access:{default:'hidden',roles:{admin:'edit',manager:'edit',production:'edit',maintenance:'read',office:'read'}},
 consumes:[{table:'machines'}],produces:[{event:'machine_station_registered'},{event:'machine_station_events'},{event:'manufacturing_intent_saved'}],
 owns:{tables:['mi_station_bindings','mi_station_messages','mi_manufacturing_intents']}};
