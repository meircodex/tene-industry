'use strict';
module.exports=function createQualityWeighingsRouter({db,requireAnyRole}){
 if(!db||!requireAnyRole)throw Error('quality weighing dependencies required');
 const router=require('express').Router(),service=require('../services/qualityWeighings').createQualityWeighingsService(db);
 const handle=fn=>(req,res)=>{try{res.json(fn(req));}catch(error){res.status(error.statusCode||500).json({error:error.statusCode?error.message:'לא ניתן להשלים את הפעולה כעת'});}};
 router.get('/quality/weighing-orders',requireAnyRole(['quality','production','office','manager','admin']),handle(req=>service.orders(req.query)));
 router.get('/quality/weighing-orders/:id',requireAnyRole(['quality','production','office','manager','admin']),handle(req=>service.context(req.params.id)));
 router.post('/quality/weighings/preview',requireAnyRole(['quality','production','office','manager','admin']),handle(req=>service.preview(req.body)));
 router.get('/quality/weighings',requireAnyRole(['quality','production','office','manager','admin']),handle(req=>service.history(req.query)));
 router.get('/quality/weighings/:id',requireAnyRole(['quality','production','office','manager','admin']),handle(req=>service.detail(req.params.id)));
 router.post('/quality/weighings',requireAnyRole(['quality','manager','admin']),handle(req=>service.save(req.body,{id:req.auth?.sub})));
 return router;
};
module.exports.manifest = {
 id: 'quality-weighings', label: 'בדיקות שקילת איכות', screens: [],
 access: {default:'hidden',roles:{quality:'edit',manager:'edit',admin:'edit',office:'read',production:'read'}},
 consumes: [{table:'orders'},{table:'items'},{table:'pallets'},{table:'customers'}],
 produces: [{table:'quality_weighings'},{table:'quality_weighing_orders'},{table:'quality_weighing_lines'},{table:'quality_weighing_events'},{event:'quality.weighing.recorded'}]
};
