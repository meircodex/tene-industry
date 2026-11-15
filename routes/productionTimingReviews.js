const express=require('express');
const reviews=require('../services/productionTimingReliability');
module.exports=function createTimingReviewsRouter(deps){
 for(const name of ['db','requireAnyRole','wsBroadcast'])if(!deps[name])throw Error('productionTimingReviews missing dependency: '+name);
 const {db,requireAnyRole,wsBroadcast}=deps;reviews.ensureReviews(db);const router=express.Router();
 router.patch('/production-timing/:id/review',requireAnyRole(['manager','admin']),(req,res)=>{
  try{
   const review=reviews.saveReview(db,{itemId:Number(req.params.id),day:req.body?.production_day,measurementKey:req.body?.measurement_key,decision:req.body?.decision,reason:req.body?.reason,expectedReviewRevision:req.body?.expected_review_revision,userId:req.userId||req.auth?.sub,userName:req.auth?.display_name});
   wsBroadcast('timing_measurement_reviewed',{item_id:Number(req.params.id),decision:review.decision});
   return res.json({ok:true,review});
  }catch(error){if(error.statusCode)return res.status(error.statusCode).json({error:error.message});console.error('[Timing review]',error.message);return res.status(500).json({error:'timing_review_failed'});}
 });return router;
};
module.exports.manifest = {
  id: 'production-timing-reviews',
  label: 'אימות מדידות ייצור',
  screens: [],
  access: { default: 'hidden', roles: { manager: 'edit', admin: 'edit' } },
  consumes: [{ table: 'items' }, { table: 'worker_card_activity' }, { table: 'scan_log' }, { table: 'inventory_reservations' }, { table: 'raw_material_usage' }, { table: 'raw_material' }],
  produces: [{ table: 'production_timing_reviews' }, { event: 'timing_measurement_reviewed' }],
};
