'use strict';
const express = require('express');
const {StationInbox} = require('../services/machineIntegration/stationInbox');
const {WorkerFeedback} = require('../services/machineIntegration/workerFeedback');
const {createHash} = require('node:crypto');
const {buildWorkerOriginalCard} = require('../services/workerOriginalCard');
const {stationOrRole,assertCardMachine}=require('../services/machineIntegration/automaticConnection');
const required = (name, value) => {if (!value) throw Error('routes/workerMachineFeedback missing dependency: ' + name); return value;};
module.exports = function createWorkerMachineFeedbackRouter(deps) {
  const db = required('db', deps.db), requireQrPermission = required('requireQrPermission', deps.requireQrPermission),
    authorizeCard = required('authorizeCard', deps.authorizeCard), parseCard = required('parseCard',deps.parseCard), wsBroadcast = required('wsBroadcast', deps.wsBroadcast);
  const router = express.Router(), service = new WorkerFeedback({db, inbox: new StationInbox({db})});
  const actor = req => req.userId || req.auth?.sub ? 'user:' + (req.userId || req.auth.sub) : req.approvedDevice?.id
    ? 'device:' + req.approvedDevice.id : 'qr:' + createHash('sha256').update(String(req.query.card || req.body?.card || '')).digest('hex');
  router.get('/stations', requireQrPermission('production'), (req, res) => {try{res.set('Cache-Control','no-store');res.json(service.stations({limit:Number(req.query.limit||100),offset:Number(req.query.offset||0)}));}catch(error){res.status(error.status||400).json({error:error.message});}});
  router.get('/snapshot',stationOrRole(service,requireQrPermission('production')),(req,res)=>{
    try{
      service.authorize(req.query.sourceId,req.headers['x-station-credential']);
      const parsed=parseCard(req.query.card);if(!parsed?.itemId)return res.status(422).json({error:'invalid_worker_card_token'});
      const item=authorizeCard(req,res,parsed.itemId);if(!item)return;
      assertCardMachine(db,req.stationBinding,item);
      const original=deps.snapshotBuilder?deps.snapshotBuilder(item,req.query.card):buildWorkerOriginalCard(db,item,req.query.card);
      const {html,...original_card}=original;
      res.set('Cache-Control','no-store');res.json({items:[item],original_card,activityFree:true});
    }catch(error){res.status(error.status||error.statusCode||400).json({error:error.message});}
  });
  router.post('/requests', requireQrPermission('production'), (req, res) => {
    try {
      const item = authorizeCard(req, res, req.body?.itemId); if (!item) return;
      const result = service.create(actor(req), item, req.body);
      wsBroadcast('worker_machine_request', {sourceId: result.sourceId, requestId: result.id}); res.status(202).json(result);
    } catch (error) {res.status(error.status || 400).json({error: error.message});}
  });
  router.get('/requests/:id', requireQrPermission('production'), (req, res) => {
    try {
      const result = service.get(actor(req), req.params.id);
      if (!authorizeCard(req, res, result.itemId)) return;
      if (String(req.query.card || '') !== result.card) return res.status(403).json({error:'WORKER_MACHINE_CARD_MISMATCH'});
      res.set('Cache-Control','no-store');res.json(result);
    } catch (error) {res.status(error.status || 400).json({error: error.message});}
  });
  return router;
};
module.exports.manifest = {id:'worker-machine-feedback',label:'משוב מכונה בכרטיס',screens:[],
  access:{default:'hidden',roles:{admin:'edit',manager:'edit',production:'edit',kiosk:'edit'}},
  consumes:[{table:'machines'},{table:'worker_card_activity'}],produces:[{event:'worker_machine_request'}],
  owns:{tables:['mi_worker_requests','mi_station_presence','mi_station_current']}};
