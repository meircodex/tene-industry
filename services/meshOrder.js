'use strict';
const {parseJsonObject}=require('./shapeSnapshot');
const {calculateMesh}=require('../modules/steel-rebar/shapes');
function metrics(item={}){
 const snapshot=parseJsonObject(item.shapeSnapshot??item.shape_snapshot??item.shape_snapshot_json??item.shapeData??item.shape_contract);
 if(snapshot?.family!=='mesh')return null;
 if(snapshot.validation?.valid===false||snapshot.validation?.ok===false)throw Object.assign(Error('invalid_mesh_shape'),{statusCode:400});
 const {data,calculated}=calculateMesh(snapshot.data);
 if(!calculated.countingVerified)throw Object.assign(Error('mesh_bar_count_confirmation_required'),{statusCode:400});
 const normalized={...snapshot,data,calculated,machineOutput:{...snapshot.machineOutput,generic:{family:'mesh',shapeType:'mesh_rectangular',...data,...calculated}},shapeType:'mesh_rectangular'};
 const specification={length_mm:data.length,width_mm:data.width,longitudinal_diameter_mm:data.longitudinalDiameter,transverse_diameter_mm:data.transverseDiameter,longitudinal_spacing_mm:data.longitudinalSpacing,transverse_spacing_mm:data.transverseSpacing,grade:data.grade,standard_code:data.standard_code,edge_left_mm:data.edgeLeft,edge_right_mm:data.edgeRight,edge_top_mm:data.edgeTop,edge_bottom_mm:data.edgeBottom};
 for(const [source,target] of [['longitudinalBarCount','longitudinal_bar_count'],['transverseBarCount','transverse_bar_count']])if(data[source]!=null)specification[target]=data[source];
 if(data.countingConfirmed)specification.counting_confirmed=true;
 return {snapshot:normalized,weightKg:calculated.weightKg,totalLengthMm:calculated.totalLengthMm,diameter:data.longitudinalDiameter,specification};
}
module.exports={metrics};
