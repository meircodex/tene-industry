'use strict';
const {itemShapeMetrics,parseJsonObject}=require('./shapeSnapshot');
const {rebarKgPerMeter}=require('../modules/steel-rebar');

function nominalLength(type,value){
  const length=Number(value);
  return type==='straight'&&Number.isFinite(length)&&length>0?length:null;
}
function itemLength(item){
  // A bent bar's developed length is not its raw stock length.
  const shape=parseJsonObject(item?.shape_snapshot_json);
  return shape?.family==='lifts'?nominalLength('straight',itemShapeMetrics(item).totalLengthMm):null;
}
function purchaseLength(po){
  const spec=parseJsonObject(po.specification_json);
  return nominalLength(po.material_type,spec?.nominal_length_mm);
}
function barEstimate(diameter,lengthMm,stockKg){
  const length=nominalLength('straight',lengthMm),d=Number(diameter),stock=Number(stockKg);
  if(!length||!Number.isFinite(d)||d<=0||!Number.isFinite(stock)||stock<0)return {unit_weight_kg:null,estimated_bar_count:null};
  const weight=rebarKgPerMeter(d)*length/1000;
  return {unit_weight_kg:weight,estimated_bar_count:Math.floor(stock/weight+1e-9)};
}
module.exports={nominalLength,itemLength,purchaseLength,barEstimate};
