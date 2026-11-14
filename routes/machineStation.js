'use strict';
const express=require('express');
const {StationInbox}=require('../services/machineIntegration/stationInbox');
function required(name,value){if(!value)throw Error('routes/machineStation missing dependency: '+name);return value;}
function principal(req){const id=req.auth?.sub??req.user?.id;return id==null?null:{id,displayName:req.auth?.display_name||req.user?.name||''};}
module.exports=function createMachineStationRouter(deps){
 const db=required('db',deps.db),requireAnyRole=required('requireAnyRole',deps.requireAnyRole),auditLog=required('auditLog',deps.auditLog),wsBroadcast=required('wsBroadcast',deps.wsBroadcast);
 const router=express.Router(),service=new StationInbox({db});
 router.post('/machine-integration/stations/register',requireAnyRole(['manager','admin']),(req,res)=>{
  try{const actor=principal(req),result=service.register(actor,req.body||{});
   auditLog('machine_station',result.sourceId,result.sourceId,'register','machine_id',null,result.machineId,'רישום תחנת מכונה',actor.id,actor.displayName);
   wsBroadcast('machine_station_registered',{sourceId:result.sourceId,machineId:result.machineId});res.status(201).json(result);
  }catch(error){res.status(error.status||400).json({error:error.message});}
 });
 router.post('/machine-integration/station-events',requireAnyRole(['production','maintenance','manager','admin']),(req,res)=>{
  try{const result=service.ingest(principal(req),req.body,req.headers['x-station-credential']);
   const accepted=result.results.filter(r=>r.status==='accepted').length;if(accepted)wsBroadcast('machine_station_events',{accepted});res.json(result);
  }catch(error){res.status(error.status||400).json({error:error.message});}
 });
 router.get('/machine-integration/station-events',requireAnyRole(['office','production','maintenance','manager','admin']),(req,res)=>{
  try{res.json(service.list({machineId:req.query.machineId?Number(req.query.machineId):null,sourceId:req.query.sourceId||'',limit:Number(req.query.limit||50),offset:Number(req.query.offset||0)}));}
  catch(error){res.status(error.status||400).json({error:error.message});}
 });
 router.get('/machine-integration/manufacturing-intent',requireAnyRole(['office','production','maintenance','manager','admin']),(req,res)=>{
  try{const record=service.getIntent({shapeId:req.query.shapeId,shapeVersion:Number(req.query.shapeVersion),geometryHash:req.query.geometryHash,machineId:Number(req.query.machineId)});res.json({found:!!record,record});}
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
