'use strict';
const portal=require('../services/workerPortalAccounts');
module.exports=function createWorkerPortalRouter({db,requireAnyRole,authService,openCard,updateStatus}){
 const router=require('express').Router();
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
  const total=db.prepare('SELECT COUNT(DISTINCT item_id) AS n FROM worker_card_activity WHERE actor_user_id=?').get(req.userId).n;
  const rows=db.prepare(`SELECT a.item_id,a.occurred_at,a.action,a.card_token,i.status,i.shape_name,i.diameter,i.quantity,i.total_weight,o.order_num,c.name AS customer_name
   FROM worker_card_activity a JOIN items i ON i.id=a.item_id LEFT JOIN pallets p ON p.id=i.pallet_id
   LEFT JOIN orders o ON o.id=COALESCE(i.order_id,p.order_id) LEFT JOIN customers c ON c.id=o.customer_id
   WHERE a.id IN(SELECT MAX(id) FROM worker_card_activity WHERE actor_user_id=? GROUP BY item_id)
   ORDER BY a.id DESC LIMIT ? OFFSET ?`).all(req.userId,limit,(page-1)*limit);
  res.json({rows,page,limit,total});
 });
 router.get('/worker-portal/card',requireAnyRole(allowed),identify,openCard);
 router.patch('/worker-portal/card/:id/status',requireAnyRole(allowed),identify,updateStatus);
 return router;
};

module.exports.manifest = {
 id:'worker-portal',label:'פורטל עובד',screens:[{id:'worker-portal',path:'/worker-portal.html',label:'פורטל עובד',icon:'📱',group:'ייצור'}],
 access:{default:'hidden',roles:{production:'edit',warehouse:'edit',quality:'edit',maintenance:'edit',kiosk:'edit',manager:'edit',admin:'edit'}},
 consumes:[{table:'users'},{table:'worker_qr_profiles'},{table:'items'},{table:'worker_card_activity'}],
 produces:[{table:'worker_portal_accounts'},{event:'item_status'}]
};
