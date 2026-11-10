'use strict';
function purchasePolicy(groups,basis='available'){
  if(!['available','physical'].includes(basis))throw Object.assign(new Error('invalid_stock_basis'),{statusCode:400});
  return {basis,minimum_stock_kg:10000,target_stock_kg:30000,minimum_order_kg:30000,types:['coil','straight'].map(type=>{
    const rows=groups.filter(r=>r.material_type===type);
    const physical=rows.reduce((n,r)=>n+r.physical_stock_kg,0),demand=rows.reduce((n,r)=>n+r.backlog_kg,0),incoming=rows.reduce((n,r)=>n+r.incoming_kg,0);
    const position=physical-(basis==='available'?demand:0),shortage=rows.reduce((n,r)=>n+r.recommended_purchase_kg,0);
    const below=position<10000,needed=Math.max(0,30000-position-incoming,shortage);
    return {material_type:type,physical_stock_kg:physical,available_stock_kg:physical-demand,incoming_kg:incoming,below_minimum:below,diameter_shortage_kg:shortage,should_reorder:(below&&needed>0)||shortage>0,recommended_order_kg:((below&&needed>0)||shortage>0)?Math.max(30000,needed):0};
  })};
}
module.exports={purchasePolicy};
