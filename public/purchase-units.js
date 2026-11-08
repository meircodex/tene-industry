(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.IronBendPurchaseUnits=api;
})(typeof window!=='undefined'?window:globalThis,function(){
  'use strict';
  const DEFAULT_UNIT_WEIGHT_KG=2050;
  const units={coil:{unit:'coil',label:'גלילים'},straight:{unit:'bundle',label:'חבילות'},mesh:{unit:'sheet',label:'רשתות'},bent:{unit:'kg',label:'ק״ג'}};
  function purchaseUnit(type){return units[type]||null;}
  function suggestedQuantity(type,shortage,unitWeight=DEFAULT_UNIT_WEIGHT_KG){
    const n=Number(shortage),weight=Number(unitWeight);
    if(!purchaseUnit(type)||!Number.isFinite(n)||n<0)throw new Error('invalid_purchase_quantity');
    if(type==='coil'||type==='straight'){
      if(!Number.isFinite(weight)||weight<0.001||weight>1e7)throw new Error('invalid_unit_weight');
      // Both operands are integer grams: exact multiples must not round up twice.
      return Math.ceil(Math.round(n*1000)/Math.round(weight*1000));
    }
    return type==='mesh'?Math.ceil(n):n;
  }
  function estimatedWeight(quantity,unitWeight){return Math.round(Number(quantity)*Number(unitWeight)*1000)/1000;}
  return {DEFAULT_UNIT_WEIGHT_KG,purchaseUnit,suggestedQuantity,estimatedWeight};
});
