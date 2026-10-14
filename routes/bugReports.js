'use strict';
const express = require('express');
const multer = require('multer');
const { rateLimit } = require('express-rate-limit');
const { createBugReportsService } = require('../services/bugReports');

function createBugReportsRouter({ db, requireRole }) {
  const router = express.Router();
  const service = createBugReportsService({ db });
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4*1024*1024, files:6, fields:14, fieldSize:24000, parts:20 } }).fields([{name:'before',maxCount:3},{name:'expected',maxCount:3},{name:'after',maxCount:3}]);
  const mutations = rateLimit({ windowMs:60000, limit:25, standardHeaders:true, legacyHeaders:false });
  router.use('/bug-reports', requireRole('viewer'), (req,res,next) => {
    if (!req.userId) return res.status(401).json({ error:'נדרשת זהות משתמש' });
    res.set('Cache-Control','no-store'); next();
  });
  const actor = req => ({ id:String(req.userId), role:req.userRole, name:String(req.auth.display_name || req.auth.displayName || req.auth.name || req.auth.username || req.userRole).slice(0,120) });
  const files = req => Object.values(req.files || {}).flat();
  const run = handler => (req,res) => { try { handler(req,res); } catch(e) { if (!e.status) console.error('[BugReports]', e.message); res.status(e.status || 500).json({error:e.status ? e.message : 'שמירת הדיווח נכשלה'}); } };
  const multipart = (req,res,next) => upload(req,res,e => e ? res.status(e.code === 'LIMIT_FILE_SIZE' || e.code === 'LIMIT_FILE_COUNT' ? 413 : 400).json({error:'ניתן לצרף עד שש תמונות, כל אחת עד 4 מ״ב'}) : next());
  router.get('/bug-reports', requireRole('viewer'), run((req,res) => res.json(service.list(actor(req)))));
  router.get('/bug-reports/:id', requireRole('viewer'), run((req,res) => res.json(service.detail(req.params.id,actor(req)))));
  router.post('/bug-reports', requireRole('viewer'), mutations, multipart, run((req,res) => res.status(201).json(service.create(actor(req),req.body,files(req)))));
  router.post('/bug-reports/:id/events', requireRole('viewer'), mutations, multipart, run((req,res) => res.json(service.update(req.params.id,actor(req),req.body,files(req)))));
  router.get('/bug-reports/:id/images/:imageId', requireRole('viewer'), run((req,res) => {
    const f = service.attachment(req.params.id,req.params.imageId,actor(req));
    res.set({'Content-Type':f.mime_type,'X-Content-Type-Options':'nosniff','Content-Disposition':`inline; filename*=UTF-8''${encodeURIComponent(f.filename)}`}).send(f.data);
  }));
  return router;
}
module.exports = createBugReportsRouter;
module.exports.manifest = {
  id:'bug-reports', label:'דיווחי באגים ותיקונים',
  screens:[{id:'bugs',path:'/bugs.html',label:'דיווחי באגים',icon:'🐞',group:'בקרה'}],
  access:{default:'edit'},
  consumes:[{table:'bug_reports'},{table:'bug_report_events'},{table:'bug_report_attachments'}], produces:[],
};
