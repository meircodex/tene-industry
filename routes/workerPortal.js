'use strict';
const portal=require('../services/workerPortalAccounts');
module.exports=function createWorkerPortalRouter({db,requireAnyRole,authService,openCard,updateStatus,wsBroadcast}){
 const router=require('express').Router();
 const support=require('../services/workerPortalSupport');support.ensureSchema(db);
 const storage=require('../services/warehouseCardStorage');
 function run(fn){return(req,res,next)=>{try{return fn(req,res);}catch(e){if(e.status)return res.status(e.status).json({error:e.message});next(e);}};}
 const deviceAccess=require('../services/workerPortalDeviceAccess');
 // Retired endpoint: older installed clients must not revoke an approved phone.
 // Only existing manager enrollment/profile controls can end device access.
 router.post('/worker-portal/logout',(_req,res)=>{
  res.set('Cache-Control','no-store');res.status(410).json({error:'worker_logout_managed_only'});
 });
 router.use('/worker-portal',(req,res,next)=>{try{deviceAccess.authenticate(db,req);next();}catch(e){res.status(e.status||403).json({error:e.message});}});
 const allowed=['production','warehouse','quality','maintenance','kiosk','manager','admin'];
 function identify(req,res,next){try{portal.identify(db,req);res.set('Cache-Control','no-store');next();}catch(e){res.status(e.status||500).json({error:e.message});}}

 router.get('/worker-portal/me',requireAnyRole(allowed),identify,(req,res)=>res.json({worker:req.portalWorker}));
 router.patch('/worker-portal/preferences',requireAnyRole(allowed),identify,(req,res)=>{
  if(Object.keys(req.body||{}).some(k=>k!=='language')||!portal.LANGUAGES.includes(req.body?.language))return res.status(400).json({error:'invalid_portal_language'});
  db.transaction(()=>{
   authService.setPortalLanguage(req.userId,req.body.language);
   db.prepare(`INSERT INTO audit_log(entity_type,entity_id,entity_ref,action,field_name,old_value,new_value,user_id,user_name)
    VALUES('worker_portal',?,?,'preference','language',?,?,?,?)`).run(req.portalWorker.profile_id,req.portalWorker.username,req.portalWorker.language,req.body.language,Number(req.userId),req.portalWorker.worker_name);
  })();res.json({ok:true,language:req.body.language});
 });
 router.get('/worker-portal/history',requireAnyRole(allowed),identify,(req,res)=>{
  const page=Number(req.query.page||1),limit=Number(req.query.limit||10);
  if(!Number.isInteger(page)||page<1||page>100000||!Number.isInteger(limit)||limit<1||limit>50)return res.status(400).json({error:'invalid_portal_page'});
  res.json(require('../services/workerPortalProjection').history(db,Number(req.userId),page,limit));
 });
 router.get('/worker-portal/summary',requireAnyRole(allowed),identify,run((req,res)=>res.json(require('../services/workerPortalProjection').daily(db,Number(req.userId)))));
 router.get('/worker-portal/zones',requireAnyRole(allowed),identify,run((req,res)=>res.json({zones:storage.zones(db)})));
 router.get('/worker-portal/help',requireAnyRole(allowed),identify,run((req,res)=>res.json({documents:support.documents(db,req.portalWorker.language)})));
 router.post('/worker-portal/faults',requireAnyRole(allowed),identify,run((req,res)=>{const receipt=support.report(db,req.body,req.portalWorker);wsBroadcast('maintenance_reported',{id:receipt.maintenance_id});res.json({ok:true,receipt});}));
 router.get('/worker-portal/manage/help',requireAnyRole(['admin','manager']),run((req,res)=>{res.set('Cache-Control','no-store');res.json({documents:['he','en','th'].flatMap(l=>support.documents(db,l))});}));
 router.put('/worker-portal/manage/help',requireAnyRole(['admin','manager']),run((req,res)=>{support.publish(db,req.body,req.auth);wsBroadcast('worker_help_published',{topic:req.body.topic});res.json({ok:true});}));
 router.get('/worker-portal/manage/faults',requireAnyRole(['admin','manager','maintenance']),run((req,res)=>{res.set('Cache-Control','no-store');res.json(support.list(db,Number(req.query.page||1)));}));
 router.get('/worker-portal/manage/faults/:id/photo',requireAnyRole(['admin','manager','maintenance']),run((req,res)=>{const row=db.prepare('SELECT photo,photo_mime FROM worker_fault_reports WHERE id=?').get(Number(req.params.id));if(!row?.photo)return res.status(404).json({error:'not_found'});res.set({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}).type(row.photo_mime).send(row.photo);}));
 router.get('/worker-portal/card',requireAnyRole(allowed),identify,openCard);
 router.patch('/worker-portal/card/:id/status',requireAnyRole(allowed),identify,updateStatus);
 return router;
};

module.exports.manifest = {
 id:'worker-portal',label:'פורטל עובד',screens:[{id:'worker-portal',path:'/worker-portal.html',label:'פורטל עובד',icon:'📱',group:'ייצור'}],
 access:{default:'hidden',roles:{production:'edit',warehouse:'edit',quality:'edit',maintenance:'edit',kiosk:'edit',manager:'edit',admin:'edit'}},
 consumes:[{table:'users'},{table:'worker_qr_profiles'},{table:'items'},{table:'worker_card_activity'},{table:'worker_help_documents'},{table:'worker_fault_reports'}],
 produces:[{table:'worker_portal_accounts'},{event:'item_status'},{event: 'maintenance_reported'},{event: 'worker_help_published'}]
};
