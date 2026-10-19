'use strict';
const express = require('express');
const multer = require('multer');
const { rateLimit } = require('express-rate-limit');
const { createBugReportsService } = require('../services/bugReports');
const { createFaultAgentService } = require('../services/faultAgent');

function createBugReportsRouter({ db, requireRole }) {
  const router = express.Router();
  const service = createBugReportsService({ db });
  const agent = createFaultAgentService({ db });
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4*1024*1024, files:6, fields:18, fieldSize:650000, parts:24 } }).fields([{name:'before',maxCount:3},{name:'expected',maxCount:3},{name:'after',maxCount:3}]);
  const mutations = rateLimit({ windowMs:60000, limit:25, standardHeaders:true, legacyHeaders:false });
  const actor = req => ({ id:String(req.userId), role:req.userRole, name:String(req.auth.display_name || req.auth.displayName || req.auth.name || req.auth.username || req.userRole).slice(0,120) });
  const files = req => Object.values(req.files || {}).flat();
  const run = handler => (req,res) => { try { handler(req,res); } catch(e) { if (!e.status) console.error('[BugReports]', e.message); res.status(e.status || 500).json({error:e.status ? e.message : 'שמירת הדיווח נכשלה'}); } };
  const multipart = (req,res,next) => upload(req,res,e => e ? res.status(e.code === 'LIMIT_FILE_SIZE' || e.code === 'LIMIT_FILE_COUNT' ? 413 : 400).json({error:'ניתן לצרף עד שש תמונות, כל אחת עד 4 מ״ב'}) : next());
  // This credential is NOT a user JWT and grants no access to orders, settings or other APIs.
  const agentTokenAuthorization = (req,res,next) => {
    res.set('Cache-Control','no-store');
    try { req.faultAgent=agent.authenticate(req.get('X-Fault-Agent-Token')); next(); }
    catch(e) { res.status(e.status || 500).json({error:e.status ? e.message : 'חיבור הסוכן נכשל'}); }
  };
  router.use('/bug-reports/agent-runtime', rateLimit({windowMs:60000,limit:120,standardHeaders:true,legacyHeaders:false}));
  router.post('/bug-reports/agent-runtime/claim',agentTokenAuthorization,run((req,res)=>res.json(agent.claim(req.faultAgent))));
  router.post('/bug-reports/agent-runtime/jobs/:id/heartbeat',agentTokenAuthorization,run((req,res)=>res.json(agent.heartbeat(req.params.id,req.faultAgent,req.body.lease))));
  router.post('/bug-reports/agent-runtime/jobs/:id/complete',agentTokenAuthorization,run((req,res)=>res.json(agent.complete(req.params.id,req.faultAgent,req.body))));
  router.get('/bug-reports/agent-runtime/jobs/:id/images/:imageId',agentTokenAuthorization,run((req,res)=>{
    const f=agent.image(req.params.id,req.params.imageId,req.faultAgent,req.get('X-Fault-Agent-Lease'));
    res.set({'Content-Type':f.mime_type,'X-Content-Type-Options':'nosniff'}).send(f.data);
  }));
  // Unknown runtime paths never fall through into ordinary report handlers.
  router.use('/bug-reports/agent-runtime',(_req,res)=>res.status(404).json({error:'פעולת סוכן לא קיימת'}));
  router.use('/bug-reports', requireRole('viewer'), (req,res,next) => {
    if (!req.userId) return res.status(401).json({ error:'נדרשת זהות משתמש' });
    res.set('Cache-Control','no-store'); next();
  });
  router.get('/bug-reports/agent-connections',requireRole('manager'),run((req,res)=>res.json({connections:agent.credentials(actor(req))})));
  router.post('/bug-reports/agent-connections',requireRole('manager'),mutations,run((req,res)=>res.status(201).json(agent.pair(actor(req),req.body.name))));
  router.delete('/bug-reports/agent-connections/:id',requireRole('manager'),mutations,run((req,res)=>res.json(agent.revoke(actor(req),req.params.id))));
  router.get('/bug-reports/reset-preview',requireRole('admin'),run((req,res)=>res.json(agent.resetPreview(actor(req)))));
  router.post('/bug-reports/reset',requireRole('admin'),mutations,run((req,res)=>res.json(agent.reset(actor(req),req.body))));
  router.get('/bug-reports/backups',requireRole('admin'),run((req,res)=>res.json({backups:agent.backups(actor(req))})));
  router.post('/bug-reports/backups/:id/restore',requireRole('admin'),mutations,run((req,res)=>res.json(agent.restore(actor(req),req.params.id))));
  router.get('/bug-reports/backups/:id',requireRole('admin'),run((req,res)=>res.type('application/json').attachment(`faults-backup-${req.params.id}.json`).send(agent.backup(actor(req),req.params.id))));
  router.get('/bug-reports', requireRole('viewer'), run((req,res) => res.json(service.list(actor(req)))));
  router.get('/bug-reports/pdf-assets/:asset',requireRole('viewer'),run((req,res)=>{const assets={'pdf.mjs':'pdfjs-dist/build/pdf.mjs','pdf.worker.mjs':'pdfjs-dist/build/pdf.worker.mjs'};const asset=Object.hasOwn(assets,req.params.asset)&&assets[req.params.asset];if(!asset)return res.status(404).end();res.type('text/javascript').sendFile(require.resolve(asset));}));
  router.get('/bug-reports/:id', requireRole('viewer'), run((req,res) => res.json(service.detail(req.params.id,actor(req)))));
  router.post('/bug-reports', requireRole('viewer'), mutations, multipart, run((req,res) => res.status(201).json(service.create(actor(req),req.body,files(req)))));
  router.post('/bug-reports/:id/events', requireRole('viewer'), mutations, multipart, run((req,res) => res.json(service.update(req.params.id,actor(req),req.body,files(req)))));
  router.patch('/bug-reports/:id/images/:imageId', requireRole('viewer'),mutations,run((req,res)=>res.json(service.editAttachment(req.params.id,req.params.imageId,actor(req),req.body))));
  router.post('/bug-reports/:id/agent',requireRole('viewer'),mutations,run((req,res)=>res.json(agent.enqueue(req.params.id,actor(req),req.body.version))));
  router.get('/bug-reports/:id/images/:imageId', requireRole('viewer'), run((req,res) => {
    const f = service.attachment(req.params.id,req.params.imageId,actor(req));
    res.set({'Content-Type':f.mime_type,'X-Content-Type-Options':'nosniff','Content-Disposition':`${f.mime_type.startsWith('image/')?'inline':'attachment'}; filename*=UTF-8''${encodeURIComponent(f.filename)}`}).send(f.data);
  }));
  return router;
}
module.exports = createBugReportsRouter;
module.exports.manifest = {
  id:'bug-reports', label:'קריאות שירות',
  screens:[{id:'bugs',path:'/bugs.html',label:'תקלות',icon:'🛠️',group:'בקרה'}],
  access:{default:'edit'},
  consumes:[{table:'bug_reports'},{table:'bug_report_events'},{table:'bug_report_attachments'},{table:'fault_agent_jobs'},{table:'fault_agent_credentials'},{table:'fault_report_backups'},{table:'fault_report_restorations'}], produces:[],
};
